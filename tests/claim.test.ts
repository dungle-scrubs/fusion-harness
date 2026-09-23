import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLAIM_KINDS,
  CLAIM_STATUSES,
  type Claim,
  NOVELTIES,
  REQUESTED_ACTIONS,
  validateClaim,
  validateClaims,
} from "../src/claim";

function baseClaim(): Record<string, unknown> {
  return {
    claim: "migration is mechanical: named import covers all 14 sites",
    claim_id: "C1",
    confidence: 0.8,
    falsifier: "any site uses the default export's method table, not just the symbol",
    kind: "finding",
    status: "inferred",
  };
}

function fixture(name: string): unknown[] {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe("required fields", () => {
  it("accepts a minimal valid claim", () => {
    expect(validateClaim(baseClaim()).valid).toBe(true);
  });

  for (const field of ["claim", "claim_id", "confidence", "falsifier", "kind", "status"]) {
    it(`rejects a claim missing ${field}`, () => {
      const claim = baseClaim();
      delete claim[field];
      const verdict = validateClaim(claim);
      expect(verdict.valid).toBe(false);
      expect(verdict.errors.some((e) => e.includes(`missing required "${field}"`))).toBe(true);
    });
  }

  it("requires a non-empty falsifier on every kind, including evidence", () => {
    for (const kind of CLAIM_KINDS) {
      const missing: Record<string, unknown> = { ...baseClaim(), kind };
      delete missing["falsifier"];
      expect(validateClaim(missing).valid).toBe(false);
      const blank = { ...baseClaim(), falsifier: "   " };
      expect(validateClaim(blank).valid).toBe(false);
    }
  });

  it("requires a non-empty claim string", () => {
    expect(validateClaim({ ...baseClaim(), claim: "" }).valid).toBe(false);
    expect(validateClaim({ ...baseClaim(), claim: "  " }).valid).toBe(false);
  });
});

describe("claim_id and dependency refs", () => {
  it("accepts C-number ids", () => {
    expect(validateClaim({ ...baseClaim(), claim_id: "C42" }).valid).toBe(true);
  });

  for (const bad of ["1", "c1", "CX", "C", "C1a", "", 7, null]) {
    it(`rejects claim_id ${JSON.stringify(bad)}`, () => {
      expect(validateClaim({ ...baseClaim(), claim_id: bad }).valid).toBe(false);
    });
  }

  it("accepts C-number dependency refs", () => {
    expect(validateClaim({ ...baseClaim(), dependencies: ["C1", "C3"] }).valid).toBe(true);
  });

  it("rejects malformed dependency refs", () => {
    const verdict = validateClaim({ ...baseClaim(), dependencies: ["C1", "nope"] });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors).toContain("dependencies must be C[0-9]+ refs");
  });
});

describe("enums", () => {
  it("accepts every kind", () => {
    for (const kind of CLAIM_KINDS) {
      expect(validateClaim({ ...baseClaim(), kind }).valid).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    const verdict = validateClaim({ ...baseClaim(), kind: "verdict" });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.some((e) => e.startsWith("kind must be one of"))).toBe(true);
  });

  it("accepts every status", () => {
    for (const status of CLAIM_STATUSES) {
      expect(validateClaim({ ...baseClaim(), status }).valid).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    expect(validateClaim({ ...baseClaim(), status: "proven" }).valid).toBe(false);
  });

  it("accepts every novelty and requested_action", () => {
    for (const novelty of NOVELTIES) {
      expect(validateClaim({ ...baseClaim(), novelty }).valid).toBe(true);
    }
    for (const requested_action of REQUESTED_ACTIONS) {
      expect(validateClaim({ ...baseClaim(), requested_action }).valid).toBe(true);
    }
  });

  it("rejects unknown novelty and requested_action", () => {
    expect(validateClaim({ ...baseClaim(), novelty: "novel" }).valid).toBe(false);
    expect(validateClaim({ ...baseClaim(), requested_action: "decide" }).valid).toBe(false);
  });
});

describe("confidence range", () => {
  for (const good of [0, 0.5, 1]) {
    it(`accepts confidence ${good}`, () => {
      expect(validateClaim({ ...baseClaim(), confidence: good }).valid).toBe(true);
    });
  }

  for (const bad of [-0.1, 1.5, Number.NaN, "0.9", null]) {
    it(`rejects confidence ${JSON.stringify(bad)}`, () => {
      expect(validateClaim({ ...baseClaim(), confidence: bad }).valid).toBe(false);
    });
  }
});

describe("optional blocks", () => {
  it("accepts a full evidence entry", () => {
    const claim: Claim = {
      claim: "test suite imports 14 sites via default export",
      claim_id: "C3",
      confidence: 0.95,
      evidence: [{ source_or_test: "rg import sites", supports: "14 default-import sites" }],
      falsifier: "rg returns fewer/more named-import sites",
      kind: "evidence",
      status: "observed",
    };
    expect(validateClaim(claim).valid).toBe(true);
  });

  it("rejects evidence missing its required fields", () => {
    const verdict = validateClaim({
      ...baseClaim(),
      evidence: [{ source_or_test: "only a source" }],
    });
    expect(verdict.valid).toBe(false);
  });

  it("rejects unknown fields inside an evidence entry", () => {
    const verdict = validateClaim({
      ...baseClaim(),
      evidence: [{ source_or_test: "s", supports: "x", extra: "no" }],
    });
    expect(verdict.valid).toBe(false);
  });

  it("accepts string assumptions, rejects non-strings", () => {
    expect(validateClaim({ ...baseClaim(), assumptions: ["CHANGELOG is accurate"] }).valid).toBe(
      true,
    );
    expect(validateClaim({ ...baseClaim(), assumptions: ["ok", 7] }).valid).toBe(false);
  });
});

describe("immutable provenance", () => {
  it("rejects any agent-set provenance block", () => {
    const verdict = validateClaim({
      ...baseClaim(),
      provenance: {
        harness: "pi",
        model: "gpt-5.2",
        runId: "r1",
        sessionId: "fake",
        stampedAt: "2026-09-23T00:00:00Z",
        workerId: "w1",
      },
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors).toContain("provenance is tool-stamped: an agent cannot set it");
  });
});

describe("unknown fields", () => {
  it("rejects unknown top-level fields instead of ignoring them", () => {
    const verdict = validateClaim({ ...baseClaim(), score: 9 });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors).toContain('unknown field "score"');
  });

  it("rejects non-object input", () => {
    expect(validateClaim("C1").valid).toBe(false);
    expect(validateClaim(null).valid).toBe(false);
    expect(validateClaim([baseClaim()]).valid).toBe(false);
  });
});

describe("prototype fixtures", () => {
  it("accepts all 5 valid jury claims", () => {
    const verdicts = validateClaims(fixture("valid-jury.jsonl"));
    expect(verdicts).toHaveLength(5);
    expect(verdicts.every((v) => v.valid)).toBe(true);
  });

  it("rejects all 3 invalid claims with the prototype's reasons", () => {
    const verdicts = validateClaims(fixture("invalid.jsonl"));
    expect(verdicts).toHaveLength(3);
    expect(verdicts.every((v) => !v.valid)).toBe(true);
    const byId = new Map(verdicts.map((v) => [v.claim_id, v.errors.join("; ")]));
    expect(byId.get("C9")).toContain("falsifier");
    expect(byId.get("C10")).toContain("confidence must be a number in [0,1]");
    expect(byId.get("C11")).toContain("provenance is tool-stamped");
  });
});
