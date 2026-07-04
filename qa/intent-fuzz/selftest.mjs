#!/usr/bin/env node
/**
 * selftest.mjs — proves the PURE core of the intent-fuzz kit (Uplevel 3 / T1).
 * No fast-check, no TypeScript, no app: just the deterministic logic the whole
 * failure-crystallization path stands on. Exits non-zero on the first failure.
 *
 *   node templates/qa/intent-fuzz/selftest.mjs
 *
 * Covers the three things the stage names: seed logging round-trip, story
 * serialization round-trip, and the shrink-output shape guard — plus the
 * end-to-end crystallization into a temp dir.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = require(join(here, 'harnessCore.cjs'));

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
    throw new SelftestAbort();
  }
}
class SelftestAbort extends Error {}

const tmp = fs.mkdtempSync(join(os.tmpdir(), 'intent-fuzz-selftest-'));

try {
  // 1. resolveRuns / resolveProfile — profile & override precedence.
  ok('resolveRuns default smoke = 50', () => {
    assert.equal(core.resolveRuns({}), core.SMOKE_RUNS);
    assert.equal(core.resolveRuns({}), 50);
  });
  ok('resolveRuns nightly = 2000', () => {
    assert.equal(core.resolveRuns({ FUZZ_PROFILE: 'nightly' }), 2000);
    assert.equal(core.resolveProfile({ FUZZ_PROFILE: 'nightly' }), 'nightly');
  });
  ok('resolveRuns explicit FUZZ_RUNS wins', () => {
    assert.equal(core.resolveRuns({ FUZZ_RUNS: '137', FUZZ_PROFILE: 'nightly' }), 137);
    assert.equal(core.resolveProfile({ FUZZ_RUNS: '137' }), 'custom');
  });
  ok('resolveRuns ignores garbage FUZZ_RUNS', () => {
    assert.equal(core.resolveRuns({ FUZZ_RUNS: 'abc' }), 50);
    assert.equal(core.resolveRuns({ FUZZ_RUNS: '-4' }), 50);
  });

  // 2. Story serialization round-trip — byte-stable + deep-equal.
  ok('serializeStory / parseStory round-trip (deep equal)', () => {
    const story = { ops: [{ a: 'add', name: 'Milk', q: 2 }, { a: 'check', id: 'i7' }], devices: 2 };
    const back = core.parseStory(core.serializeStory(story));
    assert.deepEqual(back, story);
  });
  ok('serializeStory is key-order-stable (byte identical)', () => {
    const a = core.serializeStory({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = core.serializeStory({ nested: { x: 2, y: 1 }, a: 2, b: 1 });
    assert.equal(a, b);
  });

  // 3. Shrink-output shape guard.
  ok('validateShrinkShape accepts a real failure', () => {
    const norm = core.validateShrinkShape({
      failed: true, seed: 42, counterexamplePath: '3:1:0',
      counterexample: [['add(Milk)', 'check(Milk)', 'add(Milk)']], numRuns: 50,
    });
    assert.equal(norm.seed, 42);
    assert.equal(norm.path, '3:1:0');
    assert.ok(norm.counterexample);
  });
  ok('validateShrinkShape rejects a pass', () => {
    assert.throws(() => core.validateShrinkShape({ failed: false }), /failed is not true/);
  });
  ok('validateShrinkShape rejects a shrink with no path', () => {
    assert.throws(
      () => core.validateShrinkShape({ failed: true, seed: 1, counterexample: [] }),
      /counterexamplePath/
    );
  });

  // 4. Regression fixture shape round-trips through disk.
  ok('buildRegression + validateRegressionShape + disk round-trip', () => {
    const reg = core.buildRegression({
      app: 'demo-app', model: 'list', seed: 7, path: '0:1',
      counterexample: [['add(Eggs)', 'delete(Eggs)']], message: 'I5 resurrection', date: '2026-07-04',
    });
    assert.equal(core.validateRegressionShape(reg), true);
    const f = join(tmp, 'reg.json');
    core.writeJsonFile(f, reg);
    const back = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(back, reg);
    assert.equal(back.kind, 'fuzz-seed');
    assert.equal(back.savedAt, '2026-07-04');
  });
  ok('validateRegressionShape rejects a bad artifact', () => {
    assert.throws(() => core.validateRegressionShape({ kind: 'nope' }), /kind must be/);
    assert.throws(() => core.validateRegressionShape({ kind: 'fuzz-seed', app: 'x', model: 'y', seed: 'no', path: 'p', story: '' }), /seed must be a number/);
  });

  // 5. Seed logging round-trip (the nightly-replay guarantee).
  ok('logRun appends a parseable fuzz-log line with its seed', () => {
    const appRoot = fs.mkdtempSync(join(os.tmpdir(), 'intent-fuzz-log-'));
    core.logRun({ appRoot, app: 'demo-app', model: 'list', seed: 99, runs: 2000, profile: 'nightly', outcome: 'pass', date: '2026-07-04' });
    core.logRun({ appRoot, app: 'demo-app', model: 'list', seed: 100, runs: 2000, profile: 'nightly', outcome: 'fail', date: '2026-07-04' });
    const { fuzzLog } = core.paths(appRoot);
    const lines = fs.readFileSync(fuzzLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].seed, 99);
    assert.equal(lines[0].profile, 'nightly');
    assert.equal(lines[1].outcome, 'fail');
  });

  // 6. Intake line has the fields the ledger needs + a deterministic signature.
  ok('buildIntakeLine is well-formed + signature is deterministic', () => {
    const a = core.buildIntakeLine({ app: 'demo-app', model: 'list', seed: 5, message: 'I2 check-state of "Milk" is false, last action wanted true', date: '2026-07-04' });
    const b = core.buildIntakeLine({ app: 'demo-app', model: 'list', seed: 5, message: 'I2 check-state of "Milk" is false, last action wanted true', date: '2026-07-04' });
    assert.equal(a.kind, 'test-failure');
    assert.equal(a.class, 'correctness');
    assert.equal(a.repro.kind, 'fuzz-seed');
    assert.equal(a.repro.seed, 5);
    assert.match(a.signature, /^test:/);
    assert.equal(a.signature, b.signature); // deterministic
  });

  // 7. slugify.
  ok('slugify makes a safe filename fragment', () => {
    assert.equal(core.slugify('List Sync!'), 'list-sync');
    assert.equal(core.slugify('  --A B--  '), 'a-b');
    assert.equal(core.slugify(''), 'unnamed');
  });

  // 8. End-to-end crystallization into a temp app root.
  ok('crystallizeFailure writes fixture + intake + fuzz-log', () => {
    const appRoot = fs.mkdtempSync(join(os.tmpdir(), 'intent-fuzz-cryst-'));
    const runDetails = {
      failed: true, seed: 2026, counterexamplePath: '4:2:1', numRuns: 50,
      counterexample: [['add(Milk)', 'check(Milk)', 'finishShop()', 'add(Milk)']],
    };
    const { regressionFile } = core.crystallizeFailure({
      appRoot, app: 'demo-app', model: 'list', runDetails,
      message: 'I3 re-add of checked "Milk" → qty 2, want qty 1 unchecked', date: '2026-07-04',
    });
    // fixture
    const reg = JSON.parse(fs.readFileSync(regressionFile, 'utf8'));
    assert.equal(core.validateRegressionShape(reg), true);
    assert.equal(reg.seed, 2026);
    assert.equal(reg.path, '4:2:1');
    assert.match(reg.story, /add\(Milk\)/);
    // intake
    const { intake, fuzzLog } = core.paths(appRoot);
    const intakeLine = JSON.parse(fs.readFileSync(intake, 'utf8').trim());
    assert.equal(intakeLine.kind, 'test-failure');
    assert.match(intakeLine.repro.artifact, /qa\/regressions\/list-seed-2026\.json$/);
    // fuzz-log fail line
    const logLine = JSON.parse(fs.readFileSync(fuzzLog, 'utf8').trim());
    assert.equal(logLine.outcome, 'fail');
    assert.equal(logLine.seed, 2026);
  });
  // 9. listRegressions reads back what crystallizeFailure wrote.
  ok('listRegressions returns parsed checked-in fixtures', () => {
    const appRoot = fs.mkdtempSync(join(os.tmpdir(), 'intent-fuzz-list-'));
    assert.deepEqual(core.listRegressions(appRoot), []); // none yet
    core.crystallizeFailure({
      appRoot, app: 'demo-app', model: 'tracker',
      runDetails: { failed: true, seed: 11, counterexamplePath: '0', counterexample: [['log(3)']], numRuns: 50 },
      message: 'count mismatch', date: '2026-07-04',
    });
    const regs = core.listRegressions(appRoot);
    assert.equal(regs.length, 1);
    assert.equal(regs[0].model, 'tracker');
    assert.equal(regs[0].seed, 11);
    assert.match(regs[0]._file, /tracker-seed-11\.json$/);
  });
} catch (e) {
  if (!(e instanceof SelftestAbort)) {
    console.error(e);
    process.exitCode = 1;
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (process.exitCode && process.exitCode !== 0) {
  console.error(`\nintent-fuzz selftest FAILED after ${passed} passing check(s).`);
} else {
  console.log(`\nintent-fuzz selftest: ${passed} checks passed.`);
}
