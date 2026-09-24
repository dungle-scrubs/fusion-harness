# Envelope and exit contract (supersedes RFC-01's exit section)

Fusion's exit codes no longer follow the hcn 0/1/2 mapping. Every command
emits a `{ok, run, step, errors[]}` envelope (machine-shaped with
`--json`, human text plus error lines without) and exits by class:
0 ok, 1 usage, 2 validation/gate, 3 nothing takeable, 4 internal.
Errors carry E-codes naming class and field (`E201: claims: C3.confidence:
Invalid input`). Crashes emit an E499 envelope through a synchronous
stdout write and exit 4; parser mistakes route through the same envelope
as E106. Every invocation appends start/end lines to
`.fusion/commands.jsonl` before and after work - the dead-consumer
backstop. Worker spawn failures remain typed outcomes in the run record
and never take an error path. Decided to give agent consumers truthful
envelopes and disk records that survive them; superseded mapping recorded
here so nobody re-derives the hcn codes.
