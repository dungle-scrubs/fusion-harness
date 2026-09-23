/**
 * Caller instructions for the fusion CLI. The binary is the single source
 * of truth (RFC-01: `fusion skill`): the enum vocabulary below is derived
 * from the validator's own exports, so the text and the behavior cannot
 * disagree about the schema.
 */
import { CLAIM_KINDS, CLAIM_STATUSES, NOVELTIES, REQUESTED_ACTIONS } from "./claim";

const join = (values: readonly string[]): string => [...values].sort().join("|");

export const SKILL_TEXT = `fusion - a composable fusion layer over agent harnesses.

fusion is NOT a harness. A harness owns an agent's loop (context, tools,
permissions). fusion composes runs of harnesses. All agent execution goes
through \`hcn run\`.

Tier 1 (model-free, deterministic, pipe freely - JSON in, JSON out):
  fusion validate [--json] <claims.jsonl>  Validate a JSONL stream of claims
    against the claim schema. Per-claim accept/reject verdicts with the
    validator's errors. Exit 0 when every claim is valid, 1 otherwise.
    --json: emit machine-readable verdict objects, one per line.
  fusion normalize [file]  Group claims by exact match on canonicalized
    text (Unicode NFC, whitespace, casing, number formats). Reads a JSON
    array of {claim_id, claim} from FILE or stdin; prints groups with
    member claim_ids. Near-misses stay separate: no semantic dedup here.
  fusion aggregate [file]  Fuse sealed votes mechanically - plurality,
    median, or confidence-weighted mean. Reads {method, votes:
    [{value, confidence}]} from FILE or stdin. Bit-for-bit reproducible.
  fusion score [file]  Proper scoring rules (Brier, log) over resolved
    outcomes. Reads [{confidence, outcome}] from FILE or stdin. Lower
    is better for both. Score seed questions with known answers to
    calibrate before trusting confidences.

Composition recipes:
  validate | normalize  Check claims, then group equivalent answers to
    see the duplicate rate before voting.
  normalize | aggregate  Canonicalize sealed answers, then take the
    mechanical vote/median. No model in the loop.

Tier 2 (pattern runs - the tool owns the run):
  fusion jury --task <t> [--workers N] [--harness pi] [--model <m>]
    Sealed parallel generation: every worker answers the task as one
    claim (kind=answer), unseen by the others; equivalent answers are
    normalized; plurality fusion decides mechanically. The decision
    record carries the winning answer, minority report, rejected
    options, residual risks, and an independence signal (answers,
    groups, duplicate rate) - read it before trusting consensus.
    Workers are separate processes with no shared transcript. A worker
    that asks a genuine blocking question emits a question event with
    the run id; other workers continue.
  fusion red-blue --task <t> --burden <b> [--harness] [--timeout]
    Adversarial pattern: a claimant files atomic claims (named executable
    checks go in falsifier/evidence backticks); an opponent must challenge
    with objection claims - free-form critique is rejected at the schema;
    an umpire resolves each objection (running named checks, reporting
    observed evidence; accept=sustained, revise=overruled); a judge
    blind to worker identity scores the surviving record against the
    burden. Budgets are symmetric across roles. The decision names each
    surviving claim, each rejected claim with its ruling, and unresolved
    objections as residual risks.
  fusion ach --task <t> [--workers N] [--harness] [--timeout]
    Analysis of Competing Hypotheses: sealed analysts submit hypotheses
    and evidence as linked claims (evidence links hypotheses via
    dependencies + novelty: confirms = consistent, contradicts =
    inconsistent; hypotheses cite their evidence back). The tool builds
    the hypotheses-x-evidence matrix mechanically, marks evidence that
    discriminates between hypotheses vs evidence consistent with all of
    them, and reports the least-disconfirmed hypothesis with its
    falsifier as the sensitivity check. Hypotheses without evidence
    links are rejected at the pattern stage.
  What a pattern run guarantees: the registration (run.json) is frozen
    before generation; workers are separate hcn processes with no shared
    transcript; every worker output is schema-validated at the boundary;
    provenance (run/worker/harness/model/session) is stamped by the tool:
    the session id comes from the hcn identity event, harness and model
    from the tool's launch record. Workers cannot set any provenance
    field; a failed worker does not fail the run while survivors remain
    and is named in the decision record; every run
    writes .fusion/runs/<runId>/ (run.json, events.ndjson, decision.json)
    replayable from the event stream.

Claim schema (one flat schema for all patterns):
  Required: claim_id (C-number, e.g. C1), kind
    (${join(CLAIM_KINDS)}), claim (non-empty),
    status (${join(CLAIM_STATUSES)}), confidence (number
    in [0,1]), falsifier (non-empty - what result would change this claim).
  Optional: evidence[] (source_or_test + supports), assumptions[],
    dependencies[] (C-number refs), novelty
    (${join(NOVELTIES)}), requested_action
    (${join(REQUESTED_ACTIONS)}).
  Unknown fields are rejected, not ignored. \`provenance\` is the ONLY
  tool-stamped block (runId, workerId, harness, model, sessionId,
  stampedAt): the validator rejects any claim where the agent set it.

Rules that bind every caller:
  - Never call the tool a harness. That word means loop-owners
    (claude, codex, pi, muse, cursor, antigravity).
  - Justfiles parameterize pattern invocations; they never define patterns.
  - Privacy: work that puts secret material into model context runs on
    local models only. Routing secret material to a hosted model through
    fusion is a caller error.
`;
