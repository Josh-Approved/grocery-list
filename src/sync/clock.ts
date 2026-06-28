/**
 * Skew-resistant logical clock for the shared-sync merge.
 *
 * THE PROBLEM IT SOLVES. The merge (mergeRecordSet) is last-writer-wins by
 * timestamp. Comparing two phones' raw `Date.now()` is unsafe: a device whose
 * wall clock is even a few minutes ahead wins every comparison, so a *stale*
 * edit from the fast phone can beat a *fresh* edit from the other, and a delete
 * from the fast phone can make a live item vanish (then reappear once real time
 * passes that stamp). Those are the "my list went wonky / disappeared then came
 * back" failure modes.
 *
 * THE FIX. A Hybrid-Logical-Clock, collapsed into the millisecond domain so the
 * values stay human-meaningful and still sort by real time:
 *   - monotonic per device (`now()` never goes backwards, even if the OS clock
 *     jumps back — e.g. the user corrects a fast clock),
 *   - advances past any peer timestamp we have SEEN (`observe()`), so once a
 *     device has received the fast phone's state, its next real edit out-clocks
 *     it — "last action in causal order wins", not "fastest clock wins",
 *   - clamps how far it will run ahead of real time (`maxSkewMs`), so one
 *     badly-wrong phone can't drag the shared clock arbitrarily into the future
 *     (which would also get the Nostr events relay-rejected for bad created_at).
 *
 * WHAT IT DOES NOT DO. Truly concurrent blind edits — both phones change the
 * same field while neither has seen the other — are still last-writer-wins.
 * That is inherent to an offline-capable CRDT and matches the app's "honest
 * about live-ness" promise. This module removes the *stale-beats-fresh* and
 * *skew-driven disappearance* classes, which are defects, not the irreducible
 * concurrent-edit case.
 *
 * USAGE. Stamp every merge-participating field (record `updatedAt`/`deletedAt`,
 * list `updatedAt`/`nameUpdatedAt`) with `now()` instead of `Date.now()`. Call
 * `observe(maxRemoteTs)` once when a remote payload arrives, before merging.
 * Wire `initClock(persisted, sink)` at store hydrate so the high-water mark
 * survives a restart (otherwise a backward OS-clock jump across a restart could
 * regress below stamps we already published).
 *
 * The app uses the shared default instance via the `now`/`observe`/`initClock`
 * exports. The `LogicalClock` class is exported so a test harness / simulator
 * can run several independent device clocks in one process.
 */

/** A device's clock may run at most this far ahead of real time after folding
 *  in peer timestamps. One day comfortably covers honest drift / timezone /
 *  DST while bounding the blast radius of a grossly-wrong peer clock. */
const MAX_SKEW_MS = 24 * 60 * 60 * 1000;

/** Persist at most this often (ms of clock advance). The persisted value only
 *  needs to be "recent enough" to beat a backward clock jump across a restart;
 *  throttling keeps it from writing on every keystroke. */
const PERSIST_GRANULARITY_MS = 2000;

export interface ClockOptions {
  maxSkewMs?: number;
  persistGranularityMs?: number;
  /** Injectable time source (tests/simulator). Defaults to Date.now. */
  physicalNow?: () => number;
}

export class LogicalClock {
  private last = 0;
  private lastPersisted = 0;
  private sink: ((v: number) => void) | null = null;
  private readonly maxSkewMs: number;
  private readonly persistGranularityMs: number;
  private readonly physicalNow: () => number;

  constructor(opts: ClockOptions = {}) {
    this.maxSkewMs = opts.maxSkewMs ?? MAX_SKEW_MS;
    this.persistGranularityMs = opts.persistGranularityMs ?? PERSIST_GRANULARITY_MS;
    this.physicalNow = opts.physicalNow ?? Date.now;
  }

  /** Restore the high-water mark from disk and wire the persistence sink. Call
   *  once at startup, before the first `now()`. */
  init(persisted: number, persistSink: (v: number) => void): void {
    const p = Number.isFinite(persisted) ? Math.floor(persisted) : 0;
    if (p > this.last) this.last = p;
    this.lastPersisted = this.last;
    this.sink = persistSink;
  }

  private maybePersist(): void {
    if (this.sink && this.last - this.lastPersisted >= this.persistGranularityMs) {
      this.lastPersisted = this.last;
      this.sink(this.last);
    }
  }

  /** A new monotonic timestamp for a local edit. Tracks physical time but never
   *  goes backwards and never repeats. */
  now(): number {
    const phys = this.physicalNow();
    this.last = phys > this.last ? phys : this.last + 1;
    this.maybePersist();
    return this.last;
  }

  /** Fold in a timestamp observed from a peer so our next `now()` out-clocks
   *  it. Clamped to real-time + maxSkew so a wildly-future peer stamp can't
   *  poison our clock (or get our events relay-rejected). */
  observe(peerTs: number): void {
    if (!Number.isFinite(peerTs)) return;
    const target = Math.min(Math.floor(peerTs), this.physicalNow() + this.maxSkewMs);
    if (target > this.last) {
      this.last = target;
      this.maybePersist();
    }
  }

  /** Current high-water mark without advancing it (diagnostics / tests). */
  peek(): number {
    return this.last;
  }

  /** Test-only: clear all state. */
  reset(): void {
    this.last = 0;
    this.lastPersisted = 0;
    this.sink = null;
  }
}

// ---- Shared default instance (what the app imports) -----------------------

const defaultClock = new LogicalClock();

/** Restore + wire persistence for the app's shared clock. */
export function initClock(persisted: number, persistSink: (v: number) => void): void {
  defaultClock.init(persisted, persistSink);
}

/** A new monotonic timestamp for a local edit. */
export function now(): number {
  return defaultClock.now();
}

/** Fold in a peer timestamp so our next `now()` out-clocks it. */
export function observe(peerTs: number): void {
  defaultClock.observe(peerTs);
}

/** Current high-water mark (diagnostics / tests). */
export function peek(): number {
  return defaultClock.peek();
}

/** Test-only: reset the shared default instance between cases. */
export function _resetForTest(): void {
  defaultClock.reset();
}
