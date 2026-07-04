# qa/regressions — crystallized intent-fuzz failures (TRACKED)

Each `<model>-seed-<n>.json` here is the **minimized** user story that once
breached an intent oracle (Uplevel 3 / T1, ratified condition 2). fast-check
shrank it to the shortest reproducing sequence; the harness wrote it here and
filed a ledger record.

These files are **checked in on purpose** — they are the app's permanent
regression suite. `replayRegressions()` re-runs each one (exact `seed` + `path`,
`numRuns: 1`) on every `npm test`, so a bug that was fixed can never quietly
return. Do not gitignore this directory.

- **Added automatically** when the fuzzer finds a new failure.
- **Removed only** when you deliberately retire a fixture (rare — usually because
  the behaviour it pinned was intentionally changed and the oracle updated).

The per-run seed log (`qa/fuzz-log.jsonl`) and the raw intake
(`qa/defect-intake.jsonl`) are gitignored; only these minimized fixtures are
tracked.
