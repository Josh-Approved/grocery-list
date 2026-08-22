#!/usr/bin/env node
/**
 * source-hash.mjs — the QA build cache key, in one place.
 *
 * capture.mjs hash-caches its `eas build --local` output as
 * `qa/captures/.build-<platform>.<ext>` alongside `.build-<platform>.hash`.
 * Anything else that wants to know "is that cached build current for this
 * source?" must compute the key the SAME way, or it will rebuild forever (or,
 * worse, reuse a stale artifact and call it fresh).
 *
 * Extracted 2026-08-13 (ticket ship-released-slot-never-populated) so the ship
 * path's upgrade-harness slot drop (scripts/lib/drop-released.mjs) can decide
 * staleness against capture.mjs's own key instead of guessing from mtimes.
 *
 * Usage:
 *   node scripts/qa/source-hash.mjs <app-dir>     # print the key
 *   node scripts/qa/source-hash.mjs --self-test
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Files outside src/ that change what the built binary is. */
export const HASH_INPUTS = ['app.json', 'package.json', 'package-lock.json', 'qa/journey.json', 'qa/selectors.json'];

/**
 * The QA build cache key for an app: sha256 over src/** plus HASH_INPUTS.
 * Dotfiles and node_modules are skipped (they are build output / noise).
 * Pure apart from reading the app dir; identical inputs → identical key.
 */
export function sourceHash(appDir) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else { try { h.update(e.name); h.update(fs.readFileSync(full)); } catch { /* unreadable file — skip, same as before */ } }
    }
  };
  walk(path.join(appDir, 'src'));
  for (const f of HASH_INPUTS) {
    const p = path.join(appDir, f);
    if (fs.existsSync(p)) { h.update(f); h.update(fs.readFileSync(p)); }
  }
  return h.digest('hex');
}

/** Read the hash capture.mjs recorded for a platform's cached build, or null. */
export function cachedBuildHash(appDir, platform) {
  const p = path.join(appDir, 'qa', 'captures', `.build-${platform}.hash`);
  try { return fs.readFileSync(p, 'utf8').trim() || null; } catch { return null; }
}

function selfTest() {
  let f = 0; const ok = (c, m) => { if (!c) { f++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'srchash-'));
  fs.mkdirSync(path.join(tmp, 'src', 'sync'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(tmp, 'app.json'), '{"expo":{"name":"x"}}\n');

  const base = sourceHash(tmp);
  ok(/^[0-9a-f]{64}$/.test(base), 'returns a sha256 hex digest');
  ok(sourceHash(tmp) === base, 'stable across repeated runs on unchanged source');

  fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const a = 2;\n');
  const changed = sourceHash(tmp);
  ok(changed !== base, 'changes when a src file changes');

  fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const a = 1;\n');
  ok(sourceHash(tmp) === base, 'returns to the original key when the change is reverted');

  fs.writeFileSync(path.join(tmp, 'app.json'), '{"expo":{"name":"y"}}\n');
  ok(sourceHash(tmp) !== base, 'changes when app.json changes');
  fs.writeFileSync(path.join(tmp, 'app.json'), '{"expo":{"name":"x"}}\n');

  fs.writeFileSync(path.join(tmp, 'src', '.hidden'), 'ignored\n');
  ok(sourceHash(tmp) === base, 'ignores dotfiles under src/');
  fs.mkdirSync(path.join(tmp, 'src', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'node_modules', 'x.js'), 'ignored\n');
  ok(sourceHash(tmp) === base, 'ignores node_modules under src/');

  fs.writeFileSync(path.join(tmp, 'README.md'), 'not an input\n');
  ok(sourceHash(tmp) === base, 'ignores files outside src/ that are not HASH_INPUTS');

  ok(cachedBuildHash(tmp, 'ios') === null, 'cachedBuildHash → null when no cache file');
  fs.mkdirSync(path.join(tmp, 'qa', 'captures'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'qa', 'captures', '.build-ios.hash'), 'deadbeef\n');
  ok(cachedBuildHash(tmp, 'ios') === 'deadbeef', 'cachedBuildHash reads + trims the recorded key');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(f === 0 ? '\nsource-hash self-test PASSED' : `\nsource-hash self-test FAILED (${f})`);
  process.exit(f === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();
  else if (!argv[0]) { console.error('usage: source-hash.mjs <app-dir> | --self-test'); process.exit(2); }
  else console.log(sourceHash(path.resolve(argv[0])));
}
