/**
 * Tier 1 pure functions (RFC-01, ticket #11): normalize, aggregate, score.
 *
 * Deterministic, model-free, side-effect free. No semantic dedup, no
 * embeddings, no model calls anywhere in tier 1: normalization is
 * canonicalization plus exact-match dedup, and semantic clustering is
 * tier 2 work.
 */

/** Canonicalize claim text: NFC, whitespace, casing, number formats. */
export function canonicalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[   -   　]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(/(^|\s)(\d+)\.0+(?=\s|$)/g, "$1$2");
}

export interface NormalizableClaim {
  readonly claim: string;
  readonly claim_id: string;
}

export interface NormalGroup {
  /** Canonical representative: canonical form of the first member. */
  readonly canonical: string;
  /** Member claim ids, in first-seen order. */
  readonly members: readonly string[];
}

/**
 * Group claims by exact match on canonicalized text. Groups and members
 * both follow first-seen input order, so output is deterministic.
 */
export function normalizeClaims(claims: readonly NormalizableClaim[]): NormalGroup[] {
  const groups = new Map<string, string[]>();
  for (const item of claims) {
    const key = canonicalize(item.claim);
    const members = groups.get(key);
    if (members === undefined) {
      groups.set(key, [item.claim_id]);
    } else {
      members.push(item.claim_id);
    }
  }
  return [...groups.entries()].map(([canonical, members]) => ({ canonical, members }));
}

export interface WeightedVote {
  readonly confidence: number;
  readonly value: string;
}

export type AggregateMethod = "median" | "plurality" | "weighted";

export interface AggregateResult {
  readonly detail: Record<string, number | string>;
  readonly method: AggregateMethod;
  readonly value: number | string;
}

function medianOf(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] as number;
  }
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Aggregate sealed votes. Plurality picks the value with the most votes
 * (ties break by first-seen order, so output is deterministic). Median
 * operates on numeric values; weighted uses confidences as weights.
 * Throws on empty input or non-numeric median/weighted values.
 */
export function aggregate(
  method: AggregateMethod,
  votes: readonly WeightedVote[],
): AggregateResult {
  if (votes.length === 0) {
    throw new Error("aggregate requires at least one vote");
  }
  if (method === "plurality") {
    const counts = new Map<string, { count: number; order: number }>();
    votes.forEach((vote, index) => {
      const entry = counts.get(vote.value);
      if (entry === undefined) {
        counts.set(vote.value, { count: 1, order: index });
      } else {
        entry.count += 1;
      }
    });
    let winner = "";
    let best = -1;
    let bestOrder = votes.length;
    for (const [value, entry] of counts) {
      if (entry.count > best || (entry.count === best && entry.order < bestOrder)) {
        winner = value;
        best = entry.count;
        bestOrder = entry.order;
      }
    }
    return { detail: { votes: votes.length, winnerVotes: best }, method, value: winner };
  }
  const numeric = votes.map((vote) => {
    const n = Number(vote.value);
    if (vote.value.trim() === "" || !Number.isFinite(n)) {
      throw new Error(`aggregate ${method} requires finite numeric values, got "${vote.value}"`);
    }
    if (
      typeof vote.confidence !== "number" ||
      Number.isNaN(vote.confidence) ||
      vote.confidence < 0 ||
      vote.confidence > 1
    ) {
      throw new Error(`aggregate requires confidences in [0,1], got ${String(vote.confidence)}`);
    }
    return { confidence: vote.confidence, value: n };
  });
  if (method === "median") {
    const sorted = numeric.map((v) => v.value).sort((a, b) => a - b);
    return { detail: { votes: votes.length }, method, value: medianOf(sorted) };
  }
  let weightSum = 0;
  let weightedSum = 0;
  for (const vote of numeric) {
    weightSum += vote.confidence;
    weightedSum += vote.confidence * vote.value;
  }
  if (weightSum === 0) {
    throw new Error("aggregate weighted requires non-zero total confidence");
  }
  return { detail: { votes: votes.length, weightSum }, method, value: weightedSum / weightSum };
}

export interface ScoredOutcome {
  readonly confidence: number;
  readonly outcome: boolean;
}

export interface ScoreResult {
  readonly brier: number;
  readonly logScore: number;
  readonly n: number;
}

/**
 * Proper scoring rules over resolved outcomes (design doc G2 / seed
 * questions). Brier is mean squared error of forecast vs outcome; log
 * score is mean negative log-likelihood of the outcome (clamped to
 * [1e-9, 1 - 1e-9] so a 0/1 forecast scores finitely). Lower is better
 * for both. Throws on empty input or out-of-range confidences.
 */
export function scoreForecasts(outcomes: readonly ScoredOutcome[]): ScoreResult {
  if (outcomes.length === 0) {
    throw new Error("score requires at least one resolved outcome");
  }
  let brierSum = 0;
  let logSum = 0;
  for (const item of outcomes) {
    if (
      typeof item.confidence !== "number" ||
      Number.isNaN(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      throw new Error(`score requires confidences in [0,1], got ${String(item.confidence)}`);
    }
    if (typeof item.outcome !== "boolean") {
      throw new Error(`score requires boolean outcomes, got ${String(item.outcome)}`);
    }
    const actual = item.outcome ? 1 : 0;
    brierSum += (item.confidence - actual) ** 2;
    const clamped = Math.min(Math.max(item.confidence, 1e-9), 1 - 1e-9);
    logSum += -(item.outcome ? Math.log(clamped) : Math.log(1 - clamped));
  }
  return {
    brier: brierSum / outcomes.length,
    logScore: logSum / outcomes.length,
    n: outcomes.length,
  };
}
