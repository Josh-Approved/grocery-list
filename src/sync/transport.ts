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
 * NOT DEVICE-VERIFIED: structurally complete and type-clean, but the live
 * round-trip through real relays has not been exercised on a device. This is
 * the documented, committed Layer-2 deferral (canon § Backup & restore);
 * device-verify is gated before public release in the app CLAUDE.md.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
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
  private seen = new Set<string>();
  private mine = new Set<string>();
  private closed = false;
  private priv: Uint8Array;
  private pub: string;
  private subId: string;

  constructor(
    private channel: string,
    private onMessage: (ciphertext: string) => void
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
    };
    ws.onmessage = (e) => this.onWire(String(e.data));
    ws.onclose = () => {
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
    const id = bytesToHex(sha256(utf8ToBytes(serial)));
    const sig = bytesToHex(schnorr.sign(id, this.priv));
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
  }
}
