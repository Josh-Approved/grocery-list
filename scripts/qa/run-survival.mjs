#!/usr/bin/env node
/**
 * run-survival.mjs — run an app's T4 state-survival flow on a booted device.
 *
 * The state-survival flow (chaos net, uplevel3/04) is DELIBERATELY separate from
 * the screenshot/Tier-2 mobile.yaml: it kills and relaunches the app, so it is
 * slow and belongs in the FULL profile + nightly, NOT the per-PR gate (qa-e2e.yml
 * runs only mobile.yaml). This is the token-free runner that the full-profile /
 * nightly schedule (T5) invokes to actually exercise it. It never drives taps
 * itself — Maestro does, from qa/flows/state-survival.yaml, which is GENERATED
 * from the `survival` block in qa/journey.json.
 *
 * It assumes a device is already booted + the app installed (same contract as
 * `maestro test`); pair it with capture.mjs's build/boot/install, or run after a
 * matrix cell. An app with no `survival` block is a clean SKIP (exit 0).
 *
 * Usage:
 *   node scripts/qa/run-survival.mjs <app-dir> [--platform ios|android] [--device <udid|avd>] [--dry-run]
 *   node scripts/qa/run-survival.mjs --self-test
 *
 * Exit 0 = survived (or nothing to run); 1 = the mutation did NOT survive the
 * kill, or the flow/compile failed. A failure is a real production-class defect —
 * file it against the app (node scripts/defects.mjs open …).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SURVIVAL_FLOW = path.join('qa', 'flows', 'state-survival.yaml');
const SURVIVAL_REPORT = path.join('qa', 'survival-report.json');

// Merge a per-platform survival result into qa/survival-report.json so the
// read-only run-qa `survival` tier (T5) can gate on it without a device — same
// artifact-derived contract as the matrix/two-device/upgrade tiers. ok = every
// recorded platform passed.
function writeSurvivalReport(appDir, platform, ok) {
  const p = path.join(appDir, SURVIVAL_REPORT);
  let report = { platforms: {} };
  try { report = JSON.parse(fs.readFileSync(p, 'utf8')); report.platforms = report.platforms || {}; } catch { /* fresh */ }
  report.platforms[platform || 'device'] = ok;
  report.ok = Object.values(report.platforms).every(Boolean);
  report.ranAt = new Date().toISOString();
  report.verdict = report.ok ? 'state survived process death on all recorded platforms' : 'state DID NOT survive on at least one platform';
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(report, null, 2) + '\n'); } catch { /* best effort */ }
}

/**
 * Does this app declare a survival block? Pure (reads a parsed journey), so the
 * self-test can exercise it without a device. Returns false for a missing/blank
 * block so callers SKIP cleanly rather than error.
 */
export function hasSurvival(journey) {
  return !!(journey && journey.survival && Array.isArray(journey.survival.steps) && journey.survival.steps.length);
}

/** The maestro argv for a survival run — pure so the self-test can assert it. */
export function maestroArgs({ device, platform }) {
  const argv = [];
  if (device) argv.push('--device', device);
  argv.push('test', SURVIVAL_FLOW);
  // Maestro decides `when: platform:` from the connected device, so PLATFORM is
  // informational only; pass it when known for parity with the capture pipeline.
  if (platform) argv.push(`--env=PLATFORM=${platform}`);
  argv.push('--debug-output', path.join('qa', 'maestro-debug', 'survival'));
  return argv;
}

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

  ok(hasSurvival({ survival: { steps: [{ killApp: true }] } }) === true, 'hasSurvival true when steps present');
  ok(hasSurvival({ survival: { steps: [] } }) === false, 'hasSurvival false on empty steps');
  ok(hasSurvival({}) === false, 'hasSurvival false when no block');
  ok(hasSurvival(null) === false, 'hasSurvival false on null');

  const a = maestroArgs({ device: 'emulator-5554', platform: 'android' });
  ok(a[0] === '--device' && a[1] === 'emulator-5554', 'device threads through');
  ok(a.includes('test') && a.includes(SURVIVAL_FLOW), 'runs the survival flow');
  ok(a.includes('--env=PLATFORM=android'), 'platform env passed when known');
  const b = maestroArgs({});
  ok(b[0] === 'test', 'no --device when omitted');
  ok(!b.some((x) => x.startsWith('--env=PLATFORM')), 'no platform env when omitted');

  console.log(`run-survival self-test: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const VALUE_FLAGS = new Set(['--platform', '--device']);
  const appDir = path.resolve(args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1])) || process.cwd());
  const platform = valueOf('--platform');
  const device = valueOf('--device');
  const dry = flags.has('--dry-run');

  const journeyPath = path.join(appDir, 'qa', 'journey.json');
  if (!fs.existsSync(journeyPath)) {
    console.log(`run-survival: no qa/journey.json in ${appDir} — nothing to run.`);
    return;
  }
  const journey = JSON.parse(fs.readFileSync(journeyPath, 'utf8'));
  if (!hasSurvival(journey)) {
    console.log(`run-survival: ${path.basename(appDir)} declares no survival block — skip.`);
    return;
  }

  // Compile first so the on-disk flow can't be stale vs journey.survival.
  const compile = spawnSync('node', [path.join('scripts', 'qa', 'compile-flow.mjs')],
    { cwd: appDir, stdio: 'inherit' });
  if (compile.status !== 0) { console.error('run-survival: compile-flow failed.'); process.exit(1); }

  const argv = maestroArgs({ device, platform });
  console.log(`run-survival: ${path.basename(appDir)} — maestro ${argv.join(' ')}${dry ? '  [DRY RUN]' : ''}`);
  if (dry) return;

  const r = spawnSync('maestro', argv, { cwd: appDir, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    console.error('run-survival: maestro CLI not installed.');
    process.exit(1);
  }
  if (r.status !== 0) {
    writeSurvivalReport(appDir, platform, false);
    console.error(`run-survival: state DID NOT survive the kill on ${path.basename(appDir)} — a production-class defect. File it: node scripts/defects.mjs open --app ${path.basename(appDir)} --found-by chaos-net --title "state lost across process death"`);
    process.exit(1);
  }
  writeSurvivalReport(appDir, platform, true);
  console.log(`run-survival: ${path.basename(appDir)} — state survived process death. ✓`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
