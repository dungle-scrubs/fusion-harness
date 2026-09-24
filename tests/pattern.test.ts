import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { achDefinition } from "../src/ach";
import type { RunReport } from "../src/engine";
import { juryDefinition } from "../src/jury";
import { redblueDefinition } from "../src/redblue";

function reportOf(overrides: Partial<RunReport> = {}): RunReport {
  return {
    cause: "clean",
    decision: {},
    events: [],
    runDir: "/tmp/x",
    runId: "r0a1b2c3",
    ...overrides,
  };
}

describe("jury definition", () => {
  it("builds N sealed workers with the juror prompt", () => {
    const build = juryDefinition.build({
      harness: "pi",
      task: "ship or hold?",
      timeout: "60",
      workers: "2",
    });
    expect("error" in build).toBe(false);
    if ("error" in build) {
      return;
    }
    expect(build.workers).toHaveLength(2);
    expect(build.workers[0]?.prompt).toContain("TASK: ship or hold?");
    expect(build.workers[1]?.workerId).toBe("w2");
    expect(build.fuse).toBeTypeOf("function");
  });

  it("rejects empty task, too few workers, and bad timeout", () => {
    expect(
      juryDefinition.build({ harness: "pi", task: "  ", timeout: "60", workers: "3" }),
    ).toEqual({
      error: "--task must be non-empty",
    });
    expect(juryDefinition.build({ harness: "pi", task: "t", timeout: "60", workers: "1" })).toEqual(
      {
        error: "--workers must be an integer >= 2",
      },
    );
    expect(juryDefinition.build({ harness: "pi", task: "t", timeout: "0", workers: "2" })).toEqual({
      error: "--timeout must be positive seconds",
    });
  });

  it("summarizes with run, decision, and votes lines", () => {
    const lines = juryDefinition.summarize(
      {
        decision: "ship it",
        independence: { acceptedAnswers: 2, duplicateRate: 0.5, groups: 1 },
      },
      reportOf(),
    );
    expect(lines[0]).toContain("r0a1b2c3");
    expect(lines[1]).toContain("ship it");
    expect(lines[2]).toContain("2 answers, 1 groups");
  });
});

describe("red-blue definition", () => {
  it("builds claimant plus challenge and verify stages with symmetric budgets", () => {
    const build = redblueDefinition.build({
      burden: "two sources",
      harness: "pi",
      task: "is it safe?",
      timeout: "120",
    });
    expect("error" in build).toBe(false);
    if ("error" in build) {
      return;
    }
    expect(build.workers).toEqual([
      {
        harness: "pi",
        prompt: expect.stringContaining("claimant"),
        timeoutSec: 120,
        workerId: "w-red",
      },
    ]);
    expect(build.rubric).toBe("two sources");
    expect(build.stages?.challenge).toBeTypeOf("function");
    expect(build.stages?.verify).toBeTypeOf("function");
  });

  it("rejects missing burden or task and bad timeout", () => {
    expect(redblueDefinition.build({ harness: "pi", task: "t", timeout: "10" })).toEqual({
      error: "--task and --burden must be non-empty",
    });
    expect(
      redblueDefinition.build({ burden: "b", harness: "pi", task: "t", timeout: "0" }),
    ).toEqual({ error: "--timeout must be positive seconds" });
  });

  it("summarizes ruling, verdict, and surviving claims", () => {
    const lines = redblueDefinition.summarize(
      { decision: "record stands", judgeVerdict: "accept", survivingClaims: ["w-red:C1"] },
      reportOf(),
    );
    expect(lines.join("\n")).toContain("ruling   record stands");
    expect(lines.join("\n")).toContain("verdict  accept");
    expect(lines.join("\n")).toContain('["w-red:C1"]');
  });
});

describe("ach definition", () => {
  it("builds N analysts with the ACH prompt", () => {
    const build = achDefinition.build({
      harness: "muse",
      task: "why did it fail?",
      timeout: "60",
      workers: "2",
    });
    expect("error" in build).toBe(false);
    if ("error" in build) {
      return;
    }
    expect(build.workers).toHaveLength(2);
    expect(build.workers[0]?.prompt).toContain("TASK: why did it fail?");
    expect(build.workers[0]?.harness).toBe("muse");
  });

  it("rejects single-analyst runs", () => {
    expect(achDefinition.build({ harness: "pi", task: "t", timeout: "60", workers: "1" })).toEqual({
      error: "--workers must be an integer >= 2",
    });
  });
});

describe("skill text covers every pattern command", () => {
  it("mentions all three pattern commands", () => {
    const text = readFileSync(new URL("../src/skill.ts", import.meta.url), "utf8");
    expect(text).toContain("fusion jury");
    expect(text).toContain("fusion red-blue");
    expect(text).toContain("fusion ach");
  });

  it("carries a selection rule and a counter-rule per pattern", () => {
    const text = readFileSync(new URL("../src/skill.ts", import.meta.url), "utf8");
    expect(text).toContain("-> jury");
    expect(text).toContain("Do NOT use jury");
    expect(text).toContain("-> red-blue");
    expect(text).toContain("Do NOT use it when nobody");
    expect(text).toContain("-> ach");
    expect(text).toContain("Do NOT use it to choose between proposals");
    expect(text).toContain("tier 1 directly. A pattern run adds isolation you do not need.");
    expect(text).toContain("do not call fusion at all");
  });
});
