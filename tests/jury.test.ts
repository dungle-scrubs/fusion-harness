import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AcceptedClaim, executeRun } from "../src/engine";
import { juryFuse, juryWorkerPrompt } from "../src/jury";

function answer(
  workerId: string,
  text: string,
  extra: Record<string, unknown> = {},
): AcceptedClaim {
  return {
    claim: {
      claim: text,
      claim_id: `C${workerId.slice(1)}`,
      confidence: 0.8,
      falsifier: `falsifier ${workerId}`,
      kind: "answer",
      status: "documented",
      ...extra,
    },
    stage: "generate",
    workerId,
  };
}

function rawAnswer(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim: text,
    claim_id: "C1",
    confidence: 0.8,
    falsifier: "falsifier",
    kind: "answer",
    status: "documented",
    ...extra,
  };
}

describe("juryWorkerPrompt", () => {
  it("carries the task, the claim schema, and the provenance ban", () => {
    const prompt = juryWorkerPrompt("ship or hold?");
    expect(prompt).toContain("TASK: ship or hold?");
    expect(prompt).toContain('kind: "answer"');
    expect(prompt).toContain("Do NOT include a provenance field");
    expect(prompt).toContain("sealed");
  });
});

describe("juryFuse", () => {
  it("groups equivalent answers and decides by plurality", () => {
    const result = juryFuse([
      answer("w1", "Ship it. The fix is verified."),
      answer("w2", "ship it. the fix is verified."),
      answer("w3", "Hold for a second review."),
    ]);
    expect(result.decision.decision).toBe("ship it. the fix is verified.");
    expect(result.decision.independence).toEqual({
      acceptedAnswers: 3,
      duplicateRate: 1 - 2 / 3,
      groups: 2,
    });
    expect(result.decision.minorityReport).toHaveLength(1);
    expect(result.decision.minorityReport[0]?.votes).toBe(1);
    expect(result.fusion.method).toBe("plurality");
    expect(result.fusion.winner).toBe("ship it. the fix is verified.");
  });

  it("breaks vote ties by first-seen order", () => {
    const result = juryFuse([answer("w1", "Option A"), answer("w2", "Option B")]);
    expect(result.decision.decision).toBe("option a");
  });

  it("rejects non-answer kinds with the pattern reason", () => {
    const result = juryFuse([
      answer("w1", "Fine"),
      {
        claim: {
          claim: "an objection is not a juror answer",
          claim_id: "C2",
          confidence: 0.9,
          falsifier: "x",
          kind: "objection",
          status: "documented",
        },
        stage: "generate",
        workerId: "w2",
      },
    ]);
    expect(result.decision.rejectedOptions).toEqual([
      { claimId: "C2", reason: "jury requires kind=answer, got objection" },
    ]);
    expect(result.decision.decision).toBe("fine");
  });

  it("lists high-confidence minority answers as residual risks", () => {
    const result = juryFuse([
      answer("w1", "Ship"),
      answer("w2", "Ship"),
      answer("w3", "Hold", { confidence: 0.9, requested_action: "escalate" }),
    ]);
    expect(result.decision.residualRisks).toEqual([
      { claimId: "C3", confidence: 0.9, falsifier: "falsifier w3" },
    ]);
  });

  it("omits low-confidence quiet minorities from residual risks", () => {
    const result = juryFuse([
      answer("w1", "Ship"),
      answer("w2", "Ship"),
      answer("w3", "Hold", { confidence: 0.3 }),
    ]);
    expect(result.decision.residualRisks).toEqual([]);
  });

  it("binds residual risks to the minority claim itself when claim_ids collide", () => {
    const both = { claim_id: "C1" };
    const quiet = juryFuse([
      answer("w1", "Ship", { ...both, confidence: 0.9, requested_action: "escalate" }),
      answer("w2", "Hold", { ...both, confidence: 0.3, falsifier: "hold falsifier" }),
    ]);
    expect(quiet.decision.residualRisks).toEqual([]);
    const escalated = juryFuse([
      answer("w1", "Ship", { ...both, confidence: 0.9 }),
      answer("w2", "Hold", {
        ...both,
        confidence: 0.3,
        requested_action: "escalate",
        falsifier: "hold falsifier",
      }),
    ]);
    expect(escalated.decision.residualRisks).toEqual([
      { claimId: "C1", confidence: 0.3, falsifier: "hold falsifier" },
    ]);
  });

  it("returns a null decision when nothing survives", () => {
    const result = juryFuse([]);
    expect(result.decision.decision).toBeNull();
    expect(result.decision.independence.acceptedAnswers).toBe(0);
    expect(result.decision.minorityReport).toEqual([]);
  });
});

describe("jury through the engine", () => {
  it("runs the full pattern with a fake spawner and writes the decision", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-13-"));
    const report = executeRun(
      {
        pattern: "jury",
        registeredAt: "2026-09-23T00:00:00.000Z",
        runId: "r0a1b2c3d",
        stoppingRule: "every worker submits one answer claim or times out",
        task: "ship or hold?",
        workers: [
          { harness: "pi", prompt: "p", timeoutSec: 5, workerId: "w1" },
          { harness: "pi", prompt: "p", timeoutSec: 5, workerId: "w2" },
        ],
      },
      {
        fuse: juryFuse,
        now: () => "2026-09-23T00:00:00.000Z",
        repoRoot: root,
        spawn: (config) => ({
          exitCode: 0,
          failureClass: null,
          identity: {
            harness: config.harness,
            requestedModel: config.model ?? "harness-default",
            sessionId: `s-${config.prompt.length}`,
          },
          question: null,
          rawClaims: [rawAnswer("Ship it")],
        }),
      },
    );
    const kinds = report.events.map((e) => e.kind);
    expect(kinds).toContain("fusion");
    const fusion = report.events.find((e) => e.kind === "fusion");
    expect(fusion?.payload).toMatchObject({ method: "plurality", winner: "ship it" });
    const done = report.events[report.events.length - 1];
    expect(done?.kind).toBe("done");
    expect(done?.payload["cause"]).toBe("clean");
  });
});
