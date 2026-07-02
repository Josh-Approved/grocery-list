/**
 * Collision-proof id generator. Canonical, app-agnostic — synced by
 * `sync.mjs app-shell`; do not fork.
 *
 * `${prefix}${Date.now()}` collides when two entities are created in the same
 * millisecond (rapid adds, duplicate-then-create). Collisions corrupt React
 * list keys and — once cross-device sync lands — would let two devices mint
 * the same id. Combines a base-36 timestamp, a per-session monotonic counter,
 * and a short random suffix.
 */

let counter = 0;

export function makeId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const ts = Date.now().toString(36);
  const ctr = counter.toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${ts}-${ctr}-${rand}`;
}
