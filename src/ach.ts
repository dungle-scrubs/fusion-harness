import type { AcceptedClaim, FusedOutput } from "./engine";

export const ACH_MIN_WORKERS = 2;
export const ACH_DEFAULT_WORKERS = 3;

export function achWorkerPrompt(task: string): string {
  return [
    "You are one sealed analyst in an Analysis of Competing Hypotheses run.",
    "You cannot see the other analysts. Work independently.",
    `TASK: ${task}`,
    "",
    "Submit 1-3 mutually exclusive hypotheses AND 1-3 diagnostic evidence",
    "claims, one JSON object per line, nothing else.",
    "",
    'Hypothesis: claim_id (C1, C2, ...), kind "hypothesis", claim (one',
    'sentence), status ("observed"|"documented"|"inferred"|"unknown"),',
    "confidence [0,1], falsifier, dependencies: the claim_ids of the",
    "evidence items you assessed this hypothesis against (at least one).",
    "",
    'Evidence: claim_id, kind "evidence", claim (what the item shows, one',
    "sentence), status, confidence [0,1], falsifier, dependencies: the",
    "claim_ids of the hypotheses it bears on (at least one), novelty:",
    '"confirms" = consistent with that hypothesis, "contradicts" =',
    "inconsistent with it.",
    "",
    "Choose evidence that DISCRIMINATES between hypotheses where possible;",
    "items consistent with everything are weak.",
    "Do NOT include a provenance field. It is tool-stamped; a claim that sets it is rejected.",
  ].join("\n");
}

export interface MatrixCell {
  readonly consistency: "consistent" | "inconsistent" | "unlinked";
  readonly evidenceId: string;
  readonly hypothesisId: string;
}

export interface AchDecision extends FusedOutput {
  readonly decision: {
    readonly consistentWithAll: readonly string[];
    readonly diagnosticEvidence: readonly string[];
    readonly hypotheses: readonly string[];
    readonly leastDisconfirmed: string | null;
    readonly matrix: readonly MatrixCell[];
    readonly pattern: "ach";
    readonly rejectedClaims: readonly { claimId: string; reason: string }[];
    readonly residualRisks: readonly { claimId: string; falsifier: string }[];
  };
}

function claimIdOf(claim: Record<string, unknown>): string {
  return String(claim["claim_id"] ?? "");
}

function dependenciesOf(claim: Record<string, unknown>): readonly string[] {
  const deps = claim["dependencies"];
  return Array.isArray(deps) ? deps.map(String) : [];
}

/**
 * Mechanical ACH fusion. Matrix cell (hypothesis, evidence) is consistent
 * or inconsistent when the evidence links the hypothesis via dependencies
 * with novelty confirms/contradicts AND the hypothesis cites the evidence
 * back; otherwise unlinked. ACH strictness at the pattern stage: a
 * hypothesis with no evidence dependencies and an evidence claim with no
 * hypothesis links are rejected with reasons (the check is on empty
 * dependency arrays, not on whether the links resolve). Evidence is consistent-
 * with-all when it confirms every hypothesis (>= 2 required); it is
 * diagnostic when it bears on a proper subset of hypotheses - either
 * confirming a subset (supports them over the rest) or contradicting
 * one (eliminates it). Evidence that contradicts every hypothesis
 * equally discriminates nothing and lands in neither list. The
 * least-disconfirmed hypothesis has the fewest inconsistent cells
 * (ties break toward more consistent cells, then first-seen order).
 */
export function achFuse(accepted: readonly AcceptedClaim[]): AchDecision {
  const hypotheses: { claim: Record<string, unknown>; workerId: string }[] = [];
  const evidence: { claim: Record<string, unknown>; workerId: string }[] = [];
  const rejectedClaims: { claimId: string; reason: string }[] = [];
  for (const entry of accepted) {
    if (entry.claim["kind"] === "hypothesis") {
      if (dependenciesOf(entry.claim).length === 0) {
        rejectedClaims.push({
          claimId: claimIdOf(entry.claim),
          reason: "ach requires hypotheses to cite their evidence dependencies",
        });
        continue;
      }
      hypotheses.push({ claim: entry.claim, workerId: entry.workerId });
    } else if (entry.claim["kind"] === "evidence") {
      if (dependenciesOf(entry.claim).length === 0) {
        rejectedClaims.push({
          claimId: claimIdOf(entry.claim),
          reason: "ach requires evidence to link at least one hypothesis",
        });
        continue;
      }
      evidence.push({ claim: entry.claim, workerId: entry.workerId });
    }
  }

  const hypothesisIds = hypotheses.map((h) => claimIdOf(h.claim));
  const matrix: MatrixCell[] = [];
  for (const hyp of hypotheses) {
    const hypId = claimIdOf(hyp.claim);
    const cites = new Set(dependenciesOf(hyp.claim));
    for (const ev of evidence) {
      const evId = claimIdOf(ev.claim);
      const links = dependenciesOf(ev.claim);
      const novelty = String(ev.claim["novelty"] ?? "");
      let consistency: MatrixCell["consistency"] = "unlinked";
      if (links.includes(hypId) && cites.has(evId)) {
        consistency = novelty === "contradicts" ? "inconsistent" : "consistent";
      }
      matrix.push({ consistency, evidenceId: evId, hypothesisId: hypId });
    }
  }

  const diagnosticEvidence: string[] = [];
  const consistentWithAll: string[] = [];
  for (const ev of evidence) {
    const evId = claimIdOf(ev.claim);
    const linked = dependenciesOf(ev.claim).filter((h) => hypothesisIds.includes(h));
    const novelty = String(ev.claim["novelty"] ?? "");
    if (hypothesisIds.length < 2 || linked.length === 0) {
      continue;
    }
    if (linked.length === hypothesisIds.length) {
      if (novelty !== "contradicts") {
        consistentWithAll.push(evId);
      }
    } else {
      diagnosticEvidence.push(evId);
    }
  }

  let leastDisconfirmed: string | null = null;
  let bestScore: { consistent: number; inconsistent: number } | null = null;
  for (const hyp of hypotheses) {
    const hypId = claimIdOf(hyp.claim);
    let consistent = 0;
    let inconsistent = 0;
    for (const cell of matrix) {
      if (cell.hypothesisId !== hypId) {
        continue;
      }
      if (cell.consistency === "consistent") {
        consistent += 1;
      } else if (cell.consistency === "inconsistent") {
        inconsistent += 1;
      }
    }
    if (
      bestScore === null ||
      inconsistent < bestScore.inconsistent ||
      (inconsistent === bestScore.inconsistent && consistent > bestScore.consistent)
    ) {
      bestScore = { consistent, inconsistent };
      leastDisconfirmed = hypId;
    }
  }

  const residualRisks = leastDisconfirmed
    ? hypotheses
        .filter((h) => claimIdOf(h.claim) === leastDisconfirmed)
        .map((h) => ({
          claimId: claimIdOf(h.claim),
          falsifier: String(h.claim["falsifier"] ?? ""),
        }))
    : [];

  return {
    decision: {
      consistentWithAll,
      diagnosticEvidence,
      hypotheses: hypothesisIds,
      leastDisconfirmed,
      matrix,
      pattern: "ach",
      rejectedClaims,
      residualRisks,
    },
    fusion: {
      diagnostic: diagnosticEvidence.length,
      evidence: evidence.length,
      hypotheses: hypotheses.length,
      matrixCells: matrix.length,
    },
  };
}
