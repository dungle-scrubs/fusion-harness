import { describe, expect, it } from "vitest";
import {
  delphiDefinition,
  delphiFuse,
  delphiRound1Prompt,
  delphiRound2Prompt,
} from "../src/delphi";
import type { AcceptedClaim, RunReport } from "../src/engine";

function claim(
  stage: AcceptedClaim["stage"],
  workerId: string,
  fields: Record<string, unknown>,
): AcceptedClaim {
  return {
    claim: {
      claim_id: "C1",
      confidence: 0.8,
      falsifier: "f",
      kind: "answer",
      status: "documented",
      ...fields,
    },
    stage,
    workerId,
  };
}

describe("delphi prompts", () => {
  it("round 1 carries the task, schema, and provenance ban", () => {
    const prompt = delphiRound1Prompt("ship or hold?");
    expect(prompt).toContain("TASK: ship or hold?");
    expect(prompt).toContain('kind: "answer"');
    expect(prompt).toContain("Do NOT include a provenance field");
  });

  it("round 2 shows the worker its own answer AND the panel record claims", () => {
    const prompt = delphiRound2Prompt(
      "ship or hold?",
      [{ claim: "hold", claim_id: "C1" }],
      [
        { claim: "ship now", claim_id: "w1:C1" },
        { claim: "hold for tests", claim_id: "w2:C1" },
      ],
    );
    expect(prompt).toContain("YOUR ROUND-1 ANSWER:");
    expect(prompt).toContain('"claim":"hold"');
    expect(prompt).toContain("PANEL RECORD (anonymized");
    expect(prompt).toContain('"claim":"ship now"');
    expect(prompt).toContain('"claim":"hold for tests"');
    expect(prompt).toContain("novelty:");
  });
});

describe("delphiFuse", () => {
  it("computes convergence, stability, and the round-2 winner mechanically", () => {
    const result = delphiFuse([
      claim("generate", "w1", { claim: "Ship Friday" }),
      claim("generate", "w2", { claim: "Hold for tests" }),
      claim("generate", "w3", { claim: "Ship Friday" }),
      claim("challenge", "w1-r2", { claim: "ship friday" }),
      claim("challenge", "w2-r2", { claim: "Ship Friday after tests pass" }),
      claim("challenge", "w3-r2", { claim: "ship friday" }),
    ]);
    const stats = result.decision["delphi"] as Record<string, unknown>;
    expect(result.decision["decision"]).toBe("ship friday");
    expect(stats["round1"]).toEqual({ answers: 3, groups: 2 });
    expect(stats["round2"]).toEqual({ answers: 3, groups: 2 });
    expect(stats["stabilityRate"]).toBeCloseTo(2 / 3, 12);
    expect(stats["convergenceRate"]).toBeCloseTo(1 / 3, 12);
    expect(result.decision["minorityReport"]).toHaveLength(1);
  });

  it("flags a revised high-confidence minority as a residual risk", () => {
    const result = delphiFuse([
      claim("generate", "w1", { claim: "A" }),
      claim("generate", "w2", { claim: "A" }),
      claim("challenge", "w1-r2", { claim: "a" }),
      claim("challenge", "w2-r2", {
        claim: "B instead, panel ignored the load test",
        confidence: 0.9,
        novelty: "new",
      }),
    ]);
    expect(result.decision["residualRisks"]).toEqual([
      { claimId: "C1", confidence: 0.9, falsifier: "f" },
    ]);
  });

  it("empty rounds yield a null decision with well-formed stats", () => {
    const result = delphiFuse([]);
    expect(result.decision["decision"]).toBeNull();
  });
});

describe("delphi definition", () => {
  it("builds the panel and the revision wave from the same worker count", () => {
    const build = delphiDefinition.build({
      harness: "pi",
      task: "t",
      timeout: "60",
      workers: "3",
    });
    expect("error" in build).toBe(false);
    if ("error" in build) {
      return;
    }
    expect(build.workers).toHaveLength(3);
    expect(build.workers[0]?.workerId).toBe("w1");
    expect(build.stages?.challenge).toBeTypeOf("function");
    if (build.stages?.challenge === undefined) {
      return;
    }
    const wave = build.stages.challenge({
      anonymizedClaims: [],
      byWorker: new Map([["w1", [{ claim: "own answer", claim_id: "C1" }]]]),
    });
    expect(wave).toHaveLength(3);
    expect(wave[0]?.workerId).toBe("w1-r2");
    expect(wave[0]?.prompt).toContain("YOUR ROUND-1 ANSWER:");
    expect(wave[1]?.prompt).toContain("PANEL RECORD");
  });

  it("rejects bad args", () => {
    expect(
      delphiDefinition.build({ harness: "pi", task: "", timeout: "60", workers: "3" }),
    ).toEqual({
      error: "--task must be non-empty",
    });
    expect(
      delphiDefinition.build({ harness: "pi", task: "t", timeout: "60", workers: "1" }),
    ).toEqual({
      error: "--workers must be an integer >= 2",
    });
  });

  it("summarizes rounds and signals", () => {
    const report: RunReport = {
      cause: "clean",
      decision: {},
      events: [],
      runDir: "/tmp/x",
      runId: "r0a1b2c3",
    };
    const lines = delphiDefinition.summarize(
      {
        decision: "ship",
        delphi: {
          convergenceRate: 0.33,
          round1: { answers: 3, groups: 2 },
          round2: { answers: 3, groups: 2 },
          stabilityRate: 0.67,
        },
      },
      report,
    );
    expect(lines.join("\n")).toContain("r1 3 answers / 2 groups -> r2 3 / 2");
    expect(lines.join("\n")).toContain("convergence 0.33, stability 0.67");
  });
});

describe("delphi through the engine", () => {
  it("runs challenge-without-verify from GENERATING to DONE", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { executeRun } = await import("../src/engine");
    const root = mkdtempSync(join(tmpdir(), "fusion-28-"));
    const build = delphiDefinition.build({ harness: "pi", task: "t", timeout: "5", workers: "2" });
    expect("error" in build).toBe(false);
    if ("error" in build) {
      return;
    }
    const report = executeRun(
      {
        pattern: "delphi",
        registeredAt: "2026-09-24T00:00:00.000Z",
        runId: "r3a4b5c6d",
        stoppingRule: build.stoppingRule,
        task: "t",
        workers: build.workers,
      },
      {
        fuse: build.fuse,
        now: () => "2026-09-24T00:00:00.000Z",
        repoRoot: root,
        spawn: (config) => ({
          exitCode: 0,
          failureClass: null,
          identity: {
            harness: config.harness,
            requestedModel: config.model ?? "harness-default",
            sessionId: "s",
          },
          question: null,
          rawClaims: [
            {
              claim: "ship",
              claim_id: "C1",
              confidence: 0.8,
              falsifier: "x",
              kind: "answer",
              status: "documented",
            },
          ],
        }),
        stages: build.stages,
      },
    );
    const stages = report.events
      .filter((e) => e.kind === "stage")
      .map((e) => (e.payload as Record<string, unknown>)["stage"]);
    expect(stages).toEqual([
      "SPAWNING",
      "GENERATING",
      "NORMALIZING",
      "CHALLENGING",
      "DECIDING",
      "DONE",
    ]);
    expect(report.cause).toBe("clean");
    expect(report.decision["pattern"]).toBe("delphi");
  });
});
