#!/usr/bin/env node
/**
 * npm-drift-preflight — refuse a local build whose installed packages don't
 * match package-lock.json, with an instruction instead of a baffling error.
 *
 * WHY THIS EXISTS (found 2026-10-24 building workout-timer QA builds).
 *
 * `eas build --local` reads the Expo config using the checkout's OWN
 * node_modules. A folder that was never reinstalled after a dependency bump (a
 * pull that moved package-lock.json, an SDK upgrade landed from another
 * session) still holds the old packages, so the config read resolves plugins
 * against the wrong versions. workout-timer had SDK 55 packages under an SDK 57
 * package.json and its build died with "Unable to resolve a valid config plugin
 * for expo-status-bar" — nothing in that message says "your install is stale",
 * and `npm ci` was the whole fix. The same day five more app folders on the
 * studio Mac were drifted (grocery-list 56 invalid, tend 42, packing-list 18,
 * budget and split-expenses 2 missing each): five builds waiting to fail the
 * same confusing way.
 *
 * `npm ls --depth=0` is the cheap, exact test: it compares node_modules with
 * package.json + package-lock.json and names each top-level package that is
 * missing or installed at a version the manifest does not allow. Extraneous
 * packages (installed but not declared) are not drift in this sense — npm
 * itself exits 0 on them — so they never refuse.
 *
 * WHY REFUSE RATHER THAN RUN `npm ci` ITSELF. `npm ci` deletes node_modules
 * first; doing that under a running dev server or another session's test run
 * is worse than stopping, and it needs the network. The remedy is one command
 * and the message prints it.
 *
 * THE SECOND SHAPE. If `npm ci` itself refuses ("package.json and
 * package-lock.json ... are in sync"), the COMMITTED lockfile is stale — a sync
 * added a dependency to package.json without updating the lock (budget and
 * split-expenses, 2026-07-09 → found 2026-10-24). Then the fix is `npm install`
 * and committing package-lock.json, and the message says so.
 *
 *   node scripts/lib/npm-drift-preflight.mjs <appDir>          # gate: exit 1 on drift
 *   node scripts/lib/npm-drift-preflight.mjs <appDir> --json
 *   node scripts/lib/npm-drift-preflight.mjs --self-test
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHOW_AT_MOST = 6;

/** PURE (self-tested): the wanted range for a missing dep, from npm's problem line. */
function wantedFromProblems(name, problems) {
  for (const p of problems) {
    const m = /^missing: (.+)@([^@,]+), required by /.exec(String(p));
    if (m && m[1] === name) return m[2];
  }
  return null;
}

/**
 * PURE core (self-tested): the verdict for one app's `npm ls --depth=0 --json`.
 *
 * `ls` is the parsed JSON (null when npm could not run or printed nothing
 * parseable). Missing or invalid top-level packages refuse; anything else —
 * including no input at all — passes, because this guard must never block a
 * build it knows nothing about.
 */
export function installDriftVerdict({ app = 'app', appDir = '.', ls = null } = {}) {
  if (!ls || typeof ls !== 'object') {
    return { ok: true, checked: false, drift: [], message: `${app}: npm ls gave no readable output — installed packages not checked` };
  }
  const problems = Array.isArray(ls.problems) ? ls.problems : [];
  const drift = [];
  for (const [name, d] of Object.entries(ls.dependencies || {})) {
    if (!d || typeof d !== 'object') continue;
    if (d.missing) {
      drift.push({ name, kind: 'missing', want: d.required || wantedFromProblems(name, problems) });
    } else if (d.invalid) {
      // npm writes `"^6.0.0" from the root project`; keep just the range.
      const want = /^"([^"]+)"/.exec(String(d.invalid))?.[1] || String(d.invalid);
      drift.push({ name, kind: 'invalid', have: d.version || null, want });
    }
  }
  if (!drift.length) {
    return { ok: true, checked: true, drift, message: `${app}: installed packages match package-lock.json` };
  }
  const invalid = drift.filter((d) => d.kind === 'invalid').length;
  const missing = drift.length - invalid;
  const counts = [invalid && `${invalid} at the wrong version`, missing && `${missing} missing`].filter(Boolean).join(', ');
  const shown = drift.slice(0, SHOW_AT_MOST).map((d) => (d.kind === 'missing'
    ? `${d.name} (not installed${d.want ? `, wants ${d.want}` : ''})`
    : `${d.name} ${d.have || '?'} (wants ${d.want})`));
  if (drift.length > SHOW_AT_MOST) shown.push(`+${drift.length - SHOW_AT_MOST} more`);
  return {
    ok: false,
    checked: true,
    drift,
    message: [
      `${app}: REFUSING TO BUILD — installed packages don't match package-lock.json — run npm ci.`,
      `${counts}: ${shown.join(', ')}.`,
      `A local build reads the Expo config with these stale packages and fails with an error that never says so (workout-timer's was "Unable to resolve a valid config plugin for expo-status-bar").`,
      `Remedy: cd ${appDir} && npm ci, then re-run the build. If npm ci itself refuses because package.json and package-lock.json are out of sync, the committed lockfile is stale: run npm install, commit package-lock.json, then build.`,
    ].join('\n'),
  };
}

/** IMPURE: run `npm ls --depth=0 --json` in one app dir and return the pure verdict. */
export function checkInstalledPackages(appDir) {
  const app = path.basename(path.resolve(appDir));
  // Not an npm project (no package.json) → nothing to compare; fail open.
  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    return { ok: true, checked: false, drift: [], app, message: `${app}: no package.json — installed packages not checked` };
  }
  // npm ls exits 1 on drift, so the exit code is not the verdict; the JSON is.
  const r = spawnSync('npm', ['ls', '--depth=0', '--json'], {
    cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  let ls = null;
  try { ls = JSON.parse(r.stdout || ''); } catch {}
  return { ...installDriftVerdict({ app, appDir, ls }), app };
}

// ---------- self-test (pure logic only) ----------

function selfTest() {
  let f = 0;
  const ok = (c, m) => { if (!c) { f++; console.error(`  ✗ ${m}`); } else console.log(`  ✓ ${m}`); };

  // Shapes copied from real `npm ls --depth=0 --json` output (npm 11).
  const clean = installDriftVerdict({ app: 'tally', ls: {
    name: 'tally', version: '1.0.0',
    dependencies: { expo: { version: '57.0.2', overridden: false }, react: { version: '19.2.0', overridden: false } },
  } });
  ok(clean.ok === true && clean.checked === true, 'a folder whose install matches its lockfile passes');

  const sdkDrift = installDriftVerdict({ app: 'workout-timer', appDir: '../workout-timer', ls: {
    name: 'workout-timer', version: '1.1.12',
    problems: ['invalid: expo@55.0.4 /x/node_modules/expo', 'invalid: expo-status-bar@3.0.8 /x/node_modules/expo-status-bar'],
    dependencies: {
      expo: { version: '55.0.4', overridden: false, invalid: '"~57.0.2" from the root project' },
      'expo-status-bar': { version: '3.0.8', overridden: false, invalid: '"~4.0.1" from the root project' },
      react: { version: '19.2.0', overridden: false },
    },
  } });
  ok(sdkDrift.ok === false && sdkDrift.drift.length === 2, 'the workout-timer shape (SDK 55 installed under an SDK 57 manifest) refuses');
  ok(/installed packages don't match package-lock\.json — run npm ci/.test(sdkDrift.message),
    'the message leads with the plain instruction');
  ok(/expo-status-bar 3\.0\.8 \(wants ~4\.0\.1\)/.test(sdkDrift.message),
    'and names each drifted package with what is installed and what the manifest wants');
  ok(/Unable to resolve a valid config plugin/.test(sdkDrift.message),
    'and quotes the baffling error it replaces, so someone who already saw it recognises the cause');
  ok(/cd \.\.\/workout-timer && npm ci/.test(sdkDrift.message), 'and the remedy is a command for this folder');

  const missing = installDriftVerdict({ app: 'budget', ls: {
    name: 'budget', version: '1.0.0',
    problems: [
      'missing: @testing-library/react-native@^14.0.1, required by budget@1.0.0',
      'missing: test-renderer@^1.2.0, required by budget@1.0.0',
    ],
    dependencies: {
      '@testing-library/react-native': { required: '^14.0.1', missing: true, problems: ['missing: @testing-library/react-native@^14.0.1, required by budget@1.0.0'] },
      'test-renderer': { missing: true, problems: ['missing: test-renderer@^1.2.0, required by budget@1.0.0'] },
    },
  } });
  ok(missing.ok === false && missing.drift.every((d) => d.kind === 'missing'), 'the budget shape (declared but not installed) refuses');
  ok(missing.drift.find((d) => d.name === 'test-renderer')?.want === '^1.2.0',
    'a missing dep with no `required` field still gets its range, read from npm\'s problem line');
  ok(missing.drift.find((d) => d.name === '@testing-library/react-native')?.want === '^14.0.1',
    'a scoped name parses (its leading @ is not the version separator)');
  ok(/npm install, commit package-lock\.json/.test(missing.message),
    'the message covers the second shape: npm ci refusing because the committed lockfile is stale');

  const extraneous = installDriftVerdict({ app: 'x', ls: {
    name: 'x', version: '1.0.0',
    problems: ['extraneous: stray@1.0.0 /x/node_modules/stray'],
    dependencies: { stray: { version: '1.0.0', extraneous: true } },
  } });
  ok(extraneous.ok === true, 'an extraneous package alone does not refuse (npm itself exits 0 on it)');

  const many = installDriftVerdict({ app: 'grocery-list', ls: {
    dependencies: Object.fromEntries(Array.from({ length: 56 }, (_, i) => [`pkg-${i}`, { version: '1.0.0', invalid: '"^2.0.0" from the root project' }])),
  } });
  ok(many.ok === false && /56 at the wrong version/.test(many.message) && /\+50 more/.test(many.message),
    'the grocery-list shape (56 invalid) counts them all but lists only a few');

  ok(installDriftVerdict({}).ok === true, 'no input fails OPEN — this guard must never block a build it knows nothing about');
  ok(installDriftVerdict({ ls: 'garbage' }).ok === true, 'unreadable npm output fails open too');

  console.log(f === 0 ? '\nnpm-drift-preflight self-test PASSED' : `\nnpm-drift-preflight self-test FAILED (${f})`);
  process.exit(f === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) selfTest();
  else {
    const dir = args.find((a) => !a.startsWith('--'));
    if (!dir) { console.error('Usage: npm-drift-preflight.mjs <appDir> [--json] | --self-test'); process.exit(2); }
    const verdict = checkInstalledPackages(dir);
    if (args.includes('--json')) console.log(JSON.stringify(verdict, null, 2));
    if (verdict.ok) process.exit(0);
    console.error(verdict.message);
    process.exit(1);
  }
}
