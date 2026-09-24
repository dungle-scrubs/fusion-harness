# Delphi

`fusion delphi --task <t> [--workers N] [--harness pi] [--model <m>] [--timeout <sec>] [--json]`

## What it is for

A question where independent judgment benefits from one bounded round of
peer exposure. Jury has zero interaction between workers by design; Delphi
is its counterpart with exactly one: round 2 sees the anonymized panel
record and may revise. Adapted from Delphi-panel mechanisms (design doc,
RFC-01).

Use it when anchoring on a first answer is the risk *and* some
cross-pollination is expected to help - estimation, forecasting-style
questions, and panels whose members correct each other's blind spots.

## Mechanics

1. **Round 1** (generate stage): N sealed workers, no shared transcript,
   one `kind=answer` claim each.
2. **Round 2** (the RFC challenge wave, used as the revision round): each
   worker is a fresh sealed spawn that sees its OWN round-1 answer plus
   the full anonymized panel record - blind to the other panelists'
   identities and models. It revises or keeps its position, with
   `novelty` stating which (`confirms` = kept, `new` = revised).
3. Mechanical fusion, tier 1 canonicalization throughout:
   - **convergence** - duplicate rate within round 2: did wording-level
     groups collapse toward agreement?
   - **stability** - fraction of round-2 answers canonically equal to the
     same worker's round-1 answer: held positions vs revisions.
   - **decision** - round-2 plurality winner, first-seen tiebreak.

A panel that converges with high stability was already aligned; convergence
with low stability means minds changed - read the minority report before
trusting either.

## What the decision record carries

`decision`, `delphi` (both rounds' answers/groups, convergence, stability),
`minorityReport` (losing round-2 groups with members and novelty),
`residualRisks` (minority answers with confidence >= 0.6 or their own
escalate/revise vote), `pattern`.

## Guarantees and limits

- Guaranteed: rounds are sealed spawns; round 2 is blind to others'
  identities (engine-anonymized handoff); every signal is mechanical.
- Limits: exactly one revision round (more rounds are a config change,
  deliberately absent); stability is measured by canonical comparison, not
  the self-reported novelty field (both are recorded); a worker whose
  claims are rejected gets the engine's single retry with errors fed back.

## Run artifacts

`.fusion/runs/<runId>/` - `run.json`, `events.ndjson` (stage events show
GENERATING then CHALLENGING; for Delphi the challenge wave IS the revision
round), `decision.json`.
