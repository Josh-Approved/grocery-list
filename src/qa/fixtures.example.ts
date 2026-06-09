// QA fixtures — the deterministic data the app boots with under QA_MODE.
//
// Rename to src/qa/fixtures.ts and replace the contents with YOUR app's data
// types. The goal: when the capture pipeline launches the app, every screen is
// already populated with realistic, screenshot-worthy content — so the flow
// never has to type data live (slow, agent-in-the-loop, non-deterministic).
//
// Rules that keep captures reproducible:
//   - Stable ids and FIXED timestamps (no Date.now()) — a frozen T0 like below.
//   - Names/values chosen to fill each view nicely and to give later screens
//     recognizable copy your qa/selectors.json anchors can target.
//   - Enough rows to look real, few enough to fit one screen without scrolling.
//
// Then wire it in your store/seed init (one line):
//   import { QA_MODE } from './qaMode';
//   import { QA_FIXTURES } from './fixtures';
//   const initial = QA_MODE ? QA_FIXTURES : realDefaults;

const T0 = 1700000000000; // fixed epoch — never Date.now() in fixtures

export const QA_FIXTURES = [
  // { id: 'qa-1', name: 'Example', createdAt: T0, updatedAt: T0 },
];
