# Sealed Jury

`fusion jury --task <t> [--workers N] [--harness pi] [--model <m>] [--vocabulary <a,b>] [--timeout <sec>] [--json]`

## What it is for

A question that benefits from independent judgment: when one model's
answer might anchor on its own phrasing or prior, N sealed workers answer
it separately and the tool fuses their answers mechanically. Adapted from
the nominal-group and jury mechanisms (design doc, RFC-01 phase 4).
For bounded questions with a known answer set, pass `--vocabulary`
(e.g. `ship,hold`): workers answer with exactly one member verbatim and
grouping is exact by construction.

## Mechanics

1. Every worker is a separate `hcn run` process with no shared transcript
   and no sight of the other answers. Each replies with exactly one claim,
   `kind=answer`, carrying its own confidence and falsifier.
2. Pattern strictness: only `kind=answer` claims enter fusion. Anything
   else is rejected with a reason.
3. Tier 1 canonicalization groups equivalent answers (NFC, whitespace,
   casing, number formats). Near-misses stay separate - there is no
   semantic dedup in the mechanical stage.
4. Plurality vote over the groups; ties break by first-seen order and the
   record shows the tie. When `--vocabulary` is set, answers outside the
   set are rejected with a named reason; each rejected worker gets one
   retry with the validator error fed back, then the rejection stands.
   The record carries the vocabulary.

## What the decision record carries

- `decision` - the winning canonical answer
- `independence` - accepted answers, distinct groups, duplicate rate: read
  this before trusting consensus. Three semantically identical answers
  phrased differently show as three groups; the tool refuses to pretend
  that was one answer.
- `minorityReport` - losing groups with their members
- `rejectedOptions` - pattern-rejected claims with reasons
- `residualRisks` - minority answers with confidence >= 0.6 or their own
  escalate/revise vote, each with its falsifier

## Guarantees and limits

- Guaranteed: sealed processes, schema enforcement at the boundary,
  tool-stamped provenance, replayable event stream, mechanical fusion -
  no model in the fusion loop.
- Limits: exact-match grouping splits semantically-equal answers with
  different wording (semantic dedup is tier 2 model work, deliberately
  absent); a worker whose claims are rejected gets one retry with the
  validator errors fed back - a second rejection is final for the run.

## Run artifacts

`.fusion/runs/<runId>/` - `run.json` (frozen registration),
`events.ndjson` (replayable), `decision.json`.
