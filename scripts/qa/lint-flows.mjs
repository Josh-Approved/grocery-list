#!/usr/bin/env node
/**
 * lint-flows.mjs — Layer-1 drift guard for the screenshot/traversal pipeline.
 *
 * The expensive failure this prevents: a copy or screen change quietly breaks a
 * Maestro selector, and you don't find out until 20+ minutes into a cloud e2e
 * run (or worse, ship a blank screenshot). This runs in SECONDS, locally, with
 * no device — so drift is caught the moment the app changes.
 *
 * Four checks, in increasing cost:
 *   1. journey/anchor integrity — every @anchor referenced by qa/journey.json
 *      exists in qa/selectors.json and resolves (testID or text). [FAIL]
 *   2. yaml freshness — qa/flows/mobile.yaml matches a fresh compile, i.e.
 *      nobody hand-edited it and it reflects current journey+selectors. [FAIL]
 *   3. selector grounding — each anchor's testID actually exists in src/** ;
 *      each text anchor's literal stem appears in src/** . Missing testID is a
 *      hard FAIL (unambiguous); missing text is a WARN (copy can be composed
 *      at runtime, so we don't fail CI on a heuristic). [FAIL / WARN]
 *   4. maestro syntax — `maestro check-syntax` on the generated flow, if the
 *      CLI is installed. [FAIL / SKIP]
 *
 * Usage:
 *   node scripts/qa/lint-flows.mjs [app-dir] [--json] [--quiet]
 * Exit 0 if no FAIL, 1 otherwise. WARN never fails the run.
 *
 * Exported `lintFlows(appDir)` returns the results array so qa-canonical.mjs
 * (and tests) can fold this into the canonical linter without shelling out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileJourney, resolveSelector, survivalJourney } from './compile-flow.mjs';

const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);

function walkSource(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkSource(full, acc);
    else if (SRC_EXT.has(path.extname(e.name))) acc.push(full);
  }
  return acc;
}

/** Lowercase, strip punctuation, collapse whitespace — for token matching. */
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Longest literal run of a Maestro (regex) text selector, for a substring probe. */
function literalStem(text) {
  return String(text)
    .split(/[.*+?^${}()|[\]\\]/)
    .map((s) => s.trim())
    .sort((a, b) => b.length - a.length)[0] || '';
}

export function lintFlows(appDir) {
  const results = [];
  const add = (severity, id, message, detail) => results.push({ severity, id, message, detail });

  const journeyPath = path.join(appDir, 'qa', 'journey.json');
  const selectorsPath = path.join(appDir, 'qa', 'selectors.json');
  const yamlPath = path.join(appDir, 'qa', 'flows', 'mobile.yaml');
  const survivalYamlPath = path.join(appDir, 'qa', 'flows', 'state-survival.yaml');

  if (!fs.existsSync(journeyPath)) {
    add('skip', 'flows/journey', 'no qa/journey.json — flow pipeline not adopted yet');
    return results;
  }

  let journey, selectors;
  try {
    journey = JSON.parse(fs.readFileSync(journeyPath, 'utf8'));
  } catch (e) {
    add('fail', 'flows/journey-parse', `qa/journey.json is not valid JSON: ${e.message}`);
    return results;
  }
  try {
    selectors = fs.existsSync(selectorsPath)
      ? JSON.parse(fs.readFileSync(selectorsPath, 'utf8'))
      : { anchors: {} };
  } catch (e) {
    add('fail', 'flows/selectors-parse', `qa/selectors.json is not valid JSON: ${e.message}`);
    return results;
  }
  const anchors = selectors.anchors || {};

  // (1) Journey integrity + collect referenced anchors. compileJourney throws on
  // an unknown @anchor or malformed step, which is exactly the integrity check.
  let yaml = null;
  const referenced = new Set();
  const collectAnchors = (steps) => {
    for (const step of steps || []) {
      for (const k of ['waitFor', 'assert', 'assertNot', 'tap', 'scrollUntilVisible']) {
        if (typeof step[k] === 'string' && step[k].startsWith('@')) referenced.add(step[k].slice(1));
      }
    }
  };
  collectAnchors(journey.steps);
  collectAnchors(journey.survival && journey.survival.steps);
  try {
    yaml = compileJourney(journey, selectors, appDir);
    add('pass', 'flows/journey', `journey compiles (${(journey.steps || []).length} steps, ${referenced.size} anchors used)`);
  } catch (e) {
    add('fail', 'flows/journey', e.message);
    // Can't do yaml-freshness without a compile, but still ground the anchors.
  }

  // (2) yaml freshness.
  if (yaml != null) {
    const current = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : null;
    if (current == null) {
      add('fail', 'flows/yaml-fresh', 'qa/flows/mobile.yaml missing — run compile-flow.mjs');
    } else if (current !== yaml) {
      add('fail', 'flows/yaml-fresh', 'qa/flows/mobile.yaml is STALE vs journey/selectors — run compile-flow.mjs');
    } else {
      add('pass', 'flows/yaml-fresh', 'qa/flows/mobile.yaml matches journey+selectors');
    }
  }

  // (2b) state-survival flow freshness (T4 chaos net) — only when the app
  // declares a `survival` block. It's a separate artifact from mobile.yaml so it
  // can run in the full profile + nightly, never per-PR.
  let survivalYaml = null;
  try {
    const sj = survivalJourney(journey);
    survivalYaml = sj ? compileJourney(sj, selectors, appDir) : null;
  } catch (e) {
    add('fail', 'flows/survival', e.message);
  }
  if (survivalYaml != null) {
    const cur = fs.existsSync(survivalYamlPath) ? fs.readFileSync(survivalYamlPath, 'utf8') : null;
    if (cur == null) {
      add('fail', 'flows/survival-fresh', 'qa/flows/state-survival.yaml missing — run compile-flow.mjs');
    } else if (cur !== survivalYaml) {
      add('fail', 'flows/survival-fresh', 'qa/flows/state-survival.yaml is STALE vs journey.survival — run compile-flow.mjs');
    } else {
      add('pass', 'flows/survival-fresh', `qa/flows/state-survival.yaml matches journey.survival (${journey.survival.steps.length} steps)`);
    }
  }

  // (3) Selector grounding against src/**.
  const srcRoots = ['src', 'App.tsx', 'app'].map((p) => path.join(appDir, p));
  const files = [];
  for (const r of srcRoots) {
    if (!fs.existsSync(r)) continue;
    if (fs.statSync(r).isDirectory()) walkSource(r, files);
    else files.push(r);
  }
  const haystack = files.map((f) => {
    try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
  }).join('\n');

  // Declared testIDs in source: `testID="x"`, `testID={'x'}`, `testID: 'x'`,
  // plus suffixed carriers like react-navigation's `tabBarButtonTestID: 'x'`.
  const declaredTestIds = new Set();
  for (const m of haystack.matchAll(/[Tt]estID\s*[=:]\s*[{(]?\s*[`"']([^`"']+)[`"']/g)) {
    declaredTestIds.add(m[1]);
  }

  // Only ground anchors the journey actually uses (unused ones are a separate warn).
  for (const key of referenced) {
    const a = anchors[key];
    if (!a) continue; // already a FAIL from journey integrity
    if (a.testID) {
      if (declaredTestIds.has(a.testID)) {
        add('pass', `flows/anchor:${key}`, `testID "${a.testID}" present in source`);
      } else {
        add('fail', `flows/anchor:${key}`,
          `anchor @${key} uses testID "${a.testID}" but no element declares it in src/**`,
          'Add testID="' + a.testID + '" to the element, or fix the anchor.');
      }
    } else if (a.text) {
      const stem = literalStem(a.text);
      // Composed labels ("Edit " + fixtureName) won't appear verbatim, but every
      // significant token will — accept that as grounded too, so we only WARN on
      // a token that's genuinely absent (real drift).
      const tokens = haystack.toLowerCase();
      const words = norm(a.text).split(' ').filter((w) => w.length >= 3);
      if (stem.length >= 3 && haystack.includes(stem)) {
        add('pass', `flows/anchor:${key}`, `text "${a.text}" grounded (stem "${stem}" in source)`);
      } else if (words.length && words.every((w) => tokens.includes(w))) {
        add('pass', `flows/anchor:${key}`, `text "${a.text}" grounded (all tokens in source; likely composed at runtime)`);
      } else {
        const missing = words.filter((w) => !tokens.includes(w));
        add('warn', `flows/anchor:${key}`,
          `anchor @${key} text "${a.text}" not found in src/**${missing.length ? ` (missing: ${missing.join(', ')})` : ''} — may be composed, or drifted`,
          'If the copy changed, run heal.mjs or fix the anchor. Add a testID to stop this churning.');
      }
    }
  }

  // Unused anchors — harmless, but flag so the registry doesn't rot.
  for (const key of Object.keys(anchors)) {
    if (!referenced.has(key)) add('warn', `flows/unused:${key}`, `anchor @${key} defined but unused by the journey`);
  }

  // (4) maestro check-syntax (no device needed). Skip cleanly if not installed.
  if (yaml != null && fs.existsSync(yamlPath)) {
    const probe = spawnSync('maestro', ['check-syntax', yamlPath], { encoding: 'utf8' });
    if (probe.error && probe.error.code === 'ENOENT') {
      add('skip', 'flows/syntax', 'maestro CLI not installed — skipped check-syntax');
    } else if (probe.status === 0) {
      add('pass', 'flows/syntax', 'maestro check-syntax OK');
    } else {
      add('fail', 'flows/syntax', 'maestro check-syntax failed',
        (probe.stdout || '' + probe.stderr || '').split('\n').slice(0, 8).join('\n'));
    }
  }

  return results;
}

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const appDir = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());

  const results = lintFlows(appDir);
  const failed = results.filter((r) => r.severity === 'fail');

  if (flags.has('--json')) {
    console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
    process.exit(failed.length ? 1 : 0);
  }

  const icon = { pass: '✓', warn: '!', fail: '✗', skip: '·' };
  for (const r of results) {
    if (flags.has('--quiet') && r.severity !== 'fail') continue;
    console.log(`  ${icon[r.severity] || '?'} [${r.id}] ${r.message}`);
    if (r.detail && r.severity !== 'pass') console.log(`      ${r.detail}`);
  }
  const n = (s) => results.filter((r) => r.severity === s).length;
  console.log('');
  console.log(`flow-lint: ${n('pass')} pass, ${n('warn')} warn, ${n('fail')} fail, ${n('skip')} skip`);
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
