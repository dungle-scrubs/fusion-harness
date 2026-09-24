import { describe, expect, it } from "vitest";
import type { AcceptedClaim } from "../src/engine";
import { gonogoDefinition, gonogoFuse, gonogoPrompt } from "../src/gonogo";

function position(
  workerId: string,
  action: string,
  extra: Record<string, unknown> = {},
): AcceptedClaim {
  return {
    claim: {
      claim: "note",
      claim_id: "C1",
      confidence: 0.8,
      falsifier: "f",
      kind: "answer",
      requested_action: action,
      status: "documented",
      ...extra,
    },
    stage: "generate",
    workerId,
  };
}

describe("gonogo prompt", () => {
  it("spells the position mapping, veto rule, and provenance ban", () => {
    const prompt = gonogoPrompt("release v2.1");
    expect(prompt).toContain("WHAT IS BEING GATED: release v2.1");
    expect(prompt).toContain('"accept" for GO, "test" for GO WITH CONSTRAINT');
    expect(prompt).toContain("blocks the gate regardless of majority");
    expect(prompt).toContain("Do NOT include a provenance field");
  });
});

describe("gonogoFuse", () => {
  it("GO when every reviewer accepts", () => {
    const result = gonogoFuse([position("w-gate-1", "accept"), position("w-gate-2", "accept")]);
    expect(result.decision["decision"]).toBe("GO");
    expect(result.decision["blockingConcerns"]).toEqual([]);
  });

  it("one NO-GO blocks regardless of majority", () => {
    const result = gonogoFuse([
      position("w-gate-1", "accept"),
      position("w-gate-2", "accept"),
      position("w-gate-3", "escalate", {
        claim: "no rollback plan",
        falsifier: "a tested rollback runbook",
      }),
    ]);
    expect(result.decision["decision"]).toBe("NO-GO");
    expect(result.decision["blockingConcerns"]).toEqual([
      {
        action: "escalate",
        claimId: "C1",
        concern: "no rollback plan",
        falsifier: "a tested rollback runbook",
        workerId: "w-gate-3",
      },
    ]);
  });

  it("abstain also blocks, as unverifiable", () => {
    const result = gonogoFuse([position("w-gate-1", "accept"), position("w-gate-2", "abstain")]);
    expect(result.decision["decision"]).toBe("NO-GO");
    expect((result.decision["blockingConcerns"] as { action: string }[])[0]?.action).toBe(
      "abstain",
    );
  });

  it("GO WITH CONSTRAINT carries the constraint union", () => {
    const result = gonogoFuse([
      position("w-gate-1", "accept"),
      position("w-gate-2", "test", { claim: "soak for 48h under shadow traffic first" }),
    ]);
    expect(result.decision["decision"]).toBe("GO WITH CONSTRAINT");
    expect(result.decision["constraints"]).toEqual([
      { constraint: "soak for 48h under shadow traffic first", workerId: "w-gate-2" },
    ]);
  });

  it("missing requested_action counts as abstain, not silence", () => {
    const raw: AcceptedClaim = {
      claim: {
        claim: "n",
        claim_id: "C1",
        confidence: 0.5,
        falsifier: "f",
        kind: "answer",
        status: "unknown",
      },
      stage: "generate",
      workerId: "w-gate-1",
    };
    const result = gonogoFuse([raw, position("w-gate-2", "accept")]);
    expect(result.decision["decision"]).toBe("NO-GO");
  });
});

describe("gonogo definition", () => {
  it("builds the gate reviewers and rejects bad args", () => {
    const build = gonogoDefinition.build({
      harness: "pi",
      reviewers: "3",
      task: "ship it?",
      timeout: "60",
    });
    expect("error" in build).toBe(false);
    if ("error" in build) {
      return;
    }
    expect(build.workers).toHaveLength(3);
    expect(build.workers[0]?.workerId).toBe("w-gate-1");
    expect(build.workers[0]?.prompt).toContain("WHAT IS BEING GATED: ship it?");
    expect(
      gonogoDefinition.build({ harness: "pi", reviewers: "3", task: "", timeout: "60" }),
    ).toEqual({
      error: "--task must be non-empty",
    });
    expect(
      gonogoDefinition.build({ harness: "pi", reviewers: "1", task: "t", timeout: "60" }),
    ).toEqual({
      error: "--reviewers must be an integer >= 2",
    });
  });
});
