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
 * NOT DEVICE-VERIFIED end-to-end (see transport.ts / crypto.ts headers).
 */

import { useListsStore } from '../store/lists';
import type { GroceryList } from '../data/list';
import { channelId, seal, open } from './crypto';
import { DropBoxTransport } from './transport';

interface Channel {
  transport: DropBoxTransport;
  lastSent: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const channels = new Map<string, Channel>();
let unsub: (() => void) | null = null;

function sharedSecret(l: GroceryList): string | undefined {
  return l.shareIdentity?.secret;
}

function ensureChannel(secret: string): Channel {
  let ch = channels.get(secret);
  if (ch) return ch;
  const transport = new DropBoxTransport(channelId(secret), (ct) => {
    const json = open(secret, ct);
    if (!json) return;
    try {
      const remote = JSON.parse(json) as GroceryList;
      if (remote?.shareIdentity?.secret === secret) {
        useListsStore.getState().mergeRemoteList(remote);
      }
    } catch {
      /* malformed payload — ignore, next publish re-converges */
    }
  });
  ch = { transport, lastSent: '', timer: null };
  channels.set(secret, ch);
  transport.start();
  return ch;
}

function publish(secret: string, list: GroceryList): void {
  const ch = ensureChannel(secret);
  const payload = JSON.stringify(list);
  if (payload === ch.lastSent) return; // nothing changed since last send
  if (ch.timer) clearTimeout(ch.timer);
  ch.timer = setTimeout(() => {
    ch.lastSent = payload;
    ch.transport.publish(seal(secret, payload));
  }, 700);
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
    }
  }
}

/** Start once after the store has hydrated (App.tsx). Idempotent. */
export function startSyncEngine(): void {
  if (unsub) return;
  reconcile(useListsStore.getState().lists);
  unsub = useListsStore.subscribe((state) => reconcile(state.lists));
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
