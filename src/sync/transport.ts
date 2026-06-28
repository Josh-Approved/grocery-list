/**
 * The drop-box transport: a small swarm of free public Nostr relays.
 *
 * Relays are the courier, never the filing cabinet — we use *ephemeral*
 * events (kind 20000-range, NIP-16: relays don't store them), publish to
 * several at once, and need only one to deliver. The list itself always
 * lives on the devices; a missed message just re-converges on the next
 * publish (the merge is conflict-free). No account: a throwaway key is
 * generated per run purely to satisfy Nostr's event-signing requirement —
 * it identifies nothing and is never persisted.
 *
 * Studio cost: zero. We neither run nor pay for any relay; the payload is
 * already end-to-end encrypted (see crypto.ts) so a relay only ever sees
 * ciphertext under a random channel tag.
 *
 * Round-trip verified 2026-05-21 against real public relays via
 * `scripts/test-relay.mjs` (Bob publishes encrypted, Alice receives +
 * decrypts in <1s through nostr.mom; nos.lol also reached). Two peers, same
 * crypto + signing the app uses, on the same relay list. In-app integration
 * — engine wiring on local changes, share-link/QR flow between two installed
 * instances — is the remaining verification (canon § Backup & restore Layer
 * 2: documented, committed deferral pre-public-release).
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import nacl from 'tweetnacl';

/** Free public relays. Updatable: the swarm is redundant by design, so a
 *  dead one just means fewer couriers, never a broken app. */
export const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
];

const KIND = 20001; // ephemeral (NIP-16) — relays relay it, don't store it

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class DropBoxTransport {
  private sockets: WebSocket[] = [];
  private openSockets = new Set<WebSocket>();
  private seen = new Set<string>();
  private mine = new Set<string>();
  private closed = false;
  private priv: Uint8Array;
  private pub: string;
  private subId: string;

  /**
   * @param onMessage  delivers each peer ciphertext (already deduped).
   * @param onConnect  fires when the transport goes from fully-offline to
   *   having at least one live relay (initial connect AND every reconnect after
   *   a full drop). The engine uses this to announce itself ("hello") so a peer
   *   re-publishes current state — relays are ephemeral and don't backfill, so
   *   without this a just-opened / just-reconnected device sees nothing until
   *   the other side happens to make an edit.
   */
  constructor(
    private channel: string,
    private onMessage: (ciphertext: string) => void,
    private onConnect?: () => void
  ) {
    this.priv = sha256(nacl.randomBytes(32));
    this.pub = bytesToHex(schnorr.getPublicKey(this.priv));
    this.subId = 's' + Math.random().toString(36).slice(2, 10);
  }

  start(): void {
    for (const url of RELAYS) this.connect(url);
  }

  private connect(url: string): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.sockets.push(ws);
    ws.onopen = () => {
      const since = Math.floor(Date.now() / 1000) - 120;
      ws.send(
        JSON.stringify([
          'REQ',
          this.subId,
          { kinds: [KIND], '#t': [this.channel], since },
        ])
      );
      const wasOffline = this.openSockets.size === 0;
      this.openSockets.add(ws);
      if (wasOffline && !this.closed) this.onConnect?.();
    };
    ws.onmessage = (e) => this.onWire(String(e.data));
    ws.onclose = () => {
      this.openSockets.delete(ws);
      this.sockets = this.sockets.filter((s) => s !== ws);
      if (!this.closed) setTimeout(() => this.connect(url), 4000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }

  private onWire(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT') return;
    const ev = msg[2] as NostrEvent | undefined;
    if (!ev || ev.kind !== KIND || this.seen.has(ev.id) || this.mine.has(ev.id))
      return;
    const tagged = ev.tags?.some((t) => t[0] === 't' && t[1] === this.channel);
    if (!tagged) return;
    this.seen.add(ev.id);
    if (this.seen.size > 500) this.seen = new Set();
    this.onMessage(ev.content);
  }

  publish(ciphertext: string): void {
    if (this.closed) return;
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [['t', this.channel]];
    const serial = JSON.stringify([
      0,
      this.pub,
      created_at,
      KIND,
      tags,
      ciphertext,
    ]);
    const idBytes = sha256(utf8ToBytes(serial));
    const id = bytesToHex(idBytes);
    const sig = bytesToHex(schnorr.sign(idBytes, this.priv));
    this.mine.add(id);
    if (this.mine.size > 200) this.mine = new Set([id]);
    const ev: NostrEvent = {
      id,
      pubkey: this.pub,
      created_at,
      kind: KIND,
      tags,
      content: ciphertext,
      sig,
    };
    const frame = JSON.stringify(['EVENT', ev]);
    for (const ws of this.sockets) {
      if (ws.readyState === 1) {
        try {
          ws.send(frame);
        } catch {
          /* dropped — another relay or the next publish will carry it */
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets = [];
    this.openSockets.clear();
  }
}
