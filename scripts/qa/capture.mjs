#!/usr/bin/env node
/**
 * capture.mjs — the whole screenshot/traversal run as ONE Bash call, zero agent
 * tokens. This is the thing the high-priority TODO asked for: the agent kicks
 * off one script and (optionally) glances at one contact sheet; it is NEVER in
 * a per-tap loop driving the sim.
 *
 * Pipeline (per platform/store):
 *   1. build   — eas build --local with EXPO_PUBLIC_QA_MODE=1, hash-cached so an
 *                unchanged app skips the (slow) rebuild.
 *   2. device  — boot the right sim/emulator; normalize the status bar; for an
 *                Android tablet force portrait (it boots landscape and letter-
 *                boxes the app so taps miss).
 *   3. install — install the built artifact.
 *   4. compile — journey.json + selectors.json → qa/flows/mobile.yaml.
 *   5. traverse— maestro test, writing qa/captures/<store>/*.png at waypoints.
 *   6. heal    — on failure, if --heal: read Maestro's command log to name the
 *                anchor that actually failed, dump the live hierarchy, repair
 *                THAT anchor (heal.mjs --anchor … --apply), recompile, retry
 *                once. When the failing anchor can't be named, heal runs
 *                propose-only — never an untargeted --apply.
 *   7. frame   — render-screenshots.mjs --store <store> → store-assets/.
 *   8. sheet   — optional --contact-sheet montage for a one-glance check.
 *   9. learn   — on green, record the resolved hierarchy as the healer baseline.
 *
 * Usage:
 *   node scripts/qa/capture.mjs <app-dir> --platform ios --store ios [--heal] [--contact-sheet]
 *   node scripts/qa/capture.mjs <app-dir> --platform android --store androidTablet --device <avd> --heal
 *   node scripts/qa/capture.mjs <app-dir> --store ios --dry-run      # print the plan, run nothing
 *
 * Flags:
 *   --platform ios|android   (inferred from --store when omitted)
 *   --store ios|ipad|android|androidTablet
 *   --device <udid|name>     target a specific sim/emulator (else first booted)
 *   --no-build               reuse the cached artifact even if source changed
 *   --rebuild                force a build even on a cache hit
 *   --build-only             build (or reuse) the artifact and stop — no device,
 *                            no traverse. Used by drop-released.mjs to refresh a
 *                            stale QA build cache at ship time.
 *   --heal                   auto-repair confident anchor drift and retry once
 *   --contact-sheet          also emit the downscaled montage
 *   --dry-run                print every command without executing
 *   --self-test              check the pure failure→anchor mapping; no device
 *
 * Heavy, environment-coupled steps (eas build, simctl, adb, maestro) are kept in
 * small labelled helpers running the SAME commands the CI template proves, so
 * this stays auditable. See runbooks/qa-capture.md for the full picture.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withHeavyLock, concurrency } from '../lib/heavy.mjs';
// The build cache key lives in one place so anything else that asks "is this
// cached build current?" (the ship path's upgrade-harness slot drop) agrees
// with us instead of guessing — scripts/qa/source-hash.mjs.
import { sourceHash } from './source-hash.mjs';

// store → how to build, what device, how to normalize.
// NOTE: iOS device names are Xcode-version-specific — the boot step greps
// `simctl list devices` for an exact match (and creates one if absent, which
// needs a valid devicetype). Keep these to the current Xcode's 6.9" phone +
// 13" iPad; pass `--device "<name>"` to override on a machine with different
// sims installed. Updated 2026-06-11 (Xcode 26.5 ships iPhone 17 / iPad M5;
// the old "iPhone 16 Pro Max" / "iPad Pro 13-inch (M4)" no longer exist).
const STORES = {
  ios:           { platform: 'ios',     device: 'iPhone 17 Pro Max', kind: 'phone'  },
  ipad:          { platform: 'ios',     device: 'iPad Pro 13-inch (M5)', kind: 'tablet' },
  android:       { platform: 'android', device: null, kind: 'phone'  },
  androidTablet: { platform: 'android', device: null, kind: 'tablet' },
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const VALUE_FLAGS = new Set(['--platform', '--store', '--device', '--appearance', '--font-scale', '--orientation', '--cell']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
const appDir = path.resolve(positional[0] || process.cwd());

// --self-test covers the pure failure→anchor mapping (no device, no build, no
// store). It runs BEFORE the --store check so it needs no arguments at all.
if (flags.has('--self-test')) process.exit(selfTest() ? 0 : 1);

const storeKey = valueOf('--store');
if (!storeKey || !STORES[storeKey]) {
  console.error(`--store is required, one of: ${Object.keys(STORES).join(', ')}`);
  process.exit(1);
}
const store = STORES[storeKey];
const platform = valueOf('--platform') || store.platform;
const device = valueOf('--device') || store.device;
const dry = flags.has('--dry-run');

// Device-matrix axes (P10): set the device's appearance + font scale before the
// traverse; orientation is injected into the generated flow (compile-flow handles
// it deterministically on both platforms). `--cell <label>` namespaces captures
// to qa/captures/matrix/<label>/ (for visual-reg) and skips store framing/learn.
const appearance = valueOf('--appearance') || null;     // light | dark
const fontScale = valueOf('--font-scale') || null;       // e.g. 1.0 | 1.3
const orientation = valueOf('--orientation') || 'portrait';
const cell = valueOf('--cell') || null;
const captureKey = cell ? `matrix/${cell}` : storeKey;   // STORE env + captures subdir
const tag = cell || storeKey;                            // debug-output namespacing

// ---------- shell helper ----------

function run(label, cmd, argv, opts = {}) {
  const pretty = `${cmd} ${argv.join(' ')}`;
  console.log(`\n› ${label}\n  $ ${pretty}`);
  if (dry) return { status: 0, stdout: '', stderr: '', dryRun: true };
  const r = spawnSync(cmd, argv, { cwd: appDir, encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit', env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`  ✗ ${label} failed (exit ${r.status}).`);
    if (opts.capture && r.stderr) console.error(r.stderr.split('\n').slice(0, 12).join('\n'));
    process.exit(r.status || 1);
  }
  return r;
}

// ---------- 1. build (hash-cached) ----------

async function buildArtifact() {
  const ext = platform === 'ios' ? 'tar.gz' : 'apk';
  const outPath = path.join(appDir, 'qa', 'captures', `.build-${platform}.${ext}`);
  const hashPath = path.join(appDir, 'qa', 'captures', `.build-${platform}.hash`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const hash = dry ? 'DRYRUN' : sourceHash(appDir);
  const cachedHash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, 'utf8').trim() : null;
  const hit = fs.existsSync(outPath) && cachedHash === hash;

  if (flags.has('--no-build') || (hit && !flags.has('--rebuild'))) {
    console.log(`\n› build — cache ${hit ? 'HIT' : '(forced reuse)'} (${path.relative(appDir, outPath)}); skipping eas build.`);
    return outPath;
  }

  // EAS_LOCAL_BUILD_WORKINGDIR avoids the /tmp symlink Metro-entry bug (factory
  // stack/eas-build.md § Gotchas). QA_MODE bakes deterministic fixtures in.
  // Clear the workingdir first: eas-build-local-plugin aborts with "Workingdir
  // is not empty" if a prior interrupted build left scratch behind (hard-won —
  // it silently kills a capture run). Done in-process (not a shell `rm`) so it
  // can't be gated and is always cleaned.
  const workingdir = path.join(os.homedir(), '.eas-build', path.basename(appDir));
  if (!dry) { try { fs.rmSync(workingdir, { recursive: true, force: true }); } catch {} }
  // Load governor (Uplevel 3 / T5): the local EAS build is the heavy step. On the
  // 8 GB mini it must run one-at-a-time, so it holds the machine-wide heavy lock
  // (a no-op on a full-size machine; re-entrant, so matrix.mjs → capture doesn't
  // double-lock). The Gradle heap is profile-driven — 2048m on the low-RAM mini,
  // 4096m (the old hardcoded -Xmx4g) on a full machine.
  await withHeavyLock(`capture:${path.basename(appDir)}:${platform}`, () => {
    run(`build — eas build --local (${platform}, QA_MODE)`, 'eas', [
      'build', '--platform', platform, '--profile', 'preview', '--local',
      '--non-interactive', '--output', outPath,
    ], { env: {
      EXPO_PUBLIC_QA_MODE: '1',
      EAS_LOCAL_BUILD_WORKINGDIR: workingdir,
      GRADLE_OPTS: `-Xmx${concurrency().gradleJvmMaxMB}m -XX:MaxMetaspaceSize=1g`,
    } });
  });
  if (!dry) fs.writeFileSync(hashPath, hash + '\n');
  return outPath;
}

// ---------- 2/3. device boot + normalize + install ----------

function iosPrepare(artifact) {
  // Extract the .app from the simulator tarball.
  const extractDir = path.join(appDir, 'qa', 'captures', `.app-${storeKey}`);
  run('device — extract simulator .app', 'bash', ['-lc',
    `rm -rf ${JSON.stringify(extractDir)} && mkdir -p ${JSON.stringify(extractDir)} && tar -xzf ${JSON.stringify(artifact)} -C ${JSON.stringify(extractDir)}`]);
  const findApp = run('device — locate .app', 'bash', ['-lc',
    `find ${JSON.stringify(extractDir)} -maxdepth 3 -name '*.app' -type d -print -quit`], { capture: true });
  const appPath = dry ? '<app>' : (findApp.stdout || '').trim();

  // Boot a sim of the right device type (create if missing), normalize status bar.
  // ISOLATE to a single sim first: Maestro's iOS (XCTest) driver flakes badly
  // when several sims are booted — launchApp lands on the wrong one and every
  // screenshot is the springboard. So we shut down all OTHER booted sims before
  // the run (hard-won; this exact failure ate a capture on 2026-06-08).
  // One reusable sim PER DEVICE TYPE (see the note below) — e.g. qa-ios-iphone-17-pro-max.
  const simName = `qa-${storeKey}-${String(device).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  run('device — boot simulator (isolated)', 'bash', ['-lc',
    // Reuse a PREVIOUSLY-CREATED reusable device first (the exact name
    // `simctl create` gives it below). Searching only for the device-type string
    // (e.g. "iPhone 17 Pro Max") never matches it back — simctl lists devices by
    // their given NAME, not their type — so every run minted a fresh qa sim
    // instead of reusing the last one (ticket qa-ios-sim-leak). Fall back to a
    // stock same-named simulator, then create only as a last resort.
    //
    // The reusable name is keyed on the DEVICE, not just the store: keying it on
    // the store alone made every iOS phone cell reuse one "qa-ios" sim, so the
    // iPhone 6.9" cell silently ran on whatever model that sim happened to be
    // (an SE) and its screenshots were another device's. L23.
    `UDID=$(xcrun simctl list devices | grep -m1 "^ *${simName} (" | grep -oE '[0-9A-F-]{36}' | head -1); ` +
    `[ -z "$UDID" ] && UDID=$(xcrun simctl list devices | grep -m1 ${JSON.stringify(device)} | grep -oE '[0-9A-F-]{36}' | head -1); ` +
    `[ -z "$UDID" ] && UDID=$(xcrun simctl create ${simName} ${JSON.stringify(device)}); ` +
    `for u in $(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}'); do [ "$u" != "$UDID" ] && xcrun simctl shutdown "$u" 2>/dev/null; done; ` +
    `xcrun simctl boot "$UDID" 2>/dev/null; xcrun simctl bootstatus "$UDID" -b; ` +
    `xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3; ` +
    `echo "$UDID" > ${JSON.stringify(path.join(appDir, 'qa', 'captures', `.udid-${storeKey}`))}`]);
  run('install — app on simulator', 'bash', ['-lc',
    `UDID=$(cat ${JSON.stringify(path.join(appDir, 'qa', 'captures', `.udid-${storeKey}`))}); ` +
    `xcrun simctl install "$UDID" ${JSON.stringify(appPath)}`]);
  applyIosAxes();
}

// Apply the appearance + font-scale axes to a booted iOS sim (best-effort —
// some sims/runtimes don't honour content_size; never fail the capture on it).
function applyIosAxes() {
  if (!appearance && !fontScale) return;
  const udidFile = path.join(appDir, 'qa', 'captures', `.udid-${storeKey}`);
  const cmds = [`UDID=$(cat ${JSON.stringify(udidFile)})`];
  if (appearance) cmds.push(`xcrun simctl ui "$UDID" appearance ${appearance === 'dark' ? 'dark' : 'light'}`);
  if (fontScale) {
    // iOS Dynamic Type is categorical, not a multiplier; map our scale onto the
    // nearest simctl content_size (1.0 -> default L, 1.3 -> a large step). NB the
    // subcommand is `content_size` (underscore); `content-size` is silently
    // rejected with a usage dump, making the axis a no-op.
    const size = Number(fontScale) >= 1.3 ? 'extra-extra-extra-large' : 'large';
    cmds.push(`xcrun simctl ui "$UDID" content_size ${size}`);
  }
  run(`device — apply axes (appearance=${appearance || '-'} font=${fontScale || '-'})`, 'bash', ['-lc', cmds.join('; ')], { allowFail: true });
}

// Apply the appearance + font-scale axes to a booted Android device/emulator.
function applyAndroidAxes(adb) {
  if (!appearance && !fontScale) return;
  const cmds = [];
  if (appearance) cmds.push(`adb ${adb} shell "cmd uimode night ${appearance === 'dark' ? 'yes' : 'no'}"`);
  if (fontScale) cmds.push(`adb ${adb} shell settings put system font_scale ${Number(fontScale).toFixed(2)}`);
  run(`device — apply axes (appearance=${appearance || '-'} font=${fontScale || '-'})`, 'bash', ['-lc', cmds.join('; ')], { allowFail: true });
}

// eas `build --output X.apk` for an Android build that emits MULTIPLE apks
// (release + debug) actually writes a GZIPPED TAR (release/app-release.apk,
// debug/app-debug.apk) at that path — not a raw apk. Installing it directly fails
// with INSTALL_PARSE_FAILED_NOT_APK. Detect the gzip magic and extract the release
// apk; a real apk (PK-zip magic) is returned untouched. (iOS already extracts its
// tar.gz; this is the Android analogue.)
function resolveAndroidApk(artifact) {
  if (dry) return artifact;
  let magic;
  try {
    const fd = fs.openSync(artifact, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    magic = b;
  } catch { return artifact; }
  if (!(magic[0] === 0x1f && magic[1] === 0x8b)) return artifact; // not gzip -> real apk
  const outDir = path.join(appDir, 'qa', 'captures', `.apk-${storeKey}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  run('device — extract apk from build archive', 'bash', ['-lc',
    `tar -xzf ${JSON.stringify(artifact)} -C ${JSON.stringify(outDir)}`]);
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.apk$/i.test(e.name)) found.push(p);
    }
  };
  walk(outDir);
  const apk = found.find((f) => /release/i.test(f) && !/debug/i.test(f)) || found[0];
  if (!apk) throw new Error('no .apk found inside the gzipped Android build archive');
  return apk;
}

function androidPrepare(artifact) {
  const dev = device ? ['-s', device] : [];
  const adb = (sub) => ['bash', ['-lc', `adb ${dev.join(' ')} ${sub}`]];
  // Uninstall any prior build first. `install -r` fails with
  // INSTALL_FAILED_UPDATE_INCOMPATIBLE when a previously-installed build (a prior
  // capture, or a debug vs release apk) was signed with a different key. The QA
  // boot re-seeds deterministic fixtures on launch, so wiping app data is correct.
  // Best-effort: a clean device (nothing installed) just no-ops.
  if (!dry) {
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'))?.expo?.android?.package; } catch {}
    if (pkg) run('device — uninstall prior build', ...adb(`uninstall ${pkg}`), { allowFail: true });
  }
  run('install — apk on emulator', ...adb(`install -r ${JSON.stringify(resolveAndroidApk(artifact))}`));
  if (store.kind === 'tablet') {
    // The Pixel-tablet AVD boots LANDSCAPE; the app then renders a letterboxed
    // portrait column and Maestro taps miss. Force portrait first.
    run('device — force portrait (tablet)', ...adb(
      `shell settings put system accelerometer_rotation 0 && adb ${dev.join(' ')} shell settings put system user_rotation 1`));
  }
  // Suppress system dialogs + collapse any open system panel before traversal.
  // A system window drawn OVER the app defeats Maestro completely: the hierarchy
  // query returns the system UI, so every anchor misses against a screen that is
  // in fact fine. CI has carried `hide_error_dialogs` since the 2026-06-10
  // Pixel-Launcher-ANR diagnosis (templates/qa/qa-e2e.yml.template), but the
  // LOCAL capture path never got it — and the 2026-07-29 nightly proved the same
  // class bites here too: packing-list and tend both failed every Android cell
  // with healer candidates that were all `com.android.systemui:*` (the
  // airplane-mode/internet panel was open on the emulator). Best-effort; a
  // device that refuses either call just no-ops.
  run('device — suppress system dialogs + collapse panels', 'bash', ['-lc',
    `adb ${dev.join(' ')} shell settings put global hide_error_dialogs 1; ` +
    `adb ${dev.join(' ')} shell cmd statusbar collapse; ` +
    `adb ${dev.join(' ')} shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS`],
    { allowFail: true });
  // Demo-mode status bar (clean 9:41-style bar). Best-effort; ignore failures.
  run('device — status bar demo mode', 'bash', ['-lc',
    `adb ${dev.join(' ')} shell settings put global sysui_demo_allowed 1; ` +
    `adb ${dev.join(' ')} shell am broadcast -a com.android.systemui.demo -e command enter; ` +
    `adb ${dev.join(' ')} shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941; ` +
    `adb ${dev.join(' ')} shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false`],
    { allowFail: true });
  applyAndroidAxes(dev.join(' '));
  // NOTE: the Pixel-tablet system taskbar can't be hidden via adb and overlaps a
  // corner FAB. capture.mjs runs the recomposite (scripts/qa/recomposite-tablet.mjs)
  // after framing for tablet stores — see runbooks/device-quality-net.md § Tablet dock.
}

// ---------- 5. traverse (+ optional heal/retry) ----------

function compileFlow() {
  const argv = [path.join('scripts', 'qa', 'compile-flow.mjs')];
  // Cell-level orientation is injected into the generated flow (Maestro
  // setOrientation), so landscape cells rotate deterministically on both
  // platforms. Portrait => no flag => identical to the canonical artifact.
  if (orientation && String(orientation).toLowerCase() !== 'portrait') argv.push('--orientation', orientation);
  run('compile — journey → mobile.yaml', 'node', argv);
}

function deviceArg() {
  if (platform === 'ios') {
    const f = path.join(appDir, 'qa', 'captures', `.udid-${storeKey}`);
    if (!dry && fs.existsSync(f)) return ['--device', fs.readFileSync(f, 'utf8').trim()];
    return [];
  }
  return device ? ['--device', device] : [];
}

function traverse() {
  // captureKey routes screenshots: store dir for a normal run, matrix/<cell> for
  // a matrix cell (the flow writes to qa/captures/${STORE}/<id>).
  const capturesDir = path.join(appDir, 'qa', 'captures', ...captureKey.split('/'));
  if (!dry) fs.mkdirSync(capturesDir, { recursive: true });
  const debugDir = path.join('qa', 'maestro-debug', tag);
  // Remembered so the heal step only ever reads THIS run's command log — a log
  // left by a previous capture names an anchor that is not the one that broke.
  // The margin absorbs clock/mtime granularity, not another capture (a capture
  // is minutes of build + boot, never seconds apart).
  const startedAt = Date.now() - 5000;
  const r = run('traverse — maestro test', 'maestro', [
    ...deviceArg(), 'test', path.join('qa', 'flows', 'mobile.yaml'),
    `--env=STORE=${captureKey}`, '--debug-output', debugDir,
  ], { allowFail: true });
  return { ok: r.status === 0, startedAt };
}

// --- which anchor actually broke? -------------------------------------------
//
// heal was invoked with no --anchor, so it weighed EVERY anchor the journey
// references against the single screen the failed traverse left up. An anchor
// that belongs to a later screen is not broken, it is OFF-SCREEN — and heal
// cannot tell the difference, so it hunted the whole tree for a replacement and
// could auto-apply one. The 2026-08-13 workout-timer corruption came in through
// exactly this door.
//
// Maestro already knows which step failed, and writes it machine-readably to
// --debug-output: <debugDir>/.maestro/tests/<stamp>/commands-(<flow>.yaml).json,
// an array of { command, metadata: { status } }. Each command carries the
// RESOLVED selector (textRegex / idRegex) — which is what compile-flow wrote
// from an anchor — so a reverse lookup over qa/selectors.json names the anchor
// that broke. When it can't be named, heal runs PROPOSE-ONLY: an unattended
// capture must never write a selectors.json change nobody asked for.

/** Every {textRegex|idRegex} selector inside the commands Maestro marked FAILED. */
export function failedSelectors(commands) {
  const out = [];
  const collect = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (typeof v.textRegex === 'string' || typeof v.idRegex === 'string') {
      out.push({ textRegex: v.textRegex ?? null, idRegex: v.idRegex ?? null });
    }
    Object.values(v).forEach(collect);
  };
  for (const entry of Array.isArray(commands) ? commands : []) {
    if (String(entry?.metadata?.status).toUpperCase() !== 'FAILED') continue;
    collect(entry.command);
  }
  return out;
}

/** Anchor keys whose resolved selector is one of these — compile-flow's inverse. */
export function anchorsForSelectors(anchors, selectors) {
  const keys = [];
  for (const sel of selectors || []) {
    for (const [key, a] of Object.entries(anchors || {})) {
      if (!a) continue;
      const hit = (sel.idRegex && a.testID === sel.idRegex) || (sel.textRegex && a.text === sel.textRegex);
      if (hit && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** Newest commands-*.json under a Maestro --debug-output dir, ignoring old runs. */
export function newestCommandsLog(debugDirAbs, notBefore = 0, io = fs) {
  const testsDir = path.join(debugDirAbs, '.maestro', 'tests');
  let best = null;
  let stamps = [];
  try { stamps = io.readdirSync(testsDir); } catch { return null; }
  for (const stamp of stamps) {
    let files = [];
    try { files = io.readdirSync(path.join(testsDir, stamp)); } catch { continue; }
    for (const f of files) {
      if (!/^commands-.*\.json$/.test(f)) continue;
      const p = path.join(testsDir, stamp, f);
      let mtime = 0;
      try { mtime = io.statSync(p).mtimeMs; } catch { continue; }
      // A stale log from a previous capture would name the WRONG anchor, which
      // is worse than naming none — so anything older than this run is ignored.
      if (mtime < notBefore) continue;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    }
  }
  return best ? best.path : null;
}

/** The anchor keys this run's traverse actually failed on ([] = could not tell). */
function failedAnchors(notBefore) {
  if (dry) return [];
  const log = newestCommandsLog(path.join(appDir, 'qa', 'maestro-debug', tag), notBefore);
  if (!log) return [];
  let commands, selectors;
  try { commands = JSON.parse(fs.readFileSync(log, 'utf8')); } catch { return []; }
  try { selectors = JSON.parse(fs.readFileSync(path.join(appDir, 'qa', 'selectors.json'), 'utf8')); } catch { return []; }
  return anchorsForSelectors(selectors.anchors || {}, failedSelectors(commands));
}

function selfTest() {
  let pass = 0;
  const fails = [];
  const check = (name, cond) => { if (cond) pass++; else fails.push(name); };

  // The real shape of a Maestro command log: one FAILED command among greens.
  const commands = [
    { command: { launchAppCommand: { appId: 'com.x' } }, metadata: { status: 'COMPLETED' } },
    { command: { tapOnElement: { selector: { textRegex: 'Weekly shop.*' } } }, metadata: { status: 'COMPLETED' } },
    { command: { assertConditionCommand: { condition: { visible: { textRegex: 'Send feedback' } } } }, metadata: { status: 'FAILED' } },
    { command: { tapOnElement: { selector: { idRegex: 'addSheetDone' } } }, metadata: { status: 'PENDING' } },
  ];
  const anchors = {
    'weekly-list': { text: 'Weekly shop.*' },
    'feedback-row': { text: 'Send feedback' },
    'add-done': { testID: 'addSheetDone' },
  };

  let sels = failedSelectors(commands);
  check('only the FAILED command yields a selector', sels.length === 1);
  check('the failed selector is read out of a nested condition', sels[0].textRegex === 'Send feedback');
  check('a COMPLETED command contributes nothing', !sels.some((s) => s.textRegex === 'Weekly shop.*'));
  check('a PENDING command contributes nothing', !sels.some((s) => s.idRegex === 'addSheetDone'));

  let keys = anchorsForSelectors(anchors, sels);
  check('the failed selector maps back to exactly its anchor', keys.length === 1 && keys[0] === 'feedback-row');
  // The whole point: a targeted heal must NOT carry the anchors that merely
  // belong to other screens (that is what made an off-screen anchor "broken").
  check('anchors that did not fail are not targeted', !keys.includes('weekly-list'));

  check('an id selector maps through testID',
    anchorsForSelectors(anchors, [{ idRegex: 'addSheetDone', textRegex: null }])[0] === 'add-done');
  check('an unknown selector names no anchor — the propose-only fallback',
    anchorsForSelectors(anchors, [{ textRegex: 'Nothing here', idRegex: null }]).length === 0);
  check('no FAILED command means no target', failedSelectors(
    [{ command: { tapOnElement: { selector: { textRegex: 'a' } } }, metadata: { status: 'COMPLETED' } }]).length === 0);
  check('a malformed log is survivable', failedSelectors(null).length === 0 && failedSelectors([{}]).length === 0);
  check('two failed commands both map', anchorsForSelectors(anchors, failedSelectors([
    { command: { tapOnElement: { selector: { textRegex: 'Weekly shop.*' } } }, metadata: { status: 'FAILED' } },
    { command: { tapOnElement: { selector: { idRegex: 'addSheetDone' } } }, metadata: { status: 'FAILED' } },
  ])).sort().join(',') === 'add-done,weekly-list');

  // A stale log from a PREVIOUS capture must never be read — it would name the
  // wrong anchor, which is worse than naming none.
  const io = {
    readdirSync: (p) => (p.endsWith(path.join('.maestro', 'tests')) ? ['2026-01-01_000000', '2026-02-02_000000'] : ['commands-(mobile.yaml).json']),
    statSync: (p) => ({ mtimeMs: p.includes('2026-02-02_000000') ? 2000 : 1000 }),
  };
  check('the newest command log wins',
    (newestCommandsLog('/d', 0, io) || '').includes('2026-02-02_000000'));
  check('a log older than this run is ignored', newestCommandsLog('/d', 1500, io).includes('2026-02-02_000000'));
  check('every log older than this run means no target', newestCommandsLog('/d', 5000, io) === null);
  check('a missing debug dir means no target',
    newestCommandsLog('/d', 0, { readdirSync: () => { throw new Error('ENOENT'); }, statSync: () => ({ mtimeMs: 0 }) }) === null);

  console.log(fails.length
    ? `capture --self-test: ${pass} passed, ${fails.length} FAILED\n` + fails.map((f) => `  ✗ ${f}`).join('\n')
    : `capture --self-test: ${pass} checks passed`);
  return fails.length === 0;
}

function healAndRetry(traverseStartedAt) {
  if (!flags.has('--heal')) return false;
  const targeted = failedAnchors(traverseStartedAt);
  const argv = [path.join('scripts', 'qa', 'heal.mjs'), '--from-device', ...deviceArg()];

  if (targeted.length) {
    console.log(`\n› heal — traverse failed at @${targeted.join(', @')}; reading live screen and repairing that anchor`);
    argv.push('--anchor', targeted.join(','), '--apply');
    run('heal — repair the anchor that broke', 'node', argv, { allowFail: true });
    compileFlow();
    return traverse().ok;
  }

  // No nameable failing anchor: propose, never write. Retrying would re-run the
  // identical flow against an identical app, so it is skipped on purpose.
  console.log('\n› heal — traverse failed, but Maestro\'s command log did not name a known anchor. ' +
    'Running PROPOSE-ONLY (no --apply): an untargeted sweep can rewrite an anchor that is merely off-screen.');
  run('heal — propose only (untargeted)', 'node', argv, { allowFail: true });
  console.log('  Review qa/heal-report.json, then re-run heal with --anchor <key> --apply if a proposal is right.');
  return false;
}

// ---------- 7/8/9. frame, sheet, learn ----------

function frame() {
  run('frame — render store assets', 'node', [path.join('scripts', 'render-screenshots.mjs'), '--store', storeKey]);
  if (flags.has('--contact-sheet')) {
    run('sheet — contact-sheet montage', 'node', [path.join('scripts', 'render-screenshots.mjs'), '--contact-sheet', '--store', storeKey]);
  }
}

function learn() {
  run('learn — record green hierarchy as healer baseline', 'node', [
    path.join('scripts', 'qa', 'heal.mjs'), '--from-device', ...deviceArg(), '--record',
  ], { allowFail: true });
}

// ---------- orchestrate ----------

console.log(`capture: app=${path.basename(appDir)} platform=${platform} store=${storeKey} device=${device || '(first booted)'}${dry ? '  [DRY RUN]' : ''}`);

// --build-only never traverses, so it doesn't need a journey — it exists so the
// ship path can refresh the QA build cache (and with it the upgrade harness's
// released slot) on an app whose journey may not even be current.
if (!flags.has('--build-only') && !fs.existsSync(path.join(appDir, 'qa', 'journey.json'))) {
  console.error(`No qa/journey.json in ${appDir}. This app hasn't adopted the journey pipeline yet.`);
  process.exit(1);
}

const artifact = await buildArtifact();

if (flags.has('--build-only')) {
  console.log(`\n✓ capture: build-only — artifact at ${path.relative(appDir, artifact)}. No device, no traverse.`);
  process.exit(0);
}

if (platform === 'ios') iosPrepare(artifact); else androidPrepare(artifact);
compileFlow();

const first = traverse();
let ok = first.ok;
if (!ok) ok = healAndRetry(first.startedAt);

if (!ok) {
  console.error(`\n✗ capture: traverse failed${flags.has('--heal') ? ' even after heal' : ''}. ` +
    `See qa/maestro-debug/${storeKey}/ and qa/heal-report.json. ` +
    (flags.has('--heal') ? '' : 'Re-run with --heal to auto-repair confident anchor drift.'));
  process.exit(1);
}

if (cell) {
  // A matrix cell: captures feed visual-reg, NOT the store listing. Skip framing
  // store assets + recording the healer baseline (the canonical store-key run
  // owns those, so a 1.3-font dark-mode cell can't poison them).
  learn();
  console.log(`\n✓ capture: cell ${cell} done → qa/captures/${captureKey}/. (visual-reg consumes these)`);
} else {
  frame();
  learn();
  console.log(`\n✓ capture: ${storeKey} done. Framed assets in store-assets/screenshots/. ` +
    (flags.has('--contact-sheet') ? `Glance: store-assets/contact-sheet-*.png` : `Add --contact-sheet for a one-image check.`));
}
