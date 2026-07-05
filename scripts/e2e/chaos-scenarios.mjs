#!/usr/bin/env node
/**
 * Network-chaos scenario catalog for the two-device sync E2E.
 *
 * Each scenario is a NAMED, SEEDED, REPLAYABLE fault schedule expressed as a
 * list of timed steps against a toxiproxy proxy that sits in front of the
 * hermetic mini-relay. "Chaos is never random and hope" (T4 guardrail): the
 * fault *schedule* is fixed and deterministic. Where a toxic is inherently
 * probabilistic (lossy uses reset_peer toxicity), the ORACLE is invariant to
 * the coin flips — it asserts eventual convergence + status honesty, never an
 * exact drop pattern — so the scenario is still replayable and its verdict
 * stable. The `seed` field records the fixed parameterization for the log.
 *
 * Oracles per scenario = the T1 intent set (a check-off survives, nothing
 * resurrects, no duplicates, bounded payload) PLUS the honesty oracle: the
 * sync-status indicator must read "Not syncing" whenever delivery is actually
 * failing (the 2026-07-04 fix, kept honest forever). On device those are the
 * Maestro flow assertions; at the transport level (chaos-relay --self-test)
 * the oracle is the delivery signature described by `transportOracle`.
 *
 * Pure module: no I/O, no toxiproxy dependency at import time, so `--self-test`
 * validates the catalog shape anywhere. chaos-relay.mjs is the executor.
 *
 * Factory template (templates/e2e-two-device/) — app-agnostic; synced verbatim.
 */

// Step ops the executor understands. Kept small + declarative so the schedule
// is auditable and the self-test can validate every step without a live proxy.
export const STEP_OPS = new Set([
  'publishA', // device/client A publishes one mutation
  'publishB', // device/client B publishes one mutation
  'enable', // restore the proxy link
  'disable', // sever the proxy link entirely (partition)
  'addToxic', // add a named toxic (args: {name, type, stream, attributes, toxicity})
  'removeToxic', // remove a toxic by name (args: {name})
  'expectConverged', // both clients hold the same event set (settle window then assert)
  'expectStalled', // A's latest publish has NOT reached B yet (delivery failing)
  'expectHonestStatus', // status indicator reads "Not syncing" (device flows own the UI assert)
  'wait', // advance the schedule (args: {ms})
]);

// `atMs` is the scheduled offset from scenario start. The executor sorts by it
// and, in --self-test, scales long holds down via CHAOS_SCALE so the hermetic
// proof runs in seconds while the on-device schedule uses the real durations.
/** @typedef {{ atMs:number, op:string, args?:object, note?:string }} Step */

/** @type {{name:string, seed:string, description:string, transportOracle:string, steps:Step[]}[]} */
export const SCENARIOS = [
  {
    name: 'partition-mid-sync',
    seed: 'hold=60000',
    description:
      "Josh's \"long gap\" report as a standing scenario: drop the link right " +
      'after device A writes, hold 60s, reconnect. A write made during the ' +
      'partition must converge on reconnect; status must be honest during the gap.',
    transportOracle: 'partition-then-converges',
    steps: [
      { atMs: 0, op: 'publishA', note: 'A writes while connected — baseline delivery' },
      { atMs: 500, op: 'expectConverged' },
      { atMs: 800, op: 'disable', note: 'sever the link mid-sync' },
      { atMs: 1000, op: 'publishA', note: 'A writes into the void' },
      { atMs: 1500, op: 'expectStalled', note: 'B has not seen it — delivery is failing' },
      { atMs: 1500, op: 'expectHonestStatus' },
      { atMs: 60800, op: 'enable', note: 'reconnect after the 60s gap' },
      { atMs: 63000, op: 'expectConverged', note: 'the gap write backfills — nothing lost' },
    ],
  },
  {
    name: 'slow-drip',
    seed: 'latency=2000ms;both-ways',
    description:
      '2s+ latency each way (a full round-trip is >4s). Delivery must still ' +
      'complete and converge; nothing is dropped, just slow.',
    transportOracle: 'converges',
    steps: [
      {
        atMs: 0,
        op: 'addToxic',
        args: {
          name: 'drip-down',
          type: 'latency',
          stream: 'downstream',
          attributes: { latency: 2000, jitter: 250 },
        },
      },
      {
        atMs: 0,
        op: 'addToxic',
        args: {
          name: 'drip-up',
          type: 'latency',
          stream: 'upstream',
          attributes: { latency: 2000, jitter: 250 },
        },
      },
      { atMs: 200, op: 'publishA' },
      { atMs: 8000, op: 'expectConverged', note: 'arrives despite the slow pipe' },
    ],
  },
  {
    name: 'lossy',
    seed: 'reset_peer;toxicity=0.3',
    description:
      '30% of connections reset (TCP-level loss). With reconnect/retry the ' +
      'write converges eventually; transient "Not syncing" is allowed but no ' +
      'duplicate or resurrected item may result.',
    transportOracle: 'converges-eventually',
    steps: [
      {
        atMs: 0,
        op: 'addToxic',
        args: {
          name: 'loss',
          type: 'reset_peer',
          stream: 'downstream',
          toxicity: 0.3,
          attributes: { timeout: 0 },
        },
      },
      { atMs: 200, op: 'publishA' },
      { atMs: 400, op: 'publishA', note: 'second write to exercise retry over loss' },
      { atMs: 12000, op: 'removeToxic', args: { name: 'loss' } },
      { atMs: 15000, op: 'expectConverged' },
    ],
  },
  {
    name: 'disconnect-on-write',
    seed: 'reset_peer@publish',
    description:
      'Kill the socket exactly when a publish starts. The publish must be ' +
      'retried after the socket re-establishes; the write still converges ' +
      '(durability flush), and status is honest during the gap.',
    transportOracle: 'partition-then-converges',
    steps: [
      {
        atMs: 0,
        op: 'addToxic',
        args: {
          name: 'kill-on-write',
          type: 'reset_peer',
          stream: 'upstream',
          attributes: { timeout: 0 },
        },
        note: 'any write in flight is reset',
      },
      { atMs: 100, op: 'publishA', note: 'publish is killed on the wire' },
      { atMs: 400, op: 'expectStalled' },
      { atMs: 400, op: 'expectHonestStatus' },
      { atMs: 3000, op: 'removeToxic', args: { name: 'kill-on-write' } },
      { atMs: 5500, op: 'expectConverged', note: 'retry lands after the socket heals' },
    ],
  },
  {
    name: 'flap',
    seed: 'toggle=5000ms;cycles=4',
    description:
      'Link up/down every 5s during active editing. After the flapping stops ' +
      'both devices converge with no duplicate and no resurrected item; the ' +
      'status indicator flips honestly with each transition.',
    transportOracle: 'converges-eventually',
    steps: [
      { atMs: 0, op: 'publishA' },
      { atMs: 500, op: 'disable' },
      { atMs: 1000, op: 'publishB', note: 'B edits while the link is down' },
      { atMs: 1500, op: 'expectHonestStatus' },
      { atMs: 5000, op: 'enable' },
      { atMs: 5500, op: 'publishA' },
      { atMs: 10000, op: 'disable' },
      { atMs: 10500, op: 'publishB' },
      { atMs: 15000, op: 'enable' },
      { atMs: 20000, op: 'enable', note: 'settle connected' },
      { atMs: 23000, op: 'expectConverged' },
    ],
  },
];

export const TRANSPORT_ORACLES = new Set([
  'converges', // B ends holding A's write(s)
  'converges-eventually', // same, after transient failures clear
  'partition-then-converges', // stalled during the fault, converges after
]);

export function getScenario(name) {
  return SCENARIOS.find((s) => s.name === name) || null;
}

// Pure validation of the catalog shape — every step op known, every scenario
// seeded + named + carries a recognised transport oracle, monotonic-ish
// schedule. Lets --self-test guard the catalog on any machine.
export function validateCatalog() {
  const problems = [];
  const names = new Set();
  for (const s of SCENARIOS) {
    if (!s.name) problems.push('scenario missing name');
    if (names.has(s.name)) problems.push(`duplicate scenario name: ${s.name}`);
    names.add(s.name);
    if (!s.seed) problems.push(`${s.name}: missing seed`);
    if (!TRANSPORT_ORACLES.has(s.transportOracle))
      problems.push(`${s.name}: unknown transportOracle "${s.transportOracle}"`);
    if (!Array.isArray(s.steps) || s.steps.length === 0)
      problems.push(`${s.name}: no steps`);
    let hasConverge = false;
    for (const [i, st] of (s.steps || []).entries()) {
      if (typeof st.atMs !== 'number' || st.atMs < 0)
        problems.push(`${s.name} step ${i}: bad atMs`);
      if (!STEP_OPS.has(st.op)) problems.push(`${s.name} step ${i}: unknown op "${st.op}"`);
      if (st.op === 'addToxic' && (!st.args?.name || !st.args?.type))
        problems.push(`${s.name} step ${i}: addToxic needs {name,type}`);
      if (st.op === 'removeToxic' && !st.args?.name)
        problems.push(`${s.name} step ${i}: removeToxic needs {name}`);
      if (st.op === 'expectConverged') hasConverge = true;
    }
    if (!hasConverge)
      problems.push(`${s.name}: no expectConverged step — every scenario must end reconciled`);
  }
  return problems;
}

// --self-test: pure catalog validation, no toxiproxy needed.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test') || args.includes('--check')) {
    const problems = validateCatalog();
    if (problems.length) {
      console.error('chaos-scenarios self-test FAILED:');
      for (const p of problems) console.error('  - ' + p);
      process.exit(1);
    }
    console.log(
      `chaos-scenarios self-test OK — ${SCENARIOS.length} scenarios: ` +
        SCENARIOS.map((s) => s.name).join(', ')
    );
    process.exit(0);
  }
  if (args.includes('--list')) {
    for (const s of SCENARIOS) console.log(`${s.name}\t[${s.seed}]\t${s.transportOracle}`);
    process.exit(0);
  }
  console.log('usage: chaos-scenarios.mjs [--self-test|--list]');
}
