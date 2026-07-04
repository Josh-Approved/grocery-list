/**
 * harnessCore.cjs — the PURE, node-testable core of the intent-fuzz kit
 * (Uplevel 3 / T1). CommonJS on purpose:
 *
 *   • `node templates/qa/intent-fuzz/selftest.mjs` can require it directly (no
 *     TypeScript, no fast-check, no app) to prove the pure logic — seed logging
 *     round-trip, story serialization, shrink-output shape.
 *   • the TypeScript `harness.ts` pulls it in via `require('./harnessCore.cjs')`
 *     (a call, so tsc never module-resolves it — the harness stays tsc-clean
 *     against a fresh Expo app with only `fast-check` in scope, and all the
 *     fs/path/node work lives here where tsc never touches it).
 *
 * This file owns the FAILURE-CRYSTALLIZATION path so it is defined once: a
 * counterexample becomes (1) a checked-in minimal-story fixture under
 * `qa/regressions/` (ratified condition 2), (2) a normalized line in the
 * gitignored `qa/defect-intake.jsonl` (folded into the ledger by
 * `scripts/defects.mjs ingest`), and (3) a line in the gitignored
 * `qa/fuzz-log.jsonl` so any night replays exactly from its logged seed.
 *
 * Signature normalization mirrors `templates/qa/defect-reporter/defect-reporter.cjs`
 * (advisory only — `defects.mjs ingest` recomputes the canonical key).
 *
 * Zero deps, zero network. Schema: `defects/_SCHEMA.md`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** PR smoke default; nightly default; the env overrides. */
const SMOKE_RUNS = 50;
const NIGHTLY_RUNS = 2000;

/**
 * How many fast-check runs this invocation does. Env, in order:
 *   FUZZ_RUNS=<int>          explicit count wins (used by the nightly engine)
 *   FUZZ_PROFILE=nightly     -> NIGHTLY_RUNS
 *   (anything else / unset)  -> SMOKE_RUNS (the blocking PR gate stays cheap)
 */
function resolveRuns(env) {
  const e = env || {};
  const raw = e.FUZZ_RUNS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number.parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return String(e.FUZZ_PROFILE || '').toLowerCase() === 'nightly' ? NIGHTLY_RUNS : SMOKE_RUNS;
}

function resolveProfile(env) {
  const e = env || {};
  if (String(e.FUZZ_PROFILE || '').toLowerCase() === 'nightly') return 'nightly';
  if (e.FUZZ_RUNS != null && String(e.FUZZ_RUNS).trim() !== '') return 'custom';
  return 'smoke';
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unnamed';
}

function today(env) {
  // Deterministic when a caller pins it (tests); otherwise real wall clock.
  if (env && env.DATE) return String(env.DATE);
  return new Date().toISOString().slice(0, 10);
}

/** The three artifact locations, derived from an app root. */
function paths(appRoot) {
  const root = appRoot || process.cwd();
  return {
    regressionsDir: path.join(root, 'qa', 'regressions'),
    fuzzLog: path.join(root, 'qa', 'fuzz-log.jsonl'),
    intake: path.join(root, 'qa', 'defect-intake.jsonl'),
  };
}

/** Deterministic JSON — sorted keys — so a serialized story is byte-stable
 *  across machines/runs (the checked-in fixture must not churn). */
function stableStringify(value) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) return v.map(norm);
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

function serializeStory(story) {
  return stableStringify(story);
}
function parseStory(str) {
  return JSON.parse(str);
}

// --- signature (advisory; mirrors defect-reporter.cjs) --------------------
function normalizeAssertion(msg) {
  if (!msg) return '';
  return String(msg)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(?:\/[^\s/:]+)+\/([^\s/:]+)/g, '$1')
    .replace(/[A-Za-z]:\\[^\s]+\\([^\s\\]+)/g, '$1')
    .replace(/\b(?:0x)?[0-9a-f]{6,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 100);
}
function baseNoExt(file) {
  return path
    .basename(String(file || 'unknown'))
    .replace(/\.(test|spec)\.[jt]sx?$/i, '')
    .replace(/\.[jt]sx?$/i, '');
}
function advisorySignature(file, fullName, assertion) {
  const base = baseNoExt(file);
  const full = String(fullName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const hash8 = crypto.createHash('sha1').update(normalizeAssertion(assertion)).digest('hex').slice(0, 8);
  return `test:${base}::${full}#${hash8}`;
}

/**
 * The shrunk fast-check counterexample, normalized. fast-check's `fc.check`
 * returns a details object; the shape we depend on is { failed, seed,
 * counterexamplePath, counterexample }. Throws (with a plain reason) if a
 * caller hands us something that is not a real, minimized failure — that guards
 * the crystallization path against writing an empty/garbage fixture.
 */
function validateShrinkShape(runDetails) {
  const d = runDetails || {};
  if (d.failed !== true) throw new Error('validateShrinkShape: runDetails.failed is not true (nothing to crystallize)');
  if (typeof d.seed !== 'number' || !Number.isFinite(d.seed)) throw new Error('validateShrinkShape: missing numeric seed');
  const p = d.counterexamplePath != null ? d.counterexamplePath : d.path;
  if (typeof p !== 'string' || p.length === 0) throw new Error('validateShrinkShape: missing counterexamplePath (fast-check did not shrink)');
  if (d.counterexample == null) throw new Error('validateShrinkShape: missing counterexample');
  return { seed: d.seed, path: p, counterexample: d.counterexample };
}

/** The human-readable minimal story — fast-check's shrunk command list stringifies
 *  to the exact sequence of actions that reproduces the failure. */
function storyText(counterexample) {
  try {
    if (Array.isArray(counterexample)) return counterexample.map((c) => String(c)).join('\n');
    return String(counterexample);
  } catch {
    return '<unserializable counterexample>';
  }
}

/** The checked-in regression fixture (ratified condition 2). */
function buildRegression({ app, model, seed, path: cePath, counterexample, message, date }) {
  return {
    kind: 'fuzz-seed',
    app: String(app || ''),
    model: String(model || ''),
    // The two values that let `fast-check` re-run the EXACT minimal case:
    seed,
    path: cePath,
    // Human articulation (the "shortest story that reproduces it"):
    story: storyText(counterexample),
    message: String(message || '').slice(0, 2000),
    savedAt: today({ DATE: date }),
  };
}

function validateRegressionShape(obj) {
  const o = obj || {};
  if (o.kind !== 'fuzz-seed') throw new Error('validateRegressionShape: kind must be "fuzz-seed"');
  if (!o.app) throw new Error('validateRegressionShape: missing app');
  if (!o.model) throw new Error('validateRegressionShape: missing model');
  if (typeof o.seed !== 'number') throw new Error('validateRegressionShape: seed must be a number');
  if (typeof o.path !== 'string' || !o.path) throw new Error('validateRegressionShape: path must be a non-empty string');
  if (o.story == null) throw new Error('validateRegressionShape: missing story');
  return true;
}

/** One defect-intake line (folded into the ledger by `defects.mjs ingest`). */
function buildIntakeLine({ app, model, seed, message, testFile, fullName, artifact, date }) {
  const file = testFile || `qa/intent-fuzz/models/${model}.model.ts`;
  const full = fullName || `intent-fuzz(${model}) > user intent survives randomized stories`;
  const assertion = String(message || 'intent oracle breached');
  return {
    kind: 'test-failure',
    file,
    fullName: full,
    assertion,
    class: 'correctness',
    date: today({ DATE: date }),
    signature: advisorySignature(file, full, assertion),
    repro: { kind: 'fuzz-seed', seed, artifact: artifact || null },
  };
}

function fuzzLogEntry({ app, model, seed, path: cePath, runs, profile, outcome, date }) {
  return {
    date: today({ DATE: date }),
    app: String(app || ''),
    model: String(model || ''),
    seed,
    path: cePath != null ? cePath : null,
    runs: runs != null ? runs : null,
    profile: profile || null,
    outcome: outcome || 'pass', // 'pass' | 'fail'
  };
}

// --- tiny fs helpers (single source; harness.ts calls through here) --------
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}
function writeJsonFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Log one completed fuzz run (pass or fail) to qa/fuzz-log.jsonl. Every run
 * records its seed so a nightly high-N run can be replayed exactly. Best-effort:
 * a logging failure never fails the test.
 */
function logRun({ appRoot, app, model, seed, runs, profile, outcome, date }) {
  try {
    const { fuzzLog } = paths(appRoot);
    appendJsonl(fuzzLog, fuzzLogEntry({ app, model, seed, runs, profile, outcome, date }));
  } catch {
    /* never fail a test because logging couldn't write */
  }
}

/**
 * Every checked-in regression fixture, parsed. `replay.ts` iterates these and
 * re-runs each minimal case (seed + path) against the app's current code —
 * ratified condition 2: the story runs as a normal Jest test forever. Missing
 * dir = no regressions yet (returns []).
 */
function listRegressions(appRoot) {
  const { regressionsDir } = paths(appRoot);
  let names = [];
  try {
    names = fs.readdirSync(regressionsDir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    const file = path.join(regressionsDir, name);
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      validateRegressionShape(obj);
      out.push({ ...obj, _file: name });
    } catch (e) {
      out.push({ _file: name, _error: (e && e.message) || String(e) });
    }
  }
  return out;
}

/**
 * THE FAILURE PATH, defined once. Given a fast-check `fc.check` details object
 * for a FAILING run, crystallize it: minimal-story fixture + intake line +
 * fuzz-log line. Returns { regressionFile } (or throws only if the shape is
 * invalid — a real failure always has a shrunk counterexample).
 */
function crystallizeFailure({ appRoot, app, model, runDetails, message, date }) {
  const { seed, path: cePath, counterexample } = validateShrinkShape(runDetails);
  const { regressionsDir, intake } = paths(appRoot);
  const regressionFile = path.join(regressionsDir, `${slugify(model)}-seed-${seed}.json`);

  const regression = buildRegression({ app, model, seed, path: cePath, counterexample, message, date });
  validateRegressionShape(regression);
  writeJsonFile(regressionFile, regression);

  const rel = (p) => {
    try { return path.relative(appRoot || process.cwd(), p) || p; } catch { return p; }
  };
  appendJsonl(intake, buildIntakeLine({ app, model, seed, message, artifact: rel(regressionFile), date }));
  logRun({ appRoot, app, model, seed, runs: runDetails.numRuns, profile: null, outcome: 'fail', date });

  return { regressionFile };
}

module.exports = {
  SMOKE_RUNS,
  NIGHTLY_RUNS,
  resolveRuns,
  resolveProfile,
  slugify,
  today,
  paths,
  stableStringify,
  serializeStory,
  parseStory,
  advisorySignature,
  validateShrinkShape,
  storyText,
  buildRegression,
  validateRegressionShape,
  buildIntakeLine,
  fuzzLogEntry,
  appendJsonl,
  writeJsonFile,
  listRegressions,
  logRun,
  crystallizeFailure,
};
