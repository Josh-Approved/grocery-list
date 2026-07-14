# Architecture

A map of the codebase for someone about to change it. For what the app *is* and
how to install it, see the [README](README.md). This is the engineering view:
where things live, how state flows, and the handful of invariants you must not
break.

## What it is, in code terms

A local-first React Native (Expo) app. Every list lives in a SQLite database on
the phone. Two phones can pair once and then shop off one list that stays in sync
— no account, no server we run. Sync is peer-to-peer over public relays, with the
payload end-to-end encrypted, so the relays only ever carry ciphertext.

Stack: React Native + Expo, TypeScript, React Navigation, Zustand for state,
`expo-sqlite` for storage, `@noble/*` + `tweetnacl` for the sync crypto.

## Entry points

- **`App.tsx`** — the root. Hydrates the stores, gates the UI on readiness (so a
  populated database never flashes an empty state), sets up navigation (a
  `Lists | Kits` tab bar inside a stack), starts the sync engine, flushes state
  to disk when the app backgrounds, and handles a tapped share link.
- **`index.ts`** — registers the app. Its first import is the
  `react-native-get-random-values` polyfill so the crypto has a secure RNG.
- **`src/shell/AppShell.tsx`** — shared "chrome" (gesture root, safe area, error
  boundary, themed navigation container, splash). It is synced from a shared
  template; don't fork it per app.

## Directory layout

The `src/` tree is layered, and dependencies point one way only —
`data → store → sync → screens`. Keeping that arrow straight is what lets the
sync logic be unit-tested without a running app.

| dir | role |
|---|---|
| `src/data/` | Pure domain types + pure functions (`makeItem`, `visibleItems`, category logic). No React, no I/O. |
| `src/store/` | Zustand stores — the in-memory source of truth — plus `db.ts`, the SQLite persistence under them. |
| `src/sync/` | The shared-list engine: CRDT merge, the logical clock, encryption, and the relay transport. |
| `src/screens/` | One file per route. Composes stores + components. |
| `src/components/` | Reusable presentational pieces. |
| `src/lib/` | Small pure helpers (ids, links, transfer). |
| `src/theme/`, `src/i18n/` | Design tokens/fonts and translations (6 locales). |

## State & persistence

State lives in **Zustand** stores, one per domain aggregate: `useListsStore`,
`useKitsStore`, `useAccountStore`. The contract, stated in each store's
docblock and worth internalising:

- **Memory is the source of truth; disk is a fire-and-forget backup.** A user
  action calls `set(...)` synchronously (so the UI feels instant), and the
  SQLite write is kicked off without `await`. A failed write warns, it never
  crashes the UI.
- **Every write funnels through one private `mutate(id, fn)` helper** that maps
  the entity, stamps `updatedAt`, and persists. Actions don't hand-roll `set` —
  that's what keeps the timestamp and the save from being forgotten.
- **Deletes are soft.** Removing an item sets a `deletedAt` tombstone instead of
  dropping the row. This is what lets a delete converge across devices instead of
  the item reappearing on the next sync.
- **`flushPending()`** awaits all pending writes; `App.tsx` calls it when the app
  backgrounds so a check made a split-second before switching apps survives an OS
  kill.

Persistence is `src/store/db.ts` (SQLite, one row per list/kit with the items
JSON-encoded in a blob). The database sits in the app's default Documents
location, so it rides the OS's own iCloud / Android backup for free.

## The shared-sync data flow

This is the heart of the app and where a change is most likely to bite. Three
layers, bottom to top:

1. **Transport — `sync/transport.ts`.** A small swarm of free public Nostr
   relays. We publish *ephemeral* events (relays relay them, don't store them) to
   several relays at once and need only one to deliver. A per-run throwaway key
   signs events; it identifies nothing and is never saved. Studio cost: zero.
2. **Encryption — `sync/crypto.ts`.** Everything leaving the device is sealed
   with NaCl secretbox under a key derived from the list's shared secret. Relays
   see only ciphertext under a random-looking channel id derived from a
   *different* slice of the same hash — the channel reveals nothing about the key.
3. **Merge — `sync/merge.ts`, `sync/mergeKits.ts`, `sync/mergeRecordSet.ts`.** A
   conflict-free, state-based merge (an LWW-element-set with tombstones). Each
   record wins by timestamp; a delete out-clocks the edit before it. Because the
   merge is commutative, idempotent, and associative, the transport can be
   best-effort: drop a message and it re-converges on the next publish.

Tying them together, **`sync/index.ts`** (the engine) keeps one transport per
shared list, publishes the (encrypted) whole list when it changes locally, and
merges whatever arrives. Kits ride the same channels as a separate control
message. On (re)connect it sends a `hello`; any peer that hears one
re-publishes its full state, which is how a just-opened or just-joined device
converges within seconds instead of waiting for the other side to make an edit.

### The clock (why merges don't go haywire)

Comparing two phones' raw wall clocks is unsafe — a phone running a few minutes
fast would win every merge, so a *stale* edit could beat a *fresh* one and a
delete could make a live item vanish. `sync/clock.ts` is a Hybrid Logical Clock
that fixes this: it's monotonic per device, and every time we receive a peer's
data we `observe()` its timestamps so our *next* edit out-clocks them. That turns
"fastest clock wins" into "last action in causal order wins." Stamp every
merge-participating field with `clock.now()`, never `Date.now()`.

## Invariants — don't break these

- **The name has its own clock (`nameUpdatedAt`).** A list's name only changes on
  an explicit rename, never as a side effect of adding an item, and a freshly
  joined device (which has no name of its own, `nameUpdatedAt: 0`) never
  overwrites the creator's name.
- **Merge by shared secret, not by id.** Paired devices have independent local
  list ids; the shared secret is the join key. Keep the local id through a merge.
- **Sharing is permanent.** A list's secret is minted once and never rotates —
  "pair once, synced forever."
- **Stamp with the logical clock, not the wall clock.** (See above.)
- **The list contains only what the user typed.** Autocomplete draws only from
  the user's own history; there is no AI auto-add and no suggested rows.

## Gotchas

- **`store/db.ts` currently keeps its own database connection** and re-declares
  the cross-cutting `app_settings` / `sync_meta` / `tombstones` tables that the
  shared `storage/kv.ts` also owns. They point at the same file; consolidating
  onto one connection is a known cleanup.
- **The sync merge is the trust core — it has the tests; the engine wiring in
  `sync/index.ts` does not (yet).** If you touch reconnect/backfill/publish
  timing, verify on two real devices, not just with the unit tests.
- **Shell-synced files** (`src/shell/`, most of `src/i18n/` and `src/feedback/`,
  the generic `src/components/*` chrome, `storage/kv.ts`, `lib/backup.ts`) are
  overwrite-synced from a shared template — edit them upstream, not here, or a
  re-sync will clobber your change.

## Siri (iOS)

"Add milk to Grocery List" spoken to Siri adds an item without opening the app.
It's iOS-only (no shippable Android voice equivalent exists in 2026 — an
explicit, recorded scope decision). A Swift App Intent in the app target writes
to a shared App Group container; the JS side (`src/siri/`) mirrors the lists in
and drains dictated items into the store on launch. Full design, the platform
rationale, and the Android-deferral plan: [`docs/siri.md`](docs/siri.md).

## Run, test, ship

```
npm install
npm run ios        # or: npm run android, or: npx expo start
npm test           # Jest — the sync trust core lives in src/sync/__tests__
```

The trust core (the CRDT merge, the clock, and a property fuzzer that throws
random skew/offline/restart/loss at 2–3 simulated devices and asserts
convergence) is in `src/sync/__tests__`. If you change anything in `src/sync` or
`src/store`, those tests are the first gate. Type-check with `npx tsc --noEmit`.

Builds are produced with EAS (`eas build`) for both the App Store and Google
Play; both platforms ship in lockstep.
