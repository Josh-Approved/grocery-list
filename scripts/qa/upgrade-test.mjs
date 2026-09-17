#!/usr/bin/env node
/**
 * upgrade-test.mjs — the upgrade/migration harness (Uplevel 3 / T4 stage 4).
 *
 * THE MIGRATION BUG CLASS, untested anywhere in the fleet until now (survey
 * finding). Josh's hardest reports come from off-happy-path regimes; "upgrade
 * over months-old data" is one of them. This is the standing, seeded, replayable
 * harness for it: install the LAST RELEASED binary, write real data, install the
 * HEAD build OVER it (NEVER uninstall — uninstall-first is the very bug we'd be
 * hiding), relaunch, and assert every seeded + written datum is still present and
 * correct. If HEAD reads the persisted store differently than the released build
 * wrote it (renamed key, changed schema, dropped table), the data is gone and
 * this catches it — token-free, one Bash call, exit code is the verdict.
 *
 * ── Where the "last released binary" comes from (the source we settled on) ────
 * The studio builds every binary `eas build --local`, and local builds are NOT
 * uploaded to the EAS build archive (verified 2026-07-04: `eas build:list` is
 * empty for a --local-only app). So the archive is NOT a reliable source here.
 * We resolve the OLD binary in this priority, first hit wins (recorded in
 * runbooks/qa-capture.md § Upgrade harness):
 *   1. --old <path>            explicit override (manual runs + the gate proof).
 *   2. qa/released/<platform>.<ext>   a per-app checked-out slot the ship path
 *      drops the just-submitted artifact into (going forward). ext = apk|tar.gz.
 *   3. EAS build archive       `eas build:list --status finished` newest FINISHED
 *      build's applicationArchiveUrl (fallback for any app built in the cloud).
 * None resolve → SKIP WITH NOTICE (never a silent pass); run-qa's upgrade tier
 * turns that into a clean skip unless the app opts in via qa/baseline.json
 * "upgrade/enforce": true.
 *
 * The HEAD binary is the hash-cached QA build capture.mjs/monkey use
 * (qa/captures/.build-<platform>.<ext>); pass --head <path> to override.
 *
 * ── Flows ────────────────────────────────────────────────────────────────────
 * Authored as an optional top-level `upgrade` block in qa/journey.json:
 *   "upgrade": { "write": { "steps": [...] }, "assert": { "steps": [...] } }
 * compile-flow projects it to qa/flows/upgrade-write.yaml (run on OLD: seed +
 * write a distinctive datum) and qa/flows/upgrade-assert.yaml (run on HEAD after
 * install-over: assert the seeded + written data survived). Both boot WITHOUT
 * clearState — the whole point is that data on disk persists across the upgrade.
 * An app with no `upgrade` block is a clean SKIP.
 *
 * ── Fault injection (how the gate is PROVEN, chaos-net doctrine) ──────────────
 * `--inject-fault sqlite-rename-table:<db-relpath>:<table>` renames a table in
 * the app's on-device SQLite store between install-over and the assert run,
 * faithfully simulating a broken migration (HEAD can't find the released build's
 * data → the app re-seeds fresh → the user's writes are gone). WITH the fault the
 * assert must FAIL; WITHOUT it, PASS. That is the known-bad demonstration the net
 * is not trusted without (memory feedback_gates_prove_failure: a gate must
 * provably fail a known-bad, measured on the REAL rendered screen). Android-only
 * (needs a rooted/userdebug emulator); documented as such.
 *
 * ── Storage pressure (optional, Android only) ────────────────────────────────
 * `--storage-pressure [freeMiB]` adds a second regime after the upgrade assert:
 * fill the app sandbox to near-full, run the app's own `journey.upgrade.pressure`
 * oracle (a write that must fail GRACEFULLY — honest error, no crash), reclaim
 * the space deterministically, then re-run the assert flow to prove the pressure
 * window destroyed nothing that was already persisted. An app with no `pressure`
 * block is a clean SKIP. Android-only on purpose — filling an iOS simulator's
 * container fills the host Mac's disk, and a safely-capped ballast never reaches
 * near-full, so a green iOS run would prove nothing.
 *
 * Usage:
 *   node scripts/qa/upgrade-test.mjs <app-dir> [--platform ios|android]
 *        [--old <path>] [--head <path>] [--device <udid|serial>]
 *        [--inject-fault <spec>] [--storage-pressure [freeMiB]] [--dry-run]
 *   node scripts/qa/upgrade-test.mjs --self-test        # pure logic, no device
 *
 * Exit 0 = data survived the upgrade (or a clean SKIP: no upgrade block / no
 * released binary). Exit 1 = data DID NOT survive → a production-class migration
 * defect, FILED to the ledger with the assert artifact under qa/regressions/.
 * Exit >1 = the run could not execute (no device, no HEAD build, bad flags).
 *
 * HARD RULE (this stage): install-OVER, never uninstall-first for the tested
 * transition; a finding is FILED, product fixes ride the defect fix loop.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { withHeavyLock } from '../lib/heavy.mjs';
import { resolveAppDir } from './app-dir.mjs';

const FACTORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const HERE = path.dirname(new URL(import.meta.url).pathname);

// ── pure logic (all --self-test'd; no I/O, no device) ────────────────────────

/** Does this app declare an upgrade block with at least a write + assert flow?
 *  Pure (reads a parsed journey) so callers SKIP cleanly rather than error. */
export function hasUpgrade(journey) {
  const u = journey && journey.upgrade;
  return !!(u && Array.isArray(u.write?.steps) && u.write.steps.length
    && Array.isArray(u.assert?.steps) && u.assert.steps.length);
}

/** Artifact extension per platform (matches capture.mjs's cache naming). */
export function artifactExt(platform) {
  return platform === 'ios' ? 'tar.gz' : 'apk';
}

/**
 * Decide where the OLD (last-released) binary comes from, given the candidate
 * inputs already gathered by the caller. Pure: takes booleans/paths, returns a
 * decision, so the priority order is unit-tested without touching disk/network.
 *   inputs = { override, releasedPath, releasedExists, easUrl }
 * Returns { source: 'override'|'released'|'eas'|'none', path?|url?, reason }.
 */
export function pickOldBinary({ override, releasedPath, releasedExists, easUrl }) {
  if (override) return { source: 'override', path: override, reason: `--old ${override}` };
  if (releasedPath && releasedExists) return { source: 'released', path: releasedPath, reason: `qa/released slot: ${releasedPath}` };
  if (easUrl) return { source: 'eas', url: easUrl, reason: `EAS build archive: ${easUrl}` };
  return { source: 'none', reason: 'no released binary (no --old, no qa/released slot, no FINISHED EAS build)' };
}

/** adb/simctl argv to install a binary OVER the existing one (NO uninstall). Pure. */
export function installOverArgs({ platform, device, appOrApk }) {
  if (platform === 'ios') {
    // simctl install replaces the app bundle in place, keeping its data container.
    return ['simctl', 'install', device || 'booted', appOrApk];
  }
  // adb install -r = reinstall keeping data; NEVER `uninstall` first (the bug class).
  const dev = device ? ['-s', device] : [];
  return [...dev, 'install', '-r', appOrApk];
}

/** adb/simctl argv to install a FRESH baseline (the OLD "released world"). This
 *  is the ONE allowed uninstall — it establishes the pre-upgrade state; the
 *  tested transition (OLD→HEAD) is the install-over above. Pure. */
export function freshInstallSteps({ platform, device, pkg, appOrApk }) {
  if (platform === 'ios') {
    const d = device || 'booted';
    return [
      ['simctl', 'uninstall', d, pkg],       // wipe any prior world (best-effort)
      ['simctl', 'install', d, appOrApk],
    ];
  }
  const dev = device ? ['-s', device] : [];
  return [
    [...dev, 'uninstall', pkg],
    [...dev, 'install', '-r', appOrApk],
  ];
}

/** EVERY fully-booted Android serial from `adb devices` output, in adb's order.
 *  Tolerates the `-l` long form (`serial\tdevice product:… model:…`) as well as
 *  the plain form, so a caller that adds -l later can't silently get nothing.
 *  States other than `device` (offline / unauthorized / bootloader) are not
 *  usable targets and must not match.
 *
 *  The LIST, not just the first, because "how many are attached" is itself the
 *  answer a caller needs: a second attached emulator is the difference between
 *  "pin this one" and "refuse to guess" (capture.mjs L23 — a stray Pixel_Tablet
 *  silently captured the wrong form factor). */
export function parseAttachedAndroidSerials(stdout) {
  return String(stdout || '').split('\n').slice(1)
    .filter((l) => /\tdevice(\s|$)/.test(l))
    .map((l) => l.split('\t')[0]);
}

/** First fully-booted Android serial from `adb devices` output, or null. */
export function parseBootedAndroidSerial(stdout) {
  return parseAttachedAndroidSerials(stdout)[0] ?? null;
}

/** First booted simulator UDID from `xcrun simctl list devices booted`, or null.
 *  Header lines ("== Devices ==", "-- iOS 26.5 --") carry no UDID, so matching
 *  the UDID shape is enough to skip them. */
export function parseBootedIosUdid(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    if (!/\(Booted\)/.test(line)) continue;
    const m = line.match(/\(([0-9A-Fa-f-]{36})\)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Maestro argv for one traversal. The `--device` pin is MANDATORY, never
 * optional — that is the whole point of this helper.
 *
 * WHY (observed 2026-08-20, and it silently invalidated every run this harness
 * had ever done): unpinned, Maestro picks an arbitrary connected device. A
 * `--platform ios` run installed the binaries onto the iOS simulator via
 * `simctl`, then Maestro traversed the booted ANDROID emulator instead, against
 * whatever stale build happened to be sitting on it — so the harness returned a
 * confident verdict about a different platform, a different binary, and a
 * different upgrade than the one under test. A false PASS there is worse than no
 * test: it certifies that user data survives an upgrade that was never
 * exercised. Same failure class as capture.mjs's L23 (wrong-device screenshots).
 *
 * Refusing to build argv without a device is deliberate — the caller must
 * resolve one and fail loudly when the requested platform has nothing booted.
 */
export function maestroArgs({ flowRel, device, platform, tag }) {
  if (!device) throw new Error('maestroArgs: a resolved device is required (refusing to let Maestro pick one)');
  return ['--device', device, 'test', flowRel, `--env=PLATFORM=${platform}`,
    '--debug-output', path.join('qa', 'maestro-debug', `upgrade-${tag}`)];
}

/**
 * The final verdict from the two flow outcomes. Pure oracle:
 *   wroteOk   — the OLD-binary write flow succeeded (data was actually written)
 *   assertOk  — the HEAD-binary assert flow succeeded (data present after upgrade)
 * A write that never landed is an INCONCLUSIVE run (exit >1), not a pass — we
 * can't claim data "survived" if it was never there. Returns { ok, status, reason }.
 */
export function verdict({ wroteOk, assertOk }) {
  if (!wroteOk) return { ok: false, status: 'error', reason: 'the write flow on the released binary failed — nothing was written, so the upgrade result is inconclusive (not a pass)' };
  if (assertOk) return { ok: true, status: 'pass', reason: 'seeded + written data present after install-over — migration preserved user data' };
  return { ok: false, status: 'fail', reason: 'seeded/written data missing after install-over — the upgrade LOST user data (migration defect)' };
}

/**
 * Parse an --inject-fault spec into an on-device command plan. Pure so the
 * self-test asserts the sqlite it will run. Supported (Android, rooted emulator):
 *   sqlite-rename-table:<db-relpath-under-app-files>:<table>
 * Returns { kind, dbRel, table, sql } or throws on a bad spec.
 */
export function parseFault(spec) {
  if (!spec) return null;
  const [kind, ...rest] = String(spec).split(':');
  if (kind === 'sqlite-rename-table') {
    const [dbRel, table] = rest;
    if (!dbRel || !table) throw new Error(`--inject-fault ${spec}: need sqlite-rename-table:<db-relpath>:<table>`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`--inject-fault: unsafe table name "${table}"`);
    // Renaming the table away is exactly a "renamed storage key" migration bug:
    // the released build's rows are orphaned; HEAD's `CREATE TABLE IF NOT EXISTS`
    // makes a fresh empty one and the app re-seeds, losing the user's writes.
    return { kind, dbRel, table, sql: `ALTER TABLE ${table} RENAME TO ${table}_migrated_away;` };
  }
  throw new Error(`--inject-fault: unknown fault kind "${kind}" (supported: sqlite-rename-table)`);
}

/** The adb shell argv that applies a parsed sqlite fault to an app's on-device
 *  db. Pure. The db lives under the app's private files dir; on a userdebug
 *  emulator `adb root` grants access (asserted by the caller before this runs). */
export function faultAdbArgs({ device, pkg, fault }) {
  const dev = device ? ['-s', device] : [];
  const dbPath = `/data/data/${pkg}/files/SQLite/${fault.dbRel}`;
  return [...dev, 'shell', `sqlite3 ${dbPath} "${fault.sql}"`];
}

// ── storage pressure (folded in from t4-upgrade-storage-pressure) ────────────
//
// THE REGIME: a device whose storage is nearly full. Josh's hardest reports come
// from off-happy-path regimes, and "the disk filled up mid-write" is one no test
// in the fleet has ever exercised. The failure we care about is not "the write
// failed" — that is allowed and expected — it is the app CORRUPTING or LOSING
// data it had already persisted, or dying without an honest error.
//
// ANDROID ONLY, and the reason is not laziness. An iOS simulator's app container
// is a directory on the studio Mac's own volume, so "fill the sandbox to
// near-full" means filling the Mac's 70 GiB system disk — dangerous, and not
// representative of a real iPhone's per-device storage. Capping the ballast to
// something safe instead would leave the sandbox far from full, the app would
// never hit ENOSPC, and the run would return a confident green having exercised
// nothing. This harness's whole history is false verdicts from vacuous runs
// (see maestroArgs), so a refusal is the honest answer for iOS. The Android
// emulator has a real, bounded userdata partition, so pressure there is genuine.

/**
 * Is this pair actually cross-VERSION, or the same build installed over itself?
 * Pure.
 *
 * WHY THIS GATE EXISTS. The released slot and the HEAD build cache are resolved
 * independently, and nothing checked that they differ. When an app's source has
 * not moved since its slot was dropped, capture.mjs's hash cache correctly
 * declines to rebuild — so `qa/released/<p>` and `qa/captures/.build-<p>` are the
 * SAME FILE, and a run installs a binary over itself, asserts the data is still
 * there (of course it is) and reports "migration preserved user data".
 *
 * That is a false green of exactly the kind this harness keeps producing (see
 * maestroArgs, and the iOS refusal in the storage-pressure block): a confident
 * verdict from a run that exercised nothing. It is not hypothetical — on
 * 2026-08-27 home-maintenance's two artifacts were byte-identical
 * (a6bdd4c4…), and packing-list was noted in the same state on 2026-08-25 and
 * only avoided it because someone checked by hand.
 *
 * A vacuous run must be a SKIP WITH NOTICE, never a pass. Same rule as a missing
 * released binary: say precisely why, and how to get a real pair.
 */
export function sameBuildVerdict({ oldDigest, headDigest } = {}) {
  if (!oldDigest || !headDigest) return { known: false, same: false };
  return { known: true, same: oldDigest === headDigest };
}

/** MiB of headroom left free when filling the sandbox; small enough that an
 *  ordinary write hits ENOSPC, not so small the OS itself falls over. */
export const DEFAULT_PRESSURE_FREE_MIB = 8;
/** Safety ceiling on the ballast. A run that hits this never reached near-full,
 *  so it is reported INCONCLUSIVE rather than passing. */
export const PRESSURE_BALLAST_CAP_MIB = 16384;

/** Does this app declare a storage-pressure oracle? Only the app knows which
 *  write to attempt under pressure and what its honest error says, so the flow
 *  is per-app (`journey.upgrade.pressure`). Absent → clean SKIP, never a pass. */
export function hasPressure(journey) {
  const p = journey && journey.upgrade && journey.upgrade.pressure;
  return !!(p && Array.isArray(p.steps) && p.steps.length);
}

/**
 * Read the storage-pressure mode off argv. Returns the MiB to leave free, or
 * null when the mode is off. `--storage-pressure` alone uses the default;
 * `--storage-pressure 32` leaves 32 MiB. Pure so the arg shape is unit-tested.
 */
export function pressureFreeMiBFromArgs(args) {
  const i = args.indexOf('--storage-pressure');
  if (i < 0) return null;
  const next = args[i + 1];
  if (next !== undefined && /^\d+$/.test(next)) return parseInt(next, 10);
  return DEFAULT_PRESSURE_FREE_MIB;
}

/**
 * Pick the positional app-dir argument, skipping any token that is the VALUE of
 * a preceding value-flag. `--storage-pressure` takes an OPTIONAL numeric value,
 * so it can't live in VALUE_FLAGS (that would swallow a bare app-dir that
 * followed it); its numeric value is skipped explicitly instead. Pure.
 */
export function pickAppArg(args, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) continue;
    const prev = args[i - 1];
    if (prev && valueFlags.has(prev)) continue;
    if (prev === '--storage-pressure' && /^\d+$/.test(a)) continue;
    return a;
  }
  return null;
}

/** Merge one platform's verdict into the per-app report (pure). The report used
 *  to be one flat object, so the second platform's run erased the first — an
 *  iOS FAIL followed by an Android PASS left a green file on disk (ticket
 *  upgrade-report-overwrites-platform). Now each platform keeps its own entry
 *  under `platforms`, and the top-level fields stay the LATEST run's so a
 *  reader of the old flat shape still parses. An old flat report is carried
 *  forward as its own platform's entry. */
export function mergePlatformReport(existing, report) {
  const platforms = {};
  if (existing && typeof existing === 'object') {
    if (existing.platforms && typeof existing.platforms === 'object') Object.assign(platforms, existing.platforms);
    else if (existing.platform) platforms[existing.platform] = { ...existing };
  }
  if (report && report.platform) platforms[report.platform] = { ...report };
  return { ...(report || {}), platforms };
}

/** One platform's entry from a report of either shape, or null (pure). */
export function upgradeReportFor(report, platform) {
  if (!report || typeof report !== 'object') return null;
  if (report.platforms && typeof report.platforms === 'object') return report.platforms[platform] || null;
  return report.platform === platform ? report : null;
}

/** Available KiB from `df` output (the 4th column of the first data row), or
 *  null. The header row's "1K-blocks" is not digits, so it self-skips. Pure. */
export function parseDfAvailKiB(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 4 && /^\d+$/.test(cols[1]) && /^\d+$/.test(cols[3])) {
      return parseInt(cols[3], 10);
    }
  }
  return null;
}

/**
 * How big a ballast file to write so the partition is left with ~freeMiB free.
 * Pure — the arithmetic that decides whether a run is meaningful is unit-tested
 * rather than discovered on a device at 3am.
 * Returns { fill, sizeMiB, availMiB?, capped?, reason }.
 */
export function ballastPlan({ availKiB, freeMiB, capMiB = PRESSURE_BALLAST_CAP_MIB }) {
  if (!Number.isFinite(availKiB) || availKiB < 0) {
    return { fill: false, sizeMiB: 0, reason: 'could not read available space on /data (df output was not parseable)' };
  }
  const availMiB = Math.floor(availKiB / 1024);
  const want = availMiB - freeMiB;
  if (want <= 0) {
    return { fill: false, sizeMiB: 0, availMiB,
      reason: `/data already has only ${availMiB} MiB free (target leaves ${freeMiB} MiB) — nothing to fill` };
  }
  const sizeMiB = Math.min(want, capMiB);
  const capped = sizeMiB < want;
  return { fill: true, sizeMiB, availMiB, capped,
    reason: capped
      ? `ballast CAPPED at ${capMiB} MiB but ${availMiB} MiB is free — the sandbox will not reach near-full, so this run cannot prove anything`
      : `filling ${sizeMiB} MiB to leave ~${freeMiB} MiB free of ${availMiB} MiB` };
}

/** Where the ballast lives: inside the app's own private files dir, so it both
 *  pressures the shared /data partition and is trivially reclaimable. Pure. */
export function ballastPath(pkg) {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(String(pkg || ''))) {
    throw new Error(`ballastPath: unsafe package name "${pkg}"`);
  }
  return `/data/data/${pkg}/files/.qa-storage-ballast`;
}

/** adb argv that allocates the ballast. fallocate is instant on ext4/f2fs; dd is
 *  the fallback for images without it. Ends with `ls -l` so the caller can prove
 *  the file actually reached the requested size. Pure. */
export function ballastFillArgs({ device, pkg, sizeMiB }) {
  const p = ballastPath(pkg);
  const bytes = sizeMiB * 1024 * 1024;
  const dev = device ? ['-s', device] : [];
  return [...dev, 'shell',
    `fallocate -l ${bytes} ${p} 2>/dev/null || dd if=/dev/zero of=${p} bs=1048576 count=${sizeMiB} 2>/dev/null; ls -l ${p}`];
}

/** adb argv that reclaims the ballast DETERMINISTICALLY. This must run even when
 *  the pressure phase blew up — a leftover ballast leaves the emulator with a
 *  full /data partition and poisons every later run on this machine. Pure. */
export function ballastRemoveArgs({ device, pkg }) {
  const p = ballastPath(pkg);
  const dev = device ? ['-s', device] : [];
  // `ls` after the rm is the PROOF of reclamation: it prints the path if the
  // file survived and nothing if it is gone, so the caller checks the ballast
  // path's absence from stdout rather than trusting rm's exit code. `df` is
  // appended for the human-readable log line.
  return [...dev, 'shell', `rm -f ${p}; sync; ls ${p} 2>/dev/null; df /data`];
}

/**
 * The storage-pressure oracle. Ordered worst-first, and deliberately refuses to
 * call a vacuous run a pass:
 *   reclaimed   — the ballast was removed (device hygiene; checked FIRST because
 *                 a dirty emulator invalidates every later run on this machine)
 *   filled      — pressure was actually applied
 *   capped      — the safety ceiling was hit, so near-full was never reached
 *   postAssertOk— data written BEFORE the pressure window survived it
 *   pressureOk  — the app's own oracle flow passed (honest error, no crash)
 * Pure.
 */
export function pressureVerdict({ filled, capped, pressureOk, postAssertOk, reclaimed }) {
  if (!reclaimed) {
    return { ok: false, status: 'error',
      reason: 'the storage ballast could not be removed — this emulator is left with a full /data partition and must be reclaimed by hand before any later device run is trustworthy' };
  }
  if (!filled) {
    return { ok: false, status: 'error',
      reason: 'no ballast was written, so storage pressure was never applied — inconclusive, not a pass' };
  }
  if (capped) {
    return { ok: false, status: 'error',
      reason: 'the ballast hit its safety cap, so the sandbox never reached near-full — the run proves nothing either way' };
  }
  if (!postAssertOk) {
    return { ok: false, status: 'fail',
      reason: 'data written before the pressure window was missing once space was reclaimed — storage pressure DESTROYED persisted user data' };
  }
  if (!pressureOk) {
    return { ok: false, status: 'fail',
      reason: "the app's storage-pressure oracle did not pass — a write against a near-full sandbox did not fail gracefully (no honest error, or the app died)" };
  }
  return { ok: true, status: 'pass',
    reason: 'a write against a near-full sandbox failed gracefully and pre-existing data survived intact after reclamation' };
}

// ── self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

  // hasUpgrade
  ok(hasUpgrade({ upgrade: { write: { steps: [{ tap: '@x' }] }, assert: { steps: [{ assert: '@x' }] } } }) === true, 'hasUpgrade true when both flows present');
  ok(hasUpgrade({ upgrade: { write: { steps: [] }, assert: { steps: [{ assert: '@x' }] } } }) === false, 'hasUpgrade false on empty write');
  ok(hasUpgrade({ upgrade: { assert: { steps: [{ assert: '@x' }] } } }) === false, 'hasUpgrade false when write missing');
  ok(hasUpgrade({}) === false, 'hasUpgrade false when no block');
  ok(hasUpgrade(null) === false, 'hasUpgrade false on null');

  // artifactExt
  ok(artifactExt('ios') === 'tar.gz', 'ios ext');
  ok(artifactExt('android') === 'apk', 'android ext');

  // pickOldBinary priority
  ok(pickOldBinary({ override: '/o.apk', releasedPath: '/r.apk', releasedExists: true, easUrl: 'http://x' }).source === 'override', 'override wins');
  ok(pickOldBinary({ releasedPath: '/r.apk', releasedExists: true, easUrl: 'http://x' }).source === 'released', 'released beats eas');
  ok(pickOldBinary({ releasedPath: '/r.apk', releasedExists: false, easUrl: 'http://x' }).source === 'eas', 'eas when no released slot');
  ok(pickOldBinary({ releasedPath: '/r.apk', releasedExists: false }).source === 'none', 'none when nothing resolves');
  ok(pickOldBinary({}).source === 'none', 'none on empty inputs');

  // installOverArgs — never contains uninstall
  const aAnd = installOverArgs({ platform: 'android', device: 'emulator-5554', appOrApk: '/h.apk' });
  ok(aAnd.join(' ') === '-s emulator-5554 install -r /h.apk', `android install-over argv (got ${aAnd.join(' ')})`);
  ok(!aAnd.includes('uninstall'), 'android install-over NEVER uninstalls');
  const aIos = installOverArgs({ platform: 'ios', device: 'UDID', appOrApk: '/h.app' });
  ok(aIos.join(' ') === 'simctl install UDID /h.app', `ios install-over argv (got ${aIos.join(' ')})`);
  ok(!aIos.includes('uninstall'), 'ios install-over NEVER uninstalls');
  const aIosBooted = installOverArgs({ platform: 'ios', appOrApk: '/h.app' });
  ok(aIosBooted[2] === 'booted', 'ios install-over defaults to booted device');

  // freshInstallSteps — the one allowed uninstall (baseline only)
  const fAnd = freshInstallSteps({ platform: 'android', device: 'd', pkg: 'com.x', appOrApk: '/o.apk' });
  ok(fAnd.length === 2 && fAnd[0].includes('uninstall') && fAnd[1].includes('install'), 'android fresh install = uninstall then install');
  const fIos = freshInstallSteps({ platform: 'ios', pkg: 'com.x', appOrApk: '/o.app' });
  ok(fIos[0].join(' ') === 'simctl uninstall booted com.x' && fIos[1].join(' ') === 'simctl install booted /o.app', 'ios fresh install steps');

  // device resolution — the wrong-device false-verdict regression (2026-08-20).
  // A run must traverse the SAME device it installed onto, or its verdict is
  // about a different platform entirely.
  const ADB_OUT = 'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_arm64\n';
  ok(parseBootedAndroidSerial(ADB_OUT) === 'emulator-5554', 'parse booted android serial');
  ok(parseBootedAndroidSerial('List of devices attached\n\n') === null, 'no android device → null');
  ok(parseBootedAndroidSerial('List of devices attached\nemulator-5554\toffline\n') === null,
    'an offline android device is not bootable');
  const ADB_TWO = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice product:Pixel_Tablet\n'
    + 'emulator-5558\toffline\n';
  ok(parseAttachedAndroidSerials(ADB_TWO).join(',') === 'emulator-5554,emulator-5556',
    'every attached android device is enumerated, offline ones excluded');
  ok(parseAttachedAndroidSerials('List of devices attached\n\n').length === 0, 'nothing attached → empty list');
  ok(parseAttachedAndroidSerials(ADB_OUT)[0] === parseBootedAndroidSerial(ADB_OUT),
    'the single-serial helper is the list helper\'s first entry (one parser, not two)');
  const SIMCTL_OUT = '== Devices ==\n-- iOS 26.5 --\n'
    + '    iPhone 17 Pro Max (6056CB2A-B5BD-4FB3-BB14-9445B38F571E) (Booted) \n';
  ok(parseBootedIosUdid(SIMCTL_OUT) === '6056CB2A-B5BD-4FB3-BB14-9445B38F571E', 'parse booted ios udid');
  ok(parseBootedIosUdid('== Devices ==\n-- iOS 26.5 --\n') === null, 'no booted sim → null');
  ok(parseBootedIosUdid('    iPhone 17 (ABC) (Shutdown)\n') === null, 'a shutdown sim is not booted');

  // maestroArgs — the pin is mandatory, and it comes FIRST (before `test`).
  const mArgs = maestroArgs({ flowRel: 'qa/flows/upgrade-write.yaml', device: 'udid-1', platform: 'ios', tag: 'write' });
  ok(mArgs[0] === '--device' && mArgs[1] === 'udid-1', 'maestroArgs pins --device first');
  ok(mArgs.includes('test') && mArgs.includes('qa/flows/upgrade-write.yaml'), 'maestroArgs carries the flow');
  ok(mArgs.includes('--env=PLATFORM=ios'), 'maestroArgs carries the platform env');
  // known-bad: the exact shape that produced the false verdict must be refused.
  let unpinned = false;
  try { maestroArgs({ flowRel: 'f.yaml', device: null, platform: 'ios', tag: 'write' }); }
  catch { unpinned = true; }
  ok(unpinned, 'maestroArgs REFUSES to build argv without a device (no implicit device pick)');

  // verdict oracle
  ok(verdict({ wroteOk: true, assertOk: true }).ok === true, 'verdict pass when written+present');
  ok(verdict({ wroteOk: true, assertOk: false }).status === 'fail', 'verdict FAIL when data lost after upgrade');
  ok(verdict({ wroteOk: false, assertOk: true }).status === 'error', 'verdict error/inconclusive when write never landed');
  ok(verdict({ wroteOk: false, assertOk: false }).ok === false, 'verdict not-ok when write failed');

  // same-build refusal — a run that installs a binary over itself certifies
  // nothing, so it must never reach the verdict oracle at all.
  ok(sameBuildVerdict({ oldDigest: 'a6bdd4c4', headDigest: 'a6bdd4c4' }).same === true,
    'identical digests → same build (the home-maintenance 2026-08-27 shape: slot IS the HEAD cache)');
  ok(sameBuildVerdict({ oldDigest: 'a6bdd4c4', headDigest: 'deadbeef' }).same === false,
    'differing digests → a genuine cross-version pair, run it');
  ok(sameBuildVerdict({ oldDigest: null, headDigest: 'deadbeef' }).known === false
    && sameBuildVerdict({ oldDigest: null, headDigest: 'deadbeef' }).same === false,
    'an unreadable artifact is NOT reported as same — never block a real run on a failed hash');
  ok(sameBuildVerdict().same === false, 'no digests at all → do not block (null-safe)');

  // parseFault
  const pf = parseFault('sqlite-rename-table:grocery-list.db:lists');
  ok(pf.kind === 'sqlite-rename-table' && pf.table === 'lists' && pf.dbRel === 'grocery-list.db', 'parseFault fields');
  ok(pf.sql === 'ALTER TABLE lists RENAME TO lists_migrated_away;', `parseFault sql (got ${pf.sql})`);
  ok(parseFault(null) === null, 'parseFault null passes through');
  let threw = false; try { parseFault('sqlite-rename-table:db'); } catch { threw = true; }
  ok(threw, 'parseFault throws on missing table');
  threw = false; try { parseFault('sqlite-rename-table:db:bad;name'); } catch { threw = true; }
  ok(threw, 'parseFault rejects an unsafe table name');
  threw = false; try { parseFault('drop-everything:db:t'); } catch { threw = true; }
  ok(threw, 'parseFault throws on an unknown kind');

  // faultAdbArgs
  const fa = faultAdbArgs({ device: 'emulator-5554', pkg: 'com.joshapproved.grocerylist', fault: pf });
  ok(fa.join(' ') === '-s emulator-5554 shell sqlite3 /data/data/com.joshapproved.grocerylist/files/SQLite/grocery-list.db "ALTER TABLE lists RENAME TO lists_migrated_away;"', `faultAdbArgs (got ${fa.join(' ')})`);

  // ── storage pressure ───────────────────────────────────────────────────────

  // hasPressure — absent oracle must SKIP, never silently pass.
  ok(hasPressure({ upgrade: { pressure: { steps: [{ assert: '@err' }] } } }) === true, 'hasPressure true with steps');
  ok(hasPressure({ upgrade: { pressure: { steps: [] } } }) === false, 'hasPressure false on empty steps');
  ok(hasPressure({ upgrade: {} }) === false, 'hasPressure false when block missing');
  ok(hasPressure(null) === false, 'hasPressure false on null');

  // flag parsing — optional value, and it must not eat the app-dir positional.
  ok(pressureFreeMiBFromArgs(['../app']) === null, 'pressure mode off when flag absent');
  ok(pressureFreeMiBFromArgs(['--storage-pressure']) === DEFAULT_PRESSURE_FREE_MIB, 'bare flag uses the default headroom');
  ok(pressureFreeMiBFromArgs(['--storage-pressure', '32']) === 32, 'flag takes an explicit MiB value');
  ok(pressureFreeMiBFromArgs(['--storage-pressure', '--platform', 'android']) === DEFAULT_PRESSURE_FREE_MIB,
    'a following flag is not read as the value');
  ok(pressureFreeMiBFromArgs(['--storage-pressure', '../grocery-list']) === DEFAULT_PRESSURE_FREE_MIB,
    'a following app-dir is not read as the value');

  const VF = new Set(['--platform', '--old', '--head', '--device', '--inject-fault']);
  ok(pickAppArg(['../grocery-list', '--platform', 'android'], VF) === '../grocery-list', 'app-dir picked when first');
  ok(pickAppArg(['--platform', 'android', '../grocery-list'], VF) === '../grocery-list', 'flag value not mistaken for app-dir');
  ok(pickAppArg(['--storage-pressure', '../grocery-list'], VF) === '../grocery-list',
    'a bare --storage-pressure does NOT swallow the app-dir');
  ok(pickAppArg(['--storage-pressure', '64', '../grocery-list'], VF) === '../grocery-list',
    'the numeric pressure value is skipped, app-dir still found');
  ok(pickAppArg(['--dry-run'], VF) === null, 'no positional → null');

  // df parsing
  const DF_OUT = 'Filesystem     1K-blocks    Used Available Use% Mounted on\n'
    + '/dev/block/dm-6  5946428 1234568   4711860  21% /data\n';
  ok(parseDfAvailKiB(DF_OUT) === 4711860, `parse df available KiB (got ${parseDfAvailKiB(DF_OUT)})`);
  ok(parseDfAvailKiB('Filesystem 1K-blocks Used Available Use% Mounted on\n') === null, 'header-only df → null');
  ok(parseDfAvailKiB('') === null, 'empty df → null');

  // ballastPlan arithmetic — the "is this run meaningful" decision.
  const bp = ballastPlan({ availKiB: 1024 * 1024, freeMiB: 8 });   // 1024 MiB free
  ok(bp.fill === true && bp.sizeMiB === 1016, `ballast leaves the requested headroom (got ${bp.sizeMiB})`);
  ok(bp.capped === false, 'a normal plan is not capped');
  const bpCap = ballastPlan({ availKiB: 1024 * 1024 * 40, freeMiB: 8, capMiB: 100 });
  ok(bpCap.fill === true && bpCap.sizeMiB === 100 && bpCap.capped === true, 'ballast honours the safety cap');
  const bpFull = ballastPlan({ availKiB: 1024 * 4, freeMiB: 8 });  // 4 MiB free, want 8
  ok(bpFull.fill === false, 'no fill when the partition is already tighter than the target');
  ok(ballastPlan({ availKiB: NaN, freeMiB: 8 }).fill === false, 'unparseable df → no fill');

  // ballast paths + argv
  ok(ballastPath('com.joshapproved.grocerylist') === '/data/data/com.joshapproved.grocerylist/files/.qa-storage-ballast',
    'ballast lives in the app private files dir');
  let badPkg = false;
  try { ballastPath('com.x; rm -rf /'); } catch { badPkg = true; }
  ok(badPkg, 'ballastPath REFUSES a package name that could break out of the shell string');
  const fillArgs = ballastFillArgs({ device: 'emulator-5554', pkg: 'com.joshapproved.grocerylist', sizeMiB: 512 });
  ok(fillArgs[0] === '-s' && fillArgs[1] === 'emulator-5554' && fillArgs[2] === 'shell', 'fill argv targets the device');
  ok(/fallocate -l 536870912 /.test(fillArgs[3]), 'fill argv allocates the requested byte count');
  ok(/dd if=\/dev\/zero .* count=512/.test(fillArgs[3]), 'fill argv carries the dd fallback');
  const rmArgs = ballastRemoveArgs({ device: 'emulator-5554', pkg: 'com.joshapproved.grocerylist' });
  ok(/rm -f \/data\/data\/com\.joshapproved\.grocerylist\/files\/\.qa-storage-ballast/.test(rmArgs[3]),
    'remove argv deletes exactly the ballast');
  ok(/df \/data/.test(rmArgs[3]), 'remove argv re-reads df for the log line');
  ok(/ls \/data\/data\/[^ ]*\.qa-storage-ballast 2>\/dev\/null/.test(rmArgs[3]),
    'remove argv probes with ls so reclamation is PROVEN by absence, not by rm exit code');

  // pressureVerdict oracle — worst-first, and no vacuous passes.
  const allGood = { filled: true, capped: false, pressureOk: true, postAssertOk: true, reclaimed: true };
  ok(pressureVerdict(allGood).status === 'pass', 'pressure passes when graceful + data intact + reclaimed');
  ok(pressureVerdict({ ...allGood, reclaimed: false }).status === 'error',
    'a ballast left behind is an ERROR even when everything else passed');
  ok(pressureVerdict({ ...allGood, filled: false }).status === 'error',
    'never applying pressure is inconclusive, NOT a pass');
  ok(pressureVerdict({ ...allGood, capped: true }).status === 'error',
    'a capped (never near-full) run is inconclusive, NOT a pass');
  ok(pressureVerdict({ ...allGood, postAssertOk: false }).status === 'fail',
    'losing pre-existing data under pressure is a FAIL');
  ok(pressureVerdict({ ...allGood, pressureOk: false }).status === 'fail',
    'an ungraceful write failure is a FAIL');
  ok(pressureVerdict({ ...allGood, postAssertOk: false, pressureOk: false }).reason.includes('DESTROYED'),
    'data destruction outranks ungraceful failure in the reported reason');

  // per-platform report: the second platform must never erase the first
  const iosFail = { app: 'a', platform: 'ios', ok: false, status: 'fail', ranAt: '2026-09-12T01:00:00Z' };
  const andPass = { app: 'a', platform: 'android', ok: true, status: 'pass', ranAt: '2026-09-12T02:00:00Z' };
  const both = mergePlatformReport(mergePlatformReport(null, iosFail), andPass);
  ok(both.platforms.ios.ok === false && both.platforms.android.ok === true, 'merge keeps an iOS FAIL after an Android PASS');
  ok(both.platform === 'android' && both.ok === true, 'merge keeps the latest run at top level (old readers still parse)');
  const fromFlat = mergePlatformReport(iosFail, andPass);
  ok(fromFlat.platforms.ios && fromFlat.platforms.ios.ok === false, 'an old flat report is carried forward as its own platform');
  ok(mergePlatformReport(both, { ...iosFail, ok: true }).platforms.ios.ok === true && mergePlatformReport(both, { ...iosFail, ok: true }).platforms.android.ok === true, 're-running one platform replaces only that entry');
  ok(upgradeReportFor(both, 'ios') === both.platforms.ios && upgradeReportFor(both, 'android').ok === true, 'upgradeReportFor reads the map');
  ok(upgradeReportFor(iosFail, 'ios') === iosFail && upgradeReportFor(iosFail, 'android') === null, 'upgradeReportFor reads the old flat shape by platform');
  ok(upgradeReportFor(null, 'ios') === null, 'upgradeReportFor tolerates no report');

  console.log(`\nupgrade-test self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── I/O shell ────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }

function sh(label, cmd, argv, opts = {}) {
  const pretty = `${cmd} ${argv.join(' ')}`;
  if (opts.quiet !== true) console.log(`\n› ${label}\n  $ ${pretty}`);
  if (opts.dry) return { status: 0, stdout: '', stderr: '' };
  return spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts });
}

/** Write the compact report run-qa's `upgrade` tier reads (mirrors
 *  qa/e2e-sync-report.json / qa/matrix-report.json). Never throws. Skips writing
 *  a report for fault-injected proof runs (they're not a real gate signal). */
function writeReport(appDir, report) {
  if (report.faultInjected) return;
  try {
    const p = path.join(appDir, 'qa', 'upgrade-report.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // `ranAt` is what lets a caller tell "this harness ran tonight" from "a
    // report left behind by a run last week". It matters because a SKIP (no
    // upgrade block, no released binary, released slot == HEAD) exits 0 and
    // writes nothing at all — without the stamp, a scheduler reading an old
    // report would score a skipped app green. See nightly-local's upgradeState.
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { existing = null; }
    const merged = mergePlatformReport(existing, { ...report, ranAt: new Date().toISOString() });
    fs.writeFileSync(p, JSON.stringify(merged, null, 2) + '\n');
  } catch { /* best-effort */ }
}

function fail(msg, code = 2) { console.error(`\n✗ upgrade-test: ${msg}`); process.exit(code); }
function skip(msg) { console.log(`\n∅ upgrade-test: ${msg} — SKIP.`); process.exit(0); }
/** sha256 of an artifact, or null if unreadable. Impure; feeds sameBuildVerdict. */
function fileDigest(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch { return null; }
}

function firstBootedAndroid() {
  const r = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  return parseBootedAndroidSerial(r.stdout);
}

function firstBootedIos() {
  const r = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted'], { encoding: 'utf8' });
  return parseBootedIosUdid(r.stdout);
}

/** Resolve the cached/gzipped Android artifact to an installable .apk (mirrors
 *  capture.mjs + monkey.mjs: an `eas build --output X.apk` release+debug build is
 *  actually a gzipped tar). iOS: extract the .app from the simulator tarball. */
function resolveArtifact(appDir, artifact, platform, tag, dry) {
  if (dry) return artifact;
  if (platform === 'ios') {
    const outDir = path.join(appDir, 'qa', 'captures', `.app-upgrade-${tag}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const ex = sh(`device — extract .app (${tag})`, 'tar', ['-xzf', artifact, '-C', outDir], { stdio: 'pipe' });
    if (ex.status !== 0) throw new Error(`failed to extract iOS artifact: ${(ex.stderr || '').slice(0, 200)}`);
    const found = [];
    const walk = (d, depth) => { if (depth > 4) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (/\.app$/.test(e.name)) found.push(p); else walk(p, depth + 1); }
    } };
    walk(outDir, 0);
    if (!found.length) throw new Error('no .app found inside the iOS simulator tarball');
    return found[0];
  }
  // Android
  let magic;
  try { const fd = fs.openSync(artifact, 'r'); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); magic = b; }
  catch { return artifact; }
  if (!(magic[0] === 0x1f && magic[1] === 0x8b)) return artifact; // raw apk
  const outDir = path.join(appDir, 'qa', 'captures', `.apk-upgrade-${tag}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const r = sh(`device — extract apk (${tag})`, 'tar', ['-xzf', artifact, '-C', outDir], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error('failed to extract the Android build archive');
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.apk$/i.test(e.name)) found.push(p);
  } };
  walk(outDir);
  const apk = found.find((f) => /release/i.test(f) && !/debug/i.test(f)) || found[0];
  if (!apk) throw new Error('no .apk found inside the gzipped Android build archive');
  return apk;
}

/** Newest FINISHED EAS build's application archive URL, or null. Best-effort;
 *  a --local-only app returns []. Never throws (network/login problems → null). */
function easArchiveUrl(appDir, platform) {
  const r = spawnSync('eas', ['build:list', '--platform', platform, '--status', 'finished', '--limit', '1', '--non-interactive', '--json'],
    { cwd: appDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return null;
  // eas prints an upgrade banner to stdout before the JSON; grab the JSON array.
  const s = String(r.stdout || '');
  const i = s.indexOf('[');
  if (i < 0) return null;
  try {
    const arr = JSON.parse(s.slice(i));
    return arr?.[0]?.artifacts?.applicationArchiveUrl || null;
  } catch { return null; }
}

function compileUpgradeFlows(appDir, dry) {
  // Use the FACTORY compile-flow (upgrade-aware) so the app need not be re-synced
  // first; it reads the app's journey.json + selectors.json and writes the app's
  // qa/flows/upgrade-*.yaml.
  const r = sh('compile — journey.upgrade → upgrade-{write,assert}.yaml', 'node',
    [path.join(HERE, 'compile-flow.mjs'), appDir], { dry, stdio: 'inherit' });
  if (!dry && r.status !== 0) fail('compile-flow failed for the upgrade flows.', 6);
}

/**
 * The storage-pressure regime, run on HEAD after the upgrade assert. Fill the
 * sandbox to near-full, run the app's own oracle flow (which must show an honest
 * error rather than crashing), reclaim the space DETERMINISTICALLY, then re-run
 * the upgrade assert flow to prove nothing written before the pressure window
 * was destroyed by it. Reclamation is in a `finally` because a leftover ballast
 * leaves the emulator with a full /data partition and silently poisons every
 * later device run on this machine.
 */
function runPressurePhase({ appDir, device, pkg, freeMiB, platform, assertFlow }) {
  const dev = device ? ['-s', device] : [];
  const pressureFlow = path.join('qa', 'flows', 'upgrade-pressure.yaml');
  let filled = false, capped = false, pressureOk = false, postAssertOk = false, reclaimed = false;
  let plan = { fill: false, reason: 'not planned' };

  try {
    const df = sh('pressure — read free space on /data', 'adb', [...dev, 'shell', 'df', '/data'], { stdio: 'pipe' });
    plan = ballastPlan({ availKiB: parseDfAvailKiB(df.stdout), freeMiB });
    console.log(`  ${plan.reason}`);

    if (plan.fill) {
      capped = !!plan.capped;
      const f = sh(`pressure — fill the sandbox (${plan.sizeMiB} MiB ballast)`, 'adb',
        ballastFillArgs({ device, pkg, sizeMiB: plan.sizeMiB }), { stdio: 'pipe' });
      // Prove the ballast landed (the trailing `ls` prints it) rather than
      // trusting an exit code from a shell one-liner with a `||` fallback.
      filled = f.status === 0 && /\.qa-storage-ballast/.test(String(f.stdout || ''));
      if (!filled) {
        console.error(`  ballast did not land: ${(f.stderr || f.stdout || '').split('\n').slice(0, 4).join(' ')}`);
      }
    }

    if (filled && !capped) {
      pressureOk = maestro(appDir, pressureFlow, device, platform, 'pressure', false);
    }
  } finally {
    const r = sh('pressure — reclaim the ballast', 'adb', ballastRemoveArgs({ device, pkg }), { stdio: 'pipe' });
    const out = String(r.stdout || '');
    reclaimed = r.status === 0 && !/\.qa-storage-ballast/.test(out);
    const availAfter = parseDfAvailKiB(out);
    console.log(`  reclaimed: ${reclaimed ? 'yes' : 'NO — BALLAST STILL ON DEVICE'}` +
      `${Number.isFinite(availAfter) ? ` (/data free: ${Math.floor(availAfter / 1024)} MiB)` : ''}`);
  }

  // Only meaningful once space is back: does the data from before the pressure
  // window still read correctly? Re-uses the upgrade assert flow as the oracle.
  if (reclaimed && filled && !capped) {
    postAssertOk = maestro(appDir, assertFlow, device, platform, 'post-pressure', false);
  }

  return { filled, capped, pressureOk, postAssertOk, reclaimed, plan: plan.reason };
}

function maestro(appDir, flowRel, device, platform, tag, dry) {
  const argv = maestroArgs({ flowRel, device, platform, tag });
  const r = sh(`traverse — ${flowRel}`, 'maestro', argv, { cwd: appDir, dry, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') fail('maestro CLI not installed.', 7);
  return dry ? true : r.status === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const VALUE_FLAGS = new Set(['--platform', '--old', '--head', '--device', '--inject-fault']);
  const appDir = resolveAppDir(pickAppArg(args, VALUE_FLAGS), 'upgrade-test');
  const app = path.basename(appDir);
  const platform = valueOf('--platform') || 'android';
  const dry = flags.has('--dry-run');
  const faultSpec = valueOf('--inject-fault');
  const pressureFreeMiB = pressureFreeMiBFromArgs(args);

  const journeyPath = path.join(appDir, 'qa', 'journey.json');
  if (!fs.existsSync(journeyPath)) skip(`no qa/journey.json in ${app} (capture pipeline not adopted)`);
  const journey = JSON.parse(fs.readFileSync(journeyPath, 'utf8'));
  if (!hasUpgrade(journey)) skip(`${app} declares no qa/journey.json "upgrade" block (rolling out, like survival)`);

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'))?.expo?.[platform === 'ios' ? 'ios' : 'android']?.[platform === 'ios' ? 'bundleIdentifier' : 'package']; } catch {}
  if (!pkg) fail(`no ${platform} package/bundle id in ${app}/app.json`, 2);

  const fault = faultSpec ? parseFault(faultSpec) : null;
  if (fault && platform !== 'android') fail('--inject-fault is Android-only (needs a rooted/userdebug emulator).', 2);

  if (pressureFreeMiB !== null) {
    // Android-only, and the refusal is deliberate — see the storage-pressure
    // section above. Filling an iOS simulator's sandbox fills the studio Mac's
    // own disk, and a ballast capped small enough to be safe never reaches
    // near-full, which would make a green run mean nothing.
    if (platform !== 'android') {
      fail('--storage-pressure is Android-only: an iOS simulator\'s container lives on the Mac\'s own volume, so filling it would fill the host disk rather than a device sandbox, and a safely-capped ballast never reaches near-full (a green run would prove nothing).', 2);
    }
    if (fault) fail('--storage-pressure and --inject-fault are mutually exclusive (the injected fault makes the assert flow fail by design, so the pressure oracle could not be read).', 2);
    if (!hasPressure(journey)) {
      skip(`${app} declares no qa/journey.json "upgrade.pressure" oracle — only the app knows which write to attempt under a full sandbox and what its honest error says, so there is nothing to assert (never a silent pass)`);
    }
  }

  // ── resolve the OLD (released) + HEAD binaries ──────────────────────────────
  const ext = artifactExt(platform);
  const override = valueOf('--old');
  const releasedPath = path.join(appDir, 'qa', 'released', `${platform}.${ext}`);
  const releasedExists = fs.existsSync(releasedPath);
  const easUrl = (!override && !releasedExists && !dry) ? easArchiveUrl(appDir, platform) : null;
  const oldPick = pickOldBinary({ override, releasedPath, releasedExists, easUrl });
  if (oldPick.source === 'none') {
    // Never a silent pass: say exactly why and how to feed it a released binary.
    skip(`no last-released ${platform} binary for ${app} — ${oldPick.reason}. ` +
      `Feed one with --old <path>, drop it at qa/released/${platform}.${ext}, or run where the EAS archive has a FINISHED build. ` +
      `(Device runs against the live store version are Mac-present → T5-scheduled.)`);
  }
  if (oldPick.source === 'eas') {
    fail(`the only source is the EAS archive (${oldPick.url}); this harness installs from a local file. ` +
      `Download it first: eas build:download, then pass --old <path>. (Left explicit rather than auto-downloading in a headless gate.)`, 2);
  }
  const headOverride = valueOf('--head');
  const headArtifact = headOverride || path.join(appDir, 'qa', 'captures', `.build-${platform}.${ext}`);
  if (!dry && !fs.existsSync(headArtifact)) {
    fail(`no HEAD build at ${path.relative(appDir, headArtifact)}. Run capture.mjs once to populate the cache, or pass --head <path>.`, 4);
  }

  // Refuse a same-build-over-itself run rather than certify it. See sameBuildVerdict.
  if (!dry) {
    const pair = sameBuildVerdict({
      oldDigest: fileDigest(oldPick.path),
      headDigest: fileDigest(headArtifact),
    });
    if (pair.same) {
      skip(`the released slot and the HEAD build are the SAME BINARY for ${app} (${platform}) — ` +
        `qa/released/${platform}.${ext} is byte-identical to ${path.relative(appDir, headArtifact)}, so this would install a build over itself ` +
        `and report a green that proves nothing about migration. ` +
        `Get a real pair: build a HEAD that has actually moved (capture.mjs --store ${platform} --build-only after app source changes), ` +
        `or point --old at an artifact older than the current slot.`);
    }
  }

  // Resolve a CONCRETE device for BOTH platforms and fail loudly when the
  // requested platform has nothing booted. Never fall through to "let the tool
  // pick": with an Android emulator up, an unpinned iOS run traverses Android
  // against a stale build and returns a verdict about the wrong upgrade
  // entirely (see maestroArgs). Absent hardware must be a hard stop, not a
  // silent platform swap.
  let device = valueOf('--device');
  if (!device && !dry) {
    device = platform === 'android' ? firstBootedAndroid() : firstBootedIos();
    if (!device) {
      fail(platform === 'android'
        ? 'no booted Android emulator/device (adb devices is empty). Boot one first.'
        : 'no booted iOS simulator (xcrun simctl list devices booted is empty). Boot one first.', 3);
    }
  }
  if (!device && dry) device = `<booted-${platform}-device>`;

  console.log(`upgrade-test: app=${app} platform=${platform} pkg=${pkg} device=${device || '(booted)'}\n` +
    `  OLD (released): ${oldPick.reason}\n  HEAD:           ${path.relative(appDir, headArtifact)}` +
    `${fault ? `\n  FAULT:          ${faultSpec} (proving the gate — expect FAIL)` : ''}${dry ? '  [DRY RUN]' : ''}`);

  const dev = device ? ['-s', device] : [];

  // Load governor (Uplevel 3 / T5): the whole install-baseline → write → install-
  // over → assert sequence drives a device end-to-end and is heavy. Run it under
  // the machine-wide lock so it can't overlap another heavy job on the 8 GB mini
  // (a no-op on a full-size machine). Dry runs execute nothing, so they skip it.
  const deviceSequence = async () => {
    if (platform === 'android' && !dry) {
      // Root the emulator up front so the fault injection (and any db inspection)
      // can reach the app's private files. Best-effort on production images.
      sh('device — adb root', 'adb', [...dev, 'root'], { stdio: 'pipe', quiet: true });
    }

    // Compile the upgrade flows fresh (can't be stale vs journey.upgrade).
    compileUpgradeFlows(appDir, dry);
    const writeFlow = path.join('qa', 'flows', 'upgrade-write.yaml');
    const assertFlow = path.join('qa', 'flows', 'upgrade-assert.yaml');

    // ── 1. install the RELEASED binary FRESH (the pre-upgrade world) ──────────
    const oldInstallable = resolveArtifact(appDir, oldPick.path, platform, 'old', dry);
    for (const step of freshInstallSteps({ platform, device, pkg, appOrApk: oldInstallable })) {
      const cmd = platform === 'ios' ? 'xcrun' : 'adb';
      const argv = platform === 'ios' ? step : step;
      const r = sh(`baseline — ${argv.includes('uninstall') ? 'uninstall prior world' : 'install released binary'}`,
        cmd, argv, { dry, stdio: 'pipe', allowFail: argv.includes('uninstall') });
      if (!dry && argv.includes('install') && r.status !== 0) {
        fail(`installing the released binary failed:\n${(r.stderr || r.stdout || '').split('\n').slice(0, 8).join('\n')}`, 4);
      }
    }

    // ── 2. write real data on the released binary ─────────────────────────────
    const wroteOk = maestro(appDir, writeFlow, device, platform, 'write', dry);
    if (!dry && !wroteOk) {
      fail(`the write flow failed on the released binary (see qa/maestro-debug/upgrade-write/). ` +
        `Cannot judge the upgrade — the pre-upgrade data was never written.`, 8);
    }

    // ── 3. install HEAD OVER it — NEVER uninstall (this is the tested transition) ─
    const headInstallable = resolveArtifact(appDir, headArtifact, platform, 'head', dry);
    const overCmd = platform === 'ios' ? 'xcrun' : 'adb';
    const over = sh('UPGRADE — install HEAD over the released build (no uninstall)',
      overCmd, installOverArgs({ platform, device, appOrApk: headInstallable }), { dry, stdio: 'pipe' });
    if (!dry && over.status !== 0) {
      fail(`install-over failed:\n${(over.stderr || over.stdout || '').split('\n').slice(0, 8).join('\n')}\n` +
        `(A signing-key mismatch between the released + HEAD builds surfaces here — real upgrades keep the same key.)`, 4);
    }

    // ── 3b. OPTIONAL fault injection (proving the gate) ───────────────────────
    if (fault && !dry) {
      const fa = faultAdbArgs({ device, pkg, fault });
      const r = sh(`FAULT — simulate a broken migration (${fault.kind})`, 'adb', fa, { stdio: 'pipe' });
      if (r.status !== 0) {
        fail(`fault injection failed (${(r.stderr || r.stdout || '').split('\n').slice(0, 4).join(' ')}). ` +
          `Needs a rooted userdebug emulator + on-device sqlite3.`, 9);
      }
      console.log(`  fault applied: ${fault.sql}`);
    }

    // ── 4. relaunch on HEAD + assert the seeded/written data survived ─────────
    const assertOk = maestro(appDir, assertFlow, device, platform, 'assert', dry);

    // ── 5. OPTIONAL storage-pressure regime (folded-in t4 scope) ──────────────
    // Runs last, on HEAD, so the upgrade verdict above is already settled and a
    // pressure failure can never be confused for a migration failure.
    let pressure = null;
    if (pressureFreeMiB !== null && !dry && wroteOk && assertOk) {
      pressure = runPressurePhase({ appDir, device, pkg, freeMiB: pressureFreeMiB, platform, assertFlow });
    }
    return { wroteOk, assertOk, pressure };
  };

  const { wroteOk, assertOk, pressure } = dry
    ? await deviceSequence()
    : await withHeavyLock(`upgrade:${app}:${platform}`, deviceSequence);

  if (dry) { console.log('\n(dry run — plan above; not executing)'); return; }

  const v = verdict({ wroteOk, assertOk });
  const pv = pressure ? pressureVerdict(pressure) : null;
  const baseReport = { app, platform, ok: v.ok && (!pv || pv.ok), status: v.status, verdict: v.reason,
    oldSource: oldPick.source, faultInjected: !!fault,
    ...(pv ? { pressure: { status: pv.status, verdict: pv.reason, plan: pressure.plan } } : {}) };

  if (v.ok && (!pv || pv.ok)) {
    writeReport(appDir, baseReport);
    console.log(`\n✓ upgrade-test: ${app} (${platform}) — ${v.reason}${fault ? ' [UNEXPECTED: a fault was injected but data survived — check the fault]' : ''}.`);
    if (pv) console.log(`✓ storage pressure: ${pv.reason}.`);
    process.exit(0);
  }

  // The upgrade itself was clean but the storage-pressure regime was not. Kept
  // separate from the migration-finding path below so the two never blur: a
  // pressure 'error' is inconclusive (exit 2, nothing filed), a pressure 'fail'
  // is a real product finding against HEAD.
  if (v.ok && pv && !pv.ok) {
    writeReport(appDir, baseReport);
    if (pv.status === 'error') {
      console.error(`\n∅ upgrade-test: ${app} (${platform}) upgraded cleanly, but the storage-pressure run was INCONCLUSIVE — ${pv.reason}`);
      process.exit(2);
    }
    const regDir = path.join(appDir, 'qa', 'regressions');
    fs.mkdirSync(regDir, { recursive: true });
    const pLog = path.join(regDir, `pressure-${platform}-${today()}.log`);
    fs.writeFileSync(pLog,
      `# storage-pressure finding — app=${app} platform=${platform} date=${today()}\n` +
      `# ballast: ${pressure.plan}\n# verdict: ${pv.status} — ${pv.reason}\n` +
      `# replay: node scripts/qa/upgrade-test.mjs ../${app} --platform ${platform} --storage-pressure\n`, 'utf8');
    const relPLog = path.relative(FACTORY_ROOT, pLog);
    console.error(`\n✗ upgrade-test: ${app} (${platform}) FAILED under storage pressure — ${pv.reason}. Artifact → ${relPLog}`);
    const filedP = sh('triage — file ledger record', 'node', [
      path.join('scripts', 'defects.mjs'), 'open',
      '--app', app,
      '--class', 'correctness',
      '--found-by', 'net',
      '--title', `${app} does not survive a near-full device (${platform})`,
      '--symptom', `with the app sandbox filled to near-full, a write did not fail gracefully and/or previously-persisted data was destroyed`.slice(0, 200),
      '--repro-kind', 'upgrade',
      '--repro-artifact', relPLog,
    ], { cwd: FACTORY_ROOT, stdio: 'inherit' });
    if (filedP.status !== 0) console.error('upgrade-test: WARNING — defect open exited non-zero; the artifact is still saved at ' + relPLog);
    process.exit(1);
  }

  // ── a finding: save the assert artifact, file a ledger record, exit non-zero ─
  const regDir = path.join(appDir, 'qa', 'regressions');
  fs.mkdirSync(regDir, { recursive: true });
  const stamp = `upgrade-${platform}-${today()}`;
  const logPath = path.join(regDir, `${stamp}.log`);
  const dbgDir = path.join(appDir, 'qa', 'maestro-debug', 'upgrade-assert');
  const record =
    `# upgrade migration finding — app=${app} platform=${platform} date=${today()}\n` +
    `# OLD (released): ${oldPick.reason}\n# HEAD: ${path.relative(appDir, headArtifact)}\n` +
    `# fault-injected: ${fault ? faultSpec : 'no (real HEAD build)'}\n` +
    `# verdict: ${v.status} — ${v.reason}\n` +
    `# replay: node scripts/qa/upgrade-test.mjs ../${app} --platform ${platform}${fault ? ' --inject-fault ' + faultSpec : ''}\n\n` +
    `The HEAD build did not show data that the released build wrote. Assert-flow debug output: ${path.relative(FACTORY_ROOT, dbgDir)}\n`;
  fs.writeFileSync(logPath, record, 'utf8');
  const relLog = path.relative(FACTORY_ROOT, logPath);

  if (v.status === 'error') {
    // Inconclusive, not a migration finding — don't pollute the ledger or the report.
    console.error(`\n✗ upgrade-test: ${app} — ${v.reason}. Notes → ${relLog}`);
    process.exit(2);
  }

  writeReport(appDir, { ...baseReport, artifact: relLog });

  console.error(`\n✗ upgrade-test: ${app} (${platform}) LOST DATA across the upgrade — ${v.reason}. Artifact → ${relLog}`);

  if (fault) {
    // The gate-proof path: we EXPECTED this fail. Do NOT file a defect against
    // the app (there's no real product bug — we injected the fault). Exit 1 so
    // the proof harness sees the gate fired.
    console.error(`  (fault-injected run — gate PROVED it catches a broken migration; no ledger record filed.)`);
    process.exit(1);
  }

  const openArgv = [
    path.join('scripts', 'defects.mjs'), 'open',
    '--app', app,
    '--class', 'correctness',
    '--found-by', 'net',
    '--title', `upgrading ${app} loses data (migration over released ${platform} build)`,
    '--symptom', `after installing HEAD over the last-released ${platform} binary (no uninstall), seeded/written data was missing on relaunch`.slice(0, 200),
    '--repro-kind', 'upgrade',
    '--repro-artifact', relLog,
  ];
  const filed = sh('triage — file ledger record', 'node', openArgv, { cwd: FACTORY_ROOT, stdio: 'inherit' });
  if (filed.status !== 0) console.error('upgrade-test: WARNING — defect open exited non-zero; the artifact is still saved at ' + relLog);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
