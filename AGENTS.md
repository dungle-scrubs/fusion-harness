# fusion-harness

`fusion` is a composition layer over agent harnesses, per
[docs/rfc/01_fusion-a-composable-fusion-layer-over-agent-harnesses.rfc.md](docs/rfc/01_fusion-a-composable-fusion-layer-over-agent-harnesses.rfc.md).
Domain terms live in [CONTEXT.md](CONTEXT.md); use them as written.

## Decisions and docs

- Architecture decisions live in `docs/adr/`; read the governing ADR
  before changing what it covers.
- One doc per method under `docs/methods/` ([ADR-0001](docs/adr/0001-one-doc-per-method.md)):
  a new pattern or tier-1 function ships its doc in the same PR.

## Product word rules (bind the tool's surfaces)

- Never call the tool a harness. That word means loop-owners (claude,
  codex, pi, muse, cursor, antigravity).
- Tier 1 (validate/normalize/aggregate/score) stays model-free and
  deterministic.
- All agent execution goes through `hcn run`.
- Unknown claim fields are rejected, not ignored; provenance is the only
  tool-stamped claim block.

## Commands

- `pnpm build` - bundle `dist/cli.js`
- `pnpm test` / `pnpm vitest run` - full suite
- `pnpm typecheck`, `pnpm lint` - clean before every commit
- Binary for manual runs: `./dist/cli.js <command>`
