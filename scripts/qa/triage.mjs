#!/usr/bin/env node
/**
 * triage.mjs — bounded, autonomous handling of a red QA verdict.
 *
 * The point (memory project_qa_testing_pipeline.md): keep JOSH out of the loop.
 * When QA goes red, this reads the compact verdict (run-qa.mjs's qa-report.json),
 * AUTO-APPLIES the objective/reversible fix, and PROPOSES only the genuine
 * judgement calls into qa/qa-triage.json — the same doctrine as heal.mjs and
 * /reconcile-canon (auto-apply the confident, gate the rest). It never touches
 * app logic or invents test assertions; those become proposals an agent or human
 * resolves. It does not build or boot a device.
 *
 * Auto-fixable (with --apply):
 *   • stale generated flow  -> re-run compile-flow.mjs (purely mechanical)
 *
 * Proposed (never auto-applied — needs judgement or a device):
 *   • failing unit tests     -> the failing titles + messages (a logic decision)
 *   • selector grounding fail -> run `capture.mjs --heal` against a live screen
 *   • missing tests / assertions per the linter
 *
 * Usage:
 *   node scripts/qa/triage.mjs [appDir] [--apply] [--profile testflight|production]
 *
 * Exit 0 always (advisory). The gate is run-qa.mjs; this is the handler.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const appDir = path.resolve(positional[0] || process.cwd());
const apply = flags.has('--apply');
const profile = (() => { const i = args.indexOf('--profile'); return i >= 0 && args[i + 1] ? args[i + 1] : 'production'; })();

const runQa = path.join(appDir, 'scripts', 'qa', 'run-qa.mjs');
const compileFlow = path.join(appDir, 'scripts', 'qa', 'compile-flow.mjs');

function getReport() {
  // Always recompute fresh so triage reflects the current tree.
  let out;
  try {
    out = execSync(`node ${JSON.stringify(runQa)} ${JSON.stringify(appDir)} --profile ${profile} --json`, { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { out = e.stdout || ''; }
  try { return JSON.parse(out); } catch { return null; }
}

const report = getReport();
if (!report) {
  console.error('triage: could not obtain a qa-report (is scripts/qa/run-qa.mjs present?)');
  process.exit(0);
}

const autoApplied = [];
const proposals = [];

if (report.ok) {
  console.log(`✓ triage: nothing to do — ${report.verdict}`);
} else {
  const { unit, flow, lint } = report.tiers;

  // --- AUTO-FIX: stale generated flow ---
  if (flow && flow.status === 'fail' && flow.stale) {
    if (apply) {
      try {
        execSync(`node ${JSON.stringify(compileFlow)} ${JSON.stringify(appDir)}`, { cwd: appDir, stdio: 'ignore' });
        autoApplied.push({ kind: 'flow/stale', action: 'regenerated qa/flows/mobile.yaml via compile-flow.mjs' });
      } catch (e) {
        proposals.push({ kind: 'flow/stale', severity: 'major', summary: 'flow yaml is stale and auto-regenerate failed', detail: e.message, suggestedAction: 'run node scripts/qa/compile-flow.mjs and inspect' });
      }
    } else {
      proposals.push({ kind: 'flow/stale', severity: 'minor', summary: 'flow yaml is stale', detail: 'committed qa/flows/mobile.yaml does not match a fresh compile', suggestedAction: 're-run triage with --apply (auto-fixable) or node scripts/qa/compile-flow.mjs' });
    }
  }

  // --- PROPOSE: selector grounding failed (needs a live screen) ---
  if (flow && flow.status === 'fail' && !flow.stale && flow.lint && flow.lint.fail > 0) {
    proposals.push({ kind: 'flow/selector-drift', severity: 'major', summary: `${flow.lint.fail} selector(s) no longer ground against src/**`, detail: 'an anchor in qa/selectors.json points at copy/testID that moved', suggestedAction: 'run `node scripts/qa/capture.mjs . --store ios --heal` against a live screen; heal auto-applies the confident selector repair' });
  }

  // --- PROPOSE: failing unit tests (a logic decision, never auto-touched) ---
  if (unit && unit.status === 'fail') {
    proposals.push({
      kind: 'unit/failing',
      severity: 'blocker',
      summary: `${unit.failed} unit test(s) failing in the trust core`,
      detail: (unit.failures || []).map((f) => `${f.file} :: ${f.title} — ${f.message}`),
      suggestedAction: 'a failing trust-core test is either a real regression (fix the code) or an intended behavior change (update the test) — a judgement call; do NOT blindly edit the test to pass',
    });
  }

  // --- PROPOSE: linter testing-rule failures (missing tests/assertions) ---
  if (lint && lint.status === 'fail') {
    const failing = (lint.rules || []).filter((r) => r.severity === 'fail').map((r) => r.id);
    proposals.push({ kind: 'lint/testing', severity: 'major', summary: `qa-canonical testing rule(s) failing: ${failing.join(', ')}`, detail: failing, suggestedAction: 'add the missing trust-core unit tests and/or an outcome assertion per core action in qa/journey.json' });
  }

  console.log(`✗ triage: ${report.verdict}`);
  if (autoApplied.length) console.log(`  auto-applied: ${autoApplied.map((a) => a.kind).join(', ')}`);
  if (proposals.length) console.log(`  proposed (read qa/qa-triage.json): ${proposals.map((p) => p.kind).join(', ')}`);
}

const triageOut = {
  app: report.app,
  profile,
  ok: report.ok,
  autoApplied,
  proposals,
  // The agent's instruction, in one line.
  next: report.ok
    ? 'healthy — no action'
    : proposals.length
      ? 'an agent or human should resolve the proposals above; unit/selector/test-coverage items need judgement or a device, flow/stale is auto-fixable with --apply'
      : 'all detected issues were auto-applied; re-run run-qa.mjs to confirm green',
};
fs.writeFileSync(path.join(appDir, 'qa', 'qa-triage.json'), JSON.stringify(triageOut, null, 2) + '\n');

process.exit(0);
