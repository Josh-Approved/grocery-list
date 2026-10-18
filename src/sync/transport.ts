/**
 * The drop-box transport: a small swarm of free public Nostr relays.
 *
 * Two kinds of traffic ride every channel:
 *
 *  • LIVE (kind 20001, ephemeral, NIP-16): relays forward it to whoever is
 *    subscribed right now and keep nothing. Used for the "hello" handshake —
 *    anything whose only meaning is "I am here now".
 *  • STORED (kind 30078, parameterized replaceable, NIP-33/NIP-78): the relay
 *    keeps the LATEST event per (author, kind, `d` tag) and replays it to any
 *    later subscriber. Used for the list state itself, so a phone that opens
 *    hours or days later still receives what its partner left — store-and-
 *    forward, no partner online needed. The `d` tag is `<channel>:<slot>`
 *    (slots: the list, the kits); the author key is derived per device from
 *    `authorSeed`, so each device owns its own slot and can never overwrite a
 *    partner's deposit with a stale copy. A stored publish also fans out live
 *    to anyone subscribed, so it replaces (not duplicates) the old ephemeral
 *    state message. Verified 2026-10-18 against the relays below: all accept
 *    kind 30078 from an unknown key, replay it to a fresh subscriber hours
 *    later, and fan it out live.
 *
 * The list itself always lives on the devices; the drop box holds only the
 * latest encrypted copy per device, and the merge is conflict-free, so a lost
 * or stale deposit just re-converges on the next publish. No account: the
 * signing key is derived from the per-list secret + a per-device salt, it
 * identifies nothing and is never shown to anyone.
 *
 * Studio cost: zero. We neither run nor pay for any relay; the payload is
 * already end-to-end encrypted (see crypto.ts) so a relay only ever sees
 * ciphertext under a random channel tag. Relay event-size ceilings measured
 * 2026-10-18: ~64 KB on the strictest of the swarm — keep a full-state
 * payload under that (tombstone pruning in the app bounds it).
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import nacl from 'tweetnacl';

/** Free public relays. Updatable: the swarm is redundant by design, so a
 *  dead one just means fewer couriers, never a broken app.
 *  EXPO_PUBLIC_SYNC_RELAYS (comma-separated ws:// URLs, baked at bundle time)
 *  overrides the list — used by the two-device E2E harness to run against a
 *  local relay hermetically. DEV-ONLY by construction: release builds ignore
 *  it, so a stray env var in the build shell can never bake a localhost
 *  relay list into a store binary. An empty/blank var falls back too. */
function envRelays(): string[] | undefined {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return undefined;
  const list = process.env.EXPO_PUBLIC_SYNC_RELAYS?.split(',')
    .map((u: string) => u.trim())
    .filter(Boolean);
  return list && list.length > 0 ? list : undefined;
}

/** Every relay here was probed 2026-10-18 for: accepts kind 30078 from an
 *  unknown key, replays it to a fresh subscriber hours later, fans it out live,
 *  and takes a 40 KB event. relay.nostr.band was dropped (refused every
 *  connection on 2026-10-18); relay.snort.social and nostr.oxtr.dev replace it. */
export const RELAYS = envRelays() ?? [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://nostr.oxtr.dev',
];

/** Ephemeral (NIP-16): relays forward it, never store it. */
export const LIVE_KIND = 20001;
/** Parameterized replaceable (NIP-33, NIP-78 app data): relays keep the
 *  latest per author + `d` tag and replay it to later subscribers. */
export const STORED_KIND = 30078;
/** How far back the stored-slot subscription looks. Bounded so a device that
 *  has been gone longer than the app's tombstone horizon cannot resurrect
 *  deleted items from a forgotten deposit: keep this ≤ the consumer's
 *  tombstone retention (grocery-list: 21 days). */
export const STORED_WINDOW_S = 21 * 24 * 3600;
/** Live window: a courier only needs to cover a reconnect blip. */
const LIVE_WINDOW_S = 120;

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
  /** Per published event id: whether any relay accepted, how many rejected,
   *  and how many sockets the event was actually SENT to — the rejection
   *  threshold must count recipients, not currently-open sockets (a relay
   *  that connected after the publish never got the event and will never
   *  OK it). */
  private ackState = new Map<string, { ok: boolean; rejects: number; sent: number }>();
  /** Last created_at we signed, per `d` tag: a replaceable slot must never
   *  see two of our events with the same second (the relay keeps the newer
   *  one, and "same second" is a coin toss), and must never go backwards if
   *  the device clock steps back. */
  private lastStamp = new Map<string, number>();
  private closed = false;
  private priv: Uint8Array;
  private pub: string;
  private subId: string;

  /**
   * @param onMessage  delivers each peer ciphertext (already deduped; never
   *   our own deposits) with the time the peer published it (ms) — for a
   *   replayed slot that is hours or days ago, which is exactly what the UI's
   *   "last heard from the other phone" should say.
   * @param onConnect  fires when the transport goes from fully-offline to
   *   having at least one live relay (initial connect AND every reconnect after
   *   a full drop). The engine uses this to re-deposit its state and announce
   *   itself ("hello") so a peer that is online right now re-publishes too.
   * @param onStatus  fires with the live relay count whenever it changes — the
   *   engine surfaces this as a connected/offline indicator in the UI. It means
   *   "drop boxes reachable", never "partner present".
   * @param onPublishResult  fires once per published event: `true` when the
   *   first relay accepts it, `false` when every open relay rejected it — so
   *   the engine can tell "sent" apart from "actually delivered".
   * @param authorSeed  32 bytes that make this device's signing key stable
   *   across runs (so its stored slot is replaced, not accumulated). Omitted →
   *   a throwaway key per run: fine for live-only use, wrong for deposits.
   */
  constructor(
    private channel: string,
    private onMessage: (ciphertext: string, at: number) => void,
    private onConnect?: () => void,
    private onStatus?: (openRelays: number) => void,
    private onPublishResult?: (delivered: boolean, reason: string) => void,
    authorSeed?: Uint8Array
  ) {
    this.priv = sha256(authorSeed ?? nacl.randomBytes(32));
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
      const now = Math.floor(Date.now() / 1000);
      ws.send(
        JSON.stringify([
          'REQ',
          this.subId,
          { kinds: [LIVE_KIND], '#t': [this.channel], since: now - LIVE_WINDOW_S },
          {
            kinds: [STORED_KIND],
            '#t': [this.channel],
            since: now - STORED_WINDOW_S,
            limit: 16,
          },
        ])
      );
      const wasOffline = this.openSockets.size === 0;
      this.openSockets.add(ws);
      this.onStatus?.(this.openSockets.size);
      if (wasOffline && !this.closed) this.onConnect?.();
    };
    ws.onmessage = (e) => this.onWire(String(e.data));
    ws.onclose = () => {
      const had = this.openSockets.delete(ws);
      if (had) this.onStatus?.(this.openSockets.size);
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
    if (!Array.isArray(msg)) return;
    // NIP-20 command result for one of our publishes. One acceptance anywhere
    // means the swarm carried it; a rejection from EVERY open relay means the
    // publish silently failed (rate limit, max event size, …) — ignoring that
    // made oversized publishes vanish while the UI claimed "Connected".
    if (msg[0] === 'OK' && typeof msg[1] === 'string' && this.mine.has(msg[1])) {
      const id = msg[1];
      const st = this.ackState.get(id) ?? { ok: false, rejects: 0, sent: 1 };
      if (msg[2] === true) {
        if (!st.ok) this.onPublishResult?.(true, '');
        st.ok = true;
      } else {
        st.rejects += 1;
        if (!st.ok && st.rejects >= Math.max(1, st.sent)) {
          const reason = String(msg[3] ?? '');
          console.warn(`shared-sync: all relays rejected publish: ${reason}`);
          this.onPublishResult?.(false, reason);
        }
      }
      this.ackState.set(id, st);
      return;
    }
    if (msg[0] !== 'EVENT') return;
    const ev = msg[2] as NostrEvent | undefined;
    if (!ev || (ev.kind !== LIVE_KIND && ev.kind !== STORED_KIND)) return;
    // Our own stored slot comes back on every cold start (the relay replays
    // it, and a fresh run has forgotten the event id). It is ours by author,
    // so it is never "something the partner said".
    if (ev.pubkey === this.pub) return;
    if (this.seen.has(ev.id) || this.mine.has(ev.id)) return;
    const tagged = ev.tags?.some((t) => t[0] === 't' && t[1] === this.channel);
    if (!tagged) return;
    this.seen.add(ev.id);
    if (this.seen.size > 500) this.seen = new Set();
    const at = typeof ev.created_at === 'number' ? ev.created_at * 1000 : Date.now();
    this.onMessage(ev.content, at);
  }

  /** Live-only: forwarded to peers listening right now, kept nowhere. For
   *  control messages whose meaning is "I am here now" (hello). */
  publish(ciphertext: string): void {
    this.send(LIVE_KIND, [['t', this.channel]], ciphertext, 'live');
  }

  /** Deposit: the relay keeps the latest copy of this device's `slot` and
   *  replays it to anyone who subscribes later — AND fans it out live to peers
   *  listening now. For state (the list, the kits). */
  publishStored(ciphertext: string, slot: string): void {
    const d = `${this.channel}:${slot}`;
    this.send(STORED_KIND, [['d', d], ['t', this.channel]], ciphertext, d);
  }

  private send(kind: number, tags: string[][], ciphertext: string, stampKey: string): void {
    if (this.closed) return;
    const created_at = Math.max(
      Math.floor(Date.now() / 1000),
      (this.lastStamp.get(stampKey) ?? 0) + 1
    );
    this.lastStamp.set(stampKey, created_at);
    const serial = JSON.stringify([0, this.pub, created_at, kind, tags, ciphertext]);
    const idBytes = sha256(utf8ToBytes(serial));
    const id = bytesToHex(idBytes);
    const sig = bytesToHex(schnorr.sign(idBytes, this.priv));
    this.mine.add(id);
    if (this.mine.size > 200) {
      this.mine = new Set([id]);
      this.ackState.clear();
    }
    const ev: NostrEvent = {
      id,
      pubkey: this.pub,
      created_at,
      kind,
      tags,
      content: ciphertext,
      sig,
    };
    const frame = JSON.stringify(['EVENT', ev]);
    let sent = 0;
    for (const ws of this.sockets) {
      if (ws.readyState === 1) {
        try {
          ws.send(frame);
          sent += 1;
        } catch {
          /* dropped — another relay or the next publish will carry it */
        }
      }
    }
    this.ackState.set(id, { ok: false, rejects: 0, sent: Math.max(1, sent) });
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
    this.onStatus?.(0);
  }
}
