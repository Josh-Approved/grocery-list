#!/usr/bin/env node
/**
 * Hermetic local Nostr relay for the two-device sync E2E.
 *
 * Implements the NIP-01 subset the app's DropBoxTransport speaks: EVENT
 * publish → NIP-20 ["OK"] reply → broadcast to every OTHER subscriber whose
 * REQ filter (kinds + #t tag) matches. Ephemeral like the public relays the
 * app uses: nothing is stored, so the cold-start "hello" backfill path is
 * exercised exactly as in production.
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

import ws from 'ws';
// Older `ws` majors (the one RN's dep tree pins) export Server, not
// WebSocketServer.
const WebSocketServer = ws.WebSocketServer ?? ws.Server;

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const PORT = flag('port', 7447);
const MAX_BYTES = flag('max-bytes', 0); // 0 = unlimited

const wss = new WebSocketServer({ port: PORT });
/** ws -> Map<subId, filter> */
const subs = new Map();
let eventCount = 0;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function matches(filter, ev) {
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  const tags = filter['#t'];
  if (tags) {
    const evTags = (ev.tags ?? []).filter((t) => t[0] === 't').map((t) => t[1]);
    if (!tags.some((t) => evTags.includes(t))) return false;
  }
  if (filter.since && ev.created_at < filter.since) return false;
  return true;
}

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
      const [, subId, filter] = msg;
      subs.get(ws)?.set(subId, filter ?? {});
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
      eventCount += 1;
      log(`event #${eventCount} ${ev.id.slice(0, 8)} kind=${ev.kind} ${size}B`);
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      // Ephemeral broadcast to every other matching subscriber.
      for (const [client, clientSubs] of subs) {
        if (client === ws || client.readyState !== 1) continue;
        for (const [subId, filter] of clientSubs) {
          if (matches(filter, ev)) {
            client.send(JSON.stringify(['EVENT', subId, ev]));
            break;
          }
        }
      }
    }
  });
});

log(`mini-relay listening on ws://0.0.0.0:${PORT}` + (MAX_BYTES ? ` (max event ${MAX_BYTES}B)` : ''));
