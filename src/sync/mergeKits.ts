/**
 * App-specific merge for the kit collection.
 *
 * Kits are a global collection that rides the shared-list sync channels, so two
 * devices that share a list converge on the same kits. Unlike lists (which have
 * independent local ids joined by a shared secret), a kit propagates by id — the
 * receiving device adopts the originator's kit id — so kits merge directly by id
 * as a record set.
 *
 * Two levels of merge, both conflict-free / commutative / idempotent:
 *   - the COLLECTION merges by kit id (this file), and
 *   - within a matched kit, the ITEM set merges via the generic
 *     `mergeRecordSet` and the name merges on its own clock — exactly the shape
 *     `sync/merge.ts` uses for a single list.
 *
 * Tombstones at BOTH levels (kit.deletedAt + item.deletedAt) so a delete
 * survives a cross-device merge instead of being re-adopted — canon § Backup &
 * restore #5 (never file-level last-write-wins).
 */

import type { Kit } from '../data/kit';
import { mergeRecordSet } from './mergeRecordSet';

/** The clock the *name* merges by (legacy fall back to createdAt). */
function nameClock(k: Kit): number {
  return k.nameUpdatedAt ?? k.createdAt;
}

/** Effective clock of a kit for the exists-vs-deleted decision: a tombstoned
 *  kit's clock is max(updatedAt, deletedAt), so a delete out-clocks the edit
 *  that preceded it (mirrors mergeRecordSet's record clock). */
function kitClock(k: Kit): number {
  return k.deletedAt != null ? Math.max(k.updatedAt, k.deletedAt) : k.updatedAt;
}

/** Merge two copies of the SAME kit (same id). */
export function mergeKit(local: Kit, remote: Kit): Kit {
  const lc = kitClock(local);
  const rc = kitClock(remote);
  // Existence/tombstone resolves by effective clock; a tie lets a delete win
  // (safe — converges identically on both devices).
  let head: Kit;
  if (lc > rc) head = local;
  else if (rc > lc) head = remote;
  else head = remote.deletedAt != null ? remote : local;

  // The name resolves on its OWN clock. Tie → the lexicographically greater
  // name (mirrors sync/merge.ts mergeList), so two devices renaming the same
  // kit in the same millisecond still converge instead of each keeping its own.
  const nc = nameClock(local) - nameClock(remote);
  const nameHead =
    nc !== 0 ? (nc > 0 ? local : remote) : local.name >= remote.name ? local : remote;
  return {
    id: local.id,
    name: nameHead.name,
    nameUpdatedAt: Math.max(nameClock(local), nameClock(remote)),
    // Always merge the item sets — two live devices may have edited different
    // ingredients of the same kit while disconnected.
    items: mergeRecordSet(local.items, remote.items),
    deletedAt: head.deletedAt,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

/** Merge two kit collections by id. Returns a new array; the caller sorts for
 *  its UI. Conflict-free, commutative, idempotent. */
export function mergeKits(local: Kit[], remote: Kit[]): Kit[] {
  const byId = new Map<string, Kit>();
  for (const k of local) byId.set(k.id, k);
  for (const r of remote) {
    const cur = byId.get(r.id);
    byId.set(r.id, cur ? mergeKit(cur, r) : r);
  }
  return Array.from(byId.values());
}
