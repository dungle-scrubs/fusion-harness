# fusion-panel - domain glossary

Canonical terms for this repository. Source of naming: RFC-01
(docs/rfc/01_fusion-a-composable-fusion-layer-over-agent-harnesses.rfc.md).

## Terms

- **fusion** - this CLI. A composition layer over agent harnesses; never
  called a harness itself.
- **harness** - the layer that owns an agent's loop (context, tools,
  permissions): claude, codex, pi, muse, cursor, antigravity. Reached only
  through `hcn run`.
- **claim** - the typed object every component exchanges. Flat schema;
  `provenance` is the only tool-stamped block.
- **tier 1** - deterministic, model-free pure functions callable as
  one-shot subcommands: validate, normalize, aggregate, score.
- **tier 2 / pattern run** - an execution the tool owns end to end: sealed
  workers, schema enforcement at the boundary, provenance stamping, event
  stream, decision record.
- **pattern definition** - tool-side config that fully describes one
  pattern: its command flags, worker/stage construction, mechanical fuse,
  and human summary. One module per pattern; the dispatcher is generic.
  RFC-01: "Pattern definitions are tool-side config."
- **dispatcher** - the generic CLI layer that turns one pattern definition
  into a subcommand: owns runId, executeRun, the run directory, `--json`
  output, and exit codes.
- **worker** - one sealed agent invocation inside a pattern run, launched
  through `hcn run`.
- **provenance** - the tool-stamped record of who produced a claim: run,
  worker, harness, model, session. Workers cannot set it.
- **decision record** - the final artifact of a pattern run, written to
  `.fusion/runs/<runId>/decision.json`: decision, minority/rejected/risk
  content per pattern.
