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

Tier 2 (pattern runs - the tool owns the run; coming in later tickets):
  fusion jury | red-blue | ach   Sealed parallel generation, adversarial
    challenge, and blind adjudication. Callers invoke a pattern with
    parameters; pattern definitions are tool-side config.

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
