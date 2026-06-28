/**
 * Sync engine — wires the store to the drop-box transport.
 *
 * For every list that has a share identity it keeps one transport open,
 * publishes the (encrypted) whole list when it changes locally, and merges
 * anything that arrives. The merge is conflict-free, so this can be
 * best-effort: a missed message re-converges on the next publish.
 *
 * Durable by construction: the channel is derived from the persistent
 * per-list secret, so a paired list reconnects forever with nothing from the
 * user ("pair once, synced forever"). Devices have different local list ids;
 * the shared secret — not the id — is the join key.
 *
 * COLD-START BACKFILL. Relays are ephemeral couriers — they don't store, so a
 * device that just opened (or just reconnected, or just joined a link) hears
 * nothing until the OTHER side happens to edit. That made shared lists look
 * empty/stale until someone touched them. Fixed with a tiny "hello" handshake:
 * on each (re)connect a device announces itself; any peer that hears a hello
 * force-republishes its current full state, so the newcomer converges within
 * seconds instead of waiting for an edit. Hello carries no list data; old app
 * versions simply ignore it (no `shareIdentity`), so it is wire-compatible.
 *
 * Merge correctness across skewed device clocks is handled by the logical
 * clock (see ./clock.ts); `mergeRemoteList` folds the peer's timestamps in
 * before merging.
 *
 * NOT DEVICE-VERIFIED end-to-end (see transport.ts / crypto.ts headers).
 */

import { useListsStore } from '../store/lists';
import type { GroceryList } from '../data/list';
import { channelId, seal, open } from './crypto';
import { DropBoxTransport } from './transport';
import { markConnected, markReceived, markSent, dropStatus } from './status';

/** A control message asking peers to re-publish their current state. Encrypted
 *  like everything else; distinguished from a state message by `_sync` (a state
 *  message is a bare GroceryList, which has `shareIdentity` and no `_sync`). */
const HELLO = JSON.stringify({ _sync: 'hello' });
/** Don't re-announce more than this often per channel (relays may report
 *  several sockets opening near-simultaneously). */
const HELLO_DEBOUNCE_MS = 3000;

interface Channel {
  transport: DropBoxTransport;
  lastSent: string;
  timer: ReturnType<typeof setTimeout> | null;
  lastHelloAt: number;
}

const channels = new Map<string, Channel>();
let unsub: (() => void) | null = null;

function sharedSecret(l: GroceryList): string | undefined {
  return l.shareIdentity?.secret;
}

function ensureChannel(secret: string): Channel {
  let ch = channels.get(secret);
  if (ch) return ch;
  const transport = new DropBoxTransport(
    channelId(secret),
    (ct) => receive(secret, ct),
    () => onReconnect(secret),
    (openRelays) => markConnected(secret, openRelays > 0)
  );
  ch = { transport, lastSent: '', timer: null, lastHelloAt: 0 };
  channels.set(secret, ch);
  transport.start();
  return ch;
}

/** Handle one decrypted peer message: a hello (→ re-publish our state) or a
 *  state copy (→ merge it). */
function receive(secret: string, ct: string): void {
  const json = open(secret, ct);
  if (!json) return;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return; // malformed — next publish re-converges
  }
  if (obj && typeof obj === 'object' && (obj as { _sync?: string })._sync === 'hello') {
    forcePublish(secret);
    return;
  }
  const remote = obj as GroceryList;
  if (remote?.shareIdentity?.secret === secret) {
    // mergeRemoteList folds the remote clock in before merging (see clock.ts).
    useListsStore.getState().mergeRemoteList(remote);
    markReceived(secret, Date.now());
  }
}

/** On (re)connect, both PUSH our current state (so a peer that is already
 *  online converges to our latest — e.g. the checks we just made) and PULL via
 *  hello (so peers push us theirs). Both directions are needed: hello alone
 *  only fetches, so a device that reconnects while its partner is already
 *  online would never re-share its own state. */
function onReconnect(secret: string): void {
  forcePublish(secret);
  sendHello(secret);
}

/** Announce ourselves so a peer re-publishes its current state. Debounced. */
function sendHello(secret: string): void {
  const ch = channels.get(secret);
  if (!ch) return;
  const t = Date.now();
  if (t - ch.lastHelloAt < HELLO_DEBOUNCE_MS) return;
  ch.lastHelloAt = t;
  ch.transport.publish(seal(secret, HELLO));
}

/** Publish our current full state immediately, bypassing the change-dedupe —
 *  used to answer a peer's hello (its copy may be empty/stale even though ours
 *  hasn't changed since we last sent). */
function forcePublish(secret: string): void {
  const ch = channels.get(secret);
  if (!ch) return;
  const list = useListsStore
    .getState()
    .lists.find((l) => sharedSecret(l) === secret);
  if (!list) return;
  const payload = JSON.stringify(list);
  ch.lastSent = payload;
  ch.transport.publish(seal(secret, payload));
  markSent(secret, Date.now());
}

function publish(secret: string, list: GroceryList): void {
  const ch = ensureChannel(secret);
  const payload = JSON.stringify(list);
  if (payload === ch.lastSent) return; // nothing changed since last send
  if (ch.timer) clearTimeout(ch.timer);
  ch.timer = setTimeout(() => {
    ch.lastSent = payload;
    ch.transport.publish(seal(secret, payload));
    markSent(secret, Date.now());
  }, 700);
}

/** Force an immediate full exchange for one shared list (the UI's manual
 *  "resync" affordance): push our state and ask peers for theirs. */
export function resyncNow(secret: string): void {
  onReconnect(secret);
}

function reconcile(lists: GroceryList[]): void {
  const live = new Set<string>();
  for (const l of lists) {
    const secret = sharedSecret(l);
    if (!secret) continue;
    live.add(secret);
    publish(secret, l);
  }
  // Close channels for lists that are gone / no longer shared.
  for (const [secret, ch] of channels) {
    if (!live.has(secret)) {
      if (ch.timer) clearTimeout(ch.timer);
      ch.transport.close();
      channels.delete(secret);
      dropStatus(secret);
    }
  }
}

/** Start once after the store has hydrated (App.tsx). Idempotent. */
export function startSyncEngine(): void {
  if (unsub) return;
  reconcile(useListsStore.getState().lists);
  unsub = useListsStore.subscribe((state) => reconcile(state.lists));
}

/** Push current state immediately on every channel, skipping the debounce.
 *  Call when the app is about to background: the 700ms publish debounce would
 *  otherwise be suspended mid-wait, so a check made right before switching apps
 *  never leaves the device. Best-effort — sockets may be closing. */
export function flushSyncEngine(): void {
  for (const secret of channels.keys()) {
    const ch = channels.get(secret);
    if (ch?.timer) {
      clearTimeout(ch.timer);
      ch.timer = null;
    }
    forcePublish(secret);
  }
}

export function stopSyncEngine(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
  for (const ch of channels.values()) {
    if (ch.timer) clearTimeout(ch.timer);
    ch.transport.close();
  }
  channels.clear();
}
