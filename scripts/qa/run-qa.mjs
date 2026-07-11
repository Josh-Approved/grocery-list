#!/usr/bin/env node
/**
 * run-qa.mjs — produce a compact QA VERDICT for an app: qa/qa-report.json.
 *
 * This is the one file an agent (or human) reads to know if an app is healthy —
 * NOT logs, NOT screenshots, NOT a per-tap device loop (the studio's biggest
 * token sink, see memory feedback_screenshot_capture_tokens.md). CI and submit
 * gates emit it; the triage agent (scripts/qa/triage.mjs) consumes it.
 *
 * It runs the cheap, headless-verifiable tiers and records a structured result:
 *   • Tier 1 — unit (jest):       does `npm test` pass? how many?
 *   • Tier 2 — flow (static):     is the generated flow fresh + do selectors
 *                                  ground? (the live device run is CI/capture.mjs)
 *   • Lint  — qa-canonical tiers: the test/* and flows/* rule severities.
 *
 * It does NOT build or boot a device — that's capture.mjs / CI. It is safe to
 * run unattended and in seconds.
 *
 * Usage:
 *   node scripts/qa/run-qa.mjs [appDir] [--profile testflight|production]
 *                              [--json] [--out qa/qa-report.json]
 *
 * Exit code: 0 if the report is OK for the chosen profile, 1 otherwise — so it
 * can gate a submit step. Profile gate (canon § QA & testing):
 *   • testflight  = Tier 1 must pass (Tier 2 is smoke/optional)
 *   • production  = Tier 1 must pass AND Tier 2 static must pass (or be cleanly
 *                   not-adopted); a Tier 2 FAILURE always blocks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const appDir = path.resolve(positional[0] || process.cwd());
const profile = (() => {
  const i = args.indexOf('--profile');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'production';
})();
const outArg = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'qa/qa-report.json';
})();
const toStdout = flags.has('--json');

const exists = (p) => fs.existsSync(p);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ---------- Tier 1: unit (jest) ----------
function runUnit() {
  const pkg = readJson(path.join(appDir, 'package.json'));
  const testScript = pkg && pkg.scripts && pkg.scripts.test;
  if (!testScript || /no test specified/i.test(testScript)) {
    return { status: 'skip', reason: 'no test script', passed: 0, failed: 0, total: 0, failures: [] };
  }
  let out;
  try {
    out = execSync('npx jest --json --passWithNoTests', { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // jest exits 1 on test failure but still prints the JSON report to stdout.
    out = e.stdout || '';
  }
  // jest prints the JSON as the last line; find the last '{' ... parse.
  let report = null;
  const start = out.lastIndexOf('\n{');
  try { report = JSON.parse(start >= 0 ? out.slice(start + 1) : out); } catch { /* fall through */ }
  if (!report) return { status: 'error', reason: 'could not parse jest output', passed: 0, failed: 0, total: 0, failures: [] };
  const failures = [];
  for (const tr of report.testResults || []) {
    for (const a of tr.assertionResults || []) {
      if (a.status === 'failed') {
        failures.push({ file: path.relative(appDir, tr.name || ''), title: a.fullName || a.title, message: (a.failureMessages || []).join('\n').split('\n').slice(0, 3).join(' ') });
      }
    }
  }
  return {
    status: report.numFailedTests > 0 || report.numFailedTestSuites > 0 ? 'fail' : 'pass',
    passed: report.numPassedTests || 0,
    failed: report.numFailedTests || 0,
    total: report.numTotalTests || 0,
    suitesFailed: report.numFailedTestSuites || 0,
    failures: failures.slice(0, 25),
  };
}

// ---------- Tier 2: flow (static) ----------
async function runFlowStatic() {
  const journeyPath = path.join(appDir, 'qa', 'journey.json');
  if (!exists(journeyPath)) return { status: 'skip', reason: 'no qa/journey.json (capture pipeline not adopted)' };
  const result = { status: 'pass', stale: false, lint: null, assertions: 0 };
  // Freshness: generated yaml must match a fresh compile.
  try {
    execSync(`node ${JSON.stringify(path.join(appDir, 'scripts', 'qa', 'compile-flow.mjs'))} ${JSON.stringify(appDir)} --check`, { cwd: appDir, stdio: 'ignore' });
  } catch { result.stale = true; result.status = 'fail'; }
  // Outcome assertions present?
  const journey = readJson(journeyPath);
  result.assertions = (journey && Array.isArray(journey.steps) ? journey.steps : []).filter((s) => s && (('assert' in s) || ('assertNot' in s))).length;
  // Selector grounding via the app's own linter.
  const linterPath = path.join(appDir, 'scripts', 'qa', 'lint-flows.mjs');
  if (exists(linterPath)) {
    try {
      const mod = await import(pathToFileURL(linterPath).href);
      const lint = mod.lintFlows ? mod.lintFlows(appDir) : null;
      if (Array.isArray(lint)) {
        const fails = lint.filter((r) => r.severity === 'fail').length;
        result.lint = { fail: fails, total: lint.length };
        if (fails > 0) result.status = 'fail';
      }
    } catch (e) { result.lint = { error: e.message }; }
  }
  return result;
}

// ---------- Tier "matrix": cross-device net (P10) ----------
// Reads the artifacts the deterministic matrix run already wrote — never drives
// a device here. Gate policy (canon § QA & testing + uplevel/10):
//   • production = full matrix must be green: no unaccepted visual regression,
//     no failed cell, no reviewer blocker/major.
//   • testflight = smoke is enough: only a reviewer BLOCKER or a failed smoke
//     cell blocks; a missing full matrix does not.
// Graceful rollout: absent artifacts => 'skip' (a WARN-equivalent), unless the
// app opts in via qa/baseline.json "device-net/enforce": true, which makes a
// missing full matrix block production (same doctrine as "testing/enforce").
function runMatrix(profile) {
  const visual = readJson(path.join(appDir, 'qa', 'visual-reg.json'));
  const matrixReport = readJson(path.join(appDir, 'qa', 'matrix-report.json'));
  const triage = readJson(path.join(appDir, 'qa', 'qa-triage.json'));
  const baseline = readJson(path.join(appDir, 'qa', 'baseline.json')) || {};
  const enforce = baseline['device-net/enforce'] === true;

  if (!visual && !matrixReport) {
    return { status: enforce && profile === 'production' ? 'fail' : 'skip',
      reason: enforce ? 'device-net enforced but no matrix has run (run scripts/qa/matrix.mjs --profile full)' : 'no matrix run yet (device-net rolling out)' };
  }

  const regressions = visual && visual.status === 'ok' ? (visual.regressions || 0) : 0;
  const cellFails = matrixReport ? (matrixReport.cells || []).filter((c) => c.status === 'fail').length : 0;
  const matrixProfile = matrixReport ? matrixReport.profile : null;
  const reviewer = (triage && triage.reviewerPass && Array.isArray(triage.reviewerPass.findings)) ? triage.reviewerPass.findings : [];
  const reviewerBlockers = reviewer.filter((f) => f.severity === 'blocker').length;
  const reviewerMajors = reviewer.filter((f) => f.severity === 'major').length;

  let status = 'pass';
  if (profile === 'production') {
    if (regressions > 0 || cellFails > 0 || reviewerBlockers > 0 || reviewerMajors > 0) status = 'fail';
    else if (enforce && matrixProfile !== 'full') status = 'fail';
  } else { // testflight / smoke
    if (reviewerBlockers > 0 || cellFails > 0) status = 'fail';
  }
  return { status, profile: matrixProfile, regressions, cellFails, reviewerBlockers, reviewerMajors };
}

// ---------- Tier "twoDevice": network chaos on the two-device rig (T4 stage 2) ----------
// Gates the two-device sync E2E for apps that consume shared-sync — currently
// gated NOWHERE (survey gap #3). Read-only like the matrix tier: it never boots
// a device here; it reads the artifact the Mac-present run wrote
// (qa/e2e-sync-report.json), plus cheap static checks (harness wired + chaos
// catalog shape valid). "Consumer of shared-sync" is derived the same way the
// module-consumers map is: the overwrite-synced src/sync/transport.ts present.
// Gate policy (canon § QA & testing doctrine, mirrors device-net):
//   • not a sync consumer          => 'skip' (not applicable)
//   • production + two-device/enforce:
//       harness missing / catalog invalid / no green report => 'fail'
//   • production without enforce, or testflight => 'skip' (rolling out)
async function runTwoDevice(profile) {
  const isConsumer = exists(path.join(appDir, 'src', 'sync', 'transport.ts'));
  if (!isConsumer) return { status: 'skip', reason: 'not a shared-sync consumer' };

  const baseline = readJson(path.join(appDir, 'qa', 'baseline.json')) || {};
  const enforce = baseline['two-device/enforce'] === true;
  const enforcedProd = enforce && profile === 'production';

  const e2eDir = path.join(appDir, 'scripts', 'e2e');
  const harnessFiles = ['chaos-relay.mjs', 'chaos-scenarios.mjs', 'mini-relay.mjs', 'harness-lib.sh'];
  const missing = harnessFiles.filter((f) => !exists(path.join(e2eDir, f)));
  const hasFlows = exists(path.join(appDir, 'qa', 'flows', 'e2e-sync'));
  if (missing.length || !hasFlows) {
    const reason = `two-device harness not wired (${missing.length ? 'missing ' + missing.join(',') : 'no qa/flows/e2e-sync'}) — sync module e2e-two-device`;
    return { status: enforcedProd ? 'fail' : 'skip', reason };
  }

  // Cheap, pure catalog validation (no toxiproxy, no ws) — chaos-scenarios.mjs
  // is import-safe. Guards against a broken/forked scenario schedule shipping.
  let catalogProblems = [];
  try {
    const mod = await import(pathToFileURL(path.join(e2eDir, 'chaos-scenarios.mjs')).href);
    catalogProblems = mod.validateCatalog ? mod.validateCatalog() : ['no validateCatalog export'];
  } catch (e) {
    catalogProblems = ['catalog import failed: ' + e.message];
  }
  if (catalogProblems.length) {
    return { status: enforcedProd ? 'fail' : 'skip', reason: 'chaos catalog invalid: ' + catalogProblems.join('; ') };
  }

  const report = readJson(path.join(appDir, 'qa', 'e2e-sync-report.json'));
  if (!report) {
    return { status: enforcedProd ? 'fail' : 'skip',
      reason: enforcedProd ? 'two-device enforced but no run recorded (run scripts/e2e/run-two-device.sh + run-chaos.sh on a Mac)' : 'two-device wired; no device run recorded yet (rolling out)' };
  }
  const failures = Array.isArray(report.scenarios) ? report.scenarios.filter((s) => !s.ok) : [];
  const runOk = report.ok === true && failures.length === 0;
  let status;
  if (profile === 'production') status = runOk ? 'pass' : (enforce ? 'fail' : 'skip');
  else status = 'skip'; // testflight: sync E2E is a production-gate concern
  return { status, ok: runOk, suite: report.suite, scenarios: report.scenarios, failures: failures.map((f) => f.name) };
}

// ---------- Tier "upgrade": migration harness (T4 stage 4) ----------
// Gates the upgrade/migration harness (scripts/qa/upgrade-test.mjs): install the
// last-released binary, write data, install HEAD OVER it (no uninstall), assert
// the data survived. Read-only here like the matrix/twoDevice tiers: it never
// boots a device; it reads the artifact the Mac-present run wrote
// (qa/upgrade-report.json). The device run itself is Mac-present → T5-scheduled.
// Gate policy (mirrors device-net/two-device, canon § QA & testing doctrine):
//   • no upgrade block in journey.json      => 'skip' (rolling out, like survival)
//   • no released binary / no run recorded  => 'skip' unless upgrade/enforce
//   • production + upgrade/enforce + a recorded FAIL => 'fail'
//   • a recorded PASS => 'pass'
function runUpgrade(profile) {
  const journey = readJson(path.join(appDir, 'qa', 'journey.json'));
  const hasBlock = !!(journey && journey.upgrade && journey.upgrade.write && journey.upgrade.assert);
  if (!hasBlock) return { status: 'skip', reason: 'no journey.json "upgrade" block (migration harness rolling out)' };
  if (profile !== 'production') return { status: 'skip', reason: 'upgrade harness is a production-gate concern' };

  const baseline = readJson(path.join(appDir, 'qa', 'baseline.json')) || {};
  const enforce = baseline['upgrade/enforce'] === true;
  const report = readJson(path.join(appDir, 'qa', 'upgrade-report.json'));
  if (!report) {
    return { status: enforce ? 'fail' : 'skip',
      reason: enforce ? 'upgrade enforced but no run recorded (run scripts/qa/upgrade-test.mjs on a Mac with a released binary)' : 'upgrade harness wired; no device run recorded yet (rolling out / no local released binary)' };
  }
  if (report.ok === true) return { status: 'pass', platform: report.platform, oldSource: report.oldSource };
  // A recorded loss blocks production when enforced; otherwise it's still surfaced.
  return { status: enforce ? 'fail' : 'skip', reason: report.verdict || 'upgrade lost data', platform: report.platform };
}

// ---------- Defect loop: no unproven fix at release (T0 stage 2) ----------
// The failing-first fix gate (regression-gate.mjs) advances a defect out of
// `proving` only once its regression test provably fails on the pre-fix code.
// A record still sitting in `proving` at release means a fix landed without its
// proof — that must not ship (SQLite/WebKit's merge rule, machine-enforced).
// Rollout doctrine (same as testing/*): an absent ledger simply skips.
function runDefectGate(app, profile) {
  if (profile !== 'production') return { status: 'skip', reason: 'defect gate is production-only' };
  const cli = path.join(__dirname, '..', 'defects.mjs');
  if (!exists(cli)) return { status: 'skip', reason: 'no defects.mjs (defect loop not present)' };
  let out;
  try {
    out = execFileSync('node', [cli, 'list', '--app', app, '--status', 'proving', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return { status: 'skip', reason: 'no ledger for this app (defect loop rolling out)' }; }
  let recs;
  try { recs = JSON.parse(out); } catch { return { status: 'skip', reason: 'ledger unreadable' }; }
  const proving = Array.isArray(recs) ? recs : [];
  if (!proving.length) return { status: 'pass', proving: 0 };
  return { status: 'fail', proving: proving.length, ids: proving.map((r) => r.id) };
}

// ---------- Gates prove failure: dead-sensor check (T2 stage 2) ----------
// Every checkable gate must reject a checked-in known-bad; a gate that reports
// green over its known-bad is a DEAD SENSOR — a hole exactly where the net says
// "covered" (canon 2026-07-02, the demo-frame miss, generalized). A dead sensor
// blocks a production release. prove-gates.mjs is the app's own synced runner; it
// uses the app's own gates (qa-canonical, lint-flows) against qa/known-bad/.
// Rollout doctrine (mirrors testing/*): an app with no registry yet simply skips.
function runProveGates(profile) {
  if (profile !== 'production') return { status: 'skip', reason: 'dead-sensor check is a production-gate concern' };
  const runner = path.join(__dirname, 'prove-gates.mjs');
  if (!exists(runner)) return { status: 'skip', reason: 'no prove-gates.mjs (gates-prove-failure rolling out)' };
  let out;
  try {
    out = execFileSync('node', [runner, appDir, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // prove-gates exits 1 on a dead sensor / malformed registry but still prints its JSON.
    out = e.stdout || '';
  }
  let rep;
  try { rep = JSON.parse(out); } catch { return { status: 'error', reason: 'could not parse prove-gates output' }; }
  if (rep.status === 'skip') return { status: 'skip', reason: rep.reason || 'no known-bad registry' };
  if (rep.status === 'error') return { status: 'fail', reason: `known-bad registry malformed: ${(rep.problems || []).join('; ')}` };
  return rep.ok
    ? { status: 'pass', total: rep.total }
    : { status: 'fail', dead: rep.dead || [], reason: rep.verdict || `dead sensor(s): ${(rep.dead || []).join(', ')}` };
}

// ---------- Tier "nightly": last nightly green or its defects triaged (T5) ----------
// The nightly deep-suites engine (templates/qa/nightly.yml.template) runs the
// heavy tiers off the sacred per-PR budget and NEVER blocks — a red nightly files
// defects. This tier makes production honour that signal: a new production
// release requires the app's last nightly to have gone green on both platforms
// OR every defect it filed to be triaged (closed/waived/no longer open). Read-
// only: it reads the digest cache (scripts/qa/nightly-digest.mjs) + the ledger,
// never runs a suite. Rollout doctrine (mirrors device-net/two-device/upgrade):
// no digest yet → skip unless the app opts in with qa/baseline.json
// "nightly/enforce": true.
function runNightly(app, profile) {
  if (profile !== 'production') return { status: 'skip', reason: 'nightly gate is production-only' };
  const baseline = readJson(path.join(appDir, 'qa', 'baseline.json')) || {};
  const enforce = baseline['nightly/enforce'] === true;
  const digest = readJson(path.join(__dirname, '..', '..', 'scratch', 'cache', 'nightly-digest.json'));
  const entry = digest && digest.apps ? digest.apps[app] : null;
  if (!entry) {
    return { status: enforce ? 'fail' : 'skip',
      reason: enforce ? 'nightly enforced but no digest yet (run scripts/qa/nightly-digest.mjs)' : 'no nightly digest yet (nightly engine rolling out)' };
  }
  if (entry.netGreen) return { status: 'pass', platforms: entry.platforms };
  // Not green — pass only if every net-found defect has been triaged.
  const cli = path.join(__dirname, '..', 'defects.mjs');
  let open = [];
  if (exists(cli)) {
    try {
      const out = execFileSync('node', [cli, 'list', '--app', app, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const recs = JSON.parse(out);
      open = (Array.isArray(recs) ? recs : []).filter((r) => r.status !== 'closed' && r.status !== 'waived' && r.foundBy === 'net' && ['correctness', 'build', 'ux'].includes(r.class));
    } catch { /* no ledger → nothing open */ }
  }
  if (!open.length) return { status: 'pass', triaged: true, reason: 'nightly not green but all filed defects triaged' };
  const p = entry.platforms || {};
  return { status: enforce ? 'fail' : 'skip',
    reason: `last nightly not green (iOS ${p.ios || 'none'}, Android ${p.android || 'none'}); ${open.length} open net-found defect(s): ${open.map((r) => r.id).slice(0, 4).join(', ')}` };
}

// ---------- Tier "survival": chaos subflows green (T4/T5) ----------
// The state-survival subflow (kill + relaunch, assert the persisted write) is a
// chaos-net subflow that runs in the full profile / nightly, not per-PR. Read-
// only like the device tiers: it reads qa/survival-report.json (written by
// scripts/qa/run-survival.mjs on a Mac-present run). Rollout doctrine: no
// survival block → skip; no run recorded → skip unless "survival/enforce".
function runSurvival(profile) {
  if (profile !== 'production') return { status: 'skip', reason: 'chaos subflows are a production-gate concern' };
  const journey = readJson(path.join(appDir, 'qa', 'journey.json'));
  const hasBlock = !!(journey && journey.survival && Array.isArray(journey.survival.steps) && journey.survival.steps.length);
  if (!hasBlock) return { status: 'skip', reason: 'no journey.json "survival" block (chaos subflow rolling out)' };
  const baseline = readJson(path.join(appDir, 'qa', 'baseline.json')) || {};
  const enforce = baseline['survival/enforce'] === true;
  const report = readJson(path.join(appDir, 'qa', 'survival-report.json'));
  if (!report) {
    return { status: enforce ? 'fail' : 'skip',
      reason: enforce ? 'survival enforced but no run recorded (run scripts/qa/run-survival.mjs on a Mac)' : 'survival wired; no device run recorded yet (rolling out)' };
  }
  if (report.ok === true) return { status: 'pass', platforms: report.platforms };
  return { status: enforce ? 'fail' : 'skip', reason: report.verdict || 'state did not survive process death' };
}

// ---------- Lint: qa-canonical testing tiers ----------
function runLintTiers() {
  const canon = path.join(appDir, 'scripts', 'qa-canonical.mjs');
  if (!exists(canon)) return { status: 'skip', reason: 'no scripts/qa-canonical.mjs' };
  let out;
  try {
    out = execSync(`node ${JSON.stringify(canon)} ${JSON.stringify(appDir)} --json`, { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { out = e.stdout || ''; }
  const parsed = (() => { try { return JSON.parse(out); } catch { return null; } })();
  if (!parsed) return { status: 'error', reason: 'could not parse qa-canonical output' };
  const tierRules = (parsed.results || []).filter((r) => /^(test\/|flows\/)/.test(r.id))
    .map((r) => ({ id: r.id, severity: r.severity }));
  const anyFail = tierRules.some((r) => r.severity === 'fail');
  return { status: anyFail ? 'fail' : 'pass', rules: tierRules };
}

// ---------- assemble ----------
const unit = runUnit();
const flow = await runFlowStatic();
const lint = runLintTiers();
const matrix = runMatrix(profile);
const twoDevice = await runTwoDevice(profile);
const upgrade = runUpgrade(profile);
const defects = runDefectGate(path.basename(appDir), profile);
const proveGates = runProveGates(profile);
const nightly = runNightly(path.basename(appDir), profile);
const survival = runSurvival(profile);

// Gate: a tier that ERRORs or FAILs blocks; SKIP/PASS are fine.
const unitOk = unit.status === 'pass' || unit.status === 'skip';
const flowFailed = flow.status === 'fail';
const lintFailed = lint.status === 'fail';
const matrixFailed = matrix.status === 'fail';
const twoDeviceFailed = twoDevice.status === 'fail';
const upgradeFailed = upgrade.status === 'fail';
const defectsFailed = defects.status === 'fail';
const proveGatesFailed = proveGates.status === 'fail' || proveGates.status === 'error';
const nightlyFailed = nightly.status === 'fail';
const survivalFailed = survival.status === 'fail';
const ok = profile === 'testflight'
  ? unitOk && !lintFailed && !matrixFailed       // Tier 1 + lint + device smoke; Tier 2 is smoke/optional
  : unitOk && !flowFailed && !lintFailed && !matrixFailed && !twoDeviceFailed && !upgradeFailed && !defectsFailed && !proveGatesFailed && !nightlyFailed && !survivalFailed;  // production: Tier 2 + full matrix + two-device sync + upgrade migration + no unproven fix + no dead sensor + last nightly green/triaged + chaos subflows survived

const report = {
  app: path.basename(appDir),
  profile,
  ok,
  // NOTE: timestamp intentionally omitted — Date.now() is unavailable in some
  // factory contexts and would make the artifact non-deterministic. CI/commit
  // metadata carries the time.
  tiers: { unit, flow, lint, matrix, twoDevice, upgrade, defects, proveGates, nightly, survival },
  // The agent's reading guide — what to do, in one line, without opening logs.
  verdict: ok
    ? `OK for ${profile}: ${unit.status === 'skip' ? 'no unit tests' : unit.passed + ' tests pass'}${flow.status === 'pass' ? ', flow static green' : ''}${matrix.status === 'pass' ? ', device matrix green' : ''}.`
    : `BLOCKED for ${profile}: ${[
        unit.status === 'fail' && `${unit.failed} unit test(s) failing`,
        flow.status === 'fail' && (flow.stale ? 'flow yaml stale (re-run compile-flow)' : 'selector grounding failed (run heal)'),
        lint.status === 'fail' && 'qa-canonical testing rule failing',
        matrix.status === 'fail' && (matrix.reason || `device matrix: ${matrix.regressions || 0} visual regression(s), ${matrix.cellFails || 0} failed cell(s), ${matrix.reviewerBlockers || 0} reviewer blocker(s)` + ' (accept intended changes via visual-reg --accept)'),
        twoDevice.status === 'fail' && (twoDevice.reason || `two-device sync E2E: ${(twoDevice.failures || []).join(', ') || 'not green'} (run scripts/e2e/run-two-device.sh + run-chaos.sh)`),
        upgrade.status === 'fail' && (upgrade.reason || `upgrade migration: data lost across install-over (run scripts/qa/upgrade-test.mjs)`),
        defects.status === 'fail' && `${defects.proving} defect(s) unproven at release (${(defects.ids || []).join(', ')}) — run scripts/qa/regression-gate.mjs to prove the failing-first test, or waive`,
        proveGatesFailed && (proveGates.reason || `dead sensor(s): ${(proveGates.dead || []).join(', ')} — a gate reports green over its known-bad; fix the gate (run scripts/qa/prove-gates.mjs)`),
        nightly.status === 'fail' && (nightly.reason || 'last nightly not green and its defects are not triaged (run scripts/qa/nightly-digest.mjs, then triage the ledger)'),
        survival.status === 'fail' && (survival.reason || 'chaos state-survival subflow did not survive process death (run scripts/qa/run-survival.mjs)'),
      ].filter(Boolean).join('; ')}`,
};

if (toStdout) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const outPath = path.isAbsolute(outArg) ? outArg : path.join(appDir, outArg);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.ok ? '✓' : '✗'} ${report.verdict}`);
  console.log(`  wrote ${path.relative(appDir, outPath)}`);
}

process.exit(report.ok ? 0 : 1);
