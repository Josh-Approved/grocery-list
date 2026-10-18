#!/usr/bin/env node
/**
 * Hermetic local Nostr relay for the two-device sync E2E.
 *
 * Implements the NIP-01 subset the app's DropBoxTransport speaks: EVENT
 * publish → NIP-20 ["OK"] reply → broadcast to every OTHER subscriber whose
 * REQ filters (kinds + #t tag + since; several filters per REQ) match. Like
 * the public relays the app uses it keeps NOTHING for ephemeral kinds
 * (20000–29999: the "hello"), and keeps exactly the LATEST event per
 * (pubkey, kind, `d` tag) for parameterized-replaceable kinds (30000–39999:
 * the deposited list state), replaying those to a later REQ before EOSE. An
 * older event for an occupied slot is refused with OK=false, as real relays
 * do. So both production paths — the live hello backfill and the
 * store-and-forward "partner was closed" path — run exactly as in production.
 *
 * --max-bytes <n> makes it reject oversized events with OK=false, mirroring
 * public relays' event-size limits — used to verify the app SURFACES a
 * rejected publish instead of failing silently (the pre-fix behaviour).
 *
 * Local relay ONLY — never point tests at a public relay. Usage:
 *   node scripts/e2e/mini-relay.mjs [--port 7447] [--max-bytes N]
 * Logs one line per event so a test run is auditable.
 *
 * Factory template (templates/e2e-two-device/) — app-agnostic; synced verbatim
 * into each shared-sync consumer's scripts/e2e/. Do not fork per app.
 */

import * as ws from 'ws';
// Resolve the server class across every shape `ws` has shipped: modern majors
// expose a NAMED `WebSocketServer` on the module namespace, older ones hang
// `Server` off the default (CJS `module.exports`) object. A default-only lookup
// throws "WebSocketServer is not a constructor" on ws >= 8.19, whose default
// export is the WebSocket CLIENT class with no server statics attached — which
// meant this relay could not start at all, and with it the whole two-device
// suite (found 2026-08-25 on packing-list's first real execution).
const WebSocketServer =
  ws.WebSocketServer ?? ws.Server ?? ws.default?.WebSocketServer ?? ws.default?.Server;
if (typeof WebSocketServer !== 'function') {
  throw new Error(`mini-relay: no WebSocketServer export found in 'ws' (keys: ${Object.keys(ws)})`);
}

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const PORT = flag('port', 7447);
const MAX_BYTES = flag('max-bytes', 0); // 0 = unlimited

const wss = new WebSocketServer({ port: PORT });
/** ws -> Map<subId, filter[]> */
const subs = new Map();
/** `${pubkey}:${kind}:${d}` -> latest replaceable event (NIP-33 slots). */
const slots = new Map();
let eventCount = 0;

const isEphemeral = (kind) => kind >= 20000 && kind < 30000;
const isReplaceable = (kind) => kind >= 30000 && kind < 40000;
const dTag = (ev) => (ev.tags ?? []).find((t) => t[0] === 'd')?.[1] ?? '';

const log = (...a) => console.log(new Date().toISOString(), ...a);

function matches(filter, ev) {
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue;
    const letter = key.slice(1);
    const evTags = (ev.tags ?? []).filter((t) => t[0] === letter).map((t) => t[1]);
    if (!filter[key].some((t) => evTags.includes(t))) return false;
  }
  if (filter.since && ev.created_at < filter.since) return false;
  if (filter.until && ev.created_at > filter.until) return false;
  return true;
}
const matchesAny = (filters, ev) => filters.some((f) => matches(f, ev));

wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  log('conn open', `(${wss.clients.size} clients)`);
  ws.on('close', () => subs.delete(ws));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    if (msg[0] === 'REQ') {
      const [, subId, ...filters] = msg;
      const fs = filters.length ? filters : [{}];
      subs.get(ws)?.set(subId, fs);
      // Replay the stored slots this subscription can see (newest first), then
      // EOSE — the store-and-forward path a phone takes when it opens alone.
      const stored = [...slots.values()]
        .filter((ev) => matchesAny(fs, ev))
        .sort((a, b) => b.created_at - a.created_at);
      const limit = Math.min(...fs.map((f) => f.limit ?? Infinity));
      for (const ev of stored.slice(0, limit)) ws.send(JSON.stringify(['EVENT', subId, ev]));
      if (stored.length) log(`replayed ${Math.min(stored.length, limit)} stored event(s) to ${subId}`);
      ws.send(JSON.stringify(['EOSE', subId]));
      return;
    }
    if (msg[0] === 'CLOSE') {
      subs.get(ws)?.delete(msg[1]);
      return;
    }
    if (msg[0] === 'EVENT') {
      const ev = msg[1];
      if (!ev?.id) return;
      const size = String(data).length;
      if (MAX_BYTES > 0 && size > MAX_BYTES) {
        log(`REJECT event ${ev.id.slice(0, 8)} (${size}B > ${MAX_BYTES}B)`);
        ws.send(JSON.stringify(['OK', ev.id, false, `invalid: event too large (${size} bytes)`]));
        return;
      }
      if (isReplaceable(ev.kind)) {
        const key = `${ev.pubkey}:${ev.kind}:${dTag(ev)}`;
        const have = slots.get(key);
        if (have && have.created_at > ev.created_at) {
          log(`REFUSE older event ${ev.id.slice(0, 8)} for slot ${key.slice(0, 8)}…`);
          ws.send(JSON.stringify(['OK', ev.id, false, 'replaced: have newer event']));
          return;
        }
        slots.set(key, ev);
      }
      eventCount += 1;
      log(
        `event #${eventCount} ${ev.id.slice(0, 8)} kind=${ev.kind} ${size}B` +
          (isReplaceable(ev.kind) ? ' (stored)' : isEphemeral(ev.kind) ? ' (ephemeral)' : '')
      );
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      // Live broadcast to every other matching subscriber.
      for (const [client, clientSubs] of subs) {
        if (client === ws || client.readyState !== 1) continue;
        for (const [subId, filters] of clientSubs) {
          if (matchesAny(filters, ev)) {
            client.send(JSON.stringify(['EVENT', subId, ev]));
            break;
          }
        }
      }
    }
  });
});

log(`mini-relay listening on ws://0.0.0.0:${PORT}` + (MAX_BYTES ? ` (max event ${MAX_BYTES}B)` : ''));
