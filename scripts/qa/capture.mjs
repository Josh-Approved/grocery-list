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
const STORES = {
  ios:           { platform: 'ios',     device: 'iPhone 16 Pro Max', kind: 'phone'  },
  ipad:          { platform: 'ios',     device: 'iPad Pro 13-inch (M4)', kind: 'tablet' },
  android:       { platform: 'android', device: null, kind: 'phone'  },
  androidTablet: { platform: 'android', device: null, kind: 'tablet' },
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const VALUE_FLAGS = new Set(['--platform', '--store', '--device']);
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
  run(`build — eas build --local (${platform}, QA_MODE)`, 'eas', [
    'build', '--platform', platform, '--profile', 'preview', '--local',
    '--non-interactive', '--output', outPath,
  ], { env: {
    EXPO_PUBLIC_QA_MODE: '1',
    EAS_LOCAL_BUILD_WORKINGDIR: path.join(os.homedir(), '.eas-build', path.basename(appDir)),
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
}

function androidPrepare(artifact) {
  const dev = device ? ['-s', device] : [];
  const adb = (sub) => ['bash', ['-lc', `adb ${dev.join(' ')} ${sub}`]];
  run('install — apk on emulator', ...adb(`install -r ${JSON.stringify(artifact)}`));
  if (store.kind === 'tablet') {
    // The Pixel-tablet AVD boots LANDSCAPE; the app then renders a letterboxed
    // portrait column and Maestro taps miss. Force portrait first.
    run('device — force portrait (tablet)', ...adb(
      'shell settings put system accelerometer_rotation 0 && adb shell settings put system user_rotation 1'));
  }
  // Demo-mode status bar (clean 9:41-style bar). Best-effort; ignore failures.
  run('device — status bar demo mode', 'bash', ['-lc',
    `adb ${dev.join(' ')} shell settings put global sysui_demo_allowed 1; ` +
    `adb ${dev.join(' ')} shell am broadcast -a com.android.systemui.demo -e command enter; ` +
    `adb ${dev.join(' ')} shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941; ` +
    `adb ${dev.join(' ')} shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false`],
    { allowFail: true });
  // NOTE (TODO §5): the Pixel-tablet system taskbar can't be hidden via adb and
  // overlaps a corner FAB. If a tablet capture shows the dock over the "+",
  // apply the paper-recomposite stopgap — see runbooks/qa-capture.md.
}

// ---------- 5. traverse (+ optional heal/retry) ----------

function compileFlow() {
  run('compile — journey → mobile.yaml', 'node', [path.join('scripts', 'qa', 'compile-flow.mjs')]);
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
  const capturesDir = path.join(appDir, 'qa', 'captures', storeKey);
  if (!dry) fs.mkdirSync(capturesDir, { recursive: true });
  const debugDir = `maestro-debug-${storeKey}`;
  const r = run('traverse — maestro test', 'maestro', [
    ...deviceArg(), 'test', path.join('qa', 'flows', 'mobile.yaml'),
    `--env=STORE=${storeKey}`, '--debug-output', debugDir,
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
    `See maestro-debug-${storeKey}/ and qa/heal-report.json. ` +
    (flags.has('--heal') ? '' : 'Re-run with --heal to auto-repair confident anchor drift.'));
  process.exit(1);
}

frame();
learn();
console.log(`\n✓ capture: ${storeKey} done. Framed assets in store-assets/screenshots/. ` +
  (flags.has('--contact-sheet') ? `Glance: store-assets/contact-sheet-*.png` : `Add --contact-sheet for a one-image check.`));
