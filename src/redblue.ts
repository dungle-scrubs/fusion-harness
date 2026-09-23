import type { AcceptedClaim, FusedOutput, StageInput } from "./engine";
import type { WorkerConfig } from "./run";

export interface RedBlueOptions {
  readonly burden: string;
  readonly harness: string;
  readonly model?: string;
  readonly task: string;
  readonly timeoutSec: number;
}

export function claimantPrompt(task: string): string {
  return [
    "You are the claimant in a red-blue adversarial review.",
    `TASK: ${task}`,
    "",
    "File 1-4 atomic claims that together answer the task.",
    "Each claim: one JSON object with claim_id (C1, C2, ...), kind",
    "(answer|evidence|finding|hypothesis), claim (one sentence), status",
    '("observed"|"documented"|"inferred"|"unknown"), confidence [0,1],',
    "falsifier.",
    "If a claim can be checked by running a command, put the exact command",
    "in its falsifier or in an evidence source_or_test field, in backticks.",
    "Do NOT include a provenance field. It is tool-stamped; a claim that sets it is rejected.",
    "Reply with one JSON object per claim, nothing else.",
  ].join("\n");
}

function claimsBlock(claims: readonly Record<string, unknown>[]): string {
  return claims.map((c) => JSON.stringify(c)).join("\n");
}

export function opponentPrompt(input: StageInput): string {
  return [
    "You are the opponent in a red-blue adversarial review.",
    "Challenge the claimant's claims on admissibility, relevance, credibility,",
    "or inference. Free-form critique is not accepted: every challenge must be",
    "an objection claim.",
    "",
    "CLAIMANT CLAIMS (one JSON per line):",
    claimsBlock(input.anonymizedClaims),
    "",
    "File 0-4 objections. Each objection: one JSON object with claim_id (C1, ...),",
    'kind: "objection", claim (the objection, one sentence), status',
    '("observed"|"documented"|"inferred"|"unknown"), confidence [0,1],',
    "falsifier, and dependencies: the claim_id(s) you target.",
    "Do NOT include a provenance field.",
    "Reply with one JSON object per objection, nothing else.",
  ].join("\n");
}

export function umpirePrompt(input: StageInput): string {
  return [
    "You are the umpire in a red-blue adversarial review.",
    "Resolve source facts for each objection against the claim it targets.",
    "Where a claim or objection names an executable check in backticks, run that",
    'command, and report the result as an evidence claim with status "observed"',
    "and the command as source_or_test.",
    "",
    "RECORD SO FAR (one JSON per line):",
    claimsBlock(input.anonymizedClaims),
    "",
    "File one ruling per objection: one JSON object with claim_id (C1, ...),",
    'kind: "evidence", claim (what the check or source shows), status',
    '("observed"|"documented"|"inferred"|"unknown"), confidence,',
    "falsifier, dependencies: [the objection's claim_id], and requested_action:",
    '  "accept" = objection sustained (target claim falls),',
    '  "revise" = objection overruled (target claim survives),',
    '  "test"   = check inconclusive.',
    "Do NOT include a provenance field.",
    "Reply with one JSON object per ruling, nothing else.",
  ].join("\n");
}

export function judgePrompt(burden: string, input: StageInput): string {
  return [
    "You are the judge in a red-blue adversarial review.",
    "You see the anonymized record: claims, objections, and umpire rulings.",
    "Worker identity and model are hidden from you; judge the record only.",
    `BURDEN: ${burden}`,
    "",
    "RECORD (one JSON per line):",
    claimsBlock(input.anonymizedClaims),
    "",
    "Score the SURVIVING claims against the burden and reply with EXACTLY ONE",
    'JSON object: claim_id "C1", kind "answer", claim (the ruling, one to three',
    "sentences naming what survives and what does not), status",
    '("observed"|"documented"|"inferred"|"unknown"), confidence [0,1],',
    "falsifier, requested_action: accept | revise | escalate | abstain",
    "(accept = the surviving record meets the burden).",
    "Do NOT include a provenance field.",
  ].join("\n");
}

export function redblueWorkers(
  options: RedBlueOptions,
  input: StageInput,
  phase: "challenge" | "verify",
): readonly WorkerConfig[] {
  const base = {
    harness: options.harness,
    ...(options.model !== undefined ? { model: options.model } : {}),
    timeoutSec: options.timeoutSec,
  };
  if (phase === "challenge") {
    return [{ ...base, prompt: opponentPrompt(input), workerId: "w-blue" }];
  }
  return [
    { ...base, prompt: umpirePrompt(input), workerId: "w-umpire" },
    { ...base, prompt: judgePrompt(options.burden, input), workerId: "w-judge" },
  ];
}

export interface RulingOutcome {
  readonly objectionId: string;
  readonly ruling: "overruled" | "sustained" | "unresolved";
  readonly targetId: string | null;
}

function claimIdOf(claim: Record<string, unknown>): string {
  return String(claim["claim_id"] ?? "");
}

function dependenciesOf(claim: Record<string, unknown>): readonly string[] {
  const deps = claim["dependencies"];
  return Array.isArray(deps) ? deps.map(String) : [];
}

/**
 * Mechanical red-blue resolution. Objections (challenge stage, kind=objection)
 * target claim_ids; rulings (verify stage, evidence claims) resolve them via
 * requested_action (accept=sustained, revise=overruled, test=unresolved).
 * The judge's answer claim becomes the ruling. No model in the loop.
 */
export function redblueFuse(accepted: readonly AcceptedClaim[]): FusedOutput {
  const base = accepted.filter((a) => a.stage === "generate");
  const objections = accepted.filter(
    (a) => a.stage === "challenge" && a.claim["kind"] === "objection",
  );
  const verifyClaims = accepted.filter((a) => a.stage === "verify");
  const rulings = verifyClaims.filter(
    (a) => a.claim["kind"] === "evidence" && a.claim["requested_action"] !== undefined,
  );
  const judge = verifyClaims.find(
    (a) => a.claim["kind"] === "answer" && a.claim["requested_action"] !== undefined,
  );

  const rulingsByObjection = new Map<string, RulingOutcome>();
  for (const objection of objections) {
    const objectionId = claimIdOf(objection.claim);
    const deps = dependenciesOf(objection.claim);
    const targetId = deps[0] ?? null;
    const rulingClaim = rulings.find((r) => dependenciesOf(r.claim).includes(objectionId));
    let ruling: RulingOutcome["ruling"] = "unresolved";
    if (rulingClaim !== undefined) {
      const action = String(rulingClaim.claim["requested_action"]);
      if (action === "accept") {
        ruling = "sustained";
      } else if (action === "revise") {
        ruling = "overruled";
      }
    }
    rulingsByObjection.set(objectionId, { objectionId, ruling, targetId });
  }

  const sustainedTargets = new Set<string>();
  const rejectedClaims: { claimId: string; reason: string }[] = [];
  for (const outcome of rulingsByObjection.values()) {
    if (outcome.ruling === "sustained" && outcome.targetId !== null) {
      sustainedTargets.add(outcome.targetId);
      const target = base.find((b) => claimIdOf(b.claim) === outcome.targetId);
      if (target !== undefined) {
        rejectedClaims.push({
          claimId: outcome.targetId,
          reason: `objection ${outcome.objectionId} sustained`,
        });
      }
    }
    if (outcome.ruling === "unresolved") {
      rejectedClaims.push({
        claimId: outcome.objectionId,
        reason: "objection unresolved: check inconclusive or no ruling",
      });
    }
  }

  const surviving = base.filter((b) => !sustainedTargets.has(claimIdOf(b.claim)));
  const unresolvedObjections = [...rulingsByObjection.values()].filter(
    (o) => o.ruling === "unresolved",
  );

  return {
    decision: {
      decision: judge ? String(judge.claim["claim"]) : null,
      judgeVerdict: judge ? String(judge.claim["requested_action"]) : null,
      pattern: "red-blue",
      rejectedClaims,
      residualRisks: unresolvedObjections.map((o) => ({
        objectionId: o.objectionId,
        targetId: o.targetId,
      })),
      survivingClaims: surviving.map((s) => claimIdOf(s.claim)),
    },
    fusion: {
      objections: objections.length,
      rulings: [...rulingsByObjection.values()],
      surviving: surviving.length,
    },
  };
}
