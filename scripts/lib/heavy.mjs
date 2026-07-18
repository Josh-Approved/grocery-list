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
 *                               never fail. Stale holders (dead PID) are stolen.
 *                               On 'full' it just runs fn() (no serialization)
 *                               unless {force:true}.
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
 *   node scripts/lib/heavy.mjs --self-test        # pure-logic tests, exit 0/1
 *
 * The lock lives at ~/.ja-heavy.lock (+ ~/.ja-heavy.queue). Override the
 * directory with HEAVY_LOCK_DIR (used by the self-test to stay isolated).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GIB = 1024 ** 3;
const LOW_RAM_THRESHOLD = 16 * GIB; // < 16 GB ⇒ serialize heavy work

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

/** A held lock is stale (steal-able) when its holder PID is no longer alive. */
export function isStale(holder, isAlive) {
  if (!holder || typeof holder.pid !== 'number') return true;
  return !isAlive(holder.pid);
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
const machineFile = () => path.join(os.homedir(), '.ja-machine.json');

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
function tryClaim(label) {
  try {
    const fd = fs.openSync(lockPath(), 'wx'); // exclusive create; EEXIST if held
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, label, ts: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Held — steal only if the current holder is dead.
    const holder = readHolder();
    if (isStale(holder, pidAlive)) {
      try {
        fs.unlinkSync(lockPath());
      } catch {}
      return tryClaim(label);
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
    const free = !holder || isStale(holder, pidAlive);
    if (free && head && head.pid === process.pid && tryClaim(label)) {
      dequeue(seq);
      if (waitedFor) log(`[heavy] acquired after waiting — running ${label}`);
      return { seq, label };
    }
    const blockerLabel = holder && !isStale(holder, pidAlive) ? holder.label : head && head.label;
    if (blockerLabel && blockerLabel !== waitedFor) {
      log(`[heavy] ${label}: waiting on ${blockerLabel} …`);
      waitedFor = blockerLabel;
    }
    await sleep(pollMs);
  }
}

function releaseHandle(handle) {
  if (!handle) return;
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
    const q = readQueue();
    console.log(
      JSON.stringify(
        { profile: machineProfile(), holder, holderAlive: holder ? pidAlive(holder.pid) : false, queue: q },
        null,
        2
      )
    );
    return;
  }
  console.error('usage: heavy.mjs run|profile|concurrency|status|--self-test');
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
    check('steals a stale (dead-pid) lock', tryClaim('d') === true && readHolder().label === 'd');
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
