# Research: execution backends for isolated agents on these machines

Ticket: dungle-scrubs/fusion-harness#3 (wayfinder research). Question: what can the fusion CLI use to spawn isolated agent instances, with what isolation properties, streaming, cost, and cross-model diversity?

## The finding that reframes the decision

**The fusion CLI does not need its own model-execution engine for v0.** hcn already provides what the design doc demands of a harness: one sealed process per invocation, provenance on stderr, a typed NDJSON event stream, a 0/1/2 exit contract, six model families for diversity, and memory off by default. The privacy route (local models for secret material) is also already reachable through pi's lmstudio providers. Direct provider APIs buy nothing v0 needs, and they would add key management the tool would have to own. The boundary decision (#2) therefore reduces to: the tool owns pattern orchestration, mechanical components, and schema enforcement, and delegates every agent invocation to `hcn run`.

## Backend 1: hcn - the delegation layer

- `hcn run <harness> "prompt"` launches six harnesses headless: claude, codex, pi, muse, cursor, antigravity. **Observed** via `hcn ls`: claude@2.1.278, codex@0.155.1, pi@0.87.0, muse@1.3.0, cursor@2026.09.15, antigravity@1.2.8 (2026-09-23).
- Isolation: every run is a fresh headless process with no shared transcript; claude/codex auto-memory disabled by default; provenance lines on stderr. **Documented** - ~/.agents/skills/hcn/SKILL.md, "Defaults and config". Sealed generation = N separate `hcn run` invocations; the seal is process isolation, not prompt discipline. **Design inference** from those documented properties.
- Streaming: `--json` emits NDJSON events: identity, token, message, progress, tool, context, question, limit, error, failure, done. **Documented** - same file, "Reading events"; reference schema in references/reference.md.
- Verdict channel: exit 0 clean / 1 failure / 2 hcn refusal; failure classes distinguish provider-unavailable (reroutable) from work-verdict (not). **Documented** - same file.
- Question escalation: typed `question` event, `done` cause `awaiting-input`, resume with `--resume <id>`. **Documented** - same file, "Delegating with question escalation". This is how a sealed worker asks the fusion CLI's caller without seeing anything else.
- Cost profile: one process per run, effort medium default, timeout/maxSteps opt-in only. **Documented** - same file. No per-run metering of tokens across harnesses was found in the skill; token accounting would come from per-harness events. **Silent** in the source read.
- Session mode (`hcn session`, live steering) exists for claude/pi/antigravity only; codex/muse/cursor are run/resume only. **Documented** - same file, "Resume-last" and session sections.
- Version baseline: 0.6.21+ for five harnesses. **Documented** - same file header.

## Backend 2: pi SDK - the in-process option

- `createAgentSession()` embeds pi in a Node/Bun process; every boundary injectable: `modelRuntime`, `model`, `tools`, `resourceLoader`, `customTools`, and `SessionManager.inMemory()` for conversations with no session files. **Documented** - @earendil-works/pi-coding-agent docs/sdk.md, "Configuring a session" (v0.87.0 install at ~/.local/share/mise/installs/node/24.15.0/...).
- Streaming: `session.subscribe` events, `text_delta`, `agent_settled`. **Documented** - same file, "Subscribing to events".
- Isolation: in-process, so seals are whatever the host constructs; distinct in-memory sessions are sealed by construction. **Design inference** from the documented session model.
- Subprocess isolation alternative: docs/cli-integration.md exists for a language-independent subprocess. **Documented** (existence; not read in this pass).
- Cross-model incl. local: pi's `lmstudio` provider reaches both local endpoints. **Documented** - ~/.agents/references/local-inference.md lines 40-43.

## Backend 3: direct provider APIs (incl. local endpoints)

- Local endpoints (OpenAI-compatible /v1): quality `127.0.0.1:17452` (qwen3.8-27b-mlx@8bit, 18.1 tok/s) on pro; speed `127.0.0.1:17453` (qwen3.6-35b-a3b-ud, 64.9 tok/s) on mini; same URLs from every machine; ports registered in PORTS.md. **Documented** - ~/.agents/references/local-inference.md lines 10-43.
- Privacy rule: secret-material work runs on local models only, never hosted. **Documented** - ~/.pi/AGENTS.md "Private Data and Local Inference". A fusion pattern that seals contexts does not repeal this rule; local endpoints are the only compliant route for secret inputs, and pi/hcn already reach them.
- Hosted keys: opchain (1Password service accounts; identities `human`, `primary`) exists at ~/.local/bin/opchain. **Observed** (names only; no values read). The ~/dev/opchain repo named in AGENTS.md is absent; only the installed CLI remains. **Observed**.
- Where pi's hosted-model credentials live: pi's auth.json holds no entries; auth resolves elsewhere (env/keychain). **Unverified** - not load-bearing, since hcn routes hosted runs without the fusion CLI touching keys.

## Comparison against the ticket's four axes

| Axis | hcn | pi SDK | Direct APIs |
|---|---|---|---|
| Sealed contexts | per-process by default | by host construction | by construction (raw HTTP) |
| Streaming out | NDJSON event contract | subscribe events | provider SSE, per-vendor |
| Cross-model diversity | 6 harness families + pi providers | all pi providers incl. local | per-key vendor set + local |
| Cost/control overhead | one process per run | in-process, finest control | key management the tool must own |

## Questions the sources did not answer

- Token/cost metering normalized across harnesses: not documented in the hcn skill read for this pass. If v0 needs budgets per sealed worker, this needs a spike against `hcn run --json` token events.
- Whether hcn's `--isolation tool-free` mode (fresh Claude turns only) matters for fusion patterns: **documented** as existing but Claude-only; probably irrelevant when seals come from process separation.
