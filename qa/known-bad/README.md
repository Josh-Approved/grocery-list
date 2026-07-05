# qa/known-bad — the gates-prove-failure fixtures (Uplevel 3 / T2 stage 2)

> A gate that never demonstrated failure is a hope, not a gate. (Canon
> 2026-07-02, the demo-frame miss.) This directory is that demonstration, made
> systematic: for every checkable gate, a checked-in known-bad the gate must
> reject.

`scripts/qa/prove-gates.mjs <appDir>` reads the registries here, runs each gate
against its fixture, and **fails if any gate does NOT reject its known-bad** —
a dead sensor. It's wired into `run-qa --profile production` (a dead sensor
blocks a release) and the monthly `fleet-health` sweep.

## Layout

- `registry.base.json` — the **canonical** gate list, overwrite-synced into
  every app by `sync.mjs qa`. Each entry maps a gate to a fixture and how to
  detect rejection.
- `registry.json` — **app-owned**, optional, never clobbered. Add app-specific
  gates here (e.g. a broken-merge fixture a particular app's fuzzer must catch).
  `prove-gates` runs `registry.base.json` + `registry.json` together.
- `EXCLUSIONS.md` — gates with no cheap checked-in fixture, each with an honest
  one-line reason (never silence).
- `canonical/` — a deliberately-broken mini RN app. It is **scanned, never
  built**: `qa-canonical.mjs` reads it as text to detect surface=rn and run its
  rules. Every file trips a specific FAIL rule (see the header comments). It is
  excluded from the app's `tsconfig` + jest so it never pollutes a real build.
- `flow-drift/` — a journey referencing an anchor absent from selectors, so the
  app's `lint-flows.mjs` exits non-zero (selector drift).

## Registry entry shapes

```jsonc
// canonical-rule: run the app's qa-canonical against a fixture dir, assert a
// specific rule id comes back severity:"fail".
{ "gate": "parity/no-alert-prompt", "kind": "canonical-rule",
  "fixture": "canonical", "rule": "parity/no-alert-prompt", "why": "…" }

// command: run an arbitrary gate command and assert a NON-ZERO exit (dead
// sensor if it exits 0). {appDir}/{fixtureDir} are substituted. Optional
// "expectMatch": a regex the combined stdout+stderr must contain.
{ "gate": "flows/lint-drift", "kind": "command", "fixture": "flow-drift",
  "cmd": ["node", "{appDir}/scripts/qa/lint-flows.mjs", "{fixtureDir}"], "why": "…" }
```

## Rules for editing

- **Fixtures are checked-in and tiny — never generated at run time.** They must
  survive a fresh clone of the app repo.
- A gate that can't fail its known-bad gets **fixed or excluded-with-reason**,
  never quietly skipped.
- Do not "fix" a fixture file — its brokenness is the point. Each file's header
  says which rule it exists to trip.
