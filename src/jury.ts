import type { AcceptedClaim, FusedOutput, RunReport } from "./engine";
import type { PatternDefinition, PatternOptions } from "./pattern";
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

function positiveInt(value: string, min: number, name: string): number | string {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    return `--${name} must be an integer >= ${min}`;
  }
  return n;
}

export const juryDefinition: PatternDefinition = {
  build(options: PatternOptions) {
    const task = String(options["task"] ?? "");
    if (task.trim().length === 0) {
      return { error: "--task must be non-empty" };
    }
    const workers = positiveInt(
      String(options["workers"] ?? JURY_DEFAULT_WORKERS),
      JURY_MIN_WORKERS,
      "workers",
    );
    if (typeof workers === "string") {
      return { error: workers };
    }
    const timeout = Number(options["timeout"] ?? 180);
    if (!(timeout > 0)) {
      return { error: "--timeout must be positive seconds" };
    }
    const harness = String(options["harness"] ?? "pi");
    const model = options["model"] === undefined ? undefined : String(options["model"]);
    return {
      fuse: juryFuse,
      stoppingRule: "every worker submits one answer claim or times out",
      task,
      workers: Array.from({ length: workers }, (_, index) => ({
        harness,
        ...(model !== undefined ? { model } : {}),
        prompt: juryWorkerPrompt(task),
        timeoutSec: timeout,
        workerId: `w${index + 1}`,
      })),
    };
  },
  command: "jury",
  description:
    "Sealed Jury pattern run: N sealed workers answer the task as claims; equivalent answers " +
    "are normalized; plurality fusion decides mechanically. Writes .fusion/runs/<runId>/. " +
    "Exits 0 clean, 1 run failure, 2 invalid invocation.",
  options: [
    {
      default: String(JURY_DEFAULT_WORKERS),
      description: "number of sealed workers",
      name: "workers",
    },
    { default: "pi", description: "harness for every worker (hcn name)", name: "harness" },
    { description: "model id passed to every worker", name: "model" },
    { default: "180", description: "per-worker wall-clock budget in seconds", name: "timeout" },
    { description: "the question every sealed juror answers", name: "task", required: true },
  ],
  summarize(decision, report: RunReport): readonly string[] {
    const lines = [
      `run      ${report.runId} (${report.runDir})`,
      `decision ${String(decision["decision"] ?? "(none)")}`,
    ];
    const independence = decision["independence"] as
      | { acceptedAnswers: number; duplicateRate: number; groups: number }
      | undefined;
    if (independence !== undefined) {
      lines.push(
        `votes    ${independence.acceptedAnswers} answers, ${independence.groups} groups, duplicate rate ${independence.duplicateRate.toFixed(2)}`,
      );
    }
    const failures = decision["failures"] as { class: string; workerId: string }[] | undefined;
    if ((failures?.length ?? 0) > 0) {
      lines.push(`failures ${JSON.stringify(failures)}`);
    }
    for (const risk of (decision["residualRisks"] ?? []) as {
      claimId: string;
      confidence: number;
      falsifier: string;
    }[]) {
      lines.push(`risk     ${risk.claimId} (conf ${risk.confidence}): ${risk.falsifier}`);
    }
    return lines;
  },
};
