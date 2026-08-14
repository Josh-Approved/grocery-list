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
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent mutant, index-keyed array serialization decorates both compared serializations identically ('["…' → '{"0":"…'), and a mutated join separator can only diverge against `]`/`}` (which sort above `,` and `"` alike) or against the same separator mutated identically on the other side — the `sa >= sb` outcome never flips
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as object)
    .filter((k) => (v as Record2)[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record2)[k])}`)
    .join(
      // Stryker disable next-line StringLiteral: equivalent mutant, a join separator can only become the diverging character against `]`/`}` (both sort above `,` and `"` alike) or against the same separator mutated the same way in the other serialization, so the `sa >= sb` outcome never flips
      ','
    )}}`;
}
type Record2 = { [k: string]: unknown };

/** Flat value-equality over own enumerable keys (undefined-valued keys are
 *  ignored, matching what the JSON wire drops). The fast path for ties: in a
 *  converged set EVERY shared id ties on clock with identical content, so
 *  the expensive stable serialization must not run per item per message. Any
 *  nested value (arrays/objects) fails === and falls through to the full
 *  serialization — correctness is never traded, only work. */
// Stryker disable next-line BlockStatement: equivalent mutant, an emptied body returns undefined, which only disables the fast path — the slow path computes the same winner
function shallowEqual(a: object, b: object): boolean {
  const ra = a as { [k: string]: unknown };
  const rb = b as { [k: string]: unknown };
  // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent mutant, these variants only make shallowEqual return false more often, which costs the fast path but never the verdict — the slow path returns the same winner
  for (const k in ra) if (ra[k] !== rb[k] && ra[k] !== undefined) return false;
  // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,BooleanLiteral: equivalent mutant, loop 1 already rejects every key `a` carries that `b` does not match, so the only case a wrong verdict here can reach is `a`'s defined keys being a strict SUBSET of `b`'s — and for every strict subset the slow path picks `a` too (both the lean-tombstone and the `sa >= sb` branch)
  for (const k in rb) if (rb[k] !== ra[k] && rb[k] !== undefined) return false;
  // Stryker disable next-line BooleanLiteral: equivalent mutant, a spurious `false` only costs the fast path — the slow path returns the same winner
  return true;
}

/** Pick the surviving record of two copies with the same id. Total order:
 *  higher clock → tombstone (a delete is the safe branch) → between two
 *  tombstones the LEANER serialization (so a payload-stripped tombstone
 *  propagates and the size bound actually holds swarm-wide) → greater stable
 *  serialization (arbitrary but identical on every device — two phones that
 *  stamp the same millisecond must still agree on one copy). */
function winner<T extends Record>(a: T, b: T): T {
  const ca = clock(a);
  const cb = clock(b);
  // Stryker disable next-line EqualityOperator: equivalent mutant, guard-shadowed — inside the `ca !== cb` test, so `>` and `>=` are identical
  if (ca !== cb) return ca > cb ? a : b;
  const aDead = a.deletedAt != null;
  const bDead = b.deletedAt != null;
  if (aDead !== bDead) return aDead ? a : b;
  // Stryker disable next-line ConditionalExpression: equivalent mutant, shallowEqual only gates a fast path — when the copies are genuinely equal the slow path computes equal stable serializations and `sa >= sb` returns the same first argument
  if (shallowEqual(a, b)) return a;
  const sa = stableStringify(a);
  const sb = stableStringify(b);
  // Stryker disable next-line EqualityOperator: equivalent mutant, guard-shadowed — `sa.length < sb.length` sits inside the `sa.length !== sb.length` test, so `<` and `<=` decide identically
  if (aDead) return sa.length !== sb.length ? (sa.length < sb.length ? a : b) : sa >= sb ? a : b;
  return sa >= sb ? a : b;
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
