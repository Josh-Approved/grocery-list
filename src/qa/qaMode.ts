// QA mode — canonical, app-agnostic. Synced from the factory (sync.mjs qa); do
// not edit per-app.
//
// EXPO_PUBLIC_* env is inlined into the JS bundle by Metro at bundle time, so
// this is a compile-time constant: production builds (env unset or "0") tree-
// shake the QA branches away entirely. The capture pipeline builds with
// EXPO_PUBLIC_QA_MODE=1 so the app boots with deterministic fixtures, a frozen
// clock-friendly state, and navigation animations off — which is what makes
// screenshots reproducible and Maestro waypoints land every time.
//
// Wiring (two small touch-points — see templates/qa/seed/README.md):
//   1. Store/seed init:  initialData = QA_MODE ? QA_FIXTURES : realDefaults
//   2. App.tsx:          skip the animated splash + set navigator animation
//                        to 'none' when QA_MODE (deterministic first frame).
export const QA_MODE = process.env.EXPO_PUBLIC_QA_MODE === '1';
