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
 * Zero deps, zero network, zero agent tokens. Synced into apps via `sync.mjs qa`.
 * Register it in an app's jest config:  "reporters": ["default", "<path>"].
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

class DefectReporter {
  constructor(globalConfig = {}, options = {}) {
    this._rootDir = (globalConfig && globalConfig.rootDir) || process.cwd();
    this._out = (options && options.outFile) || path.join(this._rootDir, 'qa', 'defect-intake.jsonl');
    this._lines = [];
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
      if (a.status !== 'failed') continue;
      const file = rel(testResult.testFilePath);
      const fullName = a.fullName || [...(a.ancestorTitles || []), a.title].filter(Boolean).join(' > ');
      const assertion = (a.failureMessages && a.failureMessages[0]) || 'assertion failed';
      this._lines.push({
        kind: 'test-failure', file, fullName,
        assertion, class: 'correctness', date,
        signature: advisorySignature(file, fullName, assertion),
      });
    }
  }

  onRunComplete() {
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
