#!/usr/bin/env node
/**
 * Studio canonical-requirements linter.
 *
 * Source of truth lives in josh-approved-factory; this file is synced into each
 * app via scripts/sync-qa.mjs. Encodes the mechanically-checkable rules from
 * canonical-requirements.md and runs them against an app directory.
 *
 *   node qa-canonical.mjs                 # lint current dir
 *   node qa-canonical.mjs <app-dir>       # lint a specific dir
 *   node qa-canonical.mjs --json          # machine-readable output
 *   node qa-canonical.mjs --quiet         # only print failures
 *
 * Exit code: 0 if no FAIL results, 1 otherwise. WARN never fails the run.
 *
 * Per-app extensions:
 *   - <app>/qa/rules.mjs       — default-exported array of rule fns appended to canonical set
 *   - <app>/qa/baseline.json   — per-rule grandfathering, e.g.
 *       { "commits/fingerprint": "<sha>" }  — only commits AFTER this SHA are checked
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---------- args ----------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const appDir = resolve(positional[0] || process.cwd());
const json = flags.has('--json');
const quiet = flags.has('--quiet');

if (!existsSync(appDir)) {
  console.error(`App directory does not exist: ${appDir}`);
  process.exit(2);
}

// ---------- helpers ----------

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';
const SKIP = 'skip';

const r = (id, severity, message, detail) => ({ id, severity, message, detail });
const pass = (id, message) => r(id, PASS, message);
const warn = (id, message, detail) => r(id, WARN, message, detail);
const fail = (id, message, detail) => r(id, FAIL, message, detail);
const skip = (id, message) => r(id, SKIP, message);

const readText = (p) => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};
const readJson = (p) => {
  const t = readText(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
};
const exists = (p) => existsSync(p);

const isGitRepo = exists(join(appDir, '.git'));

const gitTrackedFiles = (() => {
  if (!isGitRepo) return null;
  try {
    const out = execSync('git ls-files', { cwd: appDir, encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch { return null; }
})();

const baseline = readJson(join(appDir, 'qa', 'baseline.json')) || {};

const COMMIT_DELIM = '----QA-COMMIT-END----';
const gitLogCommits = (range) => {
  if (!isGitRepo) return null;
  try {
    const r = range || 'HEAD';
    const cmd = `git log ${r} --pretty=format:%H%n%an%n%ae%n%B%n${COMMIT_DELIM}`;
    const out = execSync(cmd, { cwd: appDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split(COMMIT_DELIM).map((s) => s.trim()).filter(Boolean);
  } catch { return null; }
};

const detectSurface = () => {
  if (exists(join(appDir, 'app.json')) && readJson(join(appDir, 'package.json'))?.dependencies?.expo) return 'rn';
  if (exists(join(appDir, 'manifest.json'))) {
    const m = readJson(join(appDir, 'manifest.json'));
    if (m?.manifest_version) return 'chrome-extension';
  }
  return 'unknown';
};
const surface = detectSurface();

// ---------- rules: repo hygiene ----------

const ruleLicense = () => {
  return exists(join(appDir, 'LICENSE'))
    ? pass('repo/license-exists', 'LICENSE present')
    : fail('repo/license-exists', 'LICENSE file missing at repo root');
};

const rulePrivacy = () => {
  const p = join(appDir, 'PRIVACY.md');
  if (!exists(p)) return fail('repo/privacy-md-exists', 'PRIVACY.md missing at repo root');
  const text = readText(p) || '';
  if (text.trim().length < 200) return warn('repo/privacy-md-substantive', 'PRIVACY.md is unusually short — confirm it actually states what stays on-device');
  return pass('repo/privacy-md-exists', 'PRIVACY.md present');
};

const README_REQUIRED_HINTS = [
  { key: 'install', re: /install|clone|npm|pnpm|yarn|expo start|load unpacked/i, label: 'How to run / install' },
  { key: 'privacy', re: /privacy|on[- ]device|stays on/i, label: 'Privacy posture' },
  { key: 'license', re: /license|MIT|Apache/i, label: 'License' },
  { key: 'feedback', re: /feedback|email|@|buymeacoffee/i, label: 'Feedback / funding' },
];
const ruleReadme = () => {
  const p = join(appDir, 'README.md');
  if (!exists(p)) return fail('repo/readme-exists', 'README.md missing at repo root');
  const text = readText(p) || '';
  const missing = README_REQUIRED_HINTS.filter((h) => !h.re.test(text)).map((h) => h.label);
  if (missing.length > 0) return warn('repo/readme-sections', `README.md may be missing sections: ${missing.join(', ')}`);
  return pass('repo/readme-exists', 'README.md present and looks complete');
};

const LEAK_FILES = ['CLAUDE.md', '.claude', 'STORE_LISTING.md'];
const LEAK_GLOBS = [/\.p8$/, /service-account.*\.json$/i];

const ruleLeakFilesNotTracked = () => {
  if (gitTrackedFiles == null) return skip('repo/leak-files', 'Not a git repo or git unavailable');
  const tracked = [...gitTrackedFiles];
  const leaks = [];
  for (const f of tracked) {
    if (LEAK_FILES.includes(f) || LEAK_FILES.some((d) => f.startsWith(`${d}/`))) leaks.push(f);
    if (LEAK_GLOBS.some((re) => re.test(f))) leaks.push(f);
  }
  if (leaks.length) return fail('repo/leak-files', 'Files that must not be tracked are committed', leaks);
  return pass('repo/leak-files', 'No CLAUDE.md / .claude/ / STORE_LISTING.md / *.p8 / service-account JSON tracked');
};

// ---------- rules: AI/Claude fingerprint in tracked text ----------

const TEXT_EXTENSIONS = /\.(md|txt|json|js|jsx|ts|tsx|html|css|yml|yaml)$/i;
const trackedTextFiles = () => {
  if (gitTrackedFiles == null) return [];
  return [...gitTrackedFiles].filter((f) => TEXT_EXTENSIONS.test(f));
};

const FINGERPRINT_PATTERNS = [
  { re: /Co-?Authored-?By:\s*(Claude|Anthropic)/i, label: 'Co-Authored-By trailer' },
  { re: /Generated with \[?Claude/i, label: '"Generated with Claude" footer' },
  { re: /Generated by Anthropic/i, label: '"Generated by Anthropic"' },
];

const AI_TELL_PHRASES = [
  'leveraged', 'leveraging', 'harnessed', 'harnessing',
  'comprehensive', 'robust', 'carefully crafted', 'meticulously',
  'delve into', 'tapestry', 'realm of', "in today's fast-paced",
  'navigating the landscape', 'plethora of',
];

const ruleNoFingerprintInTracked = () => {
  const files = trackedTextFiles();
  if (!files.length) return skip('copy/fingerprint-tracked', 'No tracked text files');
  const hits = [];
  for (const f of files) {
    const text = readText(join(appDir, f));
    if (!text) continue;
    for (const p of FINGERPRINT_PATTERNS) {
      if (p.re.test(text)) hits.push(`${f}: ${p.label}`);
    }
  }
  if (hits.length) return fail('copy/fingerprint-tracked', 'AI/Claude fingerprint in tracked files', hits);
  return pass('copy/fingerprint-tracked', 'No Claude/Anthropic fingerprint in tracked files');
};

const USER_FACING_FILES = ['README.md', 'PRIVACY.md'];
const ruleNoAiTellsInUserFacing = () => {
  const hits = [];
  for (const rel of USER_FACING_FILES) {
    const p = join(appDir, rel);
    if (!exists(p)) continue;
    const text = (readText(p) || '').toLowerCase();
    for (const phrase of AI_TELL_PHRASES) {
      if (text.includes(phrase)) hits.push(`${rel}: "${phrase}"`);
    }
  }
  if (hits.length) return warn('copy/ai-tell-phrases', 'AI-tell phrases in user-facing copy', hits);
  return pass('copy/ai-tell-phrases', 'No AI-tell phrases detected in README/PRIVACY');
};

// ---------- rules: commit history ----------

const ruleNoFingerprintInCommits = () => {
  if (!isGitRepo) return skip('commits/fingerprint', 'No git history available');
  const baselineSha = baseline['commits/fingerprint'];
  const range = baselineSha ? `${baselineSha}..HEAD` : null;
  const commits = gitLogCommits(range);
  if (commits == null) return skip('commits/fingerprint', 'git log unavailable');
  if (!commits.length) {
    return pass('commits/fingerprint', baselineSha
      ? `No new commits since baseline ${baselineSha.slice(0, 7)}`
      : 'No commits');
  }
  const hits = [];
  for (const c of commits) {
    const [sha, , email, ...msgLines] = c.split('\n');
    const msg = msgLines.join('\n');
    for (const p of FINGERPRINT_PATTERNS) {
      if (p.re.test(msg)) hits.push(`${sha.slice(0, 7)}: ${p.label}`);
    }
    if (/anthropic\.com|claude\.ai/i.test(email || '')) hits.push(`${sha.slice(0, 7)}: author email = ${email}`);
  }
  if (hits.length) return fail('commits/fingerprint', 'Claude/Anthropic fingerprint in commit history', hits);
  const scope = baselineSha ? ` since baseline ${baselineSha.slice(0, 7)}` : '';
  return pass('commits/fingerprint', `Commit history is clean${scope}`);
};

// ---------- rules: funding & feedback ----------

const ruleBmacLink = () => {
  const files = trackedTextFiles().map((f) => join(appDir, f));
  for (const f of files) {
    const t = readText(f);
    if (t && /buymeacoffee\.com\//i.test(t)) return pass('funding/bmac-present', 'Buy Me a Coffee link found');
  }
  return warn('funding/bmac-present', 'No buymeacoffee.com link found in tracked source — required by canonical');
};

const ruleFeedbackMailto = () => {
  const files = trackedTextFiles().map((f) => join(appDir, f));
  for (const f of files) {
    const t = readText(f);
    if (t && /mailto:[^"'\s)>\]]+/i.test(t)) return pass('funding/feedback-mailto', 'mailto: feedback link found');
  }
  return warn('funding/feedback-mailto', 'No mailto: feedback link found in tracked source — required by canonical');
};

// ---------- rules: telemetry / analytics SDKs ----------

const ANALYTICS_PACKAGES = [
  'firebase', '@firebase/analytics', '@react-native-firebase/analytics',
  'amplitude-js', '@amplitude/analytics-browser', 'react-native-amplitude-analytics',
  'posthog-js', 'posthog-react-native',
  'mixpanel', 'mixpanel-browser', 'mixpanel-react-native',
  '@segment/analytics-next', '@segment/analytics-react-native',
  '@sentry/react-native', '@sentry/browser',
  'react-native-google-analytics-bridge',
];
const rulePackageJsonNoAnalytics = () => {
  const pkg = readJson(join(appDir, 'package.json'));
  if (!pkg) return skip('telemetry/no-analytics-deps', 'No package.json');
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const hits = ANALYTICS_PACKAGES.filter((name) => Object.keys(deps).some((d) => d === name || d.startsWith(`${name}/`)));
  if (hits.length) return fail('telemetry/no-analytics-deps', 'Analytics/telemetry SDKs in dependencies', hits);
  return pass('telemetry/no-analytics-deps', 'No analytics SDKs in dependencies');
};

// ---------- rules: RN-specific (eas.json shape) ----------

const ruleEasJsonShape = () => {
  if (surface !== 'rn') return skip('rn/eas-json-shape', 'Not an RN app');
  const e = readJson(join(appDir, 'eas.json'));
  if (!e) return fail('rn/eas-json-shape', 'eas.json missing — should match templates/eas.json.template');
  const issues = [];
  if (!e.build?.development) issues.push('build.development missing');
  if (!e.build?.preview) issues.push('build.preview missing');
  if (!e.build?.production) issues.push('build.production missing');
  if (!e.submit?.production?.ios?.ascAppId) issues.push('submit.production.ios.ascAppId missing');
  const ios = e.submit?.production?.ios || {};
  for (const forbidden of ['ascApiKeyPath', 'ascApiKeyId', 'ascApiKeyIssuerId']) {
    if (forbidden in ios) issues.push(`submit.production.ios.${forbidden} present — credentials must live in EAS vault, not on disk`);
  }
  if (issues.length) return fail('rn/eas-json-shape', 'eas.json deviates from canonical shape', issues);
  return pass('rn/eas-json-shape', 'eas.json matches canonical shape');
};

// ---------- rules: Chrome-extension-specific (manifest.json) ----------

const KNOWN_PERMISSIONS_TIGHT = new Set(['activeTab', 'scripting', 'storage', 'sidePanel', 'offscreen']);
const ruleManifestMv3 = () => {
  if (surface !== 'chrome-extension') return skip('ext/manifest-mv3', 'Not a Chrome extension');
  const m = readJson(join(appDir, 'manifest.json'));
  if (!m) return fail('ext/manifest-mv3', 'manifest.json missing or unreadable');
  if (m.manifest_version !== 3) return fail('ext/manifest-mv3', `manifest_version is ${m.manifest_version}, must be 3`);
  return pass('ext/manifest-mv3', 'manifest.json is MV3');
};

const ruleManifestPermissionsTight = () => {
  if (surface !== 'chrome-extension') return skip('ext/permissions-tight', 'Not a Chrome extension');
  const m = readJson(join(appDir, 'manifest.json'));
  if (!m) return skip('ext/permissions-tight', 'No manifest');
  const perms = m.permissions || [];
  const hostPerms = m.host_permissions || [];
  const issues = [];
  for (const p of perms) {
    if (!KNOWN_PERMISSIONS_TIGHT.has(p)) issues.push(`broad permission: ${p}`);
  }
  if (hostPerms.includes('<all_urls>')) issues.push('host_permissions includes <all_urls>');
  if (issues.length) return warn('ext/permissions-tight', 'Manifest declares broad permissions — confirm each is justified in STORE_LISTING.md', issues);
  return pass('ext/permissions-tight', `Permissions are tight (${perms.join(', ') || 'none'})`);
};

// ---------- runner ----------

const CANONICAL_RULES = [
  ruleLicense,
  rulePrivacy,
  ruleReadme,
  ruleLeakFilesNotTracked,
  ruleNoFingerprintInTracked,
  ruleNoAiTellsInUserFacing,
  ruleNoFingerprintInCommits,
  ruleBmacLink,
  ruleFeedbackMailto,
  rulePackageJsonNoAnalytics,
  ruleEasJsonShape,
  ruleManifestMv3,
  ruleManifestPermissionsTight,
];

async function loadAppRules() {
  const p = join(appDir, 'qa', 'rules.mjs');
  if (!exists(p)) return [];
  try {
    const mod = await import(pathToFileURL(p).href);
    const arr = mod.default || mod.rules || [];
    if (!Array.isArray(arr)) {
      console.error(`qa/rules.mjs default export must be an array of rule functions`);
      return [];
    }
    return arr;
  } catch (e) {
    console.error(`Failed to load ${p}: ${e.message}`);
    return [];
  }
}

const COLOR = process.stdout.isTTY && !json;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const sym = {
  [PASS]: COLOR ? c(32, '✓') : 'PASS',
  [WARN]: COLOR ? c(33, '⚠') : 'WARN',
  [FAIL]: COLOR ? c(31, '✗') : 'FAIL',
  [SKIP]: COLOR ? c(90, '·') : 'SKIP',
};

(async () => {
  const appRules = await loadAppRules();
  const allRules = [...CANONICAL_RULES, ...appRules];
  const results = [];
  for (const fn of allRules) {
    try {
      const out = await fn({ appDir, surface });
      if (Array.isArray(out)) results.push(...out);
      else if (out) results.push(out);
    } catch (e) {
      results.push(fail(`internal/${fn.name || 'rule'}`, `Rule threw: ${e.message}`));
    }
  }

  if (json) {
    const summary = results.reduce((acc, r) => ((acc[r.severity] = (acc[r.severity] || 0) + 1), acc), {});
    process.stdout.write(JSON.stringify({ appDir, surface, summary, results }, null, 2) + '\n');
  } else {
    if (!quiet) {
      console.log(`QA · ${relative(process.cwd(), appDir) || '.'} · surface=${surface}`);
      console.log('');
    }
    for (const r of results) {
      if (quiet && r.severity !== FAIL) continue;
      const line = `${sym[r.severity]} ${r.id}  ${r.message}`;
      console.log(line);
      if (r.detail) {
        const items = Array.isArray(r.detail) ? r.detail : [String(r.detail)];
        for (const i of items) console.log(`    ${c(90, '↳')} ${i}`);
      }
    }
    const counts = results.reduce((acc, r) => ((acc[r.severity] = (acc[r.severity] || 0) + 1), acc), {});
    console.log('');
    console.log(`${results.length} checks · ${counts[FAIL] || 0} fail · ${counts[WARN] || 0} warn · ${counts[PASS] || 0} pass · ${counts[SKIP] || 0} skip`);
  }

  process.exit(results.some((r) => r.severity === FAIL) ? 1 : 0);
})();
