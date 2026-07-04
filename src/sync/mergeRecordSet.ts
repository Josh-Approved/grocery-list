/**
 * Generic conflict-free merge of two copies of a record set keyed by `id`.
 *
 * This is canon § Backup & restore #5 made portable: per-record merge by
 * `updatedAt` with `deletedAt` tombstones — NEVER file-level last-write-wins
 * (which silently loses offline edits when both devices changed things while
 * disconnected). State-based LWW-element-set, conflict-free, commutative,
 * idempotent, associative — properties that let the transport be best-effort
 * ("drop a message, it re-converges on the next publish").
 *
 * Ties are resolved deterministically (delete first, then id order) so two
 * devices that stamp the same millisecond still converge — "keep local on a
 * tie" would leave each device keeping its own copy forever.
 *
 * The optional `combine` hook lets an app fold field-level state from the
 * losing record into the winner (e.g. a field that carries its own clock, like
 * a grocery item's `checked`). It runs for every id present on both sides —
 * including tombstoned copies, so a field clock can ride through a dead record
 * instead of evaporating with it. The hook MUST preserve the winner's
 * liveness (`deletedAt`) and MUST be a pure function of the two records (no
 * wall time, no local state) — that's what keeps the merge commutative and
 * convergent.
 *
 * Apps wrap this in a data-specific `merge<Thing>(local, remote)` that also
 * handles their list-level fields (name, ordering, etc.).
 */

/** The minimum record shape this merge requires. */
export interface Record {
  id: string;
  updatedAt: number;
  /** Soft-delete tombstone (ms). Set instead of removing so a delete
   *  survives a cross-device merge. */
  deletedAt?: number;
}

/** Effective clock for one record: a tombstoned record's clock is
 *  `max(updatedAt, deletedAt)`, so a delete always out-clocks the edit that
 *  preceded it. */
function clock(r: Record): number {
  return r.deletedAt != null ? Math.max(r.updatedAt, r.deletedAt) : r.updatedAt;
}

/** Key-sorted JSON — a stable serialization, so the last-resort tie-break
 *  compares CONTENT identically on every device regardless of object key
 *  insertion order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as object)
    .filter((k) => (v as Record2)[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record2)[k])}`)
    .join(',')}}`;
}
type Record2 = { [k: string]: unknown };

/** Pick the surviving record of two copies with the same id. Total order:
 *  higher clock → tombstone (a delete is the safe branch) → greater stable
 *  serialization (arbitrary but identical on every device — two phones that
 *  stamp the same millisecond must still agree on one copy). */
function winner<T extends Record>(a: T, b: T): T {
  const ca = clock(a);
  const cb = clock(b);
  if (ca !== cb) return ca > cb ? a : b;
  const aDead = a.deletedAt != null;
  const bDead = b.deletedAt != null;
  if (aDead !== bDead) return aDead ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

/** Merge two record sets by id. Returns a new array; order is not
 *  meaningful here — the caller sorts however its UI wants. */
export function mergeRecordSet<T extends Record>(
  a: T[],
  b: T[],
  combine?: (winner: T, loser: T) => T
): T[] {
  const byId = new Map<string, T>();
  for (const r of a) byId.set(r.id, r);
  for (const r of b) {
    const cur = byId.get(r.id);
    if (!cur) {
      byId.set(r.id, r);
      continue;
    }
    const win = winner(cur, r);
    const lose = win === cur ? r : cur;
    byId.set(r.id, combine ? combine(win, lose) : win);
  }
  return Array.from(byId.values());
}
