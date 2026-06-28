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
 *   6. heal    — on failure, if --heal: dump the live hierarchy, auto-repair
 *                confident anchors (heal.mjs --apply), recompile, retry once.
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
 *   --heal                   auto-repair confident anchor drift and retry once
 *   --contact-sheet          also emit the downscaled montage
 *   --dry-run                print every command without executing
 *
 * Heavy, environment-coupled steps (eas build, simctl, adb, maestro) are kept in
 * small labelled helpers running the SAME commands the CI template proves, so
 * this stays auditable. See runbooks/qa-capture.md for the full picture.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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

function sourceHash() {
  const h = crypto.createHash('sha256');
  const inputs = ['app.json', 'package.json', 'package-lock.json', 'qa/journey.json', 'qa/selectors.json'];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else { try { h.update(e.name); h.update(fs.readFileSync(full)); } catch {} }
    }
  };
  walk(path.join(appDir, 'src'));
  for (const f of inputs) {
    const p = path.join(appDir, f);
    if (fs.existsSync(p)) { h.update(f); h.update(fs.readFileSync(p)); }
  }
  return h.digest('hex');
}

function buildArtifact() {
  const ext = platform === 'ios' ? 'tar.gz' : 'apk';
  const outPath = path.join(appDir, 'qa', 'captures', `.build-${platform}.${ext}`);
  const hashPath = path.join(appDir, 'qa', 'captures', `.build-${platform}.hash`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const hash = dry ? 'DRYRUN' : sourceHash();
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
  run(`build — eas build --local (${platform}, QA_MODE)`, 'eas', [
    'build', '--platform', platform, '--profile', 'preview', '--local',
    '--non-interactive', '--output', outPath,
  ], { env: {
    EXPO_PUBLIC_QA_MODE: '1',
    EAS_LOCAL_BUILD_WORKINGDIR: workingdir,
    GRADLE_OPTS: '-Xmx4g -XX:MaxMetaspaceSize=1g',
  } });
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
  run('device — boot simulator (isolated)', 'bash', ['-lc',
    `UDID=$(xcrun simctl list devices | grep -m1 ${JSON.stringify(device)} | grep -oE '[0-9A-F-]{36}' | head -1); ` +
    `[ -z "$UDID" ] && UDID=$(xcrun simctl create qa-${storeKey} ${JSON.stringify(device)}); ` +
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
  const r = run('traverse — maestro test', 'maestro', [
    ...deviceArg(), 'test', path.join('qa', 'flows', 'mobile.yaml'),
    `--env=STORE=${captureKey}`, '--debug-output', debugDir,
  ], { allowFail: true });
  return r.status === 0;
}

function healAndRetry() {
  if (!flags.has('--heal')) return false;
  console.log('\n› heal — traverse failed; reading live screen and repairing confident anchors');
  run('heal — repair from device', 'node', [
    path.join('scripts', 'qa', 'heal.mjs'), '--from-device', ...deviceArg(), '--apply',
  ], { allowFail: true });
  compileFlow();
  return traverse();
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

if (!fs.existsSync(path.join(appDir, 'qa', 'journey.json'))) {
  console.error(`No qa/journey.json in ${appDir}. This app hasn't adopted the journey pipeline yet.`);
  process.exit(1);
}

const artifact = buildArtifact();
if (platform === 'ios') iosPrepare(artifact); else androidPrepare(artifact);
compileFlow();

let ok = traverse();
if (!ok) ok = healAndRetry();

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
