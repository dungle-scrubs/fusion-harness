import type { AcceptedClaim, FusedOutput, RunReport, StageInput } from "./engine";
import type { PatternDefinition, PatternOptions } from "./pattern";
import { canonicalize } from "./tier1";

export const DELPHI_MIN_WORKERS = 2;
export const DELPHI_DEFAULT_WORKERS = 3;

export function delphiRound1Prompt(task: string): string {
  return [
    "You are one member of a Delphi panel, round 1.",
    "You cannot see the other members. Answer independently.",
    `TASK: ${task}`,
    "",
    "Reply with EXACTLY ONE JSON object and nothing else, with these fields:",
    '- claim_id: "C1"',
    '- kind: "answer"',
    "- claim: your answer, one self-contained sentence",
    '- status ("observed"|"documented"|"inferred"|"unknown"), confidence [0,1],',
    "  falsifier (what result would change this answer)",
    "- requested_action (optional): accept | test | revise | escalate | abstain",
    "",
    "Do NOT include a provenance field. It is tool-stamped; a claim that sets it is rejected.",
  ].join("\n");
}

function claimsBlock(claims: readonly Record<string, unknown>[]): string {
  return claims.map((c) => JSON.stringify(c)).join("\n");
}

export function delphiRound2Prompt(
  task: string,
  own: readonly Record<string, unknown>[],
  panel: readonly Record<string, unknown>[],
): string {
  return [
    "You are one member of a Delphi panel, round 2 (final).",
    `TASK: ${task}`,
    "",
    "YOUR ROUND-1 ANSWER:",
    claimsBlock(own),
    "",
    "Revise your own answer in light of the anonymized panel answers shown in",
    "the record below. Keep your position if the panel gives you no reason to",
    "change it; change it only on stated evidence or reasoning.",
    "",
    "Reply with EXACTLY ONE JSON object and nothing else, with these fields:",
    '- claim_id: "C1", kind: "answer"',
    "- claim: your round-2 answer, one self-contained sentence",
    '- status ("observed"|"documented"|"inferred"|"unknown"), confidence [0,1], falsifier',
    '- novelty: "confirms" if you kept your round-1 position,',
    '  "new" if you revised it (your reason goes in the claim text)',
    "- requested_action (optional): accept | test | revise | escalate | abstain",
    "",
    "Do NOT include a provenance field.",
    "",
    "PANEL RECORD (anonymized, one JSON per line):",
    claimsBlock(panel),
  ].join("\n");
}

export interface DelphiStats {
  readonly convergenceRate: number;
  readonly round1: { readonly answers: number; readonly groups: number };
  readonly round2: { readonly answers: number; readonly groups: number };
  readonly stabilityRate: number;
}

/**
 * Mechanical Delphi fusion. Round 1 = generate-stage answers, round 2 =
 * challenge-stage revisions. Groups come from tier-1 canonicalization.
 * Convergence: duplicate rate within round 2 (did the panel converge on
 * wording-level groups?). Stability: fraction of round-2 answers whose
 * canonical form equals the same worker's round-1 canonical form. The
 * decision is the round-2 plurality winner, first-seen tiebreak, with
 * jury-style minority report and residual risks.
 */
export function delphiFuse(accepted: readonly AcceptedClaim[]): FusedOutput & {
  decision: Record<string, unknown>;
} {
  const round1 = accepted.filter((a) => a.stage === "generate" && a.claim["kind"] === "answer");
  const round2 = accepted.filter((a) => a.stage === "challenge" && a.claim["kind"] === "answer");
  const rejectedOptions = accepted
    .filter((a) => a.claim["kind"] !== "answer")
    .map((a) => ({
      claimId: String(a.claim["claim_id"] ?? "unknown"),
      reason: `delphi requires kind=answer, got ${String(a.claim["kind"] ?? "none")}`,
    }));

  type Group = { canonical: string; members: AcceptedClaim[] };
  const groupsOf = (entries: readonly AcceptedClaim[]): Map<string, Group> => {
    const groups = new Map<string, Group>();
    for (const entry of entries) {
      const canonical = canonicalize(String(entry.claim["claim"] ?? ""));
      const existing = groups.get(canonical);
      if (existing === undefined) {
        groups.set(canonical, { canonical, members: [entry] });
      } else {
        existing.members.push(entry);
      }
    }
    return groups;
  };

  const round1Groups = groupsOf(round1);
  const round2Groups = groupsOf(round2);

  const round1CanonicalByWorker = new Map<string, string>();
  for (const entry of round1) {
    round1CanonicalByWorker.set(entry.workerId, canonicalize(String(entry.claim["claim"] ?? "")));
  }
  const stableCount = round2.filter((entry) => {
    const origin = round1CanonicalByWorker.get(entry.workerId.replace(/-r2$/, ""));
    return origin !== undefined && origin === canonicalize(String(entry.claim["claim"] ?? ""));
  }).length;

  const stabilityRate = round2.length === 0 ? 0 : stableCount / round2.length;
  const convergenceRate = round2.length === 0 ? 0 : 1 - round2Groups.size / round2.length;

  let winner: Group | null = null;
  for (const group of round2Groups.values()) {
    if (winner === null || group.members.length > winner.members.length) {
      winner = group;
    }
  }
  const minority = [...round2Groups.values()].filter((g) => g !== winner);

  const residualRisks = minority.flatMap((group) =>
    group.members
      .filter(
        (m) =>
          Number(m.claim["confidence"] ?? 0) >= 0.6 ||
          m.claim["requested_action"] === "escalate" ||
          m.claim["requested_action"] === "revise",
      )
      .map((m) => ({
        claimId: String(m.claim["claim_id"] ?? ""),
        confidence: Number(m.claim["confidence"] ?? 0),
        falsifier: String(m.claim["falsifier"] ?? ""),
      })),
  );

  const stats: DelphiStats = {
    convergenceRate,
    round1: { answers: round1.length, groups: round1Groups.size },
    round2: { answers: round2.length, groups: round2Groups.size },
    stabilityRate,
  };

  return {
    decision: {
      decision: winner?.canonical ?? null,
      delphi: stats,
      minorityReport: minority.map((g) => ({
        canonical: g.canonical,
        members: g.members.map((m) => ({
          claimId: String(m.claim["claim_id"] ?? ""),
          confidence: Number(m.claim["confidence"] ?? 0),
          novelty: m.claim["novelty"] ?? null,
          workerId: m.workerId,
        })),
        votes: g.members.length,
      })),
      pattern: "delphi",
      rejectedOptions,
      residualRisks,
    },
    fusion: {
      convergenceRate,
      round1Groups: round1Groups.size,
      round2Groups: round2Groups.size,
      stabilityRate,
    },
  };
}

export const delphiDefinition: PatternDefinition = {
  build(options: PatternOptions) {
    const task = String(options["task"] ?? "");
    if (task.trim().length === 0) {
      return { error: "--task must be non-empty" };
    }
    const workers = Number(options["workers"] ?? DELPHI_DEFAULT_WORKERS);
    if (!Number.isInteger(workers) || workers < DELPHI_MIN_WORKERS) {
      return { error: `--workers must be an integer >= ${DELPHI_MIN_WORKERS}` };
    }
    const timeout = Number(options["timeout"] ?? 300);
    if (!(timeout > 0)) {
      return { error: "--timeout must be positive seconds" };
    }
    const harness = String(options["harness"] ?? "pi");
    const model = options["model"] === undefined ? undefined : String(options["model"]);
    const base = {
      harness,
      ...(model !== undefined ? { model } : {}),
      timeoutSec: timeout,
    };
    return {
      fuse: delphiFuse,
      stages: {
        challenge: (input: StageInput) =>
          Array.from({ length: workers }, (_, index) => ({
            ...base,
            prompt: delphiRound2Prompt(
              task,
              input.byWorker.get(`w${index + 1}`) ?? [],
              input.anonymizedClaims,
            ),
            workerId: `w${index + 1}-r2`,
          })),
      },
      stoppingRule: "every worker answers round 1 and revises in round 2, or times out",
      task,
      workers: Array.from({ length: workers }, (_, index) => ({
        ...base,
        prompt: delphiRound1Prompt(task),
        workerId: `w${index + 1}`,
      })),
    };
  },
  command: "delphi",
  description:
    "Delphi pattern run: sealed panel answers, then a revision round that sees " +
    "the anonymized panel record and its own round-1 answer; the tool reports " +
    "convergence vs stability mechanically. Writes .fusion/runs/<runId>/. " +
    "Exits 0 clean, 1 run failure, 2 invalid invocation.",
  options: [
    { default: String(DELPHI_DEFAULT_WORKERS), description: "panel size", name: "workers" },
    { default: "pi", description: "harness for every worker (hcn name)", name: "harness" },
    { description: "model id passed to every worker", name: "model" },
    {
      default: "300",
      description: "per-worker wall-clock budget in seconds, per round",
      name: "timeout",
    },
    { description: "the question the panel answers", name: "task", required: true },
  ],
  summarize(decision, report: RunReport): readonly string[] {
    const stats = decision["delphi"] as DelphiStats | undefined;
    const lines = [
      `run      ${report.runId} (${report.runDir})`,
      `decision ${String(decision["decision"] ?? "(none)")}`,
    ];
    if (stats !== undefined) {
      lines.push(
        `rounds   r1 ${stats.round1.answers} answers / ${stats.round1.groups} groups -> r2 ${stats.round2.answers} / ${stats.round2.groups}`,
      );
      lines.push(
        `signal   convergence ${stats.convergenceRate.toFixed(2)}, stability ${stats.stabilityRate.toFixed(2)}`,
      );
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
