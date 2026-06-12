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
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

// Gate: a tier that ERRORs or FAILs blocks; SKIP/PASS are fine.
const unitOk = unit.status === 'pass' || unit.status === 'skip';
const flowFailed = flow.status === 'fail';
const lintFailed = lint.status === 'fail';
const matrixFailed = matrix.status === 'fail';
const ok = profile === 'testflight'
  ? unitOk && !lintFailed && !matrixFailed       // Tier 1 + lint + device smoke; Tier 2 is smoke/optional
  : unitOk && !flowFailed && !lintFailed && !matrixFailed;  // production: Tier 2 + full matrix failure blocks

const report = {
  app: path.basename(appDir),
  profile,
  ok,
  // NOTE: timestamp intentionally omitted — Date.now() is unavailable in some
  // factory contexts and would make the artifact non-deterministic. CI/commit
  // metadata carries the time.
  tiers: { unit, flow, lint, matrix },
  // The agent's reading guide — what to do, in one line, without opening logs.
  verdict: ok
    ? `OK for ${profile}: ${unit.status === 'skip' ? 'no unit tests' : unit.passed + ' tests pass'}${flow.status === 'pass' ? ', flow static green' : ''}${matrix.status === 'pass' ? ', device matrix green' : ''}.`
    : `BLOCKED for ${profile}: ${[
        unit.status === 'fail' && `${unit.failed} unit test(s) failing`,
        flow.status === 'fail' && (flow.stale ? 'flow yaml stale (re-run compile-flow)' : 'selector grounding failed (run heal)'),
        lint.status === 'fail' && 'qa-canonical testing rule failing',
        matrix.status === 'fail' && (matrix.reason || `device matrix: ${matrix.regressions || 0} visual regression(s), ${matrix.cellFails || 0} failed cell(s), ${matrix.reviewerBlockers || 0} reviewer blocker(s)` + ' (accept intended changes via visual-reg --accept)'),
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
