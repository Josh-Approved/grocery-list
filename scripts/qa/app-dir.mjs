#!/usr/bin/env node
/**
 * app-dir.mjs — the ONE place a QA tool turns its app argument into a directory.
 *
 * Every device/QA tool used to do `path.resolve(positional[0] || process.cwd())`
 * and never check the result. So `node scripts/qa/capture.mjs grocery-list` run
 * from the factory resolved `josh-approved-factory/grocery-list`, found no
 * journey, said "hasn't adopted the journey pipeline yet" and EXITED 0 — a device
 * gate that built and traversed nothing, reading green (hit for real 2026-08-23:
 * it nearly certified a native-module change that never ran on a device). A
 * misresolved path was indistinguishable from a legitimate skip.
 *
 * The rule here: an app argument resolves to a directory that is actually an app
 * (package.json, app.json or manifest.json present), or the tool exits 2 naming
 * every path it tried. Accepted forms:
 *   - nothing          → the cwd (the tools are run from inside an app)
 *   - a path           → resolved against the cwd
 *   - a bare app name  → falls back to <workspace root>/<name>, so the same
 *                        command works from the factory, the workspace root, or
 *                        inside the app. From <root>/josh-approved-factory/scripts/qa
 *                        and from a synced <root>/<app>/scripts/qa, "../../.."
 *                        is the workspace root either way.
 *
 * Usage (library):  import { resolveAppDir } from './app-dir.mjs';
 *                   const appDir = resolveAppDir(positional[0], 'capture');
 * Self-test:        node scripts/qa/app-dir.mjs --self-test
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(HERE, '..', '..', '..');
const APP_MARKERS = ['package.json', 'app.json', 'manifest.json'];

// ── pure core ────────────────────────────────────────────────────────────────

/** A bare name has no path separator and is not a dot-path, so it may mean a
 *  sibling app in the workspace root. */
export function isBareName(arg) {
  return !!arg && !arg.includes('/') && !arg.includes('\\') && arg !== '.' && arg !== '..';
}

/**
 * Pure: decide which directory an app argument means.
 * `probe(dir)` → { isDir: boolean, isApp: boolean }.
 * Returns { dir, tried } on success or { error, tried } when nothing qualifies.
 */
export function planAppDir(arg, { cwd, workspaceRoot, probe }) {
  const candidates = [];
  if (!arg) candidates.push(cwd);
  else {
    candidates.push(path.resolve(cwd, arg));
    if (isBareName(arg)) {
      const sibling = path.join(workspaceRoot, arg);
      if (!candidates.includes(sibling)) candidates.push(sibling);
    }
  }
  const tried = [];
  for (const dir of candidates) {
    const p = probe(dir);
    if (p.isDir && p.isApp) return { dir, tried };
    tried.push({ dir, why: p.isDir ? `no ${APP_MARKERS.join('/')}` : 'not a directory' });
  }
  const what = arg ? `"${arg}"` : 'the current directory';
  return {
    error: `${what} is not an app directory. Tried:\n` +
      tried.map((t) => `  - ${t.dir} (${t.why})`).join('\n') +
      '\nPass an app path or a sibling app name (e.g. grocery-list).',
    tried,
  };
}

// ── I/O shell ────────────────────────────────────────────────────────────────

export function probeDir(dir) {
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
  return { isDir, isApp: isDir && APP_MARKERS.some((m) => fs.existsSync(path.join(dir, m))) };
}

/** Resolve or exit 2. Never returns a directory that isn't an app. */
export function resolveAppDir(arg, tool = 'qa') {
  const r = planAppDir(arg, { cwd: process.cwd(), workspaceRoot: WORKSPACE_ROOT, probe: probeDir });
  if (r.error) {
    console.error(`✗ ${tool}: ${r.error}`);
    process.exit(2);
  }
  return r.dir;
}

// ── self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (a, b, msg) => {
    if (JSON.stringify(a) === JSON.stringify(b)) pass++;
    else { fail++; console.error(`  ✗ ${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
  };
  const apps = new Set(['/w/grocery-list', '/w/tend', '/w/tend/sub-app']);
  const dirs = new Set([...apps, '/w', '/w/josh-approved-factory', '/w/josh-approved-factory/scripts']);
  const probe = (d) => ({ isDir: dirs.has(d), isApp: apps.has(d) });
  const ctx = (cwd) => ({ cwd, workspaceRoot: '/w', probe });

  // The incident: a bare name from the factory must reach the sibling, not the factory subdir.
  eq(planAppDir('grocery-list', ctx('/w/josh-approved-factory')).dir, '/w/grocery-list', 'bare name from factory → sibling');
  eq(planAppDir('grocery-list', ctx('/w/grocery-list')).dir, '/w/grocery-list', 'bare name from inside the app → sibling (qa-canonical cwd bug)');
  eq(planAppDir('grocery-list', ctx('/w')).dir, '/w/grocery-list', 'bare name from workspace root');
  eq(planAppDir('/w/tend', ctx('/w/josh-approved-factory')).dir, '/w/tend', 'absolute path kept');
  eq(planAppDir('../tend', ctx('/w/josh-approved-factory')).dir, '/w/tend', 'relative path resolves against cwd');
  eq(planAppDir('sub-app', ctx('/w/tend')).dir, '/w/tend/sub-app', 'a real cwd-relative app wins over a sibling');
  eq(planAppDir(undefined, ctx('/w/tend')).dir, '/w/tend', 'no arg → cwd when it is an app');

  // Every one of these used to "resolve" silently and let the tool exit 0.
  eq(!!planAppDir(undefined, ctx('/w/josh-approved-factory')).error, true, 'no arg from a non-app cwd → error');
  eq(!!planAppDir('nope', ctx('/w/josh-approved-factory')).error, true, 'unknown name → error');
  eq(planAppDir('nope', ctx('/w/josh-approved-factory')).tried.map((t) => t.dir),
    ['/w/josh-approved-factory/nope', '/w/nope'], 'error names every path tried');
  eq(!!planAppDir('scripts', ctx('/w/josh-approved-factory')).error, true, 'an existing non-app dir → error');
  eq(planAppDir('scripts', ctx('/w/josh-approved-factory')).tried[0].why.startsWith('no '), true, 'non-app dir reason says what is missing');
  eq(!!planAppDir('/w/missing', ctx('/w')).error, true, 'absolute missing path → error, no sibling fallback');
  eq(planAppDir('/w/missing', ctx('/w')).tried.length, 1, 'a path is never retried as a sibling name');

  eq(isBareName('grocery-list'), true, 'isBareName plain');
  eq(isBareName('./grocery-list'), false, 'isBareName dot-path');
  eq(isBareName('..'), false, 'isBareName ..');
  eq(isBareName(''), false, 'isBareName empty');

  console.log(`app-dir self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.error('app-dir.mjs is a library. Run with --self-test.');
  process.exit(2);
}
