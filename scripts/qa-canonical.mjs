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

// Walk <app>/src for source files. Plain fs walk (not git) so it works on a
// fresh checkout / pre-commit; src/ is always tracked in our apps anyway.
const srcSourceFiles = () => {
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
  return out;
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
// is always an explicit escape on the empty/idle submit (Keyboard.dismiss() or
// .blur()), so we flag any file that persists the keyboard without one. Fires
// on both platforms equally — this is a UX dead-end, not an iOS quirk.
const KB_PERSIST_RE = /blurOnSubmit\s*=\s*\{\s*false\s*\}|submitBehavior\s*=\s*\{?\s*['"]submit['"]/;
const KB_ESCAPE_RE = /Keyboard\s*\.\s*dismiss\s*\(|\.\s*blur\s*\(/;

const ruleKeyboardDismissEscape = () => {
  if (surface !== 'rn') return skip('rn/keyboard-dismiss-escape', 'Not an RN app');
  const files = srcSourceFiles();
  if (!files.length) return skip('rn/keyboard-dismiss-escape', 'No src/ source files');
  const hits = [];
  for (const f of files) {
    const raw = readText(f);
    if (!raw) continue;
    const code = stripComments(raw);
    if (KB_PERSIST_RE.test(code) && !KB_ESCAPE_RE.test(code)) {
      hits.push(`${relative(appDir, f)}: persists the keyboard on submit (blurOnSubmit={false} / submitBehavior="submit") but never calls Keyboard.dismiss() / .blur()`);
    }
  }
  if (hits.length) {
    return warn('rn/keyboard-dismiss-escape',
      'Keyboard can get stuck: a persistent-keyboard TextInput has no empty/idle dismiss escape — submitting an empty field must call Keyboard.dismiss() so the user is never trapped with the keyboard open', hits);
  }
  return pass('rn/keyboard-dismiss-escape', 'No persistent-keyboard inputs without a dismiss escape');
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
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[jt]sx?$)|(?:[\\/]__tests__[\\/])/;
const ruleTrustCoreCovered = () => {
  const root = join(appDir, 'src');
  if (!exists(root)) return skip('test/trust-core-covered', 'No src/ directory');
  const files = srcSourceFiles().filter((f) => TEST_FILE_RE.test(f));
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
    const text = stripComments(raw);
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
  ruleNoIosOnlyImports,
  ruleNoAlertPrompt,
  ruleNoPlatformEarlyReturn,
  ruleEasJsonShape,
  ruleAppearanceToggle,
  ruleContrastPairing,
  ruleLanguageControl,
  ruleAppNameSpotlightSafe,
  ruleKeyboardDismissEscape,
  ruleManifestMv3,
  ruleManifestPermissionsTight,
  ruleTestScriptPresent,
  ruleTrustCoreCovered,
  ruleFlowHasAssertions,
  ruleFlowDrift,
  ruleNoHardcodedStrings,
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
