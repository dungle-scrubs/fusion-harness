---
name: Bug report
about: Something fusion did that contradicts its contract
labels: bug
---

**What happened**

A crash (E4xx/E499), a stack trace, or an exit code contradicting the envelope is a bug. Ordinary failures - E1xx misuse, E2xx gates doing their job, E3xx nothing takeable - have fix guidance in `fusion skill` and are not bugs.

**The command line you ran**

```
```

**The envelope (with --json) or the error lines**

```
```

**Evidence that survives the session**

- the last 20 lines of `.fusion/commands.jsonl`, if present
- the run directory under `.fusion/runs/<runId>/` (events.ndjson, decision.json), if a pattern run was involved

**What you expected**

A sentence or two.
