/**
 * defect-reporter.cjs — the Jest → defect-ledger intake bridge (Uplevel 3 / T0).
 *
 * On any failing test, appends one normalized intake line per failed assertion
 * to `<rootDir>/qa/defect-intake.jsonl` (gitignored). A session or job then folds
 * that file into the tracked ledger with:
 *
 *     node scripts/defects.mjs ingest --app <app>
 *
 * ingest RE-computes the canonical signature from the raw components below, so
 * `defects.mjs` stays the single source of truth for the dedupe key — the
 * `signature` this reporter writes is advisory only. Schema + normalization
 * spec: `defects/_SCHEMA.md`.
 *
 * T0 stage 3 — flake detection. It ALSO writes a fresh per-run outcome summary
 * to `<rootDir>/qa/test-run.json` (gitignored, latest-wins): every test's final
 * status + Jest invocation count. With `jest.retryTimes(1, {logErrorsBeforeRetry:
 * true})` a test that FAILED then PASSED on retry has `invocations > 1` with a
 * final `passed` — a fail-then-pass on the same commit, which is the flaky
 * signal (retries feed detection, they never hide it). `scripts/qa/flaky.mjs`
 * reads this summary to advance quarantine green-counters and to surface
 * detected-but-not-yet-quarantined flakes.
 *
 * The stable `testId` this file writes — `<file-basename-no-ext>::<full name>`
 * (ancestor titles + title joined by ' > ') — is the same key `flaky.mjs` and
 * the quarantine setup (`qa/quarantine.setup.cjs`) match on.
 *
 * PROOF-RUN / MUTATION SUPPRESSION (2026-07-21, ticket
 * defect-reporter-proof-run-pollution): deliberate failing-first proof runs
 * (T0's "prove the regression test fails on pre-fix code") and Stryker
 * mutation workers exercise failures ON PURPOSE — recording them as intake
 * pollutes the ledger with non-defects (~20 waived closes in the 2026-07-21
 * sweep). The reporter therefore writes NOTHING (no intake lines, no
 * test-run.json — proof/mutation outcomes must not advance or reset flake
 * counters either) when any of these hold:
 *   - env `JA_PROOF_RUN` is set to a truthy value ('1', 'true', …) — set it
 *     when running a deliberate failing-first proof (`regression-gate.mjs`
 *     sets it automatically; manual proof runs: `JA_PROOF_RUN=1 npx jest …`);
 *   - any `__STRYKER*` / `STRYKER*` env var is present (mutation workers);
 *   - the Jest rootDir or cwd is inside a `.stryker-tmp` sandbox.
 *
 * Zero deps, zero network, zero agent tokens. Synced into apps via `sync.mjs qa`.
 * Register it in an app's jest config:  "reporters": ["default", "<path>"].
 * Self-test: `node qa/defect-reporter.cjs --self-test`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

// advisory signature — kept in step with scripts/defects.mjs computeSignature();
// ingest recomputes canonically, so drift here is harmless.
function advisorySignature(file, fullName, assertion) {
  const base = path
    .basename(String(file || 'unknown'))
    .replace(/\.(test|spec)\.[jt]sx?$/i, '')
    .replace(/\.[jt]sx?$/i, '');
  const full = String(fullName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const hash8 = crypto.createHash('sha1').update(normalizeAssertion(assertion)).digest('hex').slice(0, 8);
  return `test:${base}::${full}#${hash8}`;
}

// Stable, path-independent test id shared with flaky.mjs + quarantine.setup.cjs:
// "<file-basename-no-ext>::<full test name>" where the full name is the ancestor
// titles + title joined by ' > '.
function baseNoExt(file) {
  return path
    .basename(String(file || 'unknown'))
    .replace(/\.(test|spec)\.[jt]sx?$/i, '')
    .replace(/\.[jt]sx?$/i, '');
}
function fullNameOf(a) {
  return [...(a.ancestorTitles || []), a.title].filter(Boolean).join(' > ');
}
function testIdOf(file, a) {
  return `${baseNoExt(file)}::${fullNameOf(a)}`;
}

/**
 * True when this run's failures are deliberate (failing-first proof run) or
 * synthetic (Stryker mutation worker) — intake + run-summary writes are
 * suppressed entirely. See the header block for the contract.
 */
function isSuppressedRun(rootDir, env = process.env, cwd = process.cwd()) {
  const flag = String(env.JA_PROOF_RUN || '').trim().toLowerCase();
  if (flag && flag !== '0' && flag !== 'false') return 'proof-run (JA_PROOF_RUN)';
  for (const k of Object.keys(env)) {
    if (/^_{0,2}STRYKER/i.test(k)) return `mutation worker (${k})`;
  }
  if (String(rootDir || '').includes('.stryker-tmp') || String(cwd || '').includes('.stryker-tmp')) {
    return 'mutation sandbox (.stryker-tmp)';
  }
  return '';
}

class DefectReporter {
  constructor(globalConfig = {}, options = {}) {
    this._rootDir = (globalConfig && globalConfig.rootDir) || process.cwd();
    this._out = (options && options.outFile) || path.join(this._rootDir, 'qa', 'defect-intake.jsonl');
    this._runOut = (options && options.runFile) || path.join(this._rootDir, 'qa', 'test-run.json');
    this._lines = [];
    this._tests = {}; // testId -> { status, invocations, flaky }
    this._suppressed = isSuppressedRun(this._rootDir);
  }

  onTestResult(_test, testResult) {
    if (!testResult) return;
    const date = new Date().toISOString().slice(0, 10);
    const rel = (p) => {
      try { return path.relative(this._rootDir, p) || p; } catch { return p; }
    };

    // A whole suite that failed to even run (import/compile crash).
    if (testResult.testExecError && (!testResult.testResults || !testResult.testResults.length)) {
      const file = rel(testResult.testFilePath);
      const msg = String(testResult.testExecError.message || testResult.failureMessage || 'suite failed to run');
      this._lines.push({
        kind: 'test-failure', file, fullName: `${file} (suite failed to load)`,
        assertion: msg, class: 'build', date,
        signature: advisorySignature(file, `${file} (suite failed to load)`, msg),
      });
      return;
    }

    for (const a of testResult.testResults || []) {
      const file = rel(testResult.testFilePath);
      const fullName = a.fullName || fullNameOf(a);
      const invocations = typeof a.invocations === 'number' ? a.invocations : 1;
      const retried = invocations > 1 || (Array.isArray(a.retryReasons) && a.retryReasons.length > 0);

      // Per-run outcome summary — every test, not just failures (flaky.mjs reads
      // this to advance quarantine green-counters). A pass on a RETRY is a flake.
      if (a.status === 'passed' || a.status === 'failed') {
        const flaky = a.status === 'passed' && retried;
        this._tests[testIdOf(file, a)] = { status: a.status, invocations, flaky };
      }

      if (a.status !== 'failed') continue;
      const assertion = (a.failureMessages && a.failureMessages[0]) || 'assertion failed';
      this._lines.push({
        kind: 'test-failure', file, fullName,
        assertion, class: 'correctness', date,
        signature: advisorySignature(file, fullName, assertion),
      });
    }
  }

  onRunComplete() {
    if (this._suppressed) {
      // Deliberate-failure run: record nothing (intake would be false defects;
      // the run summary would corrupt flake green-counters).
      if (this._lines.length) {
        // eslint-disable-next-line no-console
        console.log(`\n[defect-reporter] ${this._suppressed} — ${this._lines.length} failure(s) NOT recorded as intake`);
      }
      return;
    }
    // Always write the run summary (even a clean, all-green run) so a sweep after
    // a green nightly can advance green-counters. Latest-run-wins (overwrite).
    try {
      fs.mkdirSync(path.dirname(this._runOut), { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(this._runOut, JSON.stringify({ date, tests: this._tests }, null, 2) + '\n', 'utf8');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[defect-reporter] run-summary write skipped: ${e.message}`);
    }

    if (!this._lines.length) return;
    try {
      fs.mkdirSync(path.dirname(this._out), { recursive: true });
      fs.appendFileSync(this._out, this._lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
      // eslint-disable-next-line no-console
      console.log(`\n[defect-reporter] wrote ${this._lines.length} intake line(s) → ${path.relative(this._rootDir, this._out)}`);
    } catch (e) {
      // never fail the run because intake couldn't be written
      // eslint-disable-next-line no-console
      console.warn(`[defect-reporter] intake write skipped: ${e.message}`);
    }
  }
}

module.exports = DefectReporter;
module.exports.isSuppressedRun = isSuppressedRun;

// --self-test: node qa/defect-reporter.cjs --self-test  (zero deps, tmp-dir only)
if (require.main === module && process.argv.includes('--self-test')) {
  const os = require('node:os');
  const assert = require('node:assert');
  const failedResult = (root) => ({
    testFilePath: path.join(root, 'src', 'thing.test.ts'),
    testResults: [{
      title: 'fails', ancestorTitles: ['thing'], fullName: 'thing > fails',
      status: 'failed', invocations: 1, failureMessages: ['expected 1 to be 2'],
    }],
  });
  const run = (root, env) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      const r = new DefectReporter({ rootDir: root }, {});
      r.onTestResult(null, failedResult(root));
      r.onRunComplete();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    return {
      intake: fs.existsSync(path.join(root, 'qa', 'defect-intake.jsonl')),
      summary: fs.existsSync(path.join(root, 'qa', 'test-run.json')),
    };
  };
  const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'defect-reporter-selftest-'));

  // 1. normal failing run → intake + summary written
  let out = run(fresh(), {});
  assert.ok(out.intake && out.summary, 'normal run must write intake + summary');
  // 2. JA_PROOF_RUN=1 → nothing written
  out = run(fresh(), { JA_PROOF_RUN: '1' });
  assert.ok(!out.intake && !out.summary, 'JA_PROOF_RUN=1 must suppress all writes');
  // 3. JA_PROOF_RUN=0 → NOT suppressed
  out = run(fresh(), { JA_PROOF_RUN: '0' });
  assert.ok(out.intake && out.summary, 'JA_PROOF_RUN=0 must not suppress');
  // 4. stryker env marker → suppressed
  out = run(fresh(), { __STRYKER_SELFTEST_MARKER__: 'x' });
  assert.ok(!out.intake && !out.summary, 'STRYKER env must suppress all writes');
  // 5. .stryker-tmp sandbox rootDir → suppressed
  const sandbox = path.join(fresh(), '.stryker-tmp', 'sandbox-1');
  fs.mkdirSync(sandbox, { recursive: true });
  out = run(sandbox, {});
  assert.ok(!out.intake && !out.summary, '.stryker-tmp rootDir must suppress all writes');
  // 6. pure helper direct checks
  assert.equal(isSuppressedRun('/x', {}, '/x'), '');
  assert.ok(isSuppressedRun('/x', { JA_PROOF_RUN: 'true' }, '/x'));
  assert.ok(isSuppressedRun('/x', {}, '/y/.stryker-tmp/sandbox-2'));
  console.log('defect-reporter self-test: 6/6 OK');
}
