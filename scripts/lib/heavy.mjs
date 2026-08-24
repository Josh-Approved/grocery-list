#!/usr/bin/env node
/**
 * heavy.mjs — the load governor (Uplevel 3, T5 Stage 0). Josh's binding
 * condition, 2026-07-04.
 *
 * WHY THIS EXISTS
 * The factory's nightly engine + release train are moving to a Mac mini that is
 * an M2 with 8 GB RAM. Heavy work (local EAS builds, emulator suites, the QA
 * matrix, two-device E2E, monkey, Stryker mutation) cannot run in parallel there
 * without thrashing/OOM. This module makes heavy work run STRICTLY ONE AT A TIME
 * on low-RAM machines, sized to what the machine can hold — a cross-process
 * mutex + profile-driven worker knobs — while staying a no-op on a full-size
 * machine, so the SAME entry points behave correctly on the laptop and the mini
 * with no per-machine config.
 *
 * THREE EXPORTS
 *   machineProfile()          → 'low-ram' (<16 GB) | 'full'. Overridable by the
 *                               MACHINE_PROFILE env or a gitignored
 *                               ~/.ja-machine.json ({"profile":"low-ram"}).
 *   withHeavyLock(label, fn)  → run fn() holding a machine-wide heavy lock. On
 *                               'low-ram' at most ONE heavy task runs; others
 *                               QUEUE (FIFO by arrival, logged "waiting on …"),
 *                               never fail. Stale holders are stolen — see
 *                               ORPHANED HOLDERS below. On 'full' it just runs
 *                               fn() (no serialization) unless {force:true}.
 *   concurrency()             → the profile's worker knobs the callers read
 *                               (jest --maxWorkers, Stryker --concurrency,
 *                               emulator -memory / -no-window, Gradle/Metro
 *                               workers). 0 means "tool default / uncapped".
 *
 * CLI (so shell entry points — ship-eas.sh etc. — can wrap a command):
 *   node scripts/lib/heavy.mjs run --label <label> -- <cmd> [args…]
 *   node scripts/lib/heavy.mjs profile            # prints low-ram|full
 *   node scripts/lib/heavy.mjs concurrency --json # prints the knobs
 *   node scripts/lib/heavy.mjs status             # who holds the lock + queue
 *   node scripts/lib/heavy.mjs break [--kill]     # clear a wedged lock by hand
 *   node scripts/lib/heavy.mjs --self-test        # pure-logic tests, exit 0/1
 *
 * The lock lives at ~/.ja-heavy.lock (+ ~/.ja-heavy.queue + ~/.ja-heavy.hb).
 * Override the directory with HEAVY_LOCK_DIR (used by the self-test to stay
 * isolated).
 *
 * ORPHANED HOLDERS (ticket heavy-lock-orphan-blocks-train, 2026-08-15)
 * A dead holder PID was the ONLY staleness signal, which is not enough: on
 * 2026-08-15 an orphaned Stryker run — its parent job had already exited, but
 * the process itself was very much alive — held the lock and blocked the
 * packing-list 1.0.8 release build for ~20 minutes, with nothing able to break
 * it but a human with `kill`. A waiter now steals on any of three signals:
 *
 *   dead-pid    the holder PID is gone (the original rule).
 *   heartbeat   the holder advertised a heartbeat (`hb: true` in the lock file)
 *               and has not refreshed ~/.ja-heavy.hb for HEARTBEAT_STALE_MS
 *               (5 min). A live holder rewrites it every 30 s from an UNREF'd
 *               timer, so a frozen/SIGSTOPped/orphaned holder goes quiet while
 *               a legitimately long build keeps beating for hours.
 *   max-hold    the lock has been held longer than HEAVY_MAX_HOLD_MS (default
 *               3 h, env-overridable). The backstop for a holder written before
 *               heartbeats existed — "indefinitely" is never a valid hold.
 *
 * A holder with no `hb` flag is NEVER judged by the heartbeat rule (a missing
 * heartbeat file must not read as a stalled one), so an old build in flight
 * during a rollout degrades to exactly the previous behaviour plus max-hold.
 * Every steal is logged loudly with its reason — a silent steal would hide the
 * OOM risk of two heavy jobs overlapping.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GIB = 1024 ** 3;
const LOW_RAM_THRESHOLD = 16 * GIB; // < 16 GB ⇒ serialize heavy work

/** How often a holder refreshes its heartbeat file while it works. */
export const HEARTBEAT_MS = 30_000;
/** A heartbeat older than this means the holder is orphaned/frozen, not busy.
 *  Ten missed beats — generous enough that a swapping 8 GB mini under a build
 *  never trips it, short enough that a release train is not blocked for long. */
export const HEARTBEAT_STALE_MS = 5 * 60_000;
/** Nothing legitimately holds the heavy lock for three hours. The backstop for
 *  holders that predate heartbeats. Override with HEAVY_MAX_HOLD_MS (ms). */
export const DEFAULT_MAX_HOLD_MS = 3 * 60 * 60_000;

// ---------------------------------------------------------------------------
// pure logic (self-tested, no IO)
// ---------------------------------------------------------------------------

/** Decide the profile from a raw byte count + optional overrides.
 *  Precedence: explicit override > env profile > file profile > memory size. */
export function profileFromBytes(memBytes, { override, envProfile, fileProfile } = {}) {
  const pick = override || envProfile || fileProfile;
  if (pick === 'low-ram' || pick === 'full') return pick;
  return memBytes < LOW_RAM_THRESHOLD ? 'low-ram' : 'full';
}

/** Given queue entries [{pid,label,seq}] and an aliveness predicate, return the
 *  entry that should acquire next (lowest seq among still-alive waiters), or
 *  null if the queue holds no live waiter. FIFO by arrival (seq). */
export function pickHead(entries, isAlive) {
  const live = entries.filter((e) => isAlive(e.pid));
  if (!live.length) return null;
  return live.reduce((a, b) => (a.seq <= b.seq ? a : b));
}

/** Why a held lock is steal-able, or null when the holder is healthy.
 *
 *  'no-holder' | 'dead-pid' | 'heartbeat' | 'max-hold'  (see the header).
 *  Pure: pass `now`/`hbTs` explicitly, inject the aliveness predicate. */
export function staleReason(holder, isAlive, opts = {}) {
  if (!holder || typeof holder.pid !== 'number') return 'no-holder';
  if (!isAlive(holder.pid)) return 'dead-pid';
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const hbStaleMs = Number.isFinite(opts.heartbeatStaleMs) ? opts.heartbeatStaleMs : HEARTBEAT_STALE_MS;
  const maxHoldMs = Number.isFinite(opts.maxHoldMs) ? opts.maxHoldMs : DEFAULT_MAX_HOLD_MS;
  // Only a holder that ADVERTISED a heartbeat may be judged by one. A holder
  // written by an older build never beats, and a missing beat must not read as
  // a stalled beat — that would steal the lock out from under healthy work.
  if (holder.hb === true) {
    const beat = Number.isFinite(opts.hbTs) ? opts.hbTs : holder.ts;
    if (Number.isFinite(beat) && now - beat > hbStaleMs) return 'heartbeat';
  }
  if (Number.isFinite(holder.ts) && now - holder.ts > maxHoldMs) return 'max-hold';
  return null;
}

/** A held lock is stale (steal-able) — see staleReason for the three signals. */
export function isStale(holder, isAlive, opts) {
  return staleReason(holder, isAlive, opts) !== null;
}

/** The worker knobs for a profile. 0 ⇒ leave the tool at its own default. */
export function concurrency(profile = machineProfile()) {
  if (profile === 'low-ram') {
    return {
      profile,
      jestWorkers: 2,
      strykerConcurrency: 1,
      emulatorMemoryMB: 2048,
      emulatorNoWindow: true,
      gradleWorkers: 2,
      gradleJvmMaxMB: 2048, // caps capture.mjs's hardcoded -Xmx4g on the 8 GB mini
      metroWorkers: 2,
    };
  }
  return {
    profile,
    jestWorkers: 0,
    strykerConcurrency: 0,
    emulatorMemoryMB: 0,
    emulatorNoWindow: false,
    gradleWorkers: 0,
    gradleJvmMaxMB: 4096,
    metroWorkers: 0,
  };
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

const lockDir = () => process.env.HEAVY_LOCK_DIR || os.homedir();
const lockPath = () => path.join(lockDir(), '.ja-heavy.lock');
const queuePath = () => path.join(lockDir(), '.ja-heavy.queue');
const hbPath = () => path.join(lockDir(), '.ja-heavy.hb');
const machineFile = () => path.join(os.homedir(), '.ja-machine.json');

function envMaxHoldMs() {
  const n = Number(process.env.HEAVY_MAX_HOLD_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_HOLD_MS;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours ⇒ still alive
  }
}

function readMemBytes() {
  try {
    const out = execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : Infinity;
  } catch {
    return Infinity; // non-mac / unknown ⇒ treat as full (don't over-serialize)
  }
}

function readFileProfile() {
  try {
    const j = JSON.parse(fs.readFileSync(machineFile(), 'utf8'));
    return j && (j.profile === 'low-ram' || j.profile === 'full') ? j.profile : undefined;
  } catch {
    return undefined;
  }
}

/** The machine's heavy-work profile (memoized per process). */
let _profile;
export function machineProfile() {
  if (_profile) return _profile;
  const envProfile =
    process.env.MACHINE_PROFILE === 'low-ram' || process.env.MACHINE_PROFILE === 'full'
      ? process.env.MACHINE_PROFILE
      : undefined;
  _profile = profileFromBytes(readMemBytes(), { envProfile, fileProfile: readFileProfile() });
  return _profile;
}

function readHolder() {
  try {
    return JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** The heartbeat lives in its OWN file so the lock file is written exactly once
 *  (by the `wx` claim) and can never be seen half-written by a waiter — a
 *  truncated lock file would parse as "no holder" and get stolen instantly. */
function readHb() {
  try {
    return JSON.parse(fs.readFileSync(hbPath(), 'utf8'));
  } catch {
    return null;
  }
}

let _hbTimer = null;

function writeHb() {
  try {
    fs.writeFileSync(hbPath(), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {
    /* a missed beat is survivable; ten in a row is what we act on */
  }
}

function startHeartbeat() {
  if (_hbTimer) return;
  writeHb();
  _hbTimer = setInterval(writeHb, HEARTBEAT_MS);
  if (_hbTimer.unref) _hbTimer.unref(); // must never hold the process open
}

function stopHeartbeat() {
  if (_hbTimer) {
    clearInterval(_hbTimer);
    _hbTimer = null;
  }
  const hb = readHb();
  if (!hb || hb.pid === process.pid) {
    try {
      fs.unlinkSync(hbPath());
    } catch {}
  }
}

/** staleReason for the lock as it exists on disk right now (reads the heartbeat
 *  file, and only trusts it when it belongs to the current holder). */
function currentStaleReason(holder) {
  const hb = readHb();
  const hbTs = hb && hb.pid === holder?.pid && Number.isFinite(hb.ts) ? hb.ts : undefined;
  return staleReason(holder, pidAlive, { hbTs, maxHoldMs: envMaxHoldMs() });
}

function readQueue() {
  try {
    return fs
      .readFileSync(queuePath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeQueue(entries) {
  const tmp = `${queuePath()}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, queuePath()); // atomic same-dir replace
}

function enqueue(entry) {
  fs.appendFileSync(queuePath(), JSON.stringify(entry) + '\n');
}

function dequeue(seq) {
  writeQueue(readQueue().filter((e) => e.seq !== seq && pidAlive(e.pid)));
}

/** Try to atomically claim the lock file for {pid,label}. Returns true on win. */
function tryClaim(label, log = defaultLog) {
  try {
    const fd = fs.openSync(lockPath(), 'wx'); // exclusive create; EEXIST if held
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, label, ts: Date.now(), hb: true }));
    fs.closeSync(fd);
    startHeartbeat();
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Held — steal only from a holder that is dead, gone quiet, or over the
    // max-hold ceiling. Never silently: a steal means two heavy jobs may now
    // overlap, which is exactly what this module exists to prevent.
    const holder = readHolder();
    const reason = currentStaleReason(holder);
    if (reason) {
      if (reason !== 'no-holder') {
        log(`[heavy] stealing the lock from ${holder.label} (pid ${holder.pid}) — ${reason}`);
      }
      try {
        fs.unlinkSync(lockPath());
      } catch {}
      try {
        const hb = readHb();
        if (hb && holder && hb.pid === holder.pid) fs.unlinkSync(hbPath());
      } catch {}
      return tryClaim(label, log);
    }
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Acquire the heavy lock (low-ram only). Resolves to a release handle. */
async function acquire(label, { pollMs = 1000, log = defaultLog } = {}) {
  const seq = Date.now() * 1000 + (process.pid % 1000);
  const me = { pid: process.pid, label, seq };
  enqueue(me);
  cleanupOnExit(seq);
  let waitedFor = null;
  for (;;) {
    // prune dead waiters so a crashed queue entry can't wedge FIFO ordering
    const q = readQueue().filter((e) => pidAlive(e.pid));
    const head = pickHead(q, pidAlive);
    const holder = readHolder();
    const free = !holder || currentStaleReason(holder) !== null;
    if (free && head && head.pid === process.pid && tryClaim(label, log)) {
      dequeue(seq);
      if (waitedFor) log(`[heavy] acquired after waiting — running ${label}`);
      return { seq, label };
    }
    const blockerLabel = holder && currentStaleReason(holder) === null ? holder.label : head && head.label;
    if (blockerLabel && blockerLabel !== waitedFor) {
      log(`[heavy] ${label}: waiting on ${blockerLabel} …`);
      waitedFor = blockerLabel;
    }
    await sleep(pollMs);
  }
}

function releaseHandle(handle) {
  if (!handle) return;
  stopHeartbeat();
  const holder = readHolder();
  if (holder && holder.pid === process.pid) {
    try {
      fs.unlinkSync(lockPath());
    } catch {}
  }
  dequeue(handle.seq);
}

let _exitHooked = false;
let _mySeqs = new Set();
function cleanupOnExit(seq) {
  _mySeqs.add(seq);
  if (_exitHooked) return;
  _exitHooked = true;
  const cleanup = () => {
    stopHeartbeat();
    const holder = readHolder();
    if (holder && holder.pid === process.pid) {
      try {
        fs.unlinkSync(lockPath());
      } catch {}
    }
    try {
      writeQueue(readQueue().filter((e) => e.pid !== process.pid));
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }
}

function defaultLog(msg) {
  process.stderr.write(msg + '\n');
}

/** Run fn() while holding the heavy lock, sized to the machine profile.
 *  On 'full' this is a straight pass-through unless {force:true}. */
export async function withHeavyLock(label, fn, opts = {}) {
  const profile = opts.profile || machineProfile();
  const log = opts.log || defaultLog;
  if (profile !== 'low-ram' && !opts.force) return fn();
  // Re-entrancy: matrix→capture, chain-runner→ship-eas, run-due-jobs→job all
  // nest. The outer holder already owns the machine-wide lock and passes
  // JA_HEAVY_HELD to its children (the `run` CLI spawns with it in the env), so
  // an inner acquire here would self-deadlock. Pass through instead.
  if (process.env.JA_HEAVY_HELD && !opts.force) {
    log(`[heavy] ${label}: nested under ${process.env.JA_HEAVY_HELD} — running without re-locking`);
    return fn();
  }
  const handle = await acquire(label, opts);
  const prevHeld = process.env.JA_HEAVY_HELD;
  process.env.JA_HEAVY_HELD = label; // inherited by child processes spawned in fn
  try {
    return await fn();
  } finally {
    if (prevHeld === undefined) delete process.env.JA_HEAVY_HELD;
    else process.env.JA_HEAVY_HELD = prevHeld;
    releaseHandle(handle);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);

async function runSubcommand() {
  const label = arg('--label', 'heavy');
  const sep = process.argv.indexOf('--');
  if (sep === -1 || !process.argv[sep + 1]) {
    console.error('usage: heavy.mjs run --label <label> -- <cmd> [args…]');
    process.exit(2);
  }
  const [cmd, ...rest] = process.argv.slice(sep + 1);
  const code = await withHeavyLock(label, () =>
    new Promise((resolve) => {
      const child = spawn(cmd, rest, { stdio: 'inherit' });
      child.on('exit', (c, sig) => resolve(sig ? 1 : c ?? 1));
      child.on('error', (err) => {
        process.stderr.write(`[heavy] spawn failed: ${err.message}\n`);
        resolve(127);
      });
    })
  );
  process.exit(code);
}

async function main() {
  if (has('--self-test')) return selfTest();
  const sub = process.argv[2];
  if (sub === 'run') return runSubcommand();
  if (sub === 'profile') {
    console.log(machineProfile());
    return;
  }
  if (sub === 'concurrency') {
    const c = concurrency();
    console.log(has('--json') ? JSON.stringify(c) : Object.entries(c).map(([k, v]) => `${k}=${v}`).join('\n'));
    return;
  }
  if (sub === 'status') {
    const holder = readHolder();
    const hb = readHb();
    const q = readQueue();
    console.log(
      JSON.stringify(
        {
          profile: machineProfile(),
          holder,
          holderAlive: holder ? pidAlive(holder.pid) : false,
          heartbeatAgeMs: hb && Number.isFinite(hb.ts) ? Date.now() - hb.ts : null,
          heldForMs: holder && Number.isFinite(holder.ts) ? Date.now() - holder.ts : null,
          staleReason: holder ? currentStaleReason(holder) : 'no-holder',
          queue: q,
        },
        null,
        2
      )
    );
    return;
  }
  // The manual escape hatch. The automatic rules above cover an orphan that has
  // gone quiet or run long; `break` is for the operator who knows NOW that the
  // holder is junk and does not want to wait out the heartbeat window.
  if (sub === 'break') {
    const holder = readHolder();
    if (!holder) {
      console.log('heavy lock is not held — nothing to break');
      return;
    }
    if (has('--kill') && pidAlive(holder.pid)) {
      try {
        process.kill(holder.pid, 'SIGTERM');
        console.log(`sent SIGTERM to ${holder.label} (pid ${holder.pid})`);
      } catch (e) {
        console.error(`could not signal pid ${holder.pid}: ${e.message}`);
      }
    }
    for (const p of [lockPath(), hbPath()]) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    console.log(`broke the heavy lock held by ${holder.label} (pid ${holder.pid})`);
    return;
  }
  console.error('usage: heavy.mjs run|profile|concurrency|status|break|--self-test');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// self-test (pure logic + isolated lock IO; no network, no real heavy work)
// ---------------------------------------------------------------------------

async function selfTest() {
  let ok = true;
  const check = (name, cond) => {
    if (!cond) ok = false;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  };

  // profile thresholds
  check('8GB ⇒ low-ram', profileFromBytes(8 * GIB) === 'low-ram');
  check('16GB ⇒ full', profileFromBytes(16 * GIB) === 'full');
  check('32GB ⇒ full', profileFromBytes(32 * GIB) === 'full');
  check('env override wins over memory', profileFromBytes(64 * GIB, { envProfile: 'low-ram' }) === 'low-ram');
  check('explicit override wins over env', profileFromBytes(8 * GIB, { override: 'full', envProfile: 'low-ram' }) === 'full');
  check('file profile used when no env', profileFromBytes(64 * GIB, { fileProfile: 'low-ram' }) === 'low-ram');
  check('garbage override ignored', profileFromBytes(8 * GIB, { override: 'nonsense' }) === 'low-ram');

  // concurrency knobs
  check('low-ram caps jest to 2', concurrency('low-ram').jestWorkers === 2);
  check('low-ram stryker concurrency 1', concurrency('low-ram').strykerConcurrency === 1);
  check('low-ram emulator headless + 2048', concurrency('low-ram').emulatorNoWindow && concurrency('low-ram').emulatorMemoryMB === 2048);
  check('full leaves jest at default(0)', concurrency('full').jestWorkers === 0);

  // pickHead — FIFO by seq, skipping dead waiters
  const alive = (pid) => pid !== 999; // pretend 999 is dead
  check('pickHead lowest live seq', pickHead([{ pid: 1, seq: 30 }, { pid: 2, seq: 10 }, { pid: 3, seq: 20 }], alive).pid === 2);
  check('pickHead skips dead head', pickHead([{ pid: 999, seq: 5 }, { pid: 2, seq: 10 }], alive).pid === 2);
  check('pickHead null when all dead', pickHead([{ pid: 999, seq: 5 }], alive) === null);

  // isStale
  check('stale when holder dead', isStale({ pid: 999 }, alive) === true);
  check('not stale when holder alive', isStale({ pid: 1 }, alive) === false);
  check('stale when no holder', isStale(null, alive) === true);

  // staleReason — the orphaned-holder rules (heavy-lock-orphan-blocks-train)
  const NOW = 1_000_000_000;
  const mins = (n) => n * 60_000;
  check('reason no-holder', staleReason(null, alive) === 'no-holder');
  check('reason dead-pid', staleReason({ pid: 999, ts: NOW }, alive, { now: NOW }) === 'dead-pid');
  check(
    'a beating holder is healthy however long it runs',
    staleReason({ pid: 1, hb: true, ts: NOW - mins(120) }, alive, { now: NOW, hbTs: NOW - 1000 }) === null
  );
  check(
    'a holder that stopped beating is orphaned',
    staleReason({ pid: 1, hb: true, ts: NOW - mins(30) }, alive, { now: NOW, hbTs: NOW - mins(6) }) === 'heartbeat'
  );
  check(
    'a beat inside the window is not orphaned',
    staleReason({ pid: 1, hb: true, ts: NOW - mins(30) }, alive, { now: NOW, hbTs: NOW - mins(4) }) === null
  );
  check(
    'an hb-advertising holder with NO beat falls back to its claim time',
    staleReason({ pid: 1, hb: true, ts: NOW - mins(6) }, alive, { now: NOW }) === 'heartbeat'
  );
  // The rollout guard: a holder from a build that predates heartbeats writes no
  // `hb` flag and must never be judged by a heartbeat it never promised.
  check(
    'a legacy holder is never heartbeat-stale',
    staleReason({ pid: 1, ts: NOW - mins(60) }, alive, { now: NOW }) === null
  );
  check(
    'max-hold is the backstop for a legacy holder',
    staleReason({ pid: 1, ts: NOW - mins(200) }, alive, { now: NOW }) === 'max-hold'
  );
  check(
    'dead-pid outranks the timing rules',
    staleReason({ pid: 999, hb: true, ts: NOW - mins(200) }, alive, { now: NOW }) === 'dead-pid'
  );
  check(
    'a holder with no ts is judged only on liveness',
    staleReason({ pid: 1 }, alive, { now: NOW }) === null
  );

  // isolated lock IO: acquire → held → release → re-acquire; steal a stale lock
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-heavy-'));
  const prev = process.env.HEAVY_LOCK_DIR;
  process.env.HEAVY_LOCK_DIR = tmp;
  try {
    check('claim on free lock', tryClaim('a') === true);
    check('lock file written', !!readHolder() && readHolder().label === 'a');
    check('second claim blocked while held (alive self)', tryClaim('b') === false);
    fs.unlinkSync(lockPath());
    check('claim after release', tryClaim('c') === true);
    // simulate a dead holder, then confirm a steal
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999, label: 'zombie', ts: 1 }));
    check('steals a stale (dead-pid) lock', tryClaim('d', () => {}) === true && readHolder().label === 'd');

    // the orphan case: holder pid is ALIVE (us) but its heartbeat went quiet.
    // Before heavy-lock-orphan-blocks-train this wedged the release train.
    stopHeartbeat();
    fs.unlinkSync(lockPath());
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, label: 'orphan-stryker', ts: Date.now() - 30 * 60_000, hb: true }));
    fs.writeFileSync(hbPath(), JSON.stringify({ pid: process.pid, ts: Date.now() - 10 * 60_000 }));
    let stealLog = '';
    check('steals from a live-but-silent holder', tryClaim('train', (m) => { stealLog = m; }) === true && readHolder().label === 'train');
    check('the steal is logged with its reason', /orphan-stryker/.test(stealLog) && /heartbeat/.test(stealLog));
    check('claiming writes a fresh heartbeat', !!readHb() && Date.now() - readHb().ts < 5000);
    stopHeartbeat();
    check('release clears the heartbeat file', !fs.existsSync(hbPath()));

    // a holder whose beat is CURRENT is not stealable, however long it has held
    fs.unlinkSync(lockPath());
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, label: 'long-build', ts: Date.now() - 60 * 60_000, hb: true }));
    fs.writeFileSync(hbPath(), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    check('never steals from a holder that is still beating', tryClaim('greedy', () => {}) === false);
    fs.unlinkSync(hbPath());

    // queue round-trip + dead-pruning on dequeue
    fs.unlinkSync(lockPath());
    writeQueue([{ pid: process.pid, label: 'x', seq: 1 }, { pid: 999, label: 'dead', seq: 2 }]);
    dequeue(1);
    check('dequeue drops self + dead entries', readQueue().length === 0);

    // withHeavyLock full cycle on an isolated low-ram lock
    let ran = false;
    await withHeavyLock(
      'solo',
      async () => {
        ran = true;
        check('holds lock file during fn', fs.existsSync(lockPath()));
      },
      { profile: 'low-ram', log: () => {} }
    );
    check('releases lock after fn', ran && !fs.existsSync(lockPath()));

    // re-entrancy: nested under JA_HEAVY_HELD passes through, never re-locks
    const prevHeld = process.env.JA_HEAVY_HELD;
    process.env.JA_HEAVY_HELD = 'outer';
    let nestedRan = false;
    await withHeavyLock('inner', async () => { nestedRan = true; }, { profile: 'low-ram', log: () => {} });
    check('nested call passes through without a lock file', nestedRan && !fs.existsSync(lockPath()));
    if (prevHeld === undefined) delete process.env.JA_HEAVY_HELD;
    else process.env.JA_HEAVY_HELD = prevHeld;
  } finally {
    if (prev === undefined) delete process.env.HEAVY_LOCK_DIR;
    else process.env.HEAVY_LOCK_DIR = prev;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  console.log(ok ? '\nself-test OK' : '\nself-test FAILED');
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();
