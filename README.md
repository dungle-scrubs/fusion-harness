# fusion

A composable fusion layer over agent harnesses: consensus you can audit.

fusion is a CLI that composes runs of existing coding-agent harnesses into auditable patterns - sealed juries, adversarial review, hypothesis matrices - with the isolation, provenance, and schema enforcement no prompt can provide. Today, getting independent judgment from multiple models means prompting one agent to "act as five agents": context is shared, anchors leak, and dissent collapses into the caller's prior through persuasive prose. fusion makes sealed generation, blind adjudication, and mechanical aggregation properties of a tool boundary instead of sentences in a prompt.

```console
$ fusion jury --task "Is this migration plan sound?" --workers 3
run      rbaf20ab6 (.fusion/runs/rbaf20ab6)
decision the single biggest risk is that llm-only review replaces many independently-failing
votes    3 answers, 3 groups, duplicate rate 0.00
```

## Install

Requires Node 22+ and the `hcn` CLI (`npm install -g @dungle-scrubs/harness-cli-normalizer`) - every worker runs through it.

```console
npm install -g @dungle-scrubs/fusion
```

## Use it: run a sealed jury

Pick a bounded question you would otherwise ask one model, and decide how many sealed workers should answer it independently:

```console
$ fusion jury --task "Ship or hold the Friday release?" --workers 3 --harness pi
```

Each worker is a separate process with no shared transcript and no sight of the other answers. Equivalent answers are grouped mechanically, plurality decides, and the decision record names the winner, the minority report, and the duplicate rate - so you can see whether three "independent" answers actually converged or just shared a prior.

Everything the run produced lands in `.fusion/runs/<runId>/`: a frozen registration, a replayable event stream, and the decision record. `fusion skill` prints the complete caller guide - every pattern, the claim schema, and which method fits which problem shape.

## Concepts

**Patterns.** Six problem-solving methods, each a tool-owned run: `jury` (independent votes on a bounded question), `red-blue` (claims must survive adversarial challenge against a stated burden), `ach` (competing hypotheses for an observed outcome), `delphi` (one round of anonymized peer revision), `shortlist` (open generation ranked by blind judges), `gonogo` (a ship/block gate where one NO-GO blocks, no outvoting). Run `fusion skill` for the selection rules with their counter-rules.

**Claims.** The typed object every component exchanges: one flat schema with a falsifier required on every kind, unknown fields rejected, and provenance stamped only by the tool. Workers are untrusted content producers - nothing they write executes.

**Mechanical fusion.** No model decides a pattern's outcome. Tier-1 functions (validate, normalize, aggregate, score) are deterministic and model-free; pattern runs use exactly those functions to count, group, and rank.

## Configuration and reference

- `fusion skill` - the complete caller guide, emitted by the binary itself
- `docs/methods/` - one doc per method, with guarantees and limits
- `docs/rfc/` - the accepted RFC that specifies the design
- Exit codes and error envelopes: `docs/adr/0002-envelope-and-exit-contract.md`

## Contributing

```console
pnpm install
pnpm build        # bundle dist/cli.js
pnpm test         # vitest suite
pnpm lint         # biome
pnpm typecheck    # tsc --noEmit
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...) - release-please derives versions and the changelog from them.

## Status

v0. All six patterns are implemented and live-tested. Not yet built: caller resume for worker questions, mixed-model rosters, multi-round delphi, and the v1 calibration store. See the pipeline notes in each method doc's limits section.

## License

MIT
