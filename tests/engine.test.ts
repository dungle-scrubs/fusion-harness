import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun, extractJsonObjects, type WorkerResult } from "../src/engine";
import {
  isLegalTransition,
  type RunRegistration,
  type RunStage,
  stampProvenance,
} from "../src/run";

function registration(overrides: Partial<RunRegistration> = {}): RunRegistration {
  return {
    pattern: "echo",
    registeredAt: "2026-09-23T00:00:00.000Z",
    runId: "ra1b2c3d4",
    stoppingRule: "all workers submit or time out",
    task: "reply with one answer claim",
    workers: [
      { harness: "pi", prompt: "answer", timeoutSec: 60, workerId: "w1" },
      { harness: "pi", model: "test-model", prompt: "answer", timeoutSec: 60, workerId: "w2" },
    ],
    ...overrides,
  };
}

function validClaim(id: string): Record<string, unknown> {
  return {
    claim: `claim ${id}`,
    claim_id: id,
    confidence: 0.8,
    falsifier: `falsifier ${id}`,
    kind: "answer",
    status: "documented",
  };
}

function workerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    exitCode: 0,
    failureClass: null,
    identity: { harness: "pi", requestedModel: "harness-default", sessionId: "s1" },
    question: null,
    rawClaims: [validClaim("C1")],
    ...overrides,
  };
}

describe("state machine", () => {
  const legal: [RunStage, RunStage][] = [
    ["REGISTERED", "SPAWNING"],
    ["SPAWNING", "GENERATING"],
    ["GENERATING", "NORMALIZING"],
    ["NORMALIZING", "CHALLENGING"],
    ["NORMALIZING", "DECIDING"],
    ["CHALLENGING", "VERIFYING"],
    ["VERIFYING", "DECIDING"],
    ["DECIDING", "DONE"],
    ["GENERATING", "FAILED"],
    ["DECIDING", "FAILED"],
  ];
  for (const [from, to] of legal) {
    it(`allows ${from} -> ${to}`, () => {
      expect(isLegalTransition(from, to)).toBe(true);
    });
  }

  const illegal: [RunStage, RunStage][] = [
    ["REGISTERED", "GENERATING"],
    ["GENERATING", "DECIDING"],
    ["NORMALIZING", "GENERATING"],
    ["DECIDING", "NORMALIZING"],
    ["DONE", "FAILED"],
    ["FAILED", "GENERATING"],
    ["GENERATING", "GENERATING"],
    ["VERIFYING", "CHALLENGING"],
    ["GENERATING", "AWAITING-INPUT"],
    ["AWAITING-INPUT", "GENERATING"],
  ];
  for (const [from, to] of illegal) {
    it(`rejects ${from} -> ${to}`, () => {
      expect(isLegalTransition(from, to)).toBe(false);
    });
  }
});

describe("stampProvenance", () => {
  it("builds the block from tool records only", () => {
    const stamped = stampProvenance({
      harness: "pi",
      model: "m",
      runId: "ra1b2c3d4",
      sessionId: "s1",
      stampedAt: "2026-09-23T00:00:01.000Z",
      workerId: "w1",
    });
    expect(stamped).toEqual({
      harness: "pi",
      model: "m",
      runId: "ra1b2c3d4",
      sessionId: "s1",
      stampedAt: "2026-09-23T00:00:01.000Z",
      workerId: "w1",
    });
  });
});

describe("extractJsonObjects", () => {
  it("finds fenced and bare objects, ignores prose", () => {
    const found = extractJsonObjects(
      'here is my answer:\n```json\n{"a": 1}\n```\nand {"b": 2} is the second',
    );
    expect(found).toEqual([{ a: 1 }]);
  });

  it("returns nothing for prose without objects", () => {
    expect(extractJsonObjects("just some words, no claims")).toEqual([]);
  });

  it("extracts one object per line from multi-claim replies", () => {
    const found = extractJsonObjects(
      'here you go:\n{"claim_id": "C1", "kind": "answer"}\n{"claim_id": "C2", "kind": "evidence"}\n',
    );
    expect(found).toEqual([
      { claim_id: "C1", kind: "answer" },
      { claim_id: "C2", kind: "evidence" },
    ]);
  });
});

describe("executeRun with a fake spawner", () => {
  it("freezes run.json, stamps provenance, writes replayable events", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-12-"));
    const now = () => "2026-09-23T00:00:00.000Z";
    const report = executeRun(registration(), {
      now,
      repoRoot: root,
      spawn: (config) =>
        workerResult({
          identity: {
            harness: config.harness,
            requestedModel: config.model ?? "harness-default",
            sessionId: `sess-${config.prompt.length}`,
          },
          rawClaims: [validClaim("C1")],
        }),
    });
    expect(report.runDir).toBe(join(root, ".fusion", "runs", "ra1b2c3d4"));
    expect(readdirSync(report.runDir).sort()).toEqual([
      "decision.json",
      "events.ndjson",
      "run.json",
    ]);

    const frozen = JSON.parse(readFileSync(join(report.runDir, "run.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(frozen["runId"]).toBe("ra1b2c3d4");

    const decisionFile = JSON.parse(
      readFileSync(join(report.runDir, "decision.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(decisionFile["cause"]).toBe("clean");

    const lines = readFileSync(join(report.runDir, "events.ndjson"), "utf8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.length).toBeGreaterThan(5);
    for (const event of events) {
      expect(event["runId"]).toBe("ra1b2c3d4");
      expect(event["schemaVersion"]).toBe("fusion/v0");
    }
    const kinds = events.map((e) => e["kind"]);
    expect(kinds).toContain("worker");
    expect(kinds).toContain("claim");
    expect(kinds).toContain("decision");
    expect(kinds[kinds.length - 1]).toBe("done");

    const claimEvents = events.filter((e) => e["kind"] === "claim");
    expect(claimEvents).toHaveLength(2);
    for (const event of claimEvents) {
      const payload = event["payload"] as Record<string, unknown>;
      const claim = payload["claim"] as Record<string, unknown>;
      expect(claim["provenance"]).toMatchObject({ runId: "ra1b2c3d4" });
    }
  });

  it("marks invalid claims rejected and continues", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-12-"));
    const report = executeRun(registration(), {
      now: () => "2026-09-23T00:00:00.000Z",
      repoRoot: root,
      spawn: () => workerResult({ rawClaims: [{ claim_id: "C9", kind: "answer" }] }),
    });
    const kinds = report.events.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe("done");
    const rejected = report.events.filter(
      (e) => e.kind === "claim" && (e.payload as Record<string, unknown>)["rejected"] === true,
    );
    expect(rejected).toHaveLength(2);
  });

  it("survives a worker failure and names it", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-12-"));
    let calls = 0;
    const report = executeRun(registration(), {
      now: () => "2026-09-23T00:00:00.000Z",
      repoRoot: root,
      spawn: () => {
        calls += 1;
        if (calls === 1) {
          return workerResult({ exitCode: 1, failureClass: "timeout", identity: null });
        }
        return workerResult();
      },
    });
    const kinds = report.events.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe("done");
    const failure = report.events.find((e) => e.kind === "failure");
    expect(failure?.payload).toMatchObject({ class: "timeout", workerId: "w1" });
    const decision = JSON.parse(
      readFileSync(join(report.runDir, "decision.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(decision["survivors"]).toBe(1);
    expect(decision["failures"]).toEqual([{ class: "timeout", workerId: "w1" }]);
  });

  it("fails the run with partial events and a failure record when every worker fails", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-12-"));
    const report = executeRun(registration(), {
      now: () => "2026-09-23T00:00:00.000Z",
      repoRoot: root,
      spawn: () => workerResult({ exitCode: 1, failureClass: "transport", identity: null }),
    });
    expect(report.events[report.events.length - 1]?.kind).toBe("done");
    const done = report.events[report.events.length - 1] as {
      payload: Record<string, unknown>;
    };
    expect(done.payload["cause"]).toBe("failed");
    const stageEvents = report.events.filter((e) => e.kind === "stage");
    expect(stageEvents[stageEvents.length - 1]?.payload).toEqual({ stage: "FAILED" });
    const lines = readFileSync(join(report.runDir, "events.ndjson"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    const runJson = JSON.parse(readFileSync(join(report.runDir, "run.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(runJson["runId"]).toBe("ra1b2c3d4");
    expect(runJson["failureRecord"]).toEqual({
      failures: [
        { class: "transport", workerId: "w1" },
        { class: "transport", workerId: "w2" },
      ],
      survivors: 0,
    });
    const decision = JSON.parse(
      readFileSync(join(report.runDir, "decision.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(decision["cause"]).toBe("failed");
    expect(decision["survivors"]).toBe(0);
  });

  it("carries worker questions through with the run id", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-12-"));
    const report = executeRun(registration(), {
      now: () => "2026-09-23T00:00:00.000Z",
      repoRoot: root,
      spawn: () => workerResult({ question: { options: ["a"], question: "which?" } }),
    });
    const question = report.events.find((e) => e.kind === "question");
    expect(question?.runId).toBe("ra1b2c3d4");
    expect(question?.payload).toMatchObject({ question: "which?", workerId: "w1" });
  });

  it("remaps agent-local ids to run-scoped ids at the boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-12-"));
    const report = executeRun(
      {
        pattern: "echo",
        registeredAt: "2026-09-24T00:00:00.000Z",
        runId: "r2a3b4c5d",
        stoppingRule: "x",
        task: "remap check",
        workers: [
          { harness: "pi", prompt: "p1", timeoutSec: 5, workerId: "w1" },
          { harness: "pi", prompt: "p2", timeoutSec: 5, workerId: "w2" },
        ],
      },
      {
        now: () => "2026-09-24T00:00:00.000Z",
        repoRoot: root,
        spawn: () =>
          workerResult({
            rawClaims: [{ ...validClaim("C1"), dependencies: ["C1"] }, validClaim("C2")],
          }),
      },
    );
    const claimEvents = report.events.filter((e) => e.kind === "claim");
    expect(claimEvents).toHaveLength(4);
    const ids = claimEvents.map((e) => (e.payload["claim"] as Record<string, unknown>)["claim_id"]);
    expect(ids).toEqual(["w1:C1", "w1:C2", "w2:C1", "w2:C2"]);
    const first = claimEvents[0]?.payload["claim"] as Record<string, unknown>;
    expect(first["dependencies"]).toEqual(["w1:C1"]);
    const third = claimEvents[2]?.payload["claim"] as Record<string, unknown>;
    expect(third["dependencies"]).toEqual(["w2:C1"]);
  });

  it("rejects bad registrations before spawning", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-12-"));
    let spawned = 0;
    expect(() =>
      executeRun(registration({ workers: [] }), {
        repoRoot: root,
        spawn: () => {
          spawned += 1;
          return workerResult();
        },
      }),
    ).toThrow("at least one worker");
    expect(spawned).toBe(0);
    expect(() => executeRun(registration({ runId: "not-a-run-id" }), { repoRoot: root })).toThrow(
      "runId",
    );
  });
});
