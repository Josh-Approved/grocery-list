#!/usr/bin/env node
/**
 * Network-chaos front-end for the two-device sync E2E.
 *
 * Runs toxiproxy in front of the hermetic mini-relay so the phones connect to
 * a controllable pipe, then drives a NAMED, SEEDED scenario from
 * chaos-scenarios.mjs (partition-mid-sync, slow-drip, lossy,
 * disconnect-on-write, flap). Local relays ONLY — never a public relay.
 *
 * Topology:
 *     phones ──ws──▶ toxiproxy proxy "sync-relay" (CHAOS_PORT)
 *                        │  (latency / reset_peer / disable = the fault)
 *                        ▼
 *                    mini-relay (RELAY_PORT, internal)
 *
 * Two modes:
 *   run   node chaos-relay.mjs --scenario <name> [--port CHAOS_PORT]
 *         Boots toxiproxy + mini-relay, exposes CHAOS_PORT for the devices,
 *         executes the scenario's fault schedule, exits 0. The Maestro flows
 *         (run-two-device.sh) drive the phones and own the intent + honesty
 *         oracles; this process owns the network faults.
 *
 *   --self-test
 *         HERMETIC PROOF, no phones: boots toxiproxy + mini-relay + two
 *         in-process WS clients that speak the relay's NIP-01 subset with a
 *         durability outbox (the transport behaviour under test), runs EVERY
 *         scenario, and asserts the transport oracle — the fault really
 *         perturbs delivery (stalls during the gap) AND clears to convergence
 *         after. This is the "harness demonstrably catches a known-bad" gate
 *         for the network layer; it needs the toxiproxy binary but no device.
 *
 * Requires: `toxiproxy-server` on PATH (brew install toxiproxy).
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import ws from 'ws';
import {
  SCENARIOS,
  getScenario,
  validateCatalog,
} from './chaos-scenarios.mjs';

const WebSocketServer = ws.WebSocketServer ?? ws.Server;
const WebSocket = ws.WebSocket ?? ws;

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const TOXIPROXY_API = argVal('api', 'http://127.0.0.1:8474');
const CHAOS_PORT = Number(argVal('port', 7448)); // what the phones connect to
const RELAY_PORT = Number(argVal('relay-port', 7449)); // internal mini-relay
const PROXY_NAME = 'sync-relay';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- toxiproxy REST client ----------
async function tp(method, path, body) {
  const res = await fetch(`${TOXIPROXY_API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    const txt = await res.text().catch(() => '');
    throw new Error(`toxiproxy ${method} ${path} → ${res.status} ${txt}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function waitForApi(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await tp('GET', '/version');
      return true;
    } catch {
      await sleep(150);
    }
  }
  throw new Error('toxiproxy-server API never came up on ' + TOXIPROXY_API);
}

async function resetProxy() {
  // Recreate the proxy fresh (idempotent): delete then create.
  await tp('DELETE', `/proxies/${PROXY_NAME}`).catch(() => {});
  await tp('POST', '/proxies', {
    name: PROXY_NAME,
    listen: `0.0.0.0:${CHAOS_PORT}`,
    upstream: `127.0.0.1:${RELAY_PORT}`,
    enabled: true,
  });
}

// ---------- scenario executor ----------
// Runs a scenario's fault schedule. In self-test mode `hooks` receives the
// declarative expect* / publish* ops so the in-process clients can act on them;
// on device those ops are no-ops here (Maestro owns them) and only the network
// faults fire. `gapCapMs` compresses long idle holds for the hermetic run while
// leaving real toxic attributes (e.g. 2s latency) untouched.
async function runScenario(scenario, { hooks = {}, gapCapMs = 0 } = {}) {
  const steps = [...scenario.steps].sort((a, b) => a.atMs - b.atMs);
  let prev = 0;
  for (const step of steps) {
    const rawGap = step.atMs - prev;
    const gap = gapCapMs > 0 ? Math.min(rawGap, gapCapMs) : rawGap;
    if (gap > 0) await sleep(gap);
    prev = step.atMs;
    await execStep(scenario, step, hooks);
  }
}

async function execStep(scenario, step, hooks) {
  const { op, args: a = {}, note } = step;
  switch (op) {
    case 'disable':
      await tp('POST', `/proxies/${PROXY_NAME}`, { enabled: false });
      log(`[${scenario.name}] link DOWN` + (note ? ` — ${note}` : ''));
      break;
    case 'enable':
      await tp('POST', `/proxies/${PROXY_NAME}`, { enabled: true });
      log(`[${scenario.name}] link UP` + (note ? ` — ${note}` : ''));
      break;
    case 'addToxic':
      await tp('POST', `/proxies/${PROXY_NAME}/toxics`, {
        name: a.name,
        type: a.type,
        stream: a.stream || 'downstream',
        toxicity: a.toxicity ?? 1.0,
        attributes: a.attributes || {},
      });
      log(`[${scenario.name}] +toxic ${a.name} (${a.type})` + (note ? ` — ${note}` : ''));
      break;
    case 'removeToxic':
      await tp('DELETE', `/proxies/${PROXY_NAME}/toxics/${a.name}`).catch(() => {});
      log(`[${scenario.name}] -toxic ${a.name}`);
      break;
    case 'publishA':
    case 'publishB':
    case 'expectConverged':
    case 'expectStalled':
    case 'expectHonestStatus':
      if (hooks[op]) await hooks[op](step);
      else log(`[${scenario.name}] ${op}` + (note ? ` — ${note}` : '') + ' (device-driven)');
      break;
    case 'wait':
      break;
    default:
      throw new Error(`unknown step op ${op}`);
  }
}

// ---------- in-process transport model (self-test only) ----------
// A faithful-minimal model of the app's DropBoxTransport: connects through the
// chaos port, keeps a durability OUTBOX of un-acked events, flushes it on
// (re)connect, and re-subscribes. This is exactly the machinery the scenarios
// stress — if convergence held only because faults were no-ops, this would
// fail. Ephemeral relay means a reconnecting peer only re-receives what a peer
// RE-PUBLISHES from its outbox, mirroring the cold-start hello/flush path.
class ModelClient {
  constructor(id, port, topic) {
    this.id = id;
    this.url = `ws://127.0.0.1:${port}`;
    this.topic = topic;
    this.store = new Map(); // id -> event: every DATA event this client originated
    this.published = new Set(); // ids of my data events (convergence oracle input)
    this.received = new Set(); // peer data ids seen
    this.seq = 0;
    this.helloSeq = 0;
    this.closed = false;
    this._connect();
  }
  _connect() {
    if (this.closed) return;
    const sock = new WebSocket(this.url);
    this.sock = sock;
    sock.on('open', () => {
      sock.send(JSON.stringify(['REQ', `sub-${this.id}`, { kinds: [30078], '#t': [this.topic] }]));
      // Cold-start hello + re-publish my whole state. Models production's
      // ephemeral-relay backfill: a (re)connecting peer announces, and any
      // connected peer re-publishes so nothing written during the gap is lost.
      this._sendHello();
      this._republishAll();
    });
    sock.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT') {
        const ev = msg[2];
        if (!ev?.id) return;
        if (ev.content === 'hello') {
          // A peer (re)joined — re-publish my state so its gap is backfilled.
          this._republishAll();
        } else {
          this.received.add(ev.id);
        }
      }
    });
    const reconnect = () => {
      if (this.closed) return;
      setTimeout(() => this._connect(), 120);
    };
    sock.on('close', reconnect);
    sock.on('error', () => {
      try {
        sock.terminate();
      } catch {}
    });
  }
  _send(ev) {
    if (this.sock?.readyState !== 1) return false;
    try {
      this.sock.send(JSON.stringify(['EVENT', ev]));
      return true;
    } catch {
      return false;
    }
  }
  _sendHello() {
    this.helloSeq += 1;
    this._send({
      id: `${this.id}-hello-${this.helloSeq}`,
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', this.topic]],
      content: 'hello',
    });
  }
  _republishAll() {
    for (const ev of this.store.values()) this._send(ev);
  }
  publish() {
    this.seq += 1;
    const id = `${this.id}-ev${this.seq}`;
    const ev = {
      id,
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', this.topic]],
      content: `${this.id}:${this.seq}`,
    };
    this.store.set(id, ev); // durable — survives the gap, re-sent on backfill
    this.published.add(id);
    this._send(ev);
    return id;
  }
  close() {
    this.closed = true;
    try {
      this.sock?.terminate();
    } catch {}
  }
}

// ---------- process management ----------
function spawnProc(cmd, argv, name) {
  const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.CHAOS_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.env.CHAOS_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  return p;
}

function portListening(port, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`port ${port} never opened`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

async function startStack() {
  const toxi = spawnProc('toxiproxy-server', [], 'toxiproxy');
  const relay = spawnProc(
    'node',
    [new URL('./mini-relay.mjs', import.meta.url).pathname, '--port', String(RELAY_PORT)],
    'mini-relay'
  );
  await waitForApi();
  await portListening(RELAY_PORT);
  await resetProxy();
  await portListening(CHAOS_PORT);
  return { toxi, relay };
}

// ---------- self-test: hermetic per-scenario proof ----------
async function selfTest() {
  const catalogProblems = validateCatalog();
  if (catalogProblems.length) {
    console.error('catalog invalid:', catalogProblems.join('; '));
    process.exit(1);
  }
  const stack = await startStack();
  const results = [];
  const GAP_CAP = 8000;
  const topic = 'chaostest';
  try {
    for (const scenario of SCENARIOS) {
      await resetProxy(); // clean link + no toxics between scenarios
      const A = new ModelClient('A', CHAOS_PORT, topic);
      const B = new ModelClient('B', CHAOS_PORT, topic);
      await sleep(400); // let both subscribe
      let sawStall = false;
      let lastAId = null;
      const hooks = {
        publishA: async () => {
          lastAId = A.publish();
        },
        publishB: async () => {
          B.publish();
        },
        expectStalled: async () => {
          // during the fault, A's latest write must NOT have reached B yet
          if (lastAId && B.received.has(lastAId)) {
            throw new Error(`expected stall but B already has ${lastAId}`);
          }
          sawStall = true;
        },
        expectHonestStatus: async () => {
          // transport-level proxy: the fault is genuinely active (link down or a
          // failing toxic present) — the honesty oracle proper is the device
          // flow's "Not syncing" assertion. Verify the proxy is actually degraded.
          const p = await tp('GET', `/proxies/${PROXY_NAME}`);
          const degraded = p && (p.enabled === false || (p.toxics && p.toxics.length > 0));
          if (!degraded) throw new Error('expectHonestStatus: proxy not actually degraded');
        },
        expectConverged: async () => {
          // settle: give the outbox flush + relay broadcast time, then assert
          // every published id reached the OTHER client.
          const ok = await waitConverged(A, B, 6000);
          if (!ok) {
            throw new Error(
              `did not converge — A.pub=${[...A.published]} B.recv=${[...B.received]} ` +
                `B.pub=${[...B.published]} A.recv=${[...A.received]}`
            );
          }
        },
      };
      let verdict = { name: scenario.name, ok: true, err: null, sawStall };
      try {
        await runScenario(scenario, { hooks, gapCapMs: GAP_CAP });
        verdict.sawStall = sawStall;
        // Oracle: a partition-class scenario MUST have observed a real stall.
        if (scenario.transportOracle === 'partition-then-converges' && !sawStall) {
          throw new Error('partition scenario never observed a stall — fault not injected');
        }
        log(`✓ ${scenario.name} — converged; oracle "${scenario.transportOracle}" held`);
      } catch (e) {
        verdict.ok = false;
        verdict.err = e.message;
        log(`✗ ${scenario.name} — ${e.message}`);
      } finally {
        A.close();
        B.close();
      }
      results.push(verdict);
    }
  } finally {
    stack.toxi.kill('SIGKILL');
    stack.relay.kill('SIGKILL');
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== chaos-relay self-test ===');
  for (const r of results)
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.err ? ' — ' + r.err : ''}`);
  if (failed.length) {
    console.error(`\n${failed.length}/${results.length} scenarios FAILED`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} chaos scenarios green (hermetic, real toxiproxy).`);
  process.exit(0);
}

async function waitConverged(A, B, timeoutMs) {
  const start = Date.now();
  const done = () =>
    [...A.published].every((id) => B.received.has(id)) &&
    [...B.published].every((id) => A.received.has(id));
  while (Date.now() - start < timeoutMs) {
    if (done()) return true;
    await sleep(150);
  }
  return done();
}

// ---------- run mode (device-driven) ----------
async function runMode(name) {
  const scenario = getScenario(name);
  if (!scenario) {
    console.error(`unknown scenario "${name}". Known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  const stack = await startStack();
  log(`chaos-relay ready: phones → ws://<host>:${CHAOS_PORT} → mini-relay :${RELAY_PORT}`);
  log(`running scenario "${name}" [${scenario.seed}]`);
  const cleanup = () => {
    stack.toxi.kill('SIGKILL');
    stack.relay.kill('SIGKILL');
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  try {
    await runScenario(scenario); // faults only; Maestro drives the phones + oracles
    log(`scenario "${name}" schedule complete`);
  } finally {
    cleanup();
  }
}

// ---------- entry ----------
(async () => {
  if (has('self-test')) return selfTest();
  if (has('scenario')) return runMode(argVal('scenario', ''));
  console.log(
    'usage:\n' +
      '  chaos-relay.mjs --self-test                 hermetic proof of every scenario\n' +
      '  chaos-relay.mjs --scenario <name> [--port N]  boot the chaos front-end for a device run\n' +
      `  scenarios: ${SCENARIOS.map((s) => s.name).join(', ')}`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
