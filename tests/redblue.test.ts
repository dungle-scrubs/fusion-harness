import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AcceptedClaim } from "../src/engine";
import { executeRun } from "../src/engine";
import { claimantPrompt, judgePrompt, redblueFuse } from "../src/redblue";

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

describe("prompts", () => {
  it("claimant prompt bans provenance and allows multiple claims", () => {
    const prompt = claimantPrompt("is the build green?");
    expect(prompt).toContain("is the build green?");
    expect(prompt).toContain("1-4 atomic claims");
    expect(prompt).toContain("Do NOT include a provenance field");
  });

  it("judge prompt carries the burden and the blindness rule", () => {
    const prompt = judgePrompt("two independent sources", {
      anonymizedClaims: [],
      byWorker: new Map(),
    });
    expect(prompt).toContain("BURDEN: two independent sources");
    expect(prompt).toContain("hidden from you");
  });

  it("judge prompt receives claims without provenance", () => {
    const prompt = judgePrompt("b", {
      anonymizedClaims: [{ claim: "x", claim_id: "C1", provenance: undefined }],
      byWorker: new Map(),
    });
    expect(prompt).toContain('"claim":"x"');
  });
});

describe("redblueFuse", () => {
  const base = [
    claim("generate", "w-red", { claim: "claim one", claim_id: "C1" }),
    claim("generate", "w-red", { claim: "claim two", claim_id: "C2" }),
  ];

  it("sustained objection removes its target", () => {
    const result = redblueFuse([
      ...base,
      claim("challenge", "w-blue", {
        claim: "C1 rests on a stale source",
        claim_id: "C1",
        dependencies: ["C1"],
        kind: "objection",
      }),
      claim("verify", "w-umpire", {
        claim: "the source is stale",
        claim_id: "C1",
        dependencies: ["C1"],
        kind: "evidence",
        requested_action: "accept",
        status: "observed",
      }),
      claim("verify", "w-judge", {
        claim: "C2 alone meets the burden",
        claim_id: "C1",
        kind: "answer",
        requested_action: "accept",
      }),
    ]);
    expect(result.decision["survivingClaims"]).toEqual(["C2"]);
    expect(result.decision["decision"]).toBe("C2 alone meets the burden");
    expect(result.decision["judgeVerdict"]).toBe("accept");
    expect(result.decision["rejectedOptions"]).toEqual([
      { claimId: "C1", reason: "objection C1 sustained" },
    ]);
  });

  it("overruled objection leaves the target standing", () => {
    const result = redblueFuse([
      ...base,
      claim("challenge", "w-blue", {
        claim: "C1 is irrelevant",
        claim_id: "C1",
        dependencies: ["C1"],
        kind: "objection",
      }),
      claim("verify", "w-umpire", {
        claim: "C1 is relevant",
        claim_id: "C1",
        dependencies: ["C1"],
        kind: "evidence",
        requested_action: "revise",
        status: "observed",
      }),
      claim("verify", "w-judge", {
        claim: "record stands",
        claim_id: "C1",
        kind: "answer",
        requested_action: "accept",
      }),
    ]);
    expect(result.decision["survivingClaims"]).toEqual(["C1", "C2"]);
    expect(result.decision["residualRisks"]).toEqual([]);
  });

  it("unresolved objections become residual risks", () => {
    const result = redblueFuse([
      ...base,
      claim("challenge", "w-blue", {
        claim: "C2 is unverifiable",
        claim_id: "C1",
        dependencies: ["C2"],
        kind: "objection",
      }),
      claim("verify", "w-judge", {
        claim: "cannot rule",
        claim_id: "C1",
        kind: "answer",
        requested_action: "escalate",
      }),
    ]);
    expect(result.decision["residualRisks"]).toEqual([{ objectionId: "C1", targetId: "C2" }]);
    expect(result.decision["judgeVerdict"]).toBe("escalate");
  });

  it("no objections: everything survives", () => {
    const result = redblueFuse([
      ...base,
      claim("verify", "w-judge", {
        claim: "unopposed record meets burden",
        claim_id: "C1",
        kind: "answer",
        requested_action: "accept",
      }),
    ]);
    expect(result.decision["survivingClaims"]).toEqual(["C1", "C2"]);
  });

  it("no judge: decision null, mechanics still reported", () => {
    const result = redblueFuse(base);
    expect(result.decision["decision"]).toBeNull();
    expect(result.decision["survivingClaims"]).toEqual(["C1", "C2"]);
  });
});

describe("red-blue through the engine", () => {
  it("runs claimant, opponent, umpire, judge in RFC stage order, blind", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-14-"));
    const seenPrompts: string[] = [];
    const report = executeRun(
      {
        pattern: "red-blue",
        registeredAt: "2026-09-24T00:00:00.000Z",
        runId: "r1a2b3c4d",
        rubric: "two sources",
        stoppingRule: "fixed role sequence",
        task: "is the tree clean?",
        workers: [{ harness: "pi", prompt: "claimant", timeoutSec: 5, workerId: "w-red" }],
      },
      {
        fuse: redblueFuse,
        now: () => "2026-09-24T00:00:00.000Z",
        repoRoot: root,
        spawn: (config) => {
          seenPrompts.push(config.prompt);
          const raw =
            config.prompt === "claimant"
              ? {
                  claim: "the working tree is clean",
                  claim_id: "C1",
                  confidence: 0.9,
                  falsifier: "git status shows changes",
                  kind: "answer",
                  status: "documented",
                }
              : config.prompt.includes("opponent")
                ? {
                    claim: "the claim assumes a clean checkout",
                    claim_id: "C1",
                    confidence: 0.7,
                    dependencies: ["w-red:C1"],
                    falsifier: "x",
                    kind: "objection",
                    status: "documented",
                  }
                : config.prompt.includes("umpire")
                  ? {
                      claim: "the repo is a scratch clone; status is meaningless",
                      claim_id: "C1",
                      confidence: 0.9,
                      dependencies: ["w-blue:C1"],
                      falsifier: "x",
                      kind: "evidence",
                      requested_action: "revise",
                      status: "observed",
                    }
                  : {
                      claim: "record meets burden",
                      claim_id: "C1",
                      confidence: 0.8,
                      falsifier: "x",
                      kind: "answer",
                      requested_action: "accept",
                      status: "documented",
                    };
          return {
            exitCode: 0,
            failureClass: null,
            identity: {
              harness: config.harness,
              requestedModel: config.model ?? "harness-default",
              sessionId: "s",
            },
            question: null,
            rawClaims: [raw],
          };
        },
        stages: {
          challenge: () => [
            { harness: "pi", prompt: "opponent", timeoutSec: 5, workerId: "w-blue" },
          ],
          verify: () => [
            { harness: "pi", prompt: "umpire", timeoutSec: 5, workerId: "w-umpire" },
            { harness: "pi", prompt: "judge", timeoutSec: 5, workerId: "w-judge" },
          ],
        },
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
      "VERIFYING",
      "DECIDING",
      "DONE",
    ]);
    const decision = report.events.find((e) => e.kind === "decision");
    expect(decision?.payload).toMatchObject({
      decision: "record meets burden",
      pattern: "red-blue",
    });
    const challengePrompt = seenPrompts.find((p) => p.includes("opponent"));
    expect(challengePrompt).toBeDefined();
    expect(challengePrompt).not.toContain("sessionId");
    expect(challengePrompt).not.toContain("provenance");
  });
});
