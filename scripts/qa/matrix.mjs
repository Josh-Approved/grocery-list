#!/usr/bin/env node
/**
 * matrix.mjs — run the cross-device QA matrix as ONE Bash call, zero agent tokens.
 *
 * Josh is iPhone-only; the factory ships to four device classes (iPhone, iPad,
 * Android phone, Android tablet). This loops the deterministic capture pipeline
 * across the canonical device matrix (qa/devices.json) under two profiles —
 * `smoke` (per-PR; one phone per platform) and `full` (per-release; every device
 * x appearance x font-scale, landscape on tablets) — so a layout bug Josh can't
 * see by feel (the Pixel-tablet dock over a FAB, dark-mode contrast, large-font
 * clipping) becomes a red assertion or a visual-regression diff, not a hope.
 *
 * The expensive part — the EAS build — is hash-cached by capture.mjs and reused
 * across every cell of a platform: only the (cheap) device reconfigure + Maestro
 * traverse repeats. The agent never drives a device; it reads qa/qa-report.json
 * and (per release) ONE bounded contact-sheet review. See
 * uplevel/10-device-quality-net.md + runbooks/device-quality-net.md.
 *
 * Pipeline:
 *   1. plan     — expand qa/devices.json x profile into cells (pure; --self-test).
 *   2. capture  — per cell: capture.mjs --cell <label> (build cached, device
 *                 reconfigured for appearance/font/orientation, traverse + heal).
 *   3. visual   — visual-reg.mjs: lock baselines on first run, else diff vs
 *                 baseline (regressions -> qa/qa-triage.json).
 *   4. sheet    — one downscaled mega contact sheet across all cells x screens.
 *   5. report   — merge per-device sections into qa/qa-report.json.
 *
 * Usage:
 *   node scripts/qa/matrix.mjs <app-dir> --profile smoke|full [--heal]
 *   node scripts/qa/matrix.mjs <app-dir> --profile full --dry-run   # print the plan, run nothing
 *   node scripts/qa/matrix.mjs --self-test                          # offline: assert the planner; non-zero on fail
 *
 * Flags:
 *   --profile smoke|full   which matrix to run (default smoke)
 *   --heal                 pass --heal to each capture cell (auto-repair anchor drift)
 *   --no-visual            skip the visual-regression diff (capture only)
 *   --lock                 force visual-reg into baseline-lock mode (first full run)
 *   --dry-run              print every cell + command without executing
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------- pure planner (exercised by --self-test) ----------

/** Sanitize a font scale for a filesystem-safe cell label: 1 -> "1.0", 1.3 -> "1.3". */
export function fontTag(scale) {
  const n = Number(scale);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * Resolve an Android cell's AVD name to a booted emulator serial, given a
 * { serial: avdName } map (built in main from `adb -s <serial> emu avd name`).
 * Pure. Returns the matching serial, or null if no booted emulator runs that AVD.
 *
 * This is the load-bearing fix that lets phone + tablet emulators be booted at
 * once and still capture the RIGHT device class per cell: without it, capture.mjs
 * targets "the first booted emulator", so a pixel-tablet cell would silently lock
 * a phone screenshot as the tablet baseline (a bug only real-hardware runs expose).
 */
export function avdSerial(avdName, serialToAvd) {
  if (!avdName) return null;
  for (const [serial, name] of Object.entries(serialToAvd || {})) {
    if (name === avdName) return serial;
  }
  return null;
}

/**
 * Merge a gitignored per-machine override (devices.local.json) onto the canonical
 * devices.json. Pure. Devices merge PER ENTRY (deep) so an override that only
 * retargets an avd keeps the canonical store/platform/kind/label; profiles + axes
 * merge per top-level key (shallow is correct there — an override replaces a whole
 * profile/axis by name). A whole-map device merge would drop `store` and abort
 * capture.mjs — the bug that silently killed the Android matrix half (2026-06-11).
 */
export function mergeConfig(base, override) {
  if (!override) return base;
  const mergedDevices = { ...(base.devices || {}) };
  for (const [id, dev] of Object.entries(override.devices || {})) {
    mergedDevices[id] = { ...(base.devices?.[id] || {}), ...(dev || {}) };
  }
  return {
    ...base,
    devices: mergedDevices,
    profiles: { ...(base.profiles || {}), ...(override.profiles || {}) },
    axes: { ...(base.axes || {}), ...(override.axes || {}) },
  };
}

/**
 * Expand a device matrix + profile into the ordered list of cells to capture.
 * Pure: no I/O. Each cell carries everything a capture call needs.
 *
 * Orientation is per-device-kind from axes.orientation; a profile may pin
 * appearance/fontScale (smoke does) but never widens past the device cap.
 */
export function expandMatrix(config, profileName) {
  const profile = (config.profiles || {})[profileName];
  if (!profile) {
    throw new Error(`unknown profile "${profileName}" (have: ${Object.keys(config.profiles || {}).join(', ')})`);
  }
  const devices = config.devices || {};
  const axes = config.axes || {};
  const appearances = profile.appearance || axes.appearance || ['light'];
  const fontScales = profile.fontScale || axes.fontScale || [1.0];
  const orientationByKind = (axes.orientation && typeof axes.orientation === 'object')
    ? axes.orientation
    : { phone: ['portrait'], tablet: ['portrait'] };

  const cells = [];
  for (const id of profile.devices || []) {
    const dev = devices[id];
    if (!dev) throw new Error(`profile "${profileName}" references unknown device "${id}"`);
    const orientations = profile.orientation || orientationByKind[dev.kind] || ['portrait'];
    for (const appearance of appearances) {
      for (const fontScale of fontScales) {
        for (const orientation of orientations) {
          const label = `${id}-${appearance}-f${fontTag(fontScale)}-${orientation}`;
          cells.push({
            cell: label,
            device: id,
            platform: dev.platform,
            kind: dev.kind,
            store: dev.store,
            sim: dev.sim || null,
            avd: dev.avd || null,
            displayLabel: dev.label || id,
            appearance,
            fontScale,
            orientation,
          });
        }
      }
    }
  }
  return cells;
}

// ---------- self-test ----------

function selfTest() {
  let failures = 0;
  const ok = (cond, msg) => { if (!cond) { failures++; console.error(`  ✗ ${msg}`); } else { console.log(`  ✓ ${msg}`); } };

  const cfg = {
    devices: {
      iphone: { platform: 'ios', kind: 'phone', store: 'ios' },
      ipad: { platform: 'ios', kind: 'tablet', store: 'ipad' },
      pixel: { platform: 'android', kind: 'phone', store: 'android' },
      ptab: { platform: 'android', kind: 'tablet', store: 'androidTablet' },
    },
    axes: { appearance: ['light', 'dark'], fontScale: [1.0, 1.3], orientation: { phone: ['portrait'], tablet: ['portrait', 'landscape'] } },
    profiles: {
      smoke: { devices: ['iphone', 'pixel'], appearance: ['light'], fontScale: [1.0] },
      full: { devices: ['iphone', 'ipad', 'pixel', 'ptab'], appearance: ['light', 'dark'], fontScale: [1.0, 1.3] },
    },
  };

  const smoke = expandMatrix(cfg, 'smoke');
  ok(smoke.length === 2, `smoke expands to 2 cells (got ${smoke.length})`);
  ok(smoke.every((c) => c.appearance === 'light' && c.fontScale === 1.0 && c.orientation === 'portrait'),
    'smoke cells are all light/1.0/portrait');
  ok(smoke[0].cell === 'iphone-light-f1.0-portrait', `smoke cell label shape (got ${smoke[0].cell})`);

  const full = expandMatrix(cfg, 'full');
  // 2 phones x 2 appearance x 2 font x 1 orient = 8; 2 tablets x 2 x 2 x 2 = 16; total 24.
  ok(full.length === 24, `full expands to 24 cells (2 phones*4 + 2 tablets*8) (got ${full.length})`);
  const tabletLandscape = full.filter((c) => c.kind === 'tablet' && c.orientation === 'landscape');
  ok(tabletLandscape.length === 8, `tablets get landscape cells (got ${tabletLandscape.length})`);
  const phoneLandscape = full.filter((c) => c.kind === 'phone' && c.orientation === 'landscape');
  ok(phoneLandscape.length === 0, 'phones never get a landscape cell');
  ok(new Set(full.map((c) => c.cell)).size === full.length, 'every full cell label is unique');

  ok(fontTag(1) === '1.0' && fontTag(1.3) === '1.3', 'fontTag normalizes integer + decimal scales');

  const s2a = { 'emulator-5554': 'fwt_stable_api34', 'emulator-5556': 'fwt_tablet_api34' };
  ok(avdSerial('fwt_tablet_api34', s2a) === 'emulator-5556', 'avdSerial maps a tablet AVD to its serial');
  ok(avdSerial('fwt_stable_api34', s2a) === 'emulator-5554', 'avdSerial maps a phone AVD to its serial');
  ok(avdSerial('Pixel_Tablet', s2a) === null, 'avdSerial returns null when the AVD is not booted');
  ok(avdSerial(null, s2a) === null, 'avdSerial returns null for a missing AVD');

  // Per-machine override (devices.local.json) must DEEP-merge each device so a
  // bare avd retarget keeps store/platform/kind — the regression that killed the
  // Android matrix half on the first device-farm backfill (2026-06-11).
  const merged = mergeConfig(cfg, { devices: { pixel: { avd: 'fwt_stable_api34' } } });
  ok(merged.devices.pixel.avd === 'fwt_stable_api34', 'override retargets the avd');
  ok(merged.devices.pixel.store === 'android' && merged.devices.pixel.platform === 'android' && merged.devices.pixel.kind === 'phone',
    'override KEEPS canonical store/platform/kind (deep per-device merge)');
  ok(merged.devices.iphone.store === 'ios', 'unreferenced devices survive the merge');
  const mergedCells = expandMatrix(merged, 'full');
  ok(mergedCells.filter((c) => c.device === 'pixel').every((c) => c.store === 'android'),
    'every overridden-device cell carries a valid store');
  ok(mergeConfig(cfg, null) === cfg, 'null override is a no-op');

  let threw = false;
  try { expandMatrix(cfg, 'nope'); } catch { threw = true; }
  ok(threw, 'unknown profile throws');

  console.log(failures === 0 ? '\nself-test PASSED' : `\nself-test FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- config loading ----------

function loadConfig(appDir) {
  const base = path.join(appDir, 'qa', 'devices.json');
  if (!fs.existsSync(base)) {
    console.error(`No qa/devices.json in ${appDir}. Run: node scripts/sync.mjs qa ${appDir}`);
    process.exit(1);
  }
  let cfg = JSON.parse(fs.readFileSync(base, 'utf8'));
  // Per-machine override (gitignored): merge devices so a machine with different
  // sims/avds can retarget without editing the synced canonical file.
  const local = path.join(appDir, 'qa', 'devices.local.json');
  if (fs.existsSync(local)) {
    try {
      const ov = JSON.parse(fs.readFileSync(local, 'utf8'));
      cfg = mergeConfig(cfg, ov);
      console.log('matrix: merged qa/devices.local.json override');
    } catch (e) { console.warn(`matrix: ignoring malformed devices.local.json (${e.message})`); }
  }
  return cfg;
}

// ---------- orchestration ----------

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  if (flags.has('--self-test')) return selfTest();

  const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const VALUE_FLAGS = new Set(['--profile']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
  const appDir = path.resolve(positional[0] || process.cwd());
  const profileName = valueOf('--profile') || 'smoke';
  const dry = flags.has('--dry-run');
  const heal = flags.has('--heal');

  const cfg = loadConfig(appDir);
  let cells;
  try { cells = expandMatrix(cfg, profileName); } catch (e) { console.error(`matrix: ${e.message}`); process.exit(1); }

  console.log(`matrix: app=${path.basename(appDir)} profile=${profileName} cells=${cells.length}${dry ? '  [DRY RUN]' : ''}`);
  for (const c of cells) console.log(`  · ${c.cell}  (${c.displayLabel}, ${c.appearance}, font ${c.fontScale}, ${c.orientation})`);

  // Android cells need a booted emulator (capture.mjs installs onto a running
  // device; it does not boot AVDs). Map each booted emulator to its AVD name so a
  // cell targets the RIGHT device class by serial — phone and tablet can be booted
  // at once. Detect once; skip Android cells gracefully when their AVD isn't up.
  let serialToAvd = {};
  if (!dry && cells.some((c) => c.platform === 'android')) {
    const adb = spawnSync('adb', ['devices'], { encoding: 'utf8' });
    const serials = (adb.stdout || '').split('\n').filter((l) => /\tdevice$/.test(l))
      .map((l) => l.split('\t')[0].trim()).filter(Boolean);
    for (const s of serials) {
      const r = spawnSync('adb', ['-s', s, 'emu', 'avd', 'name'], { encoding: 'utf8' });
      serialToAvd[s] = ((r.stdout || '').split('\n')[0] || '').trim();
    }
    const n = serials.length;
    if (n === 0) console.warn('\nmatrix: no Android emulator booted — Android cells will be SKIPPED. ' +
      'Boot one first (e.g. `emulator -avd <name>`) to include them.');
    else console.log(`matrix: booted Android emulators: ${serials.map((s) => `${s}=${serialToAvd[s] || '?'}`).join(', ')}`);
  }
  const bootedSerials = Object.keys(serialToAvd);

  const results = [];
  for (const c of cells) {
    // Load governor (Uplevel 3 / T5): do NOT lock here — this is an orchestrator.
    // Each cell shells out to capture.mjs, which owns the heavy lock around its
    // own EAS build (leaf-owns-lock). A second lock here would just nest as a
    // no-op via JA_HEAVY_HELD.
    const argv = [
      path.join('scripts', 'qa', 'capture.mjs'), '.',
      '--store', c.store, '--platform', c.platform,
      '--appearance', c.appearance, '--font-scale', String(c.fontScale),
      '--orientation', c.orientation, '--cell', c.cell,
    ];

    // Device targeting. iOS: pass the sim name (capture creates/boots/isolates it).
    // Android: resolve the cell's AVD to a booted serial so phone vs tablet land on
    // the right emulator. No match + exactly one booted => use it (back-compat, but
    // warn the class is unverified); otherwise SKIP — never lock a wrong baseline.
    if (c.platform === 'android' && !dry) {
      let target = avdSerial(c.avd, serialToAvd);
      if (!target) {
        if (bootedSerials.length === 1) {
          target = bootedSerials[0];
          console.warn(`  ⚠ cell ${c.cell}: AVD "${c.avd}" not among booted emulators; ` +
            `using the only one booted (${target}=${serialToAvd[target] || '?'}). Device class UNVERIFIED.`);
        } else {
          const reason = bootedSerials.length === 0 ? 'no android emulator booted'
            : `AVD "${c.avd}" not booted (have: ${bootedSerials.map((s) => serialToAvd[s]).join(', ')})`;
          console.log(`\n=== cell ${c.cell} === SKIP (${reason})`);
          results.push({ ...c, status: 'skipped', reason });
          continue;
        }
      }
      argv.push('--device', target);
    } else if (c.sim) {
      argv.push('--device', c.sim);
    }
    if (heal) argv.push('--heal');
    if (dry) argv.push('--dry-run');

    console.log(`\n=== cell ${c.cell} ===`);
    const r = spawnSync('node', argv, { cwd: appDir, encoding: 'utf8', stdio: 'inherit' });
    results.push({ ...c, status: r.status === 0 ? 'pass' : 'fail', exit: r.status });
  }

  // Visual regression across the captured cells (lock first run, else diff).
  if (!flags.has('--no-visual')) {
    const vr = [path.join('scripts', 'qa', 'visual-reg.mjs'), '.', '--profile', profileName];
    if (flags.has('--lock')) vr.push('--lock');
    if (dry) vr.push('--dry-run');
    console.log('\n=== visual regression ===');
    spawnSync('node', vr, { cwd: appDir, encoding: 'utf8', stdio: 'inherit' });
  }

  // One downscaled mega contact sheet across every captured cell — the single
  // image the bounded reviewer pass reads (matrix-review.mjs assembles it).
  if (!dry) {
    console.log('\n=== contact sheet (matrix) ===');
    spawnSync('node', [path.join('scripts', 'qa', 'matrix-review.mjs'), '.', '--profile', profileName],
      { cwd: appDir, encoding: 'utf8', stdio: 'inherit' });
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(`\nmatrix: ${passed} pass, ${failed} fail, ${skipped} skipped of ${cells.length} cells.`);
  if (!dry) {
    const reportPath = path.join(appDir, 'qa', 'matrix-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ app: path.basename(appDir), profile: profileName, cells: results }, null, 2) + '\n');
    console.log(`  wrote ${path.relative(appDir, reportPath)}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
