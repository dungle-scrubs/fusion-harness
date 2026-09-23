import type { AcceptedClaim, FusedOutput } from "./engine";
import { canonicalize } from "./tier1";

export const JURY_MIN_WORKERS = 2;
export const JURY_DEFAULT_WORKERS = 3;

export function juryWorkerPrompt(task: string): string {
  return [
    "You are one sealed juror in an independent jury.",
    "You cannot see other jurors. Do not discuss, hedge, or ask which answer is popular.",
    "Answer the task on your own evidence and judgment.",
    "",
    `TASK: ${task}`,
    "",
    "Reply with EXACTLY ONE JSON object and nothing else, with these fields:",
    '- claim_id: "C1"',
    '- kind: "answer"',
    "- claim: your answer, one self-contained sentence",
    '- status: "observed" | "documented" | "inferred" | "unknown"',
    "- confidence: number in [0,1]",
    "- falsifier: what result would change this answer",
    '- requested_action (optional): "accept" | "test" | "revise" | "escalate" | "abstain"',
    "",
    "Do NOT include a provenance field. It is tool-stamped; a claim that sets it is rejected.",
  ].join("\n");
}

export interface JuryMember {
  readonly claimId: string;
  readonly confidence: number;
  readonly falsifier: string;
  readonly requestedAction: string | null;
  readonly workerId: string;
}

export interface JuryGroup {
  readonly canonical: string;
  readonly members: readonly JuryMember[];
  readonly votes: number;
}

export interface JuryDecision extends FusedOutput {
  readonly decision: {
    readonly decision: string | null;
    readonly independence: {
      readonly acceptedAnswers: number;
      readonly duplicateRate: number;
      readonly groups: number;
    };
    readonly minorityReport: readonly JuryGroup[];
    readonly pattern: "jury";
    readonly rejectedOptions: readonly { claimId: string; reason: string }[];
    readonly residualRisks: readonly { claimId: string; confidence: number; falsifier: string }[];
  };
}

function isAnswerClaim(claim: Record<string, unknown>): boolean {
  return claim["kind"] === "answer";
}

function memberOf(claim: Record<string, unknown>, workerId: string): JuryMember {
  return {
    claimId: String(claim["claim_id"] ?? "unknown"),
    confidence: Number(claim["confidence"] ?? 0),
    falsifier: String(claim["falsifier"] ?? ""),
    requestedAction:
      typeof claim["requested_action"] === "string" ? claim["requested_action"] : null,
    workerId,
  };
}

/**
 * Mechanical jury fusion. Pattern strictness first (kind=answer only),
 * then canonical grouping, then plurality with first-seen tiebreak.
 * A minority claim becomes a residual risk when its own confidence is
 * >= 0.6 or its own requested_action is escalate/revise. Returns a
 * null decision when no answer survives.
 */
export function juryFuse(accepted: readonly AcceptedClaim[]): JuryDecision {
  const rejectedOptions: { claimId: string; reason: string }[] = [];
  const answers: { claim: Record<string, unknown>; workerId: string }[] = [];
  for (const entry of accepted) {
    if (!isAnswerClaim(entry.claim)) {
      rejectedOptions.push({
        claimId: String(entry.claim["claim_id"] ?? "unknown"),
        reason: `jury requires kind=answer, got ${String(entry.claim["kind"] ?? "none")}`,
      });
      continue;
    }
    answers.push({ claim: entry.claim, workerId: entry.workerId });
  }

  const groups = new Map<string, JuryMember[]>();
  const order: string[] = [];
  for (const entry of answers) {
    const canonical = canonicalize(String(entry.claim["claim"] ?? ""));
    const member = memberOf(entry.claim, entry.workerId);
    const existing = groups.get(canonical);
    if (existing === undefined) {
      groups.set(canonical, [member]);
      order.push(canonical);
    } else {
      groups.set(canonical, [...existing, member]);
    }
  }

  const juryGroups: JuryGroup[] = order.map((canonical) => ({
    canonical,
    members: groups.get(canonical) ?? [],
    votes: (groups.get(canonical) ?? []).length,
  }));

  let winner: JuryGroup | null = null;
  for (const group of juryGroups) {
    if (winner === null || group.votes > winner.votes) {
      winner = group;
    }
  }

  const minority = juryGroups.filter((group) => group !== winner);
  const residualRisks = minority.flatMap((group) =>
    group.members
      .filter(
        (m) =>
          m.confidence >= 0.6 || m.requestedAction === "escalate" || m.requestedAction === "revise",
      )
      .map((m) => ({ claimId: m.claimId, confidence: m.confidence, falsifier: m.falsifier })),
  );

  const duplicateRate = answers.length === 0 ? 0 : 1 - juryGroups.length / answers.length;

  return {
    decision: {
      decision: winner?.canonical ?? null,
      independence: {
        acceptedAnswers: answers.length,
        duplicateRate,
        groups: juryGroups.length,
      },
      minorityReport: minority,
      pattern: "jury",
      rejectedOptions,
      residualRisks,
    },
    fusion: {
      duplicateRate,
      groups: juryGroups.map((g) => ({ canonical: g.canonical, votes: g.votes })),
      method: "plurality",
      winner: winner?.canonical ?? null,
    },
  };
}
