# Red-Blue-Umpire

`fusion red-blue --task <t> --burden <b> [--harness pi] [--model <m>] [--timeout <sec>] [--evidence <file>] [--json]`

## What it is for

A claim set that should survive adversarial review before you rely on it.
One worker proposes; another attacks; a third resolves facts; a fourth -
blind to all identities - scores the survivors against a standard you set.
Adapted from adversarial review and moot-court mechanisms (design doc,
RFC-01 phase 5).

## Mechanics

Four role turns over one run, in RFC stage order (GENERATING,
CHALLENGING, VERIFYING):

1. **Claimant** (`w-red`) files 1-4 atomic claims. Named executable checks
   go in the falsifier or an `evidence[]` entry (backticked command).
   With `--evidence`, the prompt carries researched sources from a dr
   citations export and the claimant cites those instead of recalling
   its own.
2. **Opponent** (`w-blue`) sees the claims anonymized - no provenance - and
   must challenge with `kind=objection` claims whose `dependencies` target
   the claim ids. Free-form critique never passes the schema.
3. **Umpire** (`w-umpire`) resolves each objection. Where a check names a
   command, it runs it and reports the result as `status=observed`
   evidence. Ruling semantics ride on `requested_action`:
   `accept` = objection sustained (target falls), `revise` = overruled
   (target survives), `test` = inconclusive.
4. **Judge** (`w-judge`) sees the full anonymized record and scores the
   surviving claims against the `--burden`. Verdict: `accept` = the record
   meets the burden.

Budgets are symmetric: every role gets the same `--timeout`.

## What the decision record carries

- `decision` and `judgeVerdict` - the ruling and its accept/revise/escalate verdict
- `survivingClaims` - claim ids that no sustained objection removed
- `rejectedClaims` - each with its ruling reason
- `residualRisks` - unresolved objections (inconclusive checks) with their targets

## Guarantees and limits

- Guaranteed: challenge must be typed objections (schema-enforced), the
  judge sees no worker identity or model, and a failed role does not fail
  the run while survivors remain.
- Limits: one judge, no appeal path; id references across roles resolve
  through run-scoped ids (`w-red:C1`), so a worker's own claim ids stay
  worker-scoped; a role whose claims are rejected gets one retry with the
  validator errors fed back - a second rejection is final for the run.

## Run artifacts

`.fusion/runs/<runId>/` - `run.json` (registration with the burden as
rubric), `events.ndjson`, `decision.json`.
