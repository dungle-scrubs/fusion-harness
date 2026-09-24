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

Choosing a method - match the problem shape, not the habit:
  - One bounded question, and one model's answer is not trusted on its
    own (anchoring, herding, prior bias) -> jury. Sealed workers answer
    independently; mechanical plurality fuses. Do NOT use jury for open
    generation (there is no comparable answer to vote on) or when you
    already hold sealed judgments - pipe normalize | aggregate instead.
  - A ship/block decision on one artifact, where one dissenter with
    evidence must be able to stop it -> gonogo. Independent reviewers
    return GO, GO WITH CONSTRAINT, or NO-GO; the veto rule is mechanical:
    any NO-GO blocks, no outvoting. Do NOT use it when you want the
    majority view on an open question -> jury; or when claims must
    survive adversarial attack -> red-blue.
  - An open-ended problem with many possible answers, and you need a
    ranked few -> shortlist. Sealed proposers generate options; blind
    judges score every option against a rubric you state; the tool
    tallies mechanically. Do NOT use it when the answer space is bounded
    enough to vote on -> jury; or when one option must survive adversarial
    attack -> red-blue.
  - A bounded question where independent answers help AND one round of
    peer exposure should improve them (estimation, forecast-style panels)
    -> delphi. Sealed round 1, anonymized revision round 2, mechanical
    convergence vs stability signals. Do NOT use it when anchoring is the
    main risk and any exposure would herd the panel -> jury instead; and
    not with more than one revision round in mind.
  - A claim set whose failure costs more than challenging it, and you
    can state the standard up front -> red-blue. It buys objection-only
    challenge, fact resolution with executable checks, and a judge blind
    to identity scoring against your burden. Do NOT use it when nobody
    can state the burden - the judge cannot score an unstated standard.
  - An observed outcome with several plausible causes -> ach. It forces
    every hypothesis against every evidence item and shows which
    evidence discriminates. Do NOT use it to choose between proposals -
    ach explains, it does not rank options.
  - You already hold claims or sealed votes and only want mechanical
    work (schema checks, dedup, vote/median, calibration scoring) ->
    tier 1 directly. A pattern run adds isolation you do not need.
  - One deep pass by one model is enough -> do not call fusion at all;
    run that harness. fusion spends N workers to buy independence - pay
    it only when independence is the missing ingredient.
  - Secret material in the task or claims -> local models only (see the
    privacy rule below); never route it to a hosted model through fusion.

Tier 1 (model-free, deterministic, pipe freely - JSON in, JSON out):
  fusion validate [--json] <claims.jsonl>  Validate a JSONL stream of claims
    against the claim schema. Per-claim accept/reject verdicts; rejected
    claims are E201 lines. Exit 0 all valid, 2 any rejected.
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
  fusion jury --task <t> [--workers N] [--harness pi] [--model <m>] [--vocabulary a,b] [--roster h[:m]] [--merge]
    Sealed parallel generation: every worker answers the task as one
    claim (kind=answer), unseen by the others; equivalent answers are
    normalized; plurality fusion decides mechanically. With --vocabulary,
    workers answer with exactly one member verbatim and off-vocabulary
    answers are rejected with a reason after one E001 retry. With --merge,
    a blind merge worker clusters paraphrased answers by meaning and the
    tally runs over clusters; the record carries pre-merge groups and the
    mapping, and a failed merge falls back to the unmerged tally.
    The decision
    record carries the winning answer, minority report, rejected
    options, residual risks, the vocabulary when set, and an independence
    signal (answers, groups, duplicate rate) plus roster diversity
    (distinct harnesses, models) - read both before trusting consensus.
    Workers are separate processes with no shared transcript. A worker
    that asks a genuine blocking question emits a question event with
    the run id; other workers continue. With --wait, the run suspends
    instead (E303) and 'fusion resume --run <id> --worker <w> --answer
    <text>' answers one question and continues; --abort fails it.
    --wait-sec sets the hold deadline.
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
  fusion gonogo --task <t> [--reviewers N]
    Ship/block gate: each reviewer returns a position (accept=GO,
    test=GO WITH CONSTRAINT, escalate=NO-GO with the blocking concern,
    abstain=NO-GO unverifiable). One NO-GO blocks - mechanically, with no
    outvoting. The record carries every position and each block's
    falsifier (what would clear it).
  fusion shortlist --task <t> --rubric <r> [--generators N] [--judges M]
    Open generation, blind judging: proposers submit options sealed;
    judges score every option against the rubric (accept | revise |
    abstain | escalate); an option advances only on a strict majority of
    accepts. Duplicate options merge mechanically; unscored options are
    flagged, never silently dropped.
  fusion delphi --task <t> [--workers N] [--harness] [--timeout] [--vocabulary a,b]
    Sealed panel, two rounds: round 1 answers independently; round 2
    revises seeing its own answer plus the anonymized panel record.
    With --vocabulary, round 1 answers from the set and round-2 revisions
    must stay inside it. The decision record reports convergence (did
    groups collapse?) and stability (did workers hold position?)
    mechanically - read both before trusting the round-2 winner.
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

Error handling and exit contract (ADR-0002):
  Every command emits {ok, run, step, errors[]} (machine-shaped with
  --json; without, human output plus E-code error lines) and exits by
  class: 0 ok, 1 usage, 2 validation/gate, 3 nothing takeable,
  4 internal. E-codes name class and field, e.g.
  E201: claims: C3.confidence: Invalid input. Crashes surface as E499
  envelopes (exit 4), never as usage errors. Worker spawn failures are
  typed outcomes in the run record - never error paths. Every invocation
  appends start/end lines to .fusion/commands.jsonl; a start with no end
  is a hung or killed invocation.

What counts as a bug - file only these, nothing else:
  - E4xx or E499, a stack trace, or an exit code contradicting the
    envelope: capture the command line, the envelope, the last 20 lines
    of .fusion/commands.jsonl, and matching run artifacts; search the
    repo's open issues for the E-code plus the first error line first -
    a hit means add your evidence as a comment, not a new issue; then
    file with gh issue create --label auto.
  - E1xx (your invocation), E2xx (a gate doing its job), E3xx (nothing
    takeable) are NOT bugs: fix the invocation or the input. Fix
    guidance: E101/E106 argument errors - re-read the command help;
    E103/E104 unreadable or malformed input - fix the input; E201 claim
    schema rejections - the error line names the field; E202/E203
    unfusable input - check method/enum and non-empty input; E301 a
    pattern run lost all workers - check the failed worker classes in
    the run's events.ndjson and rerun; E302 nothing on input. Repeat
    --roster per worker for mixed rosters; secret material routes to
    local-only harnesses in every slot.

Rules that bind every caller:
  - Never call the tool a harness. That word means loop-owners
    (claude, codex, pi, muse, cursor, antigravity).
  - Justfiles parameterize pattern invocations; they never define patterns.
  - Privacy: work that puts secret material into model context runs on
    local models only. Routing secret material to a hosted model through
    fusion is a caller error.
`;
