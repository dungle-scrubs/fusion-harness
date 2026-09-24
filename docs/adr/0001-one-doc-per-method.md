# One doc per method

Every fusion method - each tier 2 pattern and the tier 1 function set -
gets its own doc under `docs/methods/`, shipped in the same pull request
that ships the method itself. We chose per-method docs over one combined
methods page because each pattern is read independently by callers who
need its mechanics, decision-record shape, and limits without the other
patterns' noise, and because a combined page goes stale selectively: the
method that changed last wins and the rest drift.
