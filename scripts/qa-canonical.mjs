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
 *       { "testing/enforce": true }         — promote a WARN tier to FAIL
 *       { "<rule-id>/skip": true }          — disable a rule for a deliberate design, or
 *       { "<rule-id>/skip": ["Foo.tsx"] }   — exempt specific files (path fragments)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

// Shipgate opt-in (canon § QA & testing, rollout = codify -> backfill -> shipgate).
// The three testing-tier rules are WARN during codify/backfill so surfacing a
// gap never reds an app's CI before its tests exist. Once an app is backfilled
// green, set `"testing/enforce": true` in its qa/baseline.json to PROMOTE those
// rules to FAIL (the ship-gate) — per-app, so a backfilled app can't regress
// while a not-yet-backfilled app stays advisory. `testWarn` is the chosen
// severity for those rules.
const enforceTesting = baseline['testing/enforce'] === true;
const testWarn = (id, message, detail) => (enforceTesting ? fail : warn)(id, message, detail);

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

// ---------- rules: cross-platform functional parity (RN src) ----------
//
// Enforces canonical-requirements.md § Cross-platform functional parity: a
// user-facing action that exists on only one platform is an unshipped feature,
// not a scoped one. These rules catch the mechanical tells of that defect in an
// app's src/. Surfaced by packing-list shipping trip delete/rename/duplicate
// reachable only on iOS (ActionSheetIOS + Alert.prompt + `Platform.OS !== 'ios'
// return` guards) because nothing mechanical caught the pattern.

const SRC_EXTENSIONS = /\.(jsx?|tsx?)$/i;
// A test/spec file or anything under a __tests__ dir. Test files are not
// shippable UI: they legitimately carry literal strings ("Settings"), fixed
// sizes, no empty states, etc., so every CONTENT rule (i18n, ux, parity, size)
// must skip them or it false-positives on the RNTL exemplar (found 2026-07-08,
// T3 backfill). Defined here so srcSourceFiles can exclude by default.
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[jt]sx?$)|(?:[\\/]__tests__[\\/])/;

// Walk <app>/src for source files. Plain fs walk (not git) so it works on a
// fresh checkout / pre-commit; src/ is always tracked in our apps anyway.
// Excludes test files by default (they aren't shippable source); pass
// { includeTests: true } for the rule that counts them (trust-core-covered).
const srcSourceFiles = ({ includeTests = false } = {}) => {
  const root = join(appDir, 'src');
  if (!exists(root)) return [];
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(p);
      } else if (SRC_EXTENSIONS.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return includeTests ? out : out.filter((f) => !TEST_FILE_RE.test(f));
};

// Strip line + block comments so a banned name mentioned in a doc comment
// (e.g. packing-list's Dialogs.tsx documenting that it "replaces ActionSheetIOS
// and Alert.prompt") never false-positives. String/template literals are KEPT —
// the import-source rule needs the 'react-native' specifier and the Platform.OS
// rule needs the 'ios'/'android' literals to match. We stay string-aware only so
// a `//` or `/*` *inside* a string isn't mistaken for a comment. Newlines are
// preserved so reported line numbers stay accurate. Crude but sufficient: the
// goal is to avoid matching prose, not to parse JS.
const stripComments = (text) => {
  let out = '';
  let i = 0;
  const n = text.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === "'") { state = 'sq'; out += ch; i += 1; continue; }
      if (ch === '"') { state = 'dq'; out += ch; i += 1; continue; }
      if (ch === '`') { state = 'tpl'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch; // keep line count stable
      i += 1; continue;
    }
    // inside a string / template literal: keep the content verbatim
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; } // keep escaped char
    if (state === 'sq' && ch === "'") { state = 'code'; out += ch; i += 1; continue; }
    if (state === 'dq' && ch === '"') { state = 'code'; out += ch; i += 1; continue; }
    if (state === 'tpl' && ch === '`') { state = 'code'; out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
};

const BANNED_IMPORT_NAMES = ['ActionSheetIOS', 'PushNotificationIOS', 'Settings'];

// Match named imports from 'react-native' and pull out the bound names. Catches
//   import { Settings, X } from 'react-native'
//   import RN, { ActionSheetIOS } from 'react-native'
// across multiple lines. We only flag the banned names when the source module
// is literally 'react-native' (RN's built-in Settings is the trap; an app's own
// ./Settings screen import is fine).
const RN_NAMED_IMPORT_RE = /import\s+(?:[A-Za-z0-9_$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]react-native['"]/g;

const ruleNoIosOnlyImports = () => {
  if (surface !== 'rn') return skip('parity/no-ios-only-imports', 'Not an RN app');
  const files = srcSourceFiles();
  if (!files.length) return skip('parity/no-ios-only-imports', 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    const rel = relative(appDir, f);
    let m;
    RN_NAMED_IMPORT_RE.lastIndex = 0;
    while ((m = RN_NAMED_IMPORT_RE.exec(code)) !== null) {
      const named = m[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      for (const name of named) {
        if (BANNED_IMPORT_NAMES.includes(name)) {
          hits.push(`${rel}: imports { ${name} } from 'react-native'`);
        }
      }
    }
  }
  if (hits.length) {
    return fail('parity/no-ios-only-imports',
      "iOS-only RN APIs imported in src/ — break a feature on Android (use a cross-platform primitive)", hits);
  }
  return pass('parity/no-ios-only-imports', "No ActionSheetIOS / PushNotificationIOS / RN built-in Settings imports in src/");
};

const ruleNoAlertPrompt = () => {
  if (surface !== 'rn') return skip('parity/no-alert-prompt', 'Not an RN app');
  const files = srcSourceFiles();
  if (!files.length) return skip('parity/no-alert-prompt', 'No src/ source files');
  // Alert.prompt( — does not exist on Android (silently undefined), so any text
  // input it gathers is simply unreachable there. Optional whitespace before
  // the paren; comments/strings already stripped.
  const ALERT_PROMPT_RE = /\bAlert\s*\.\s*prompt\s*\(/;
  const hits = [];
  for (const f of files) {
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    if (ALERT_PROMPT_RE.test(code)) hits.push(`${relative(appDir, f)}: Alert.prompt(...)`);
  }
  if (hits.length) {
    return fail('parity/no-alert-prompt',
      'Alert.prompt() in src/ — does not exist on Android (silently undefined); use a cross-platform prompt', hits);
  }
  return pass('parity/no-alert-prompt', 'No Alert.prompt() calls in src/');
};

// Early-return guards that gate WHETHER a feature exists, e.g.
//   if (Platform.OS !== 'ios') return            (or === 'ios' / android, symmetric)
//   if (Platform.OS === 'android') { return; }
// These short-circuit logic per platform. A `Platform.OS === 'ios'` used as a
// ternary or to pick a value/style (presentation) is FINE and must NOT match —
// hence we anchor on `if (` immediately followed by the comparison and an
// immediate `return`, never a bare `Platform.OS === 'ios'` expression.
const PLATFORM_GUARD_RE =
  /\bif\s*\(\s*Platform\s*\.\s*OS\s*[=!]==\s*['"](?:ios|android)['"]\s*\)\s*\{?\s*return\b/;

const ruleNoPlatformEarlyReturn = () => {
  if (surface !== 'rn') return skip('parity/no-platform-early-return', 'Not an RN app');
  const files = srcSourceFiles();
  if (!files.length) return skip('parity/no-platform-early-return', 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    const rel = relative(appDir, f);
    const lines = code.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      // Anchor on the line that actually opens the guard, so the reported line
      // is the `if (...)` itself even when the `return` wraps to the next line.
      if (!/\bif\s*\(\s*Platform\s*\.\s*OS\b/.test(lines[idx])) continue;
      // Join with the next line so a guard whose brace/return wraps still matches.
      const window = `${lines[idx]} ${lines[idx + 1] ?? ''}`;
      if (PLATFORM_GUARD_RE.test(window)) {
        hits.push(`${rel}:${idx + 1}: ${lines[idx].trim()}`);
      }
    }
  }
  if (hits.length) {
    return fail('parity/no-platform-early-return',
      "Platform.OS early-return guard in src/ — gates whether a feature exists, not how it looks (presentation-only Platform.OS branches are fine)", hits);
  }
  return pass('parity/no-platform-early-return', 'No Platform.OS early-return guards in src/');
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
  // The QA capture/device-net pipeline builds the iOS app for the SIMULATOR
  // (capture.mjs extracts the .app from a simulator tarball). Without
  // build.preview.ios.simulator=true, `eas build --local` tries an
  // internal-distribution device build and dies on credential setup in
  // non-interactive mode — a 10-minute failure for a one-line config gap.
  if (e.build?.preview && e.build.preview.ios?.simulator !== true) {
    issues.push('build.preview.ios.simulator must be true (QA captures need a simulator build, else eas demands device credentials)');
  }
  if (!e.submit?.production?.ios?.ascAppId) issues.push('submit.production.ios.ascAppId missing');
  const ios = e.submit?.production?.ios || {};
  for (const forbidden of ['ascApiKeyPath', 'ascApiKeyId', 'ascApiKeyIssuerId']) {
    if (forbidden in ios) issues.push(`submit.production.ios.${forbidden} present — credentials must live in EAS vault, not on disk`);
  }
  if (issues.length) return fail('rn/eas-json-shape', 'eas.json deviates from canonical shape', issues);
  return pass('rn/eas-json-shape', 'eas.json matches canonical shape');
};

// ---------- rules: RN app identity name (Spotlight-safe CFBundleName) ----------

// iOS draws the home-screen icon label from CFBundleDisplayName (Expo sets it
// from expo.name), but Spotlight's "Top Hit" app row — and a few other system
// surfaces — render CFBundleName, which `expo prebuild` defaults to the Xcode
// PRODUCT_NAME: the app name with spaces stripped ("Grocery List" -> the
// product "GroceryList"). So a multi-word app that's correct on the home screen
// still shows up as "GroceryList" in search. The fix is to pin
// ios.infoPlist.CFBundleName to the real, spaced name. Caught by hand on device
// 2026-06-13 (Spotlight showed "GroceryList"/"PackingList"). Single-word names
// have no space to lose, so they pass trivially. (canon § App identity name)
const ruleAppNameSpotlightSafe = () => {
  if (surface !== 'rn') return skip('rn/app-name-spotlight-safe', 'Not an RN app');
  const expo = readJson(join(appDir, 'app.json'))?.expo;
  const name = expo?.name;
  if (!name || typeof name !== 'string') {
    return warn('rn/app-name-spotlight-safe', 'app.json expo.name missing — cannot verify the Spotlight name');
  }
  if (!/\s/.test(name)) {
    return pass('rn/app-name-spotlight-safe', `Single-word name "${name}" — no space for Spotlight to drop`);
  }
  const cfName = expo?.ios?.infoPlist?.CFBundleName;
  if (!cfName) {
    return fail('rn/app-name-spotlight-safe',
      `expo.name "${name}" has a space but ios.infoPlist.CFBundleName is unset — iOS Spotlight shows the space-stripped PRODUCT_NAME. Set "CFBundleName": "${name}".`);
  }
  if (cfName !== name) {
    return fail('rn/app-name-spotlight-safe',
      `ios.infoPlist.CFBundleName "${cfName}" doesn't match expo.name "${name}" — Spotlight renders CFBundleName, so they must agree (set it to "${name}").`);
  }
  return pass('rn/app-name-spotlight-safe', `CFBundleName "${cfName}" matches expo.name — Spotlight-safe`);
};

// ---------- rules: RN interaction safety (no keyboard dead-ends) ----------

// A TextInput that opts out of the default blur-on-submit (blurOnSubmit={false},
// or the newer submitBehavior="submit") keeps the soft keyboard up after the
// return key — deliberately, so a user can rapid-fire entries. The trap: if the
// submit handler early-returns on an empty field, the return key becomes a
// no-op AND the keyboard never dismisses, so the field is stuck with no
// on-keyboard way out (you must navigate away to escape). A real, device-only
// defect — grocery-list's add-item box, caught by hand 2026-06-13. The remedy
// is always an explicit escape on the empty/idle submit — Keyboard.dismiss() /
// .blur(), OR closing the surface the input lives on (onClose() / navigation
// .goBack()), which unmounts the field and takes the keyboard with it. We flag
// any file that persists the keyboard without ANY of these. Fires on both
// platforms equally — this is a UX dead-end, not an iOS quirk.
const KB_PERSIST_RE = /blurOnSubmit\s*=\s*\{\s*false\s*\}|submitBehavior\s*=\s*\{?\s*['"]submit['"]/;
const KB_ESCAPE_RE = /Keyboard\s*\.\s*dismiss\s*\(|\.\s*blur\s*\(|onClose\s*\(|\.\s*goBack\s*\(/;

// Pure core (self-tested): a file is a keyboard trap when it persists the
// keyboard on submit but never gives an escape (dismiss/blur/close/goBack).
const keyboardTrapped = (code) => KB_PERSIST_RE.test(code) && !KB_ESCAPE_RE.test(code);

// PROMOTED WARN→FAIL fleet-wide (Uplevel-3 T3, 2026-07-08). The 2026-06-13
// grocery-list add-item trap is a real, on-device defect class and the whole
// fleet is green here, so this rule now GATES. Per-app escape hatch:
// qa/baseline.json "keyboard/enforce": false keeps it a WARN — reserved for an
// app that is genuinely red and can't be fixed in the same change (the point of
// the promotion is to fix the trap, not opt out of it).
const enforceKeyboard = baseline['keyboard/enforce'] !== false;
const keyboardSev = (id, message, detail) => (enforceKeyboard ? fail : warn)(id, message, detail);

const ruleKeyboardDismissEscape = () => {
  if (surface !== 'rn') return skip('rn/keyboard-dismiss-escape', 'Not an RN app');
  const files = srcSourceFiles();
  if (!files.length) return skip('rn/keyboard-dismiss-escape', 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const raw = readText(f);
    if (!raw) continue;
    if (keyboardTrapped(stripComments(raw))) {
      hits.push(`${relative(appDir, f)}: persists the keyboard on submit (blurOnSubmit={false} / submitBehavior="submit") but never calls Keyboard.dismiss() / .blur()`);
    }
  }
  if (hits.length) {
    return keyboardSev('rn/keyboard-dismiss-escape',
      'Keyboard can get stuck: a persistent-keyboard TextInput has no empty/idle dismiss escape — submitting an empty field must call Keyboard.dismiss() so the user is never trapped with the keyboard open', hits);
  }
  return pass('rn/keyboard-dismiss-escape', 'No persistent-keyboard inputs without a dismiss escape');
};

// A React Native <Modal> renders in its OWN native view hierarchy, detached
// from the app's root <SafeAreaProvider>. So <SafeAreaView> / useSafeAreaInsets()
// used INSIDE a full-screen Modal read ZERO insets — the modal's chrome slides
// under the status bar (title over the clock, a Done action over the battery)
// and under the home indicator. A real, device-only defect: grocery-list's
// full-screen Add-items sheet, caught by hand 2026-06-21. The remedy is to nest
// a <SafeAreaProvider> (seed it with initialWindowMetrics so there's no 0-inset
// first frame) INSIDE the Modal, so the SafeAreaView beneath it measures real
// insets. We flag any file that presents a presentationStyle="fullScreen" Modal
// AND consumes safe-area insets but nests no provider of its own. A file that
// uses no insets has nothing to misplace; one that already nests a provider is
// correct. Fires on both platforms — statusBarTranslucent makes Android draw
// under the bar too, so the 0-inset overlap is not iOS-only.
const MODAL_FULLSCREEN_RE = /presentationStyle\s*=\s*\{?\s*['"]fullScreen['"]/;
const SAFE_AREA_CONSUMER_RE = /<\s*SafeAreaView|useSafeAreaInsets\s*\(/;
const SAFE_AREA_PROVIDER_RE = /<\s*SafeAreaProvider/;

const ruleModalSafeAreaProvider = () => {
  if (surface !== 'rn') return skip('rn/modal-safe-area-provider', 'Not an RN app');
  const files = srcSourceFiles();
  if (!files.length) return skip('rn/modal-safe-area-provider', 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    if (!MODAL_FULLSCREEN_RE.test(code)) continue;
    if (!SAFE_AREA_CONSUMER_RE.test(code)) continue; // no insets used → nothing to misplace
    if (!SAFE_AREA_PROVIDER_RE.test(code)) {
      hits.push(`${relative(appDir, f)}: a presentationStyle="fullScreen" <Modal> consumes safe-area insets (<SafeAreaView>/useSafeAreaInsets) but nests no <SafeAreaProvider> — insets read 0 inside a Modal's detached native hierarchy, so the modal's top/bottom chrome overlaps the status bar / home indicator`);
    }
  }
  if (hits.length) {
    return warn('rn/modal-safe-area-provider',
      'Safe area ignored inside a full-screen Modal: a presentationStyle="fullScreen" Modal reads safe-area insets but nests no SafeAreaProvider — wrap the modal content in <SafeAreaProvider initialMetrics={initialWindowMetrics}> so the title/actions clear the notch and home indicator', hits);
  }
  return pass('rn/modal-safe-area-provider', 'No full-screen Modals consuming safe-area without their own provider');
};

// ---------- rules: UX interaction baseline (canon proposal studio-20260702-1) ----------
//
// Seeded 2026-07-02 from Josh's recurring on-device corrections across four apps
// (tend, packing-list, grocery-list, workout-timer) — the defect class he named
// "bugs only I am able to catch by manually testing the app on my phone." The
// three mechanically-checkable rules of the UX-interaction-baseline proposal land
// here as WARN (codify→backfill→shipgate, like the testing/i18n/theme tiers); the
// non-mechanical rules of that proposal ride qa/review-rubric.md.
//
// Built FALSE-POSITIVES-FIRST (these run on every app forever): each strips
// comments (stripComments, like the parity rules) so prose/doc mentions never
// match, keys on real JSX/usage rather than a name in text, and honours a
// documented per-app escape in qa/baseline.json — set `"<rule-id>/skip": true`
// to disable the rule for a legitimate deliberate design, or an array of path
// fragments (`["FooScreen.tsx"]`) to exempt specific files — so an exception is
// recorded once instead of the rule nagging forever.
const ruleSkipsAll = (id) => baseline[`${id}/skip`] === true;
const ruleSkipsFile = (id, relPath) => {
  const s = baseline[`${id}/skip`];
  return Array.isArray(s) && s.some((frag) => relPath.replace(/\\/g, '/').includes(frag));
};

// Return {inner, end} for the balanced (…) whose opening bracket is at `open`, or
// null if unbalanced. Comments are already stripped; string literals are kept, so
// a stray bracket inside a string could skew the count — acceptable for these
// WARN heuristics (effect-arg strings almost never carry an unbalanced paren).
const matchBalanced = (code, open, oc = '(', cc = ')') => {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === oc) depth++;
    else if (ch === cc) { depth--; if (depth === 0) return { inner: code.slice(open + 1, i), end: i }; }
  }
  return null;
};

// rn/entry-screen-autofocus — a screen whose PRIMARY interaction is text entry
// should raise the keyboard on mount so the user can just start typing, with an
// explicit .focus() fallback (Android autoFocus can no-op after a navigation
// transition). Flagged conservatively to spare the many screens that merely
// CONTAIN an input: only a file under src/screens/ whose basename reads as a
// create/new/add/edit/compose surface (verb + a following PascalCase word, so
// "AddExpense" matches but "AddressScreen" does not) AND that renders a
// <TextInput> AND has neither an autoFocus prop (that isn't ={false}) nor any
// .focus() call. Recurred: tend new-person 2026-06-29, packing-list trip-info
// 2026-05-23. (canon studio-20260702-1)
const ENTRY_SCREEN_NAME_RE = /(?:^|\/)(?:New|Add|Create|Edit|Compose)[A-Z][A-Za-z]*\.(?:jsx?|tsx?)$/;
const TEXTINPUT_JSX_RE = /<\s*TextInput\b/;
const AUTOFOCUS_RE = /\bautoFocus\b(?!\s*=\s*\{?\s*false)/;
const FOCUS_CALL_RE = /\.\s*focus\s*\(/;

const ruleEntryScreenAutofocus = () => {
  const id = 'rn/entry-screen-autofocus';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  if (ruleSkipsAll(id)) return skip(id, 'Disabled via qa/baseline.json "rn/entry-screen-autofocus/skip"');
  const files = srcSourceFiles();
  if (!files.length) return skip(id, 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const rel = relative(appDir, f);
    const relSrc = relative(join(appDir, 'src'), f).replace(/\\/g, '/');
    if (!relSrc.startsWith('screens/')) continue;         // screens only
    if (!ENTRY_SCREEN_NAME_RE.test('/' + relSrc)) continue; // entry-primary by name
    if (ruleSkipsFile(id, rel)) continue;
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    if (!TEXTINPUT_JSX_RE.test(code)) continue;           // must render an input
    if (AUTOFOCUS_RE.test(code) || FOCUS_CALL_RE.test(code)) continue; // already focuses
    hits.push(`${rel}: entry screen renders <TextInput> but never autoFocuses or calls .focus() — raise the keyboard on mount (autoFocus + a .focus() fallback for Android)`);
  }
  if (hits.length) {
    return warn(id,
      'Entry screen does not focus its field on mount — a create/edit screen whose primary action is text entry should auto-focus its first input (autoFocus, with an explicit .focus() fallback) so the keyboard is up and ready', hits);
  }
  return pass(id, 'Entry screens focus their first field on mount');
};

// rn/create-on-mount — draft-first creation: a store create/insert must fire from
// an explicit user Save handler, never from a mount/navigation effect. The
// anti-pattern (tend's blank person, 2026-06-29) writes a record the instant a
// "new X" screen mounts, so backing out leaves an empty ghost. We look INSIDE
// mount effects only — useEffect(…, []) with EMPTY deps, or useFocusEffect(…) —
// for a creation call (create/insert/add/save<Noun>(…), or a .create( / .insert(
// store method), excluding the framework factory functions that legitimately run
// on mount (createRef/createContext/createNativeStackNavigator/addListener/…). A
// non-empty / dynamic deps array is treated as not-mount (conservative: no flag).
// WARN — a real save-on-mount is rare, so a hit is worth a human look, and a
// deliberate case is recorded via the baseline skip. (canon studio-20260702-1)
const CREATE_CALL_RE = /\b(?:create|insert|add|save)[A-Z]\w*\s*\(|\.\s*(?:create|insert)\s*\(/;
const CREATE_DENYLIST = /\b(?:createRef|createContext|createElement|createNativeStackNavigator|createStackNavigator|createBottomTabNavigator|createMaterialTopTabNavigator|createDrawerNavigator|createAnimatedComponent|createSelector|createStore|createNavigationContainerRef|createURL|addListener|addEventListener)\b/g;

const ruleCreateOnMount = () => {
  const id = 'rn/create-on-mount';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  if (ruleSkipsAll(id)) return skip(id, 'Disabled via qa/baseline.json "rn/create-on-mount/skip"');
  const files = srcSourceFiles();
  if (!files.length) return skip(id, 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const rel = relative(appDir, f);
    if (ruleSkipsFile(id, rel)) continue;
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    let flagged = false;
    for (const kind of ['useEffect', 'useFocusEffect']) {
      if (flagged) break;
      const re = new RegExp(`\\b${kind}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(code)) !== null) {
        const open = code.indexOf('(', m.index);
        if (open < 0) break;
        const bal = matchBalanced(code, open);
        if (!bal) continue;
        const args = bal.inner;
        let body = args;
        if (kind === 'useEffect') {
          // deps = the trailing top-level [...]; only an EMPTY [] is a mount effect.
          const depsMatch = args.match(/,\s*(\[[^\]]*\])\s*$/);
          if (!depsMatch) continue;                            // no clear deps arg → skip
          if (depsMatch[1].replace(/\s/g, '') !== '[]') continue; // has deps → not mount-only
          body = args.slice(0, depsMatch.index);
        }
        if (!CREATE_CALL_RE.test(body)) continue;
        // If the only creation-like token is a denylisted factory, don't flag.
        const stripped = body.replace(CREATE_DENYLIST, '');
        if (!CREATE_CALL_RE.test(stripped)) continue;
        const line = code.slice(0, open).split(/\r?\n/).length;
        hits.push(`${rel}:${line}: ${kind}(${kind === 'useEffect' ? '…, []' : '…'}) fires a create/insert call on ${kind === 'useEffect' ? 'mount' : 'navigation focus'} — write the record from an explicit Save handler, not a mount effect (draft-first)`);
        flagged = true;
        break;
      }
    }
  }
  if (hits.length) {
    return warn(id,
      'Record created on mount/navigation, not on Save — a create/insert call fires from a useEffect(…, []) / useFocusEffect rather than a user Save action; backing out then leaves a blank record (the draft-first violation that persisted tend\'s blank person). Move the write to the Save handler', hits);
  }
  return pass(id, 'No store create/insert calls fired from a mount or navigation effect');
};

// rn/scrollform-keyboard-avoidance — a scrollable form (a <ScrollView> holding
// 2+ <TextInput>s) must keep the focused field above the keyboard: a
// KeyboardAvoidingView ancestor (or a KeyboardAware* scroll view), plus a way to
// dismiss the keyboard (keyboardDismissMode / keyboardShouldPersistTaps).
// Without it the lower fields sit under the keyboard with no way out. Recurred:
// tend HTC form 2026-06-27, grocery-list add-box 2026-06-13 (the § Interaction
// safety seed). Flagged per-file (the common co-located form component); a form
// split across files, or one that avoids the keyboard by another means, records
// the exception via the baseline skip. WARN. (canon studio-20260702-1)
const SCROLLVIEW_RE = /<\s*ScrollView\b/;
const KB_AWARE_SCROLL_RE = /<\s*KeyboardAware(?:ScrollView|FlatList|SectionList)\b|<\s*KeyboardAvoidingView\b/;
const KB_HANDLING_RE = /keyboardDismissMode\s*=|keyboardShouldPersistTaps\s*=/;

const ruleScrollformKeyboardAvoidance = () => {
  const id = 'rn/scrollform-keyboard-avoidance';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  if (ruleSkipsAll(id)) return skip(id, 'Disabled via qa/baseline.json "rn/scrollform-keyboard-avoidance/skip"');
  const files = srcSourceFiles();
  if (!files.length) return skip(id, 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const rel = relative(appDir, f);
    if (ruleSkipsFile(id, rel)) continue;
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    if (!SCROLLVIEW_RE.test(code)) continue;
    const inputs = (code.match(/<\s*TextInput\b/g) || []).length;
    if (inputs < 2) continue;                        // a single input rarely gets clipped
    if (KB_AWARE_SCROLL_RE.test(code)) continue;     // KeyboardAvoidingView / KeyboardAware* present
    if (KB_HANDLING_RE.test(code)) continue;         // dismiss / persist-taps handling present
    hits.push(`${rel}: <ScrollView> with ${inputs} <TextInput>s but no KeyboardAvoidingView / KeyboardAware* scroll and no keyboardDismissMode / keyboardShouldPersistTaps — lower fields can sit under the keyboard`);
  }
  if (hits.length) {
    return warn(id,
      'Scrollable form has no keyboard avoidance — a <ScrollView> with 2+ TextInputs needs a KeyboardAvoidingView (or a KeyboardAware* scroll view) so the focused field stays visible, plus keyboardDismissMode / keyboardShouldPersistTaps for a tap-out. Extends § Interaction safety (rn/keyboard-dismiss-escape)', hits);
  }
  return pass(id, 'Scrollable multi-input forms handle keyboard avoidance');
};

// The cold-start splash renders the "josh approved" wordmark with a NEGATIVE
// letterSpacing (tracking.mark ≈ -0.5) inside a TRANSFORMED, animated layer
// (scale/translateY intro). Negative letterSpacing narrows iOS's measured text
// frame to just inside where the final glyph ("d" of "approved") paints; a
// transform then composites that text into a bounds-clipped layer, so the "d"
// gets cut on some devices/SDKs (sub-pixel rounding, the live animation scale,
// the wider system-fallback font). The permanent fix is trailing horizontal room
// on the wordmark Text (paddingRight / paddingHorizontal / paddingEnd) so the
// glyph's ink can never reach the layer's clip boundary. This guards against the
// fix being stripped out and the recurring "the d is cut off" bug reopening.
// FAIL, not WARN: the canonical AnimatedSplash already carries the pad, so any
// app missing it is genuinely regressed (re-sync via `sync.mjs splash`).
const ruleSplashWordmarkClip = () => {
  if (surface !== 'rn') return skip('rn/splash-wordmark-clip', 'Not an RN app');
  const f = join(appDir, 'src', 'components', 'AnimatedSplash.tsx');
  if (!exists(f)) return skip('rn/splash-wordmark-clip', 'No AnimatedSplash.tsx');
  const code = stripComments(readText(f) || '');
  if (!/letterSpacing/.test(code)) {
    // No tracking on the wordmark → no negative-letterSpacing clip to guard.
    return pass('rn/splash-wordmark-clip', 'Splash wordmark uses no letterSpacing');
  }
  if (/padding(?:Right|Horizontal|End)\b/.test(code)) {
    return pass('rn/splash-wordmark-clip', 'Splash wordmark has trailing room (no last-glyph clip)');
  }
  return fail('rn/splash-wordmark-clip',
    'Splash wordmark can clip its last glyph: AnimatedSplash.tsx sets letterSpacing on the transformed/animated wordmark but gives the Text no trailing horizontal room — the "d" of "approved" gets cut on some devices/SDKs. Add paddingRight (see WORDMARK_TRAILING_PAD) and re-sync: `node josh-approved-factory/scripts/sync.mjs splash ' + (relative(process.cwd(), appDir) || '<app>') + '`',
    [`${relative(appDir, f)}: letterSpacing present, no paddingRight/paddingHorizontal/paddingEnd on the wordmark Text`]);
};

// The tip jar (expo-iap) is the only surface in the fleet that reaches for
// Google Play Billing, so it's the only thing that can misbehave on a
// de-Googled / no-GMS Android (the Aurora field report, 2026-07-01). The
// canonical fix (templates/tip-jar/) degrades without GMS: tipJar.ts remembers,
// per launch, that no billing store answered (a session `storeReachable` flag
// exported as `isStoreKnownUnavailable()`), and TipJarSheet.tsx mounts the IAP
// hook (useTipJar → initConnection) ONLY while the sheet is visible AND the
// store isn't already known-unavailable — so the native "Google Play Store is
// missing" log is emitted at most once and re-opens are an instant, calm
// "unavailable" instead of a spinner. This rule guards against an app carrying
// a tip jar that regressed to (or predates) that fix: it fires when tipJar.ts
// exists but omits `isStoreKnownUnavailable`, or when TipJarSheet.tsx never
// gates its hook on it. WARN (not FAIL) — the remedy is a mechanical re-sync,
// and an app with no tip jar simply skips. Fix: `sync.mjs tip-jar <app>`.
const TIPJAR_GUARD_EXPORT_RE = /isStoreKnownUnavailable/;
const ruleTipJarNoGmsGuard = () => {
  if (surface !== 'rn') return skip('rn/tip-jar-nogms-guard', 'Not an RN app');
  const hook = join(appDir, 'src', 'lib', 'tipJar.ts');
  if (!exists(hook)) return skip('rn/tip-jar-nogms-guard', 'No tip jar (src/lib/tipJar.ts absent)');
  const hits = [];
  const hookCode = stripComments(readText(hook) || '');
  if (!TIPJAR_GUARD_EXPORT_RE.test(hookCode)) {
    hits.push(`${relative(appDir, hook)}: no isStoreKnownUnavailable session guard — the pre-fix tip jar re-opens a Play Billing connection on every visit (loud "Google Play Store is missing" log) and can spin on a no-GMS device`);
  }
  const sheet = join(appDir, 'src', 'components', 'TipJarSheet.tsx');
  if (exists(sheet)) {
    const sheetCode = stripComments(readText(sheet) || '');
    if (!TIPJAR_GUARD_EXPORT_RE.test(sheetCode)) {
      hits.push(`${relative(appDir, sheet)}: mounts useTipJar without gating on isStoreKnownUnavailable() — the IAP hook (initConnection) fires on a de-Googled device on every open`);
    }
  }
  if (hits.length) {
    return warn('rn/tip-jar-nogms-guard',
      'Tip jar not de-Googled-safe: the expo-iap tip jar is missing the no-GMS degradation guard (isStoreKnownUnavailable), so on an Android without Google Play Services it re-connects Billing every open (loud log, slow spinner) instead of degrading calmly. Re-sync: `node josh-approved-factory/scripts/sync.mjs tip-jar ' + (relative(process.cwd(), appDir) || '<app>') + '`',
      hits);
  }
  return pass('rn/tip-jar-nogms-guard', 'Tip jar degrades gracefully without Google Play Services');
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

// ---------- rules: testing tiers (Tier 1 logic + Tier 2 flow assertions) ----------
//
// Canon § QA & testing (extends § Store screenshots & QA capture). These three
// are WARN, not FAIL, on purpose: the studio is in the CODIFY phase of the
// rollout (codify -> backfill -> shipgate). Surfacing the gap must not red an
// app's CI before its tests are backfilled. Promote to FAIL at the shipgate
// phase, per-app, via qa/baseline.json grandfathering once green.

// Tier 1 — does the app have a real `npm test`? The trust core (the one module
// where a bug is silent and expensive — split math, merge/tombstone
// reconciliation, interval sequencing) must be unit-tested. First gate: a test
// script that isn't npm's placeholder.
const ruleTestScriptPresent = () => {
  const pkg = readJson(join(appDir, 'package.json'));
  if (!pkg) return skip('test/script-present', 'No package.json');
  const t = pkg.scripts && pkg.scripts.test;
  if (!t || /no test specified/i.test(t)) {
    return testWarn('test/script-present',
      'No real `test` script in package.json — Tier 1 logic tests are required (jest-expo); add `"test": "jest"` and cover the trust core');
  }
  return pass('test/script-present', `test script present ("${t}")`);
};

// Tier 1 — is anything actually tested? At least one *.test/*.spec file (or a
// __tests__ dir) under src/. Deliberately a presence check, not coverage %:
// the bar is "the trust core is covered", which a human/reviewer judges; this
// only catches the all-too-common "test script wired, zero tests written".
const ruleTrustCoreCovered = () => {
  const root = join(appDir, 'src');
  if (!exists(root)) return skip('test/trust-core-covered', 'No src/ directory');
  const files = srcSourceFiles({ includeTests: true }).filter((f) => TEST_FILE_RE.test(f));
  if (!files.length) {
    return testWarn('test/trust-core-covered',
      'No *.test / *.spec / __tests__ files under src/ — the trust core (the module a bug silently corrupts) must have unit tests');
  }
  return pass('test/trust-core-covered', `${files.length} test file(s) under src/`);
};

// Tier 2 — does the traversal prove a RESULT, not just navigate? A journey that
// only waitFor/tap/screenshot proves the app booted and anchors were tappable,
// never that a flow produced the right outcome. Require >=1 assert/assertNot
// step (the outcome verbs). Only meaningful once the capture pipeline is
// adopted, so skip when there's no journey.json.
const ruleFlowHasAssertions = () => {
  const journeyPath = join(appDir, 'qa', 'journey.json');
  if (!exists(journeyPath)) return skip('flows/has-outcome-assertions', 'No qa/journey.json — capture pipeline not adopted here');
  const journey = readJson(journeyPath);
  if (!journey) return testWarn('flows/has-outcome-assertions', 'qa/journey.json is unreadable JSON');
  const steps = Array.isArray(journey.steps) ? journey.steps : [];
  const assertions = steps.filter((s) => s && (('assert' in s) || ('assertNot' in s))).length;
  if (assertions === 0) {
    return testWarn('flows/has-outcome-assertions',
      'qa/journey.json has no assert/assertNot steps — the flow navigates and screenshots but proves no outcome; add an outcome assertion per core action (add/edit/delete)');
  }
  return pass('flows/has-outcome-assertions', `${assertions} assert/assertNot step(s) in journey`);
};

// Flow-drift — fold the Layer-1 traversal linter (scripts/qa/lint-flows.mjs)
// into the one canonical command, so `node scripts/qa-canonical.mjs` also
// catches a Maestro flow that has drifted from the app's current copy/screens
// BEFORE a 20-minute e2e finds out. Runs the app's own synced linter against
// itself; severities already match this file's PASS/WARN/FAIL/SKIP strings.
const ruleFlowDrift = async ({ appDir }) => {
  const linter = join(appDir, 'scripts', 'qa', 'lint-flows.mjs');
  if (!exists(linter) || !exists(join(appDir, 'qa', 'journey.json'))) {
    return skip('flows/lint', 'No qa/journey.json — traversal pipeline not adopted here');
  }
  try {
    const mod = await import(pathToFileURL(linter).href);
    return mod.lintFlows(appDir);
  } catch (e) {
    return warn('flows/lint', `Flow linter could not run: ${e.message}`);
  }
};

// ---------- rule: action coverage (Uplevel-3 T3) ----------
//
// Tier-2 journeys prove the happy path; they don't prove EVERY user-facing
// action works. scripts/qa/action-coverage.mjs enumerates the app's actions from
// src/** into the tracked registry qa/actions.json, each mapped to a proof
// (tier2-assert | rntl | unit | none). This rule surfaces the gap: WARN when the
// registry is missing or carries any unproven (proof.kind "none") or stale
// entries. Promote per-app to FAIL with `"coverage/enforce": true` in
// qa/baseline.json once the app is backfilled green — same codify→backfill→
// shipgate rollout, and the same enforce plumbing, as the testing/i18n/theme
// tiers (the backfill stages own closing the gaps).
const enforceCoverage = baseline['coverage/enforce'] === true;
const coverageWarn = (id, message, detail) => (enforceCoverage ? fail : warn)(id, message, detail);

const ruleActionsMapped = () => {
  if (surface !== 'rn') return skip('coverage/actions-mapped', 'Not a React Native app');
  const p = join(appDir, 'qa', 'actions.json');
  if (!exists(p)) {
    return coverageWarn('coverage/actions-mapped',
      'No qa/actions.json — run `node scripts/qa/action-coverage.mjs <app>` to map every user-facing action to a proof (Uplevel-3 T3)');
  }
  const reg = readJson(p);
  if (!reg || !Array.isArray(reg.actions)) {
    return coverageWarn('coverage/actions-mapped', 'qa/actions.json is unreadable or has no actions array');
  }
  const actions = reg.actions;
  const unproven = actions.filter((a) => !a.stale && (!a.proof || a.proof.kind === 'none'));
  const stale = actions.filter((a) => a.stale);
  if (unproven.length || stale.length) {
    const detail = [];
    if (unproven.length) detail.push(`${unproven.length} action(s) with no proof: ${unproven.slice(0, 8).map((a) => a.id).join(', ')}${unproven.length > 8 ? ' …' : ''}`);
    if (stale.length) detail.push(`${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} (action gone from code): ${stale.slice(0, 8).map((a) => a.id).join(', ')}`);
    return coverageWarn('coverage/actions-mapped',
      `Action coverage incomplete — ${unproven.length} unproven / ${stale.length} stale. Backfill each gap's cheapest proof (unit → rntl → tier2-assert) or remove the stale entry (canon § QA & testing)`,
      detail);
  }
  return pass('coverage/actions-mapped', `All ${actions.length} user-facing action(s) mapped to a proof`);
};

// ---------- rule: translation-readiness (canon § Translations) ----------
//
// Every v1 ships translation-READY: no user-facing copy hardcoded in
// components — it lives in the externalized strings module (src/i18n) and is
// read via t('…'). This rule flags raw JSX text and raw user-facing string
// props in src/screens + src/components. WARN during rollout (same
// codify→backfill→shipgate doctrine as the testing tiers); promote to FAIL
// per-app with `"i18n/enforce": true` in qa/baseline.json once the app is
// externalized clean. New app-shell apps start clean and can enforce.
const enforceI18n = baseline['i18n/enforce'] === true;
const i18nWarn = (id, message, detail) => (enforceI18n ? fail : warn)(id, message, detail);

// Brand-locked components: their only literal is the "josh approved" wordmark,
// a brand proper noun that never translates (canon § voice) — skip by basename.
// Every OTHER canonical component (FundingFooter, DonationModal, ReviewModal,
// ErrorBoundary, Credits, SettingsAbout, AboutRow, ScreenHeader, EmptyState) is
// now fully externalized via t() and IS scanned, so a re-introduced hardcoded
// string in shell chrome is caught — the gap that shipped the untranslated
// footer/modals (fixed 2026-06-14).
const I18N_SKIP_FILES = new Set([
  'Wordmark.tsx', 'AnimatedSplash.tsx',
]);
// Words that are valid bare JSX text but never user copy to translate.
const I18N_TEXT_OK = /^(?:[\s\d.,:;!?%$€£¥+\-/×·•|()[\]]+|[A-Za-z]{1})$/;
// Code-like spans wrongly captured by the >…< scan: a stray `>` from an arrow
// (`=>`), a TS generic, or a comparison, followed later by a JSX `<`, swallows a
// run of source between them. User-facing copy never contains these tokens, so
// reject the match when any appears. (Found 2026-06-11: `(it) => it.done).length;
// return (` flagged as copy.) Also reject a span that starts with a closing
// bracket or ends with an opening one — that's a swallowed JSX ternary fragment
// like `) : onPress ? (`, never copy (found 2026-06-14 on AboutRow).
const I18N_CODE_LIKE = /[;=]|=>|\)\.|\]\(|\b(?:return|const|let|var|function|import|export|null|undefined)\b|^[)\]}]|[([{]$/;

const ruleNoHardcodedStrings = () => {
  if (surface !== 'rn') return skip('i18n/no-hardcoded-strings', 'Not a React Native app');
  if (!exists(join(appDir, 'src', 'i18n'))) {
    return i18nWarn('i18n/no-hardcoded-strings',
      'No src/i18n module — every v1 must be translation-ready (externalized strings via the app-shell i18n module)');
  }
  const files = srcSourceFiles().filter((f) => {
    const rel = relative(join(appDir, 'src'), f).replace(/\\/g, '/');
    if (!/\.tsx$/.test(f)) return false;
    // Scan screens + components AND the app shell (src/shell — AppShell and any
    // shell chrome); the shell renders user-facing text too (canon § Translations).
    if (!(rel.startsWith('screens/') || rel.startsWith('components/') || rel.startsWith('shell/'))) return false;
    if (I18N_SKIP_FILES.has(f.split(/[\\/]/).pop())) return false;
    return true;
  });
  const hits = [];
  for (const f of files) {
    const raw = readText(f);
    if (!raw) continue;
    // Type-alias declarations (`type Props = CompositeScreenProps<A, B>;`) are
    // pure type-land — their generic params (`>, Name<`) pattern-match the JSX
    // scan below as fake copy (found 2026-07-08 on the home-maintenance build:
    // `…'Due'>, NativeStackScreenProps<…`). Strip them before scanning.
    const text = stripComments(raw).replace(
      /^[ \t]*(?:export\s+)?type\s+[A-Za-z0-9_]+\s*=[^;]*;/gm,
      ''
    );
    // 1) Raw JSX text content: >copy< (no braces/tags inside). The opening `>`
    //    must close a tag (not be an operator like `=>` / `>=`) and the closing
    //    `<` must open a tag (a tag-name letter or a `/`), never a comparison
    //    like `offset < 0`. Without these guards, a JS arrow/comparison `>`…`<`
    //    span swallows source between two attributes as fake "copy" (found
    //    2026-06-12 on the budget proving run: `offset >= 0}…() => offset < 0`).
    for (const m of text.matchAll(/(?<![=!<>&|+\-*/])>([^<>{}]+)<(?=[A-Za-z/])/g)) {
      const inner = m[1].replace(/\s+/g, ' ').trim();
      if (!inner || I18N_TEXT_OK.test(inner)) continue;
      if (!/[A-Za-z]{2,}/.test(inner)) continue;
      if (I18N_CODE_LIKE.test(inner)) continue; // swallowed source, not copy
      hits.push(`${relative(appDir, f)}: "${inner.slice(0, 40)}"`);
    }
    // 2) Raw user-facing string props.
    for (const m of text.matchAll(/\b(placeholder|accessibilityLabel|accessibilityHint|title)\s*=\s*"([^"]*[A-Za-z]{2,}[^"]*)"/g)) {
      hits.push(`${relative(appDir, f)}: ${m[1]}="${m[2].slice(0, 30)}"`);
    }
  }
  if (hits.length) {
    return i18nWarn('i18n/no-hardcoded-strings',
      `${hits.length} hardcoded user-facing string(s) in screens/components — move to src/i18n/appStrings.ts and read via t()`,
      hits.slice(0, 12));
  }
  return pass('i18n/no-hardcoded-strings', `No hardcoded user-facing strings in ${files.length} screen/component file(s)`);
};

// ---------- rule: dark-mode appearance control (canon § Theming) ----------
//
// Rendering already follows the OS via the canonical useTheme() (light/dark
// palettes in src/theme/colors.ts). This rule guards the USER-FACING control:
// every app renders the canonical <AppearanceToggle/> (System/Light/Dark) in
// Settings and applies the saved choice at the app root via
// useApplyThemePreference() — both shipped by the design-system module so no
// app forks them. WARN during rollout (codify→backfill→shipgate, like the
// testing/i18n tiers); promote per-app to FAIL with `"theme/enforce": true` in
// qa/baseline.json once it's wired green.
const enforceTheme = baseline['theme/enforce'] === true;
const themeWarn = (id, message, detail) => (enforceTheme ? fail : warn)(id, message, detail);

const ruleAppearanceToggle = () => {
  if (surface !== 'rn') return skip('theme/appearance-toggle', 'Not a React Native app');
  // App.tsx (root apply hook in non-shell apps) lives outside src/, so include
  // it explicitly; shell apps carry the hook in src/shell/AppShell.tsx.
  const haystack = [...srcSourceFiles(), join(appDir, 'App.tsx')]
    .map(readText)
    .filter(Boolean)
    .join('\n');
  if (!haystack) return skip('theme/appearance-toggle', 'No source files');
  const hasToggle = /<AppearanceToggle\b/.test(haystack);
  const hasApply = /useApplyThemePreference\s*\(/.test(haystack);
  if (hasToggle && hasApply) {
    return pass('theme/appearance-toggle',
      'Renders <AppearanceToggle/> and applies the saved preference at root (canon § Theming)');
  }
  const missing = [];
  if (!hasToggle) missing.push('no <AppearanceToggle/> rendered — Settings must offer System / Light / Dark');
  if (!hasApply) missing.push('no useApplyThemePreference() at the app root — a saved Light/Dark choice is ignored on launch');
  return themeWarn('theme/appearance-toggle', 'Dark-mode appearance control incomplete (canon § Theming)', missing);
};

// ---------- rule: in-app language control (canon § Translations) ----------
//
// The shell already follows the device locale automatically; this rule guards
// the USER-FACING control: a shell app renders the canonical <LanguageSetting/>
// in Settings (the translation sibling of <AppearanceToggle/>) and applies the
// saved language at root via useApplyLocalePreference() (shipped in AppShell, so
// shell apps get it for free). It only applies to shell apps — a pre-shell app
// has no in-app i18n to switch, so the rule SKIPS when the locale store is
// absent. WARN during rollout (codify→backfill→shipgate, like § Theming);
// promote per-app to FAIL with `"language/enforce": true` in qa/baseline.json.
const enforceLanguage = baseline['language/enforce'] === true;
const languageWarn = (id, message, detail) => (enforceLanguage ? fail : warn)(id, message, detail);

const ruleLanguageControl = () => {
  if (surface !== 'rn') return skip('language/control', 'Not a React Native app');
  if (!exists(join(appDir, 'src/i18n/localePreference.ts')))
    return skip('language/control', 'No shell i18n locale store — pre-shell app, nothing to switch in-app');
  const haystack = [...srcSourceFiles(), join(appDir, 'App.tsx')]
    .map(readText)
    .filter(Boolean)
    .join('\n');
  if (!haystack) return skip('language/control', 'No source files');
  const hasControl = /<LanguageSetting\b/.test(haystack);
  const hasApply = /useApplyLocalePreference\s*\(/.test(haystack);
  if (hasControl && hasApply) {
    return pass('language/control',
      'Renders <LanguageSetting/> and applies the saved language at root (canon § Translations)');
  }
  const missing = [];
  if (!hasControl) missing.push('no <LanguageSetting/> rendered — Settings must offer a Language picker');
  if (!hasApply) missing.push('no useApplyLocalePreference() at the app root (should ride the synced AppShell)');
  return languageWarn('language/control', 'In-app language control incomplete (canon § Translations)', missing);
};

// ---------- rule: dark-mode contrast pairing (canon § Theming) ----------
//
// The OS-following palettes (src/theme/colors.ts) INVERT in dark mode: every
// surface that is dark in light mode (c.fg, c.inkButton) becomes light in dark
// mode. A button's foreground must therefore be the token that inverts WITH its
// background — the matched pairs are `inkButton`/`inkButtonText` and `fg`/`bg`.
// The trap that shipped a real production defect (packing-list's empty-state CTA
// + FAB invisible in dark, reported by a dark-mode user 2026-06-17): pairing an
// inverting button with `c.fgOnInk`/`c.fgOnAccent`, which are PAPER-coloured in
// BOTH palettes — so on the dark-mode (now light) button the label/icon is
// white-on-white. `c.fgOnInk` has no correct background in the inverting palette
// (its only intended surface, the ink button, flips to light); the correct token
// is always `c.inkButtonText`. `c.fgOnAccent` is legitimate ONLY on the green
// `c.accent` surface (the white check on a "done" box). Two checks:
//   A. `c.fgOnInk` used as a foreground anywhere in src → FAIL (use inkButtonText).
//   B. any single style object pairing a `backgroundColor` + `color` whose WCAG
//      contrast is legible in one palette (>=4.5) but COLLAPSES (<2.0) in the
//      other → FAIL (an inversion mismatch, regardless of the tokens involved).
// Hard FAIL (a defect rule like parity/*), not a rollout WARN: every flagged
// pair is an invisible control, and the whole fleet is backfilled green here.

// Backgrounds that are overlays/scrims, never a surface text sits directly on
// (a sheet always sits between) — excluded from check B to avoid mis-pairing.
const CONTRAST_BG_IGNORE = new Set(['bgScrim']);

const ruleContrastPairing = () => {
  if (surface !== 'rn') return skip('theme/contrast-pairing', 'Not a React Native app');
  const colorsPath = join(appDir, 'src/theme/colors.ts');
  if (!exists(colorsPath)) return skip('theme/contrast-pairing', 'No src/theme/colors.ts to resolve tokens');

  // --- resolve the light/dark palettes from colors.ts (single source of truth) ---
  const colorsSrc = readText(colorsPath) || '';
  const palette = (name) => {
    const m = new RegExp(`const\\s+${name}\\b[^=]*=\\s*\\{`).exec(colorsSrc);
    if (!m) return null;
    let i = colorsSrc.indexOf('{', m.index), depth = 0, end = i;
    for (; end < colorsSrc.length; end++) {
      if (colorsSrc[end] === '{') depth++;
      else if (colorsSrc[end] === '}' && --depth === 0) { end++; break; }
    }
    const map = {};
    for (const pm of colorsSrc.slice(i + 1, end - 1).matchAll(/(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)")/g)) {
      map[pm[1]] = pm[2] ?? pm[3];
    }
    return map;
  };
  const light = palette('light'), dark = palette('dark');
  if (!light || !dark || !light.bg || !dark.bg) {
    return skip('theme/contrast-pairing', 'Could not parse light/dark palettes from colors.ts');
  }
  const toRgb = (str, base) => {
    if (!str) return null;
    str = str.trim();
    let m = str.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (m) {
      let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return [0, 2, 4].map((o) => parseInt(h.substr(o, 2), 16));
    }
    m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m) {
      const r = +m[1], g = +m[2], b = +m[3], a = m[4] == null ? 1 : +m[4];
      if (a >= 1 || !base) return [r, g, b];
      return [0, 1, 2].map((i) => Math.round(a * [r, g, b][i] + (1 - a) * base[i]));
    }
    return null;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const resolve = (mode, tok) => toRgb(mode[tok], toRgb(mode.bg));
  // contrast of (bgToken, fgToken) in both palettes → [lightRatio, darkRatio] or null
  const pairRatios = (bgTok, fgTok) => {
    const lb = resolve(light, bgTok), lf = resolve(light, fgTok);
    const db = resolve(dark, bgTok), df = resolve(dark, fgTok);
    if (!lb || !lf || !db || !df) return null;
    return [ratio(lb, lf), ratio(db, df)];
  };
  const collapses = (rs) => rs && Math.min(rs[0], rs[1]) < 2.0 && Math.max(rs[0], rs[1]) >= 4.5;

  const files = srcSourceFiles().filter((f) => f !== colorsPath);
  const failsA = [];
  const failsB = [];

  // brace-matched block that ENCLOSES character index `idx` (the nearest {...})
  const enclosingBlock = (code, idx) => {
    let i = idx, depth = 0;
    for (; i >= 0; i--) { if (code[i] === '}') depth++; else if (code[i] === '{') { if (depth === 0) break; depth--; } }
    if (i < 0) return null;
    let j = i, d = 0;
    for (; j < code.length; j++) { if (code[j] === '{') d++; else if (code[j] === '}' && --d === 0) { j++; break; } }
    return code.slice(i, j);
  };

  for (const f of files) {
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    const rel = relative(appDir, f);
    // Check A — fgOnInk as a foreground (no correct inverting background exists)
    for (const m of code.matchAll(/\bc\.fgOnInk\b/g)) {
      failsA.push(`${rel}:${code.slice(0, m.index).split('\n').length}`);
    }
    // Check B — same style object pairs a background + text colour that collapses
    for (const m of code.matchAll(/\bbackgroundColor\s*:\s*c\.(\w+)/g)) {
      const bgTok = m[1];
      if (CONTRAST_BG_IGNORE.has(bgTok)) continue;
      const block = enclosingBlock(code, m.index);
      if (!block) continue;
      const cm = /(?<![A-Za-z])color\s*:\s*c\.(\w+)/.exec(block); // plain `color:` only
      if (!cm) continue;
      const fgTok = cm[1];
      if (fgTok === 'fgOnInk') continue; // already reported by check A
      const rs = pairRatios(bgTok, fgTok);
      if (collapses(rs)) {
        const line = code.slice(0, m.index).split('\n').length;
        failsB.push(`${rel}:${line}: c.${bgTok} bg + c.${fgTok} text → ${rs[0].toFixed(1)}:1 light / ${rs[1].toFixed(1)}:1 dark (invisible in ${rs[0] < rs[1] ? 'light' : 'dark'})`);
      }
    }
  }

  const detail = [];
  if (failsA.length) detail.push(`c.fgOnInk used as a foreground (${failsA.length}) — paper in both palettes, invisible on the inverted dark-mode button; use c.inkButtonText: ${failsA.slice(0, 10).join(', ')}${failsA.length > 10 ? ' …' : ''}`);
  if (failsB.length) detail.push(...failsB.slice(0, 10));
  if (detail.length) {
    return fail('theme/contrast-pairing',
      'Dark-mode contrast inversion — a button foreground does not invert with its background (canon § Theming)', detail);
  }
  return pass('theme/contrast-pairing', 'No dark-mode contrast-inversion pairs (matched inkButton/inkButtonText + fg/bg)');
};

// ---------- rule: no price/promo text baked into store screenshots ----------

// Both Apple AND Google Play reject price/promo words baked into a screenshot.
// Apple rejected grocery-list's production build 2026-06-24 for "Free" in the
// slot-1 caption; Play's metadata policy bars the same in screenshot graphics.
// The cost claim belongs in the description, never the image (canon
// § Screenshot principles, § Long description structure). We scan every per-slot
// `caption` across all stores in qa/screenshots.config.json. The slot-2 Josh
// Approved card (kind: "card") has no caption and is the deliberate brand
// exception (it carries the wedge by design), so it never trips this rule.
const CAPTION_PRICE_RE = /\bfree\b|\bpaywall\b|\bno ads\b|\bfor free\b|\bon sale\b|\bdiscount(?:ed)?\b|\b\d+%\s*off\b|\$\s*\d/i;

const ruleScreenshotCaptionNoPrice = () => {
  const cfgPath = join(appDir, 'qa', 'screenshots.config.json');
  if (!exists(cfgPath)) return skip('store/caption-no-price', 'No qa/screenshots.config.json');
  const cfg = readJson(cfgPath);
  if (!cfg || !cfg.stores || typeof cfg.stores !== 'object') {
    return skip('store/caption-no-price', 'screenshots.config.json has no stores map');
  }
  const hits = [];
  for (const [store, slots] of Object.entries(cfg.stores)) {
    if (!Array.isArray(slots)) continue;
    for (const slot of slots) {
      const cap = slot && typeof slot.caption === 'string' ? slot.caption : '';
      if (!cap) continue;
      const m = cap.match(CAPTION_PRICE_RE);
      if (m) hits.push(`${store}/${slot.id || '?'}: "${cap}" — price/promo word: "${m[0].trim()}"`);
    }
  }
  if (hits.length) {
    return fail('store/caption-no-price',
      'Screenshot caption carries a price/promo word — both Apple and Google Play reject price text baked into a screenshot (canon § Screenshot principles). Move the cost claim to the description ("free to use", near the top); keep captions function-only.',
      hits);
  }
  return pass('store/caption-no-price', 'No price/promo words in any screenshot caption');
};

// ---------- runner ----------

// Committed demo GIFs must be framed correctly and free of the simulator home
// screen. The hard, fail-closed gate lives at production time in
// demo-capture.mjs; this is the committed-asset belt-and-suspenders. Cheap part
// (works everywhere incl. app-synced CI): every demo gif must carry a
// `.frame.json` device-frame spec — its absence means an ungated / legacy asset
// to re-render. Full part (factory only, where demo-frame-check.mjs + ffmpeg are
// present): run the gate and FAIL on a launcher/dims defect. Degrades to the
// cheap check when the module or ffmpeg is unavailable, so app CI never reds on it.
async function ruleDemoFramesValid({ appDir }) {
  const demoDir = join(appDir, 'store-assets', 'demos');
  if (!exists(demoDir)) return skip('demo/frames', 'no store-assets/demos');
  let gifs;
  try { gifs = readdirSync(demoDir).filter((f) => f.endsWith('.gif')); } catch { return skip('demo/frames', 'demos unreadable'); }
  if (!gifs.length) return skip('demo/frames', 'no demo gifs');

  let gate = null;
  try { gate = (await import(new URL('./demo-frame-check.mjs', import.meta.url).href)).checkDemoFile; } catch { /* app-synced context */ }
  let ffmpegOk = false;
  try { execSync('command -v ffmpeg && command -v ffprobe', { stdio: 'ignore' }); ffmpegOk = true; } catch { /* no ffmpeg */ }

  const results = [];
  for (const gif of gifs) {
    const gifPath = join(demoDir, gif);
    if (!exists(gifPath.replace(/\.gif$/, '.frame.json'))) {
      results.push(warn('demo/frame-spec', `${gif} has no frame-spec sidecar — re-render via demo-capture so it is gated`));
    }
    if (gate && ffmpegOk) {
      try {
        const res = gate(gifPath);
        const hard = res.findings.filter((f) => f.severity === 'fail' && f.check !== 'io');
        if (hard.length) results.push(fail('demo/frame-quality', `${gif} misframed or shows the home screen: ${hard.map((f) => f.message).join('; ')}`));
      } catch { /* decode error — leave to the production gate */ }
    }
  }
  return results.length ? results : pass('demo/frames', `${gifs.length} demo gif(s) carry a frame-spec`);
}

// ---------- rules: maintainability standards (engineering-standards.md §1, §6) ----------
//
// The mechanical half of the maintainability standards ratchet (05-maintainability
// Work item 4 / ticket eng-standards-ratchet). WARN, not FAIL — codify→backfill→
// shipgate, like the testing/i18n/theme tiers — so a real decomposition signal is
// surfaced without reddening CI while the current outliers (eng-oversized-screens)
// are decomposed in their own stages. Built false-positives-first: each keys on a
// mechanical fact (line count, dep count, repo-wide reference count), honours the
// same per-app escape as the UX rules (baseline "<id>/skip": true or ["Frag.tsx"]),
// and only names ceilings that engineering-standards.md already documents. No
// style-cop rules — these are predictive smells (a file to split, a dep to justify,
// dead code to drop), not formatting opinions.

// maint/file-size — the soft size ceilings from §1: screens ≤400, components ≤300,
// stores ≤350 lines. Pure data tables are exempt BY OMISSION — only screens/,
// components/, store/ are bucketed; data/ (seedCatalogData 1098, categoryKeywords
// 509), lib/, sync/ are never counted. A file over its ceiling is a decomposition
// signal, not a hard gate.
const SIZE_CEILINGS = [
  { dir: 'screens/', ceiling: 400, label: 'screen' },
  { dir: 'components/', ceiling: 300, label: 'component' },
  { dir: 'store/', ceiling: 350, label: 'store' },
];
const ruleFileSizeCeiling = () => {
  const id = 'maint/file-size';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  if (ruleSkipsAll(id)) return skip(id, 'Disabled via qa/baseline.json "maint/file-size/skip"');
  const files = srcSourceFiles();
  if (!files.length) return skip(id, 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const rel = relative(appDir, f);
    const relSrc = relative(join(appDir, 'src'), f).replace(/\\/g, '/');
    if (relSrc.endsWith('.d.ts')) continue;
    const bucket = SIZE_CEILINGS.find((b) => relSrc.startsWith(b.dir));
    if (!bucket) continue;                                   // data/ tables, lib/, sync/ exempt
    if (ruleSkipsFile(id, rel)) continue;
    const raw = readText(f);
    if (raw == null) continue;
    const lines = raw.split(/\r?\n/).length;
    if (lines > bucket.ceiling) {
      hits.push(`${rel}: ${lines} lines > ${bucket.ceiling}-line ${bucket.label} ceiling — extract a cohesive sub-view or hook`);
    }
  }
  if (hits.length) {
    return warn(id,
      'A screen/component/store file is over its soft size ceiling (screens ≤400, components ≤300, stores ≤350; pure data tables exempt) — a decomposition signal. Split it, or record a deliberate exception in qa/baseline.json "maint/file-size/skip": ["File.tsx"]', hits);
  }
  return pass(id, 'Screen/component/store files are within their size ceilings');
};

// maint/dep-budget — §6 dependency policy: every dep is a liability. The RN fleet
// runs 24–39 runtime deps (Expo modularity inflates the raw count); a jump past
// the budget signals a cluster of non-platform deps to justify. WARN; the per-app
// budget can be raised with baseline "maint/dep-budget": <n> when growth is
// justified (distinct key from the "/skip" escape).
const RUNTIME_DEP_BUDGET = 48; // fleet max 39 (grocery-list) as of 2026-07 + headroom
const ruleDepBudget = () => {
  const id = 'maint/dep-budget';
  if (surface !== 'rn') return skip(id, 'Not an RN app'); // budget is calibrated to the RN fleet
  if (ruleSkipsAll(id)) return skip(id, 'Disabled via qa/baseline.json "maint/dep-budget/skip"');
  const pkg = readJson(join(appDir, 'package.json'));
  if (!pkg) return skip(id, 'No package.json');
  const n = Object.keys(pkg.dependencies || {}).length;
  const budget = typeof baseline['maint/dep-budget'] === 'number' ? baseline['maint/dep-budget'] : RUNTIME_DEP_BUDGET;
  if (n > budget) {
    return warn(id,
      `${n} runtime dependencies exceed the budget of ${budget} — prefer Expo/stdlib and state a one-line justification per addition (§6). Raise the per-app budget in qa/baseline.json "maint/dep-budget": ${n} if this growth is justified`,
      [`package.json declares ${n} entries under "dependencies"`]);
  }
  return pass(id, `${n} runtime dependencies within the budget of ${budget}`);
};

// maint/orphaned-export was PROTOTYPED and DROPPED (2026-07-03, ticket
// eng-standards-ratchet). A grep-based "exported symbol referenced nowhere else"
// rule cannot meet the false-positives-first bar under the shell/app boundary:
// the app shell OVERWRITE-SYNCS a full canonical API surface (kv.ts accessors,
// EmptyState/ScreenHeader/SettingsAbout, backup/log helpers) into every app, and
// an app that wires only a subset is NOT carrying dead code — those exports are
// shared scaffolding by design. Tested against the fleet it flagged ~20 such
// shell exports per app as "remove it" — exactly wrong advice. Separating true
// app-authored dead code from shell-provided-unused-API would require coupling
// qa-canonical to the shell file map (unavailable in the app-synced CI context)
// plus reserved-config awareness. Deferred to a tsserver/ts-morph-grade pass;
// the two clean, predictive rules above ship instead.

// ---------- rules: UX interaction patterns (Uplevel-3 T3, 03-functional-ux-depth) ----------
//
// Deterministic checks for the UX defect class Josh keeps hitting on-device —
// unreachable actions, dead-end lists, un-confirmed destructive taps. WARN by
// default (codify→backfill→shipgate, like the testing/i18n/theme tiers);
// promote a per-app to FAIL with qa/baseline.json "ux/enforce": true once the
// backfill stage closes its gaps. Built FALSE-POSITIVES-FIRST: each keys on real
// JSX/usage (comments stripped so prose never matches), errs toward SILENCE, and
// honours the same per-app escape as the other UX rules (baseline "<id>/skip":
// true, or an array of path fragments). Each rule's pure core is self-tested
// (`node qa-canonical.mjs --self-test`) against a known-bad + known-good string.
const enforceUx = baseline['ux/enforce'] === true;
const uxWarn = (id, message, detail) => (enforceUx ? fail : warn)(id, message, detail);

// The pressable elements whose OWN tap target we measure. Children (an icon View
// inside a larger pressable) are never inspected — we only read the pressable's
// own `style`, so an icon-inside-a-bigger-button case can't false-positive.
const PRESSABLE_TAGS = ['Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback'];

// Return the opening JSX tag substring starting at `<` index `ltIdx` — the text
// up to and including the `>` that closes the tag, brace/string-aware so a `>`
// inside an attribute expression (`onPress={a > b ? …}`) or string doesn't end it.
const openingTag = (code, ltIdx) => {
  let depth = 0, state = 'code';
  for (let i = ltIdx; i < code.length; i++) {
    const ch = code[i];
    if (state === 'code') {
      if (ch === '{') depth++;
      else if (ch === '}') { if (depth > 0) depth--; }
      else if (ch === "'") state = 'sq';
      else if (ch === '"') state = 'dq';
      else if (ch === '`') state = 'tpl';
      else if (ch === '>' && depth === 0) return code.slice(ltIdx, i + 1);
    } else {
      if (ch === '\\') { i++; continue; }
      if (state === 'sq' && ch === "'") state = 'code';
      else if (state === 'dq' && ch === '"') state = 'code';
      else if (state === 'tpl' && ch === '`') state = 'code';
    }
  }
  return code.slice(ltIdx);
};

// Pull the balanced {…} value of a JSX attribute out of an opening tag, or null.
const attrBraceValue = (tag, attr) => {
  const m = new RegExp(`\\b${attr}\\s*=\\s*\\{`).exec(tag);
  if (!m) return null;
  const open = tag.indexOf('{', m.index);
  const bal = matchBalanced(tag, open, '{', '}');
  return bal ? bal.inner.trim() : null;
};

// Resolve a named style (`styles.foo` / `s.foo`) to its object body from the
// file's StyleSheet.create block(s). Best-effort: returns '' when not found.
const resolveNamedStyle = (code, name) => {
  const re = new RegExp(`\\b${name}\\s*:\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf('{', m.index);
    const bal = matchBalanced(code, open, '{', '}');
    if (bal) return bal.inner;
  }
  return '';
};

// A numeric size literal < 44 on the pressable's own style; `target.min` / a
// hitSlop token / a percentage or variable size are all non-matches (pass).
const STYLE_SIZE_RE = /\b(minHeight|height|minWidth|width)\s*:\s*(\d+(?:\.\d+)?)\b/g;
const TARGET_TOKEN_RE = /\btarget\s*\.\s*min\b|\bMIN(?:_TAP)?_TARGET\b|\bhitSlop\b/;

// Pure core (self-tested): find pressables whose own style sets a sub-44 size and
// carry no hitSlop. Known blind spots (deliberate — err toward silence): sizes
// from variables/props/computed expressions, styles defined in another file,
// percentage/`'auto'` widths, and array-of-conditional styles beyond the named
// refs we can resolve. A miss is safer than nagging on a healthy screen.
const detectSmallTouchTargets = (code) => {
  const hits = [];
  for (const tag of PRESSABLE_TAGS) {
    const re = new RegExp(`<\\s*${tag}\\b`, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      const openTag = openingTag(code, m.index);
      if (/\bhitSlop\b/.test(openTag)) continue;             // expanded target → fine
      const styleVal = attrBraceValue(openTag, 'style');
      if (styleVal == null) continue;                        // no own style to measure
      let styleText = styleVal;
      for (const ref of styleVal.matchAll(/\b(?:styles?|s|st)\.(\w+)/g)) {
        styleText += '\n' + resolveNamedStyle(code, ref[1]);
      }
      // A shadow/text-shadow offset is `{ width: 0, height: 4 }` — a shadow
      // vector, NOT a tap-target dimension. Strip these before measuring so a
      // FAB's own `shadowOffset: { width: 0 }` doesn't read as a 0dp target
      // (packing-list FAB, found 2026-07-08 T3 backfill).
      styleText = styleText.replace(/(?:shadowOffset|textShadowOffset)\s*:\s*\{[^}]*\}/g, '');
      if (TARGET_TOKEN_RE.test(styleText)) continue;         // uses target.min / hitSlop → fine
      STYLE_SIZE_RE.lastIndex = 0;
      let sm, small = null;
      while ((sm = STYLE_SIZE_RE.exec(styleText)) !== null) {
        if (parseFloat(sm[2]) < 44) { small = `${sm[1]}: ${sm[2]}`; break; }
      }
      if (small) {
        const line = code.slice(0, m.index).split(/\r?\n/).length;
        hits.push({ line, detail: `<${tag}> own style sets ${small} (< 44dp) and passes no hitSlop — tap target below the 44dp floor (raise the size, add hitSlop, or use target.min)` });
      }
    }
  }
  return hits;
};

const ruleTouchTargetMin = () => {
  const id = 'ux/touch-target-min';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  if (ruleSkipsAll(id)) return skip(id, 'Disabled via qa/baseline.json "ux/touch-target-min/skip"');
  const files = srcSourceFiles().filter((f) => {
    const rel = relative(join(appDir, 'src'), f).replace(/\\/g, '/');
    return rel.startsWith('screens/') || rel.startsWith('components/');
  });
  if (!files.length) return skip(id, 'No screen/component source files');
  const hits = [];
  for (const f of files) {
    const rel = relative(appDir, f);
    if (ruleSkipsFile(id, rel)) continue;
    const raw = readText(f);
    if (!raw) continue;
    for (const h of detectSmallTouchTargets(stripComments(raw))) hits.push(`${rel}:${h.line}: ${h.detail}`);
  }
  if (hits.length) {
    return uxWarn(id,
      'Touch target below 44dp — a pressable\'s own style sets a sub-44 height/width with no hitSlop. A user (especially large-finger / motor-impaired) can miss it. Raise the size to 44, add hitSlop, or size from target.min', hits);
  }
  return pass(id, 'No pressables with a sub-44dp own size and no hitSlop');
};

// Pure core (self-tested): a FlatList/SectionList surface that offers no empty
// state. Returns null when the file renders no list (not applicable), false when
// it renders one WITH an empty surface (EmptyState / ListEmptyComponent / a
// zero-length branch), true when a list has NO empty surface. Blind spot: an
// empty state driven by a pre-computed boolean (`isEmpty`) reads as missing — a
// WARN worth a look, cleared by rendering <EmptyState/> or a baseline skip.
const LIST_RE = /<\s*(?:FlatList|SectionList)\b/;
const EMPTY_SURFACE_RE = /ListEmptyComponent|<\s*EmptyState\b|\.length\s*(?:===?|!==?|<|<=|>|>=)\s*\d|!\s*\w[\w.]*\.length|\.length\s*\?/;
const detectMissingEmptyState = (code) => {
  if (!LIST_RE.test(code)) return null;
  return !EMPTY_SURFACE_RE.test(code);
};

const ruleEmptyStatePresent = () => {
  const id = 'ux/empty-state-present';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  if (ruleSkipsAll(id)) return skip(id, 'Disabled via qa/baseline.json "ux/empty-state-present/skip"');
  const files = srcSourceFiles().filter((f) => {
    const rel = relative(join(appDir, 'src'), f).replace(/\\/g, '/');
    return rel.startsWith('screens/') || rel.startsWith('components/');
  });
  if (!files.length) return skip(id, 'No screen/component source files');
  const hits = [];
  for (const f of files) {
    const rel = relative(appDir, f);
    if (ruleSkipsFile(id, rel)) continue;
    const raw = readText(f);
    if (!raw) continue;
    if (detectMissingEmptyState(stripComments(raw)) === true) {
      hits.push(`${rel}: renders a FlatList/SectionList but no <EmptyState/> / ListEmptyComponent / zero-length branch — the first-run / all-cleared screen is blank`);
    }
  }
  if (hits.length) {
    return uxWarn(id,
      'List with no empty state — a FlatList/SectionList surface must render an empty state (the canon § First-run moment bar): <EmptyState/>, ListEmptyComponent, or a zero-length branch to an alternative surface, so the first-run and all-cleared screens are never blank', hits);
  }
  return pass(id, 'Every list surface renders an empty state');
};

// Pure core (self-tested): destructive data deletes that sit in a file with no
// confirm/undo. Returns null when the file has no destructive call, false when a
// confirm (Alert.alert / confirm*() / <Confirm…) or an `undo` identifier is
// present, else the unguarded call sites.
//
// The verb is a camelCase data action — deleteKit(, removeStaple(, store.deleteList( —
// NOT a bare `.remove(` / `.delete(`. That lower-case dot-form is dominated by
// event-subscription cleanup (`subscription.remove()`, `AppState.addEventListener(…).remove()`)
// and Set/Map `.delete(x)`, none of which are user-data deletes — matching it
// trained the linter to cry wolf on every modal's listener teardown (grocery-list
// had 6 such false hits). So we require a Capital after the verb (a named data
// action) and additionally denylist the camelCase framework removers. Blind
// spots (err toward silence): a lower-case `list.remove(item)` data delete is not
// matched; a confirm that lives in a different file than the delete reads as
// unguarded (fires) — cleared by co-locating the confirm or a baseline skip.
const DELETE_CALL_RE = /\b(?:delete|remove)([A-Z]\w*)\s*\(/g;
const DELETE_DENYLIST = /\b(?:removeListener|removeEventListener|removeAllListeners|removeItem|removeChangeListener|removeSubscription|removeChild|removeClippedSubviews)\b/;
// `undo` is matched as a substring (not a bounded word): real undo affordances
// are camelCase identifiers — showUndoToast, undoDelete, handleUndo — where the
// token is embedded, not standalone. Comments are already stripped, so a prose
// "undo" can't match.
// A guard is: an Alert.alert, a confirm*( call, a <Confirm…> element, an `undo`
// affordance, OR the canonical cross-platform `useConfirm()` primitive (its
// `confirm.open({…})` opens a titled Cancel/Confirm card — grocery-list's Dialogs,
// added 2026-07-08 for the T3 destructive-confirm backfill). `confirm.open(` is
// not caught by `confirm\w*\(` (the dot breaks the \w run), so match it explicitly.
const CONFIRM_OR_UNDO_RE = /\bAlert\s*\.\s*alert\s*\(|\bconfirm\w*\s*\(|\buseConfirm\b|<\s*Confirm|undo/i;
// A remove<Noun>( that has a symmetric add<Noun>( / set<Noun>( in the same file
// is a reversible TOGGLE (mark/unmark a "usual", pin/unpin), not an unrecoverable
// data delete — one tap flips it straight back. Matching it trained the linter to
// cry wolf on every toggle (grocery-list's ItemEditor `toggleUsual`: addStaple /
// removeStaple). So a remove whose noun has a same-file add/set counterpart is
// excused (found 2026-07-08, T3 backfill).
const hasToggleCounterpart = (code, noun) =>
  new RegExp(`\\b(?:add|set)${noun}\\s*\\(`).test(code);
const detectUnconfirmedDeletes = (code) => {
  const hasGuard = CONFIRM_OR_UNDO_RE.test(code);
  const hits = [];
  DELETE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = DELETE_CALL_RE.exec(code)) !== null) {
    const window = code.slice(Math.max(0, m.index - 24), m.index + m[0].length + 4);
    if (DELETE_DENYLIST.test(window)) continue;
    if (/^remove/.test(m[0]) && hasToggleCounterpart(code, m[1])) continue; // reversible toggle
    const line = code.slice(0, m.index).split(/\r?\n/).length;
    hits.push({ line, call: `${m[0].trim()}` });
  }
  if (!hits.length) return null;
  return hasGuard ? false : hits;
};

const ruleDestructiveConfirm = () => {
  const id = 'ux/destructive-confirm';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  if (ruleSkipsAll(id)) return skip(id, 'Disabled via qa/baseline.json "ux/destructive-confirm/skip"');
  const files = srcSourceFiles().filter((f) => {
    const rel = relative(join(appDir, 'src'), f).replace(/\\/g, '/');
    return rel.startsWith('screens/') || rel.startsWith('components/');
  });
  if (!files.length) return skip(id, 'No screen/component source files');
  const hits = [];
  for (const f of files) {
    const rel = relative(appDir, f);
    if (ruleSkipsFile(id, rel)) continue;
    const raw = readText(f);
    if (!raw) continue;
    const found = detectUnconfirmedDeletes(stripComments(raw));
    if (Array.isArray(found)) {
      for (const h of found) hits.push(`${rel}:${h.line}: ${h.call} — deletes user data with no Alert.alert confirm and no undo in this file`);
    }
  }
  if (hits.length) {
    return uxWarn(id,
      'Destructive action with no confirm or undo — a delete*/remove* of user data fires from a screen/component that has no Alert.alert confirmation and no undo affordance. A mis-tap is unrecoverable. Wrap it in a confirm, or offer undo (canon § Interaction safety)', hits);
  }
  return pass(id, 'Destructive actions confirm or offer undo');
};

// ---------- rules: shipped-but-dead modules (ticket qa-canonical-wired-modules) ----------
//
// The module-present-but-never-called defect class hit three times on one app
// (home-maintenance + tend shipped/ship a review prompt and/or tip jar that
// nothing triggers). These two guard it: a module file exists in the tree but no
// screen/App renders or calls it, so it's dead weight the user never sees. WARN.

// Pure core (self-tested): is recordSuccessfulCompletion referenced by any of the
// candidate caller texts (screens + App.tsx)?
const completionReferenced = (callerTexts) =>
  callerTexts.some((t) => typeof t === 'string' && t.includes('recordSuccessfulCompletion'));

// A `src/lib/*` file is a legitimate wiring-indirection layer: an app may
// centralize its success moment in e.g. lib/reviewTrigger.ts (which calls
// recordSuccessfulCompletion) and have a screen import THAT. Count such a lib
// file as a caller only when a screen/App actually imports it (by basename), so
// the indirection is real, not a dead re-export (packing-list, found 2026-07-08).
const libWiringCallerTexts = (appDir, screenAppTexts) => {
  const out = [];
  const libDir = join(appDir, 'src', 'lib');
  if (!exists(libDir)) return out;
  const importedBases = new Set();
  for (const text of screenAppTexts) {
    for (const m of text.matchAll(/from\s+['"][^'"]*\/lib\/([A-Za-z0-9_]+)['"]/g)) importedBases.add(m[1]);
  }
  for (const f of srcSourceFiles()) {
    const rel = relative(join(appDir, 'src'), f).replace(/\\/g, '/');
    if (!rel.startsWith('lib/')) continue;
    const base = rel.replace(/^lib\//, '').replace(/\.(t|j)sx?$/, '');
    if (importedBases.has(base)) out.push(readText(f) || '');
  }
  return out;
};

const ruleReviewPromptWired = () => {
  const id = 'review-prompt/wired';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  const mod = join(appDir, 'src', 'storage', 'reviewPrompt.ts');
  if (!exists(mod)) return skip(id, 'No src/storage/reviewPrompt.ts (no review prompt module)');
  const screenApp = [
    ...srcSourceFiles().filter((f) => relative(join(appDir, 'src'), f).replace(/\\/g, '/').startsWith('screens/')),
    join(appDir, 'App.tsx'),
  ].map((f) => readText(f) || '');
  const callers = [...screenApp, ...libWiringCallerTexts(appDir, screenApp)];
  if (!completionReferenced(callers)) {
    return warn(id,
      'Review prompt is dead: src/storage/reviewPrompt.ts exists but recordSuccessfulCompletion is never called from a screen, App.tsx, or a screen-imported src/lib wiring file, so the prompt can never fire. Call it at the app\'s genuine success moment, or delete the module',
      ['recordSuccessfulCompletion not referenced from src/screens/**, App.tsx, or a screen-imported src/lib/*']);
  }
  return pass(id, 'Review prompt is wired (recordSuccessfulCompletion reachable from a screen/App)');
};

const ruleTipJarWired = () => {
  const id = 'funding/tip-jar-wired';
  if (surface !== 'rn') return skip(id, 'Not an RN app');
  const sheet = join(appDir, 'src', 'components', 'TipJarSheet.tsx');
  if (!exists(sheet)) return skip(id, 'No src/components/TipJarSheet.tsx (no tip jar)');
  const others = srcSourceFiles().filter((f) => f !== sheet).map((f) => readText(f) || '');
  const renderedElsewhere = others.some((t) => /<\s*TipJarSheet\b/.test(t));
  const onSupportPassed = others.some((t) => /onSupport\s*=\s*\{/.test(t));
  const missing = [];
  if (!renderedElsewhere) missing.push('TipJarSheet.tsx exists but is never rendered (<TipJarSheet …/>) outside its own file — the tip jar is unreachable');
  if (!onSupportPassed) missing.push('no onSupport={…} handler is passed to any footer/row — nothing opens the tip jar');
  if (missing.length) {
    return warn(id, 'Tip jar present but not wired to a trigger — the module ships but the user can never open it (canon § Donation prompt)', missing);
  }
  return pass(id, 'Tip jar is rendered and reachable (onSupport wired)');
};

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
  ruleNoIosOnlyImports,
  ruleNoAlertPrompt,
  ruleNoPlatformEarlyReturn,
  ruleEasJsonShape,
  ruleAppearanceToggle,
  ruleContrastPairing,
  ruleLanguageControl,
  ruleAppNameSpotlightSafe,
  ruleKeyboardDismissEscape,
  ruleModalSafeAreaProvider,
  ruleEntryScreenAutofocus,
  ruleCreateOnMount,
  ruleScrollformKeyboardAvoidance,
  ruleTouchTargetMin,
  ruleEmptyStatePresent,
  ruleDestructiveConfirm,
  ruleReviewPromptWired,
  ruleTipJarWired,
  ruleSplashWordmarkClip,
  ruleTipJarNoGmsGuard,
  ruleManifestMv3,
  ruleManifestPermissionsTight,
  ruleTestScriptPresent,
  ruleTrustCoreCovered,
  ruleFlowHasAssertions,
  ruleFlowDrift,
  ruleActionsMapped,
  ruleNoHardcodedStrings,
  ruleScreenshotCaptionNoPrice,
  ruleDemoFramesValid,
  ruleFileSizeCeiling,
  ruleDepBudget,
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

// ---------- self-test: prove each new rule's pure core FAILS a known-bad ----------
//
// Canon (gates prove failure): a rule that never fires on the defect it guards is
// theatre. Each UX / wired rule extracts a pure detection core above; here we run
// each against a known-BAD source string (must fire) and a known-GOOD one (must
// not), so a future edit that guts a rule trips the self-test in the chain's
// verify gate. Layout mirrors action-coverage.mjs's in-file runSelfTest().
function runSelfTest() {
  let failed = 0;
  const assert = (cond, msg) => { if (!cond) { failed++; console.error(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

  // ux/touch-target-min
  assert(detectSmallTouchTargets(`<Pressable style={{ height: 32, width: 32 }} onPress={x}/>`).length === 1,
    'touch-target: inline sub-44 size with no hitSlop fires');
  assert(detectSmallTouchTargets(`<Pressable style={{ height: 32 }} hitSlop={8} onPress={x}/>`).length === 0,
    'touch-target: hitSlop on the pressable passes');
  assert(detectSmallTouchTargets(`<Pressable style={{ minHeight: 44 }} onPress={x}/>`).length === 0,
    'touch-target: a 44dp target passes');
  assert(detectSmallTouchTargets(`<Pressable style={{ height: target.min }} onPress={x}/>`).length === 0,
    'touch-target: target.min sizing passes (non-numeric)');
  assert(detectSmallTouchTargets(`const s = StyleSheet.create({ btn: { height: 30 } });\n<Pressable style={s.btn} onPress={x}/>`).length === 1,
    'touch-target: named StyleSheet ref resolved to a sub-44 size fires');
  assert(detectSmallTouchTargets(`<View style={{ height: 20 }}/>`).length === 0,
    'touch-target: a non-pressable View is not measured');
  assert(detectSmallTouchTargets(`const s = StyleSheet.create({ fab: { width: 56, height: 56, shadowOffset: { width: 0, height: 4 } } });\n<Pressable style={s.fab} onPress={x}/>`).length === 0,
    'touch-target: a shadowOffset { width: 0 } on a 56dp FAB is NOT a 0dp target');

  // ux/empty-state-present
  assert(detectMissingEmptyState(`<FlatList data={x} renderItem={r}/>`) === true,
    'empty-state: a bare FlatList with no empty surface fires');
  assert(detectMissingEmptyState(`<FlatList data={x} ListEmptyComponent={<EmptyState/>} renderItem={r}/>`) === false,
    'empty-state: ListEmptyComponent passes');
  assert(detectMissingEmptyState(`return items.length === 0 ? <EmptyState/> : <FlatList data={items}/>`) === false,
    'empty-state: a zero-length branch passes');
  assert(detectMissingEmptyState(`<Text>no lists here</Text>`) === null,
    'empty-state: a file with no list is not applicable');

  // ux/destructive-confirm
  assert(Array.isArray(detectUnconfirmedDeletes(`function onTap(){ store.deleteTrip(id); }`)),
    'destructive-confirm: an unguarded store delete fires');
  assert(detectUnconfirmedDeletes(`function onTap(){ Alert.alert('Delete?','',[{text:'Delete',onPress:()=>store.deleteTrip(id)}]); }`) === false,
    'destructive-confirm: a delete inside an Alert.alert passes');
  assert(detectUnconfirmedDeletes(`function onTap(){ removeTrip(id); showUndoToast(); }`) === false,
    'destructive-confirm: a delete with an undo affordance passes');
  assert(detectUnconfirmedDeletes(`useEffect(()=>{ const sub = nav.addListener('x'); return ()=>sub.removeListener(); },[])`) === null,
    'destructive-confirm: removeListener is denylisted (no fire)');
  assert(detectUnconfirmedDeletes(`useEffect(()=>{ const sub = AppState.addEventListener('change', h); return ()=>sub.remove(); },[])`) === null,
    'destructive-confirm: a bare subscription .remove() is NOT a data delete (no fire)');
  assert(detectUnconfirmedDeletes(`<Text>just copy</Text>`) === null,
    'destructive-confirm: no destructive call is not applicable');
  assert(detectUnconfirmedDeletes(`function toggle(){ if(on) removeStaple(name); else addStaple(name); }`) === null,
    'destructive-confirm: a remove with a same-file add counterpart is a reversible toggle (no fire)');
  assert(Array.isArray(detectUnconfirmedDeletes(`function onTap(){ removeStaple(name); }`)),
    'destructive-confirm: a remove with NO add counterpart still fires');
  assert(detectUnconfirmedDeletes(`import { useConfirm } from './Dialogs'; function S(){ const confirm = useConfirm(); return confirm.open({ onConfirm: () => deleteList(id) }); }`) === false,
    'destructive-confirm: a delete guarded by the useConfirm() primitive passes');

  // rn/keyboard-dismiss-escape (promoted to FAIL)
  assert(keyboardTrapped(`<TextInput blurOnSubmit={false} onSubmitEditing={s}/>`) === true,
    'keyboard-trap: persistent keyboard with no escape fires');
  assert(keyboardTrapped(`<TextInput blurOnSubmit={false} onSubmitEditing={()=>{ if(!v){Keyboard.dismiss();return;} add(v); }}/>`) === false,
    'keyboard-trap: a Keyboard.dismiss() escape passes');

  // review-prompt/wired
  assert(completionReferenced([`const x = 1;`, `import {recordSuccessfulCompletion} from '../storage/reviewPrompt';`]) === true,
    'review-prompt/wired: recordSuccessfulCompletion referenced → wired');
  assert(completionReferenced([`const x = 1;`, `<View/>`]) === false,
    'review-prompt/wired: no reference → dead');

  // funding/tip-jar-wired regexes (cross-file predicates)
  assert(/<\s*TipJarSheet\b/.test(`<TipJarSheet visible={open}/>`) === true,
    'tip-jar/wired: a render site is detected');
  assert(/onSupport\s*=\s*\{/.test(`<FundingFooter onSupport={openTipJar}/>`) === true,
    'tip-jar/wired: an onSupport handler pass is detected');

  console.log(failed ? `\nqa-canonical self-test FAILED (${failed})` : '\nqa-canonical self-test PASSED');
  process.exit(failed ? 1 : 0);
}

(async () => {
  if (flags.has('--self-test')) { runSelfTest(); return; }
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
