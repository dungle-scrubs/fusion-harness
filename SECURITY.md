# Security Policy

## Supported versions

The latest release on `master`.

## Reporting a vulnerability

Open a private security advisory: GitHub -> Security -> "Report a vulnerability" on this repository. Do not open a public issue for a suspected vulnerability.

You should hear back within a few days. If the report is confirmed, a fix ships as a patch release and the advisory is published after it lands.

## Trust model (worth knowing before you report)

fusion spawns worker agents through `hcn` and treats their output as untrusted content: every claim is schema-validated at a tool boundary, provenance is stamped only by the tool, and nothing a worker writes executes or reaches the caller as instructions. Reports about a worker's content influencing a run's mechanics - rather than its claims - are especially welcome.

Secret material must never enter a hosted model through fusion; local-model routing is the caller's responsibility and is documented in `fusion skill`.
