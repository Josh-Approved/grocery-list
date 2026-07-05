# Known-bad exclusions — gates with no cheap checked-in fixture

Uplevel 3 / T2 stage 2 (gates prove failure). `prove-gates.mjs` proves each
registered gate rejects a checked-in known-bad. Some gates cannot get a small,
surgical, dependency-free fixture that survives a fresh clone. Rather than
pretend they're covered (or silently skip them), they are listed here with one
honest line each. An exclusion is a decision, not an oversight — if a cheap
fixture becomes conceivable, move the gate into `registry.base.json`.

This file is overwrite-synced by `sync.mjs qa`; it is the fleet-wide list.
App-specific exclusions belong in a sibling `registry.notes.md` next to the
app-owned `registry.json`.

## Excluded gates

- **regression-gate.mjs (failing-first fix gate)** — proving it "rejects a
  known-bad" would require a throwaway git repo with a fabricated defect record,
  a fix commit, and a linked test — not a small file. Its own `--self-test`
  already exhausts the four-cell verdict matrix (pass/fail × parent/HEAD), which
  IS the gates-prove-failure proof for its pure logic; the I/O shell is a
  mechanical git-worktree run. Covered by `regression-gate.mjs --self-test`.

- **The intent fuzzers + Tier-1 unit tests (trust cores)** — the systematic
  proof that these suites notice a broken trust core is **mutation testing**
  (T2 stage 1, `mutation.mjs`): it deliberately breaks the code thousands of
  ways and every survivor is a hole the suite missed. That is the gates-prove-
  failure mechanism for the unit/fuzzer layer, run nightly. A single hand-authored
  "broken merge" fixture would prove far less than the mutation sweep already
  does, and would need the app's full node_modules to run. Covered by
  `mutation.mjs <app>` (survivors → tickets).

- **visual-reg.mjs (pixel regression)** — its known-bad is "a baseline vs a
  deliberately-different screen", i.e. two rendered PNGs from a booted device,
  plus the `pixelmatch`/`pngjs` dev-deps. That's neither tiny nor device-free.
  Its liveness is structural instead: a baseline is only ever updated via an
  explicit `--accept`, so an un-accepted diff always blocks — the sensor cannot
  be silently disarmed. Covered by `visual-reg.mjs` self-test + the `--accept`
  gate in `run-qa --profile production`.

- **The device-artifact tiers in run-qa (matrix, two-device sync, upgrade
  migration, defect-proving)** — these tiers READ artifacts a Mac-present device
  run wrote; a known-bad would mean staging a fake failing report, which proves
  the JSON reader, not a sensor. Their fail-paths are exercised by each engine's
  own `--self-test` (matrix-review, chaos-scenarios `validateCatalog`,
  upgrade-test, regression-gate). run-qa itself is an **aggregator**, not a
  sensor — its component sensors are each proven here or above.

- **Chrome-extension gates (ext/manifest-mv3, ext/permissions-tight)** — the
  five in-scope apps are all React Native; there is no extension in T2's scope
  to carry a fixture. If an extension re-enters scope, add a `manifest.json`
  known-bad fixture (manifest_version:2 + a broad permission).
