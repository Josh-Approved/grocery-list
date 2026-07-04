/**
 * quarantine.setup.cjs — the blocking-path flake exclusion (Uplevel 3 / T0 stage 3).
 *
 * A Jest `setupFilesAfterEnv` file. It reads `<rootDir>/qa/quarantine.json` and,
 * in a BLOCKING run (the default), skips any test whose stable id is quarantined
 * — so a known-flaky test can't red a PR/ship gate. The SAME test still runs in
 * the non-blocking sweep (`QUARANTINE_MODE=run`, driven by `scripts/qa/flaky.mjs
 * sweep` / the nightly), which is where the green-counter that eventually
 * reinstates it is gathered. The signal never stops running; it just stops
 * blocking. (Slack/Uber pattern; RESEARCH-NOTES.md § Flake management.)
 *
 * The stable id is "<file-basename-no-ext>::<full test name>" — the exact key the
 * defect-reporter writes to qa/test-run.json and flaky.mjs marks/sweeps on.
 *
 * ZERO effect when the quarantine list is empty (the common case): the global
 * describe/it wrappers are only installed when there is something to exclude, so
 * a normal `npm test` is byte-for-byte unchanged.
 */

const fs = require('node:fs');
const path = require('node:path');

function loadEntries(rootDir) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(rootDir, 'qa', 'quarantine.json'), 'utf8'));
    return Array.isArray(q.entries) ? q.entries : [];
  } catch {
    return [];
  }
}

const rootDir = process.cwd();
const mode = process.env.QUARANTINE_MODE || 'block';
const quarantined = new Set(loadEntries(rootDir).map((e) => e.testId).filter(Boolean));

// Only intervene when there is a non-empty quarantine AND we're in a blocking
// run AND the globals we need are present. In `run` mode we do nothing (the
// point is to RUN the quarantine set and gather the reinstatement signal).
if (
  quarantined.size &&
  mode === 'block' &&
  typeof global.describe === 'function' &&
  typeof global.it === 'function'
) {
  // File basename for this test file (setupFilesAfterEnv runs once per file).
  let base = 'unknown';
  try {
    const tp = (global.expect && global.expect.getState && global.expect.getState().testPath) || '';
    base = path
      .basename(String(tp))
      .replace(/\.(test|spec)\.[jt]sx?$/i, '')
      .replace(/\.[jt]sx?$/i, '');
  } catch { /* keep 'unknown' */ }

  const stack = [];
  const idOf = (name) => `${base}::${[...stack, name].filter(Boolean).join(' > ')}`;

  const copyStatics = (from, to, keys) => {
    for (const k of keys) if (typeof from[k] !== 'undefined') to[k] = from[k];
    return to;
  };

  const wrapDescribe = (orig) => {
    const wrapped = function (name, fn, ...rest) {
      return orig.call(this, name, function (...a) {
        stack.push(name);
        try { return fn.apply(this, a); } finally { stack.pop(); }
      }, ...rest);
    };
    return copyStatics(orig, wrapped, ['only', 'skip', 'each', 'concurrent']);
  };

  const wrapIt = (orig) => {
    const wrapped = function (name, fn, timeout) {
      if (quarantined.has(idOf(name)) && typeof orig.skip === 'function') {
        return orig.skip(name, fn, timeout);
      }
      return orig.call(this, name, fn, timeout);
    };
    return copyStatics(orig, wrapped, ['only', 'skip', 'todo', 'concurrent', 'each', 'failing']);
  };

  global.describe = wrapDescribe(global.describe);
  global.it = wrapIt(global.it);
  if (typeof global.test === 'function') global.test = wrapIt(global.test);
}
