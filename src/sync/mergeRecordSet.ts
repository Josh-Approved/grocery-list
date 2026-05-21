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

/** Merge two record sets by id. Returns a new array; order is not
 *  meaningful here — the caller sorts however its UI wants. */
export function mergeRecordSet<T extends Record>(a: T[], b: T[]): T[] {
  const byId = new Map<string, T>();
  for (const r of a) byId.set(r.id, r);
  for (const r of b) {
    const cur = byId.get(r.id);
    if (!cur) {
      byId.set(r.id, r);
      continue;
    }
    const rc = clock(r);
    const cc = clock(cur);
    if (rc > cc) byId.set(r.id, r);
    else if (rc === cc) {
      // Tie: a delete wins over a live edit (safe, converges identically
      // on both devices); otherwise keep the existing (deterministic).
      if (r.deletedAt != null && cur.deletedAt == null) byId.set(r.id, r);
    }
  }
  return Array.from(byId.values());
}
