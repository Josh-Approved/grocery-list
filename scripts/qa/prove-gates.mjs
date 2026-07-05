#!/usr/bin/env node
/**
 * prove-gates.mjs — gates prove failure, systematically (Uplevel 3 / T2 stage 2).
 *
 * The 2026-07-02 canon rule from the demo-frame miss, generalized to EVERY gate:
 * a gate that never demonstrated failure is a hope, not a gate. This runner reads
 * an app's known-bad registry (qa/known-bad/registry.base.json + an optional
 * app-owned registry.json), runs each registered gate against its checked-in
 * known-bad fixture, and FAILS if any gate does NOT reject its known-bad — a
 * DEAD SENSOR (the net has a hole exactly where it reports "green").
 *
 * It is wired into run-qa --profile production (a dead sensor blocks a release)
 * and the monthly fleet-health sweep. Fixtures are tiny + checked-in (survive a
 * fresh clone); nothing is generated at run time. Gates with no cheap fixture are
 * listed in qa/known-bad/EXCLUSIONS.md, never silently skipped.
 *
 * Usage:
 *   node scripts/qa/prove-gates.mjs [appDir]        # default: cwd
 *   node scripts/qa/prove-gates.mjs <app-name>      # sibling of the workspace root
 *   node scripts/qa/prove-gates.mjs [appDir] --json
 *   node scripts/qa/prove-gates.mjs --self-test     # pure logic only
 *
 * Exit code: 0 if every registered gate rejected its known-bad (or the app has
 * no registry yet — rolling out, treated as a clean skip); 1 if any gate is a
 * dead sensor or the registry is malformed.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── pure core (all --self-test'd; no I/O) ────────────────────────────────────

const KINDS = new Set(['canonical-rule', 'command']);

/**
 * Validate + normalize a registry object into a flat entry list.
 * Accepts { gates: [...] } or a bare array. Returns { entries, problems }.
 * A problem is a hard error (malformed registry) — it fails the run, because a
 * registry we can't trust is itself a dead-sensor risk.
 */
export function normalizeRegistry(raw, source = 'registry') {
  const problems = [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.gates) ? raw.gates : null;
  if (list == null) {
    problems.push(`${source}: expected an array or { gates: [...] }`);
    return { entries: [], problems };
  }
  const entries = [];
  const seen = new Set();
  list.forEach((e, i) => {
    const at = `${source}[${i}]`;
    if (!e || typeof e !== 'object') { problems.push(`${at}: not an object`); return; }
    if (!e.gate || typeof e.gate !== 'string') { problems.push(`${at}: missing "gate"`); return; }
    if (!KINDS.has(e.kind)) { problems.push(`${at} (${e.gate}): kind must be one of ${[...KINDS].join('|')}`); return; }
    if (!e.fixture || typeof e.fixture !== 'string') { problems.push(`${at} (${e.gate}): missing "fixture"`); return; }
    if (e.kind === 'canonical-rule' && (!e.rule || typeof e.rule !== 'string')) {
      problems.push(`${at} (${e.gate}): canonical-rule needs "rule"`); return;
    }
    if (e.kind === 'command' && (!Array.isArray(e.cmd) || !e.cmd.length)) {
      problems.push(`${at} (${e.gate}): command needs a non-empty "cmd" array`); return;
    }
    if (seen.has(e.gate)) { problems.push(`${at}: duplicate gate id "${e.gate}"`); return; }
    seen.add(e.gate);
    entries.push({ gate: e.gate, kind: e.kind, fixture: e.fixture, rule: e.rule || null, cmd: e.cmd || null, expectMatch: e.expectMatch || null, why: e.why || '', source });
  });
  return { entries, problems };
}

/**
 * Is the canonical-rule sensor ALIVE? A rule is a live sensor iff, run against
 * its known-bad, it returned severity "fail". Any other outcome — pass, warn,
 * skip, or the rule not appearing at all — means the gate did NOT reject the
 * known-bad, so it's a dead sensor.
 * @param {object|null} ruleResult the { id, severity } row from qa-canonical, or null if absent.
 */
export function canonicalSensorAlive(ruleResult) {
  return !!ruleResult && ruleResult.severity === 'fail';
}

/**
 * Is the command sensor ALIVE? Live iff the gate exited NON-ZERO on the known-bad
 * (it rejected it), and — when an expectMatch is given — its output confirms it
 * rejected for the intended reason (guards against a gate that errors for an
 * unrelated reason, e.g. a missing file, which would be a false "alive").
 */
export function commandSensorAlive(exitCode, output = '', expectMatch = null) {
  if (exitCode === 0) return false;
  if (expectMatch) {
    try { return new RegExp(expectMatch).test(output); } catch { return false; }
  }
  return true;
}

/** Roll per-gate verdicts into an overall result. */
export function summarizeVerdicts(verdicts) {
  const dead = verdicts.filter((v) => !v.alive);
  return { ok: dead.length === 0, total: verdicts.length, dead };
}

// ── I/O shell ────────────────────────────────────────────────────────────────

function die(msg) { console.error(msg); process.exit(2); }

/** Resolve the target app dir from a positional arg (path, or sibling name, or cwd). */
function resolveAppDir(arg) {
  if (!arg) return process.cwd();
  const asPath = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) return asPath;
  // Sibling of the workspace root. From <root>/josh-approved-factory/scripts/qa
  // (or a synced <root>/<app>/scripts/qa) this "../../.." lands on the workspace
  // root either way, so `prove-gates.mjs grocery-list` works from both homes.
  const sibling = resolve(__dirname, '..', '..', '..', arg);
  if (existsSync(sibling) && statSync(sibling).isDirectory()) return sibling;
  die(`prove-gates: app dir not found: ${arg}`);
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** Load base + optional app registry for an app, merged (base first). */
function loadRegistries(knownBadDir) {
  const problems = [];
  const entries = [];
  const files = [
    ['registry.base.json', true],   // canonical, synced
    ['registry.json', false],       // app-owned, optional
  ];
  let any = false;
  for (const [name] of files) {
    const p = join(knownBadDir, name);
    if (!existsSync(p)) continue;
    any = true;
    const raw = readJson(p);
    if (raw == null) { problems.push(`${name}: not valid JSON`); continue; }
    const norm = normalizeRegistry(raw, name);
    entries.push(...norm.entries);
    problems.push(...norm.problems);
  }
  return { any, entries, problems };
}

// Cache one qa-canonical --json run per fixture dir (many rules share a fixture).
const canonicalCache = new Map();
function runCanonical(appDir, fixtureDir) {
  if (canonicalCache.has(fixtureDir)) return canonicalCache.get(fixtureDir);
  const linter = join(appDir, 'scripts', 'qa-canonical.mjs');
  if (!existsSync(linter)) { const v = { error: `no ${linter}` }; canonicalCache.set(fixtureDir, v); return v; }
  const r = spawnSync('node', [linter, fixtureDir, '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* fall through */ }
  const v = parsed && Array.isArray(parsed.results)
    ? { results: parsed.results }
    : { error: `qa-canonical produced no JSON (exit ${r.status}): ${(r.stderr || '').split('\n')[0]}` };
  canonicalCache.set(fixtureDir, v);
  return v;
}

function runCommand(entry, appDir, fixtureDir) {
  const argv = entry.cmd.map((a) => a.replace(/\{appDir\}/g, appDir).replace(/\{fixtureDir\}/g, fixtureDir));
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const exit = r.error ? (r.error.code === 'ENOENT' ? 127 : 1) : (r.status == null ? 1 : r.status);
  return { exit, output };
}

/** Run one gate → { gate, alive, detail }. */
function runGate(entry, appDir, knownBadDir) {
  const fixtureDir = join(knownBadDir, entry.fixture);
  if (!existsSync(fixtureDir)) {
    return { gate: entry.gate, alive: false, detail: `fixture missing: qa/known-bad/${entry.fixture}` };
  }
  if (entry.kind === 'canonical-rule') {
    const res = runCanonical(appDir, fixtureDir);
    if (res.error) return { gate: entry.gate, alive: false, detail: res.error };
    const row = res.results.find((r) => r.id === entry.rule) || null;
    const alive = canonicalSensorAlive(row);
    return { gate: entry.gate, alive,
      detail: alive ? `rule ${entry.rule} → fail (rejected the known-bad)`
        : `rule ${entry.rule} → ${row ? row.severity : 'ABSENT'} on the known-bad (expected fail) — DEAD SENSOR` };
  }
  // command
  const { exit, output } = runCommand(entry, appDir, fixtureDir);
  const alive = commandSensorAlive(exit, output, entry.expectMatch);
  return { gate: entry.gate, alive,
    detail: alive ? `command exited ${exit} (rejected the known-bad)`
      : `command exited ${exit} on the known-bad (expected non-zero${entry.expectMatch ? ` matching /${entry.expectMatch}/` : ''}) — DEAD SENSOR` };
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const appDir = resolveAppDir(positional[0]);
  const asJson = flags.has('--json');
  const knownBadDir = join(appDir, 'qa', 'known-bad');

  // Rollout doctrine (mirrors testing/enforce, device-net, two-device): an app
  // with no known-bad registry yet simply SKIPS — the gate is opt-in per app as
  // the fixtures are synced in. It never blocks an app that hasn't adopted it.
  if (!existsSync(knownBadDir) || (!existsSync(join(knownBadDir, 'registry.base.json')) && !existsSync(join(knownBadDir, 'registry.json')))) {
    const out = { app: appDir.split(/[\\/]/).pop(), ok: true, status: 'skip', reason: 'no qa/known-bad registry (prove-gates rolling out)', gates: [] };
    if (asJson) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else console.log(`· prove-gates: ${out.reason}`);
    process.exit(0);
  }

  const { entries, problems } = loadRegistries(knownBadDir);
  if (problems.length) {
    const out = { app: appDir.split(/[\\/]/).pop(), ok: false, status: 'error', problems, gates: [] };
    if (asJson) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else { console.error('✗ prove-gates: registry is malformed (a registry we can\'t trust is a dead-sensor risk):'); for (const p of problems) console.error(`  - ${p}`); }
    process.exit(1);
  }

  const verdicts = entries.map((e) => runGate(e, appDir, knownBadDir));
  const { ok, total, dead } = summarizeVerdicts(verdicts);

  const out = {
    app: appDir.split(/[\\/]/).pop(),
    ok,
    status: ok ? 'pass' : 'fail',
    total,
    dead: dead.map((d) => d.gate),
    gates: verdicts,
    verdict: ok
      ? `all ${total} gate(s) rejected their known-bad — no dead sensors`
      : `${dead.length}/${total} DEAD SENSOR(S): ${dead.map((d) => d.gate).join(', ')} — a gate reports green over a known-bad`,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    console.log(`prove-gates · ${out.app} — ${total} gate(s)`);
    for (const v of verdicts) console.log(`  ${v.alive ? '✓' : '✗'} ${v.gate}: ${v.detail}`);
    console.log('');
    console.log(`${ok ? '✓' : '✗'} ${out.verdict}`);
  }
  process.exit(ok ? 0 : 1);
}

// ── self-test (pure logic only) ──────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } };

  // normalizeRegistry — good + bad shapes.
  const good = normalizeRegistry({ gates: [
    { gate: 'a', kind: 'canonical-rule', fixture: 'canonical', rule: 'parity/x' },
    { gate: 'b', kind: 'command', fixture: 'flow-drift', cmd: ['node', 'x.mjs'] },
  ] });
  ok('normalizeRegistry accepts a valid registry', good.problems.length === 0 && good.entries.length === 2);
  ok('normalizeRegistry accepts a bare array', normalizeRegistry([{ gate: 'a', kind: 'command', fixture: 'f', cmd: ['x'] }]).entries.length === 1);

  const bad = normalizeRegistry({ gates: [
    { gate: 'a', kind: 'canonical-rule', fixture: 'canonical' },        // missing rule
    { gate: 'b', kind: 'command', fixture: 'f' },                       // missing cmd
    { gate: 'c', kind: 'bogus', fixture: 'f' },                         // bad kind
    { kind: 'command', fixture: 'f', cmd: ['x'] },                      // missing gate
    { gate: 'dup', kind: 'command', fixture: 'f', cmd: ['x'] },         // valid — enters seen
    { gate: 'dup', kind: 'command', fixture: 'f', cmd: ['y'] },         // duplicate id
  ] });
  ok('normalizeRegistry flags a canonical-rule without rule', bad.problems.some((p) => /needs "rule"/.test(p)));
  ok('normalizeRegistry flags a command without cmd', bad.problems.some((p) => /non-empty "cmd"/.test(p)));
  ok('normalizeRegistry flags a bad kind', bad.problems.some((p) => /kind must be/.test(p)));
  ok('normalizeRegistry flags a missing gate id', bad.problems.some((p) => /missing "gate"/.test(p)));
  ok('normalizeRegistry flags a duplicate gate id', bad.problems.some((p) => /duplicate gate id/.test(p)));
  ok('normalizeRegistry rejects a non-array', normalizeRegistry({ gates: 5 }).problems.some((p) => /expected an array/.test(p)));

  // canonicalSensorAlive — only severity:fail is alive.
  ok('canonical alive on fail', canonicalSensorAlive({ id: 'r', severity: 'fail' }) === true);
  ok('canonical DEAD on pass', canonicalSensorAlive({ id: 'r', severity: 'pass' }) === false);
  ok('canonical DEAD on warn', canonicalSensorAlive({ id: 'r', severity: 'warn' }) === false);
  ok('canonical DEAD on skip', canonicalSensorAlive({ id: 'r', severity: 'skip' }) === false);
  ok('canonical DEAD when the rule is absent', canonicalSensorAlive(null) === false);

  // commandSensorAlive — non-zero exit is alive; expectMatch narrows it.
  ok('command alive on non-zero exit', commandSensorAlive(1) === true);
  ok('command DEAD on zero exit', commandSensorAlive(0) === false);
  ok('command alive on non-zero + matching output', commandSensorAlive(1, 'selector drift here', 'drift') === true);
  ok('command DEAD on non-zero but non-matching output', commandSensorAlive(1, 'unrelated crash', 'drift') === false);
  ok('command DEAD on zero even if output matches', commandSensorAlive(0, 'drift', 'drift') === false);

  // summarizeVerdicts — ok iff zero dead sensors.
  const allAlive = summarizeVerdicts([{ gate: 'a', alive: true }, { gate: 'b', alive: true }]);
  ok('summarize: all alive → ok', allAlive.ok === true && allAlive.dead.length === 0);
  const oneDead = summarizeVerdicts([{ gate: 'a', alive: true }, { gate: 'b', alive: false }]);
  ok('summarize: one dead → not ok, names it', oneDead.ok === false && oneDead.dead[0].gate === 'b');

  console.log(`\nprove-gates self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();
else main(argv);
