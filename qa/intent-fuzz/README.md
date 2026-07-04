# intent-fuzz — the factory intent-fuzzer kit (Uplevel 3 / T1)

Machine-invented user stories, driven against the **real** store, judged by
**intent** oracles ("your check-off survives"), with automatic shrinking and a
forever-green regression suite. This is the grocery hand-rolled fuzzer
(`grocery-list/src/sync/__tests__/intentFuzz.test.ts`) formalized on
[fast-check](https://fast-check.dev)'s model-based mode, so every app's trust
core gets the same adversarial pressure.

Synced into an app by `node scripts/sync.mjs intent-fuzz <app>`; dropped by
`bootstrap-app.mjs --archetype` for every new app.

## What's in the box

| file | role |
|---|---|
| `harness.ts` | `runIntentFuzz(config)` — runs `fc.commands`, logs the seed, and on a counterexample crystallizes the failure (fixture + ledger intake + fuzz-log) and throws. tsc-clean (only imports `fast-check`). |
| `harnessCore.cjs` | the pure, node-testable core: seed/profile resolution, story serialization, shrink-shape guard, and the one failure-crystallization path. Owns all fs/node work. |
| `replay.ts` | `replayRegressions({ models })` — registers one Jest test per checked-in `qa/regressions/*.json`, re-running its exact minimal case forever. |
| `models/*.model.ts.template` | a starter command-model per archetype (`list`, `list-sync`, `timer`, `tracker`) with intent oracles. Copy one to activate. |
| `selftest.mjs` | `node qa/intent-fuzz/selftest.mjs` — proves the pure core (no app, no fast-check). |

## Activate the fuzzer for an app (one file)

1. Pick the model matching your archetype and copy it into the app, dropping the
   `.template` suffix and putting it where its header says (paths are written for
   that location):
   - `list` / `tracker` → `src/store/__tests__/intentFuzz.test.ts`
   - `timer` → `src/data/__tests__/intentFuzz.test.ts`
   - `list-sync` → `src/sync/__tests__/intentFuzz.test.ts`
2. Rename the placeholder `NAMES`/types to your domain and, if your trust core
   has fields the starter doesn't model (a separate check-clock, quantities, kit
   application…), add a command + an intent oracle for each. **Oracles are intent
   statements — "the last check wins", "nothing resurrects by id" — never
   convergence alone** (canon, 2026-07-03).
3. `npm test` — the smoke profile (50 stories) runs on every PR.

That's it. New failures now file themselves; fixed bugs replay green forever.

## Profiles (numRuns)

| when | how | runs |
|---|---|---|
| PR / local smoke (default) | `npm test` | 50 |
| nightly deep run | `FUZZ_PROFILE=nightly npm test` | 2000 |
| exact | `FUZZ_RUNS=500 npm test` | 500 |

Every run logs its seed to the gitignored `qa/fuzz-log.jsonl`, so any night's
high-N run replays exactly.

## When it finds a bug (ratified conditions 1–3)

fast-check **shrinks** the counterexample to the shortest reproducing story,
then the harness does three things in one motion:

1. writes the minimized story to **`qa/regressions/<model>-seed-<n>.json`** — a
   **checked-in** fixture (condition 2). `replayRegressions` re-runs it forever.
2. appends a normalized line to the gitignored `qa/defect-intake.jsonl`; fold it
   into the ledger with `node scripts/defects.mjs ingest --app <app>` (condition 3).
3. logs the failing seed + shrink path to `qa/fuzz-log.jsonl`.

The thrown Jest error prints the seed, the minimal story, and the breached
oracle — the "shortest story that reproduces it" articulation for free.

## Prove it fails a known-bad (canon: gates prove failure)

Before trusting a new model, hand-break the trust core (e.g. make the store's
re-add keep the checked flag) and confirm the fuzzer goes red with a shrunk
story, then revert. The per-app T1 stage records this in its log. A fuzzer that
has never caught a real bug is a hope, not a gate — grocery's only earned trust
after it caught three bugs introduced during the fix.

## Guardrails (non-negotiable)

- **Fuzz the REAL store, never a re-implementation.** The model's `run(m, r)`
  drives the app's actual store/engine; the `model` is only the intent ledger
  (the oracle), computed independently.
- **Oracles are intent, never convergence-only.** Convergence may be asserted
  too, but a fuzzer that only checks "both devices agree" is exactly what let
  the grocery defects through.
- **Every random draw is a logged fast-check seed.** No bare `Math.random()`
  anywhere — reproducibility is the whole point.

## The pure core, proven

```
node templates/qa/intent-fuzz/selftest.mjs
```

Covers seed logging round-trip, story serialization, the shrink-output shape
guard, and end-to-end crystallization — no app, no fast-check, no TypeScript.
