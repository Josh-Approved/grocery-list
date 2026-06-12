#!/usr/bin/env node
/**
 * visual-reg.mjs — the self-learning visual-regression layer of the device net.
 *
 * Per device-cell x key screen we keep a tracked BASELINE image (downscaled 2x,
 * so a whole app's baselines stay well under the ~10MB/app cap). Each full matrix
 * run diffs the freshly captured screen against its baseline with pixelmatch
 * (deterministic). A diff over threshold is a REGRESSION — it never edits the
 * baseline; it writes a side-by-side crop + a triage proposal. Baselines update
 * ONLY via `--accept` (the triage-accept path) — exactly heal.mjs doctrine:
 * intended changes teach the net, regressions get caught. First full run, with
 * no baselines yet, is the baseline-LOCK.
 *
 * This is token-free: the agent never looks at these images in a loop. It reads
 * the compact proposals in qa/qa-triage.json (and, per release, the ONE bounded
 * contact-sheet review). Regressions are a structured list, not a screenshot dump.
 *
 * Modes:
 *   (default)        diff every current capture vs its baseline; lock any that
 *                    have no baseline yet (first run); regressions -> triage.
 *   --lock           force-adopt every current capture as the baseline (re-lock).
 *   --accept <sel>   promote current -> baseline for a cell/screen ("cell/screen"),
 *                    a whole cell ("cell"), or "all". The self-learning accept.
 *
 * Layout:
 *   qa/captures/matrix/<cell>/<screen>.png   current (written by capture.mjs --cell)
 *   qa/baselines/<cell>/<screen>.png         tracked baseline (downscaled 2x)
 *   qa/captures/matrix/.diffs/<cell>__<screen>.png   regression diff (gitignored)
 *
 * Usage:
 *   node scripts/qa/visual-reg.mjs <app-dir> [--profile full] [--threshold 0.01]
 *   node scripts/qa/visual-reg.mjs <app-dir> --lock
 *   node scripts/qa/visual-reg.mjs <app-dir> --accept all
 *   node scripts/qa/visual-reg.mjs --self-test
 *
 * Dependency: pixelmatch + pngjs (dev-dependencies; bootstrap installs them).
 * If absent, the diff is SKIPPED with a clear note (never a hard failure) so an
 * app that hasn't installed them stays green.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_THRESHOLD = 0.01;     // fraction of pixels that may differ before it's a regression
const PER_PIXEL_THRESHOLD = 0.1;    // pixelmatch per-pixel sensitivity (0..1)
const BASELINE_CAP_BYTES = 10 * 1024 * 1024;

// ---------- pure logic (exercised by --self-test) ----------

/**
 * Box-average 2x downscale of an RGBA buffer. Deterministic (integer math), no
 * float ambiguity across runs. Returns { width, height, data }.
 */
export function downscale2x(img) {
  const { width, height, data } = img;
  const w2 = Math.max(1, width >> 1);
  const h2 = Math.max(1, height >> 1);
  const out = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const sx = x * 2, sy = y * 2;
      for (let c = 0; c < 4; c++) {
        const i00 = ((sy) * width + sx) * 4 + c;
        const i01 = ((sy) * width + Math.min(sx + 1, width - 1)) * 4 + c;
        const i10 = ((Math.min(sy + 1, height - 1)) * width + sx) * 4 + c;
        const i11 = ((Math.min(sy + 1, height - 1)) * width + Math.min(sx + 1, width - 1)) * 4 + c;
        out[(y * w2 + x) * 4 + c] = (data[i00] + data[i01] + data[i10] + data[i11] + 2) >> 2;
      }
    }
  }
  return { width: w2, height: h2, data: out };
}

/** Classify a diff into a regression decision. Pure. */
export function classifyDiff(numDiffPixels, totalPixels, threshold = DEFAULT_THRESHOLD) {
  const ratio = totalPixels > 0 ? numDiffPixels / totalPixels : 0;
  return { ratio: +ratio.toFixed(5), regression: ratio > threshold, numDiffPixels, totalPixels };
}

/** Parse an --accept selector into a predicate over (cell, screen). Pure. */
export function acceptMatcher(sel) {
  if (!sel || sel === 'all') return () => true;
  const [cell, screen] = sel.split('/');
  return (c, s) => c === cell && (!screen || s === screen);
}

// ---------- self-test ----------

function selfTest() {
  let failures = 0;
  const ok = (cond, msg) => { if (!cond) { failures++; console.error(`  ✗ ${msg}`); } else { console.log(`  ✓ ${msg}`); } };

  // downscale2x: a 2x2 solid block -> 1x1 of the same colour.
  const solid = { width: 2, height: 2, data: new Uint8Array([10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255]) };
  const ds = downscale2x(solid);
  ok(ds.width === 1 && ds.height === 1, `downscale2x halves dims (got ${ds.width}x${ds.height})`);
  ok(ds.data[0] === 10 && ds.data[1] === 20 && ds.data[2] === 30 && ds.data[3] === 255, 'downscale2x averages a solid block to itself');

  // averaging: two black + two white -> mid grey (128 with +2 rounding -> 128).
  const mixed = { width: 2, height: 2, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]) };
  const dm = downscale2x(mixed);
  ok(dm.data[0] === 128, `downscale2x averages mixed block (got ${dm.data[0]}, want 128)`);

  // classifyDiff
  ok(classifyDiff(0, 1000).regression === false, 'zero diff is not a regression');
  ok(classifyDiff(5, 1000, 0.01).regression === false, '0.5% diff under 1% threshold is not a regression');
  ok(classifyDiff(50, 1000, 0.01).regression === true, '5% diff over 1% threshold is a regression');
  ok(classifyDiff(50, 1000, 0.01).ratio === 0.05, 'ratio computed correctly');

  // acceptMatcher
  ok(acceptMatcher('all')('any', 'thing') === true, 'accept all matches everything');
  const m = acceptMatcher('iphone-light-f1.0-portrait/list');
  ok(m('iphone-light-f1.0-portrait', 'list') === true, 'accept cell/screen matches exactly');
  ok(m('iphone-light-f1.0-portrait', 'detail') === false, 'accept cell/screen rejects other screen');
  const mc = acceptMatcher('iphone-light-f1.0-portrait');
  ok(mc('iphone-light-f1.0-portrait', 'anything') === true, 'accept cell matches all its screens');

  console.log(failures === 0 ? '\nself-test PASSED' : `\nself-test FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- image I/O (lazy: only when actually diffing) ----------

async function loadPngLib() {
  try {
    const [{ PNG }, pixelmatchMod] = await Promise.all([import('pngjs'), import('pixelmatch')]);
    return { PNG, pixelmatch: pixelmatchMod.default || pixelmatchMod };
  } catch {
    return null;
  }
}

function readPng(PNG, file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

function writePng(PNG, file, img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

// ---------- helpers ----------

function listCells(matrixDir) {
  if (!fs.existsSync(matrixDir)) return [];
  return fs.readdirSync(matrixDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}
function listScreens(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''));
}

function baselineBytes(baselineRoot) {
  let total = 0;
  const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
  walk(baselineRoot);
  return total;
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  if (flags.has('--self-test')) return selfTest();

  const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const VALUE_FLAGS = new Set(['--profile', '--threshold', '--accept']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
  const appDir = path.resolve(positional[0] || process.cwd());
  const threshold = valueOf('--threshold') ? Number(valueOf('--threshold')) : DEFAULT_THRESHOLD;
  const dry = flags.has('--dry-run');

  const matrixDir = path.join(appDir, 'qa', 'captures', 'matrix');
  const baselineRoot = path.join(appDir, 'qa', 'baselines');
  const diffsRoot = path.join(matrixDir, '.diffs');

  const cells = listCells(matrixDir);
  if (cells.length === 0) {
    console.log('visual-reg: no captured cells under qa/captures/matrix/ — run matrix.mjs first.');
    return;
  }

  const lib = dry ? null : await loadPngLib();
  if (!dry && !lib) {
    console.warn('visual-reg: pixelmatch/pngjs not installed — diff SKIPPED (not a failure).\n' +
      '  Install once: npm i -D pixelmatch pngjs   (bootstrap installs them for new apps)');
    // Record a pending status so a reader knows the layer ran but couldn't diff.
    fs.writeFileSync(path.join(appDir, 'qa', 'visual-reg.json'),
      JSON.stringify({ app: path.basename(appDir), status: 'skipped', reason: 'pixelmatch/pngjs not installed' }, null, 2) + '\n');
    return;
  }

  // --accept: promote current -> baseline (downscaled). The self-learning path.
  if (flags.has('--accept')) {
    const matcher = acceptMatcher(valueOf('--accept'));
    let accepted = 0;
    for (const cell of cells) {
      for (const screen of listScreens(path.join(matrixDir, cell))) {
        if (!matcher(cell, screen)) continue;
        const cur = readPng(lib.PNG, path.join(matrixDir, cell, `${screen}.png`));
        writePng(lib.PNG, path.join(baselineRoot, cell, `${screen}.png`), downscale2x(cur));
        accepted++;
      }
    }
    console.log(`visual-reg: accepted ${accepted} baseline(s) → qa/baselines/`);
    return;
  }

  const forceLock = flags.has('--lock');
  const proposals = [];
  let locked = 0, compared = 0, regressions = 0;

  for (const cell of cells) {
    for (const screen of listScreens(path.join(matrixDir, cell))) {
      const curPath = path.join(matrixDir, cell, `${screen}.png`);
      const basePath = path.join(baselineRoot, cell, `${screen}.png`);
      if (dry) { console.log(`  would compare ${cell}/${screen}`); continue; }

      const curSmall = downscale2x(readPng(lib.PNG, curPath));

      if (forceLock || !fs.existsSync(basePath)) {
        writePng(lib.PNG, basePath, curSmall);
        locked++;
        continue;
      }

      const base = readPng(lib.PNG, basePath);
      // Dimensions must match to diff; if the baseline was captured at a
      // different device size, re-lock it (a device/sim change, not a regression).
      if (base.width !== curSmall.width || base.height !== curSmall.height) {
        writePng(lib.PNG, basePath, curSmall);
        proposals.push({ kind: 'visual/dimension-change', cell, screen, severity: 'minor',
          summary: `${cell}/${screen} baseline re-locked (size ${base.width}x${base.height} -> ${curSmall.width}x${curSmall.height})`,
          suggestedAction: 'a device/sim resolution change, not a regression — baseline adopted automatically' });
        continue;
      }

      const diff = { width: base.width, height: base.height, data: new Uint8Array(base.width * base.height * 4) };
      const numDiff = lib.pixelmatch(base.data, curSmall.data, diff.data, base.width, base.height, { threshold: PER_PIXEL_THRESHOLD });
      const verdict = classifyDiff(numDiff, base.width * base.height, threshold);
      compared++;
      if (verdict.regression) {
        regressions++;
        const diffPath = path.join(diffsRoot, `${cell}__${screen}.png`);
        writePng(lib.PNG, diffPath, diff);
        proposals.push({
          kind: 'visual/regression', cell, screen, severity: 'major',
          ratio: verdict.ratio,
          summary: `${cell}/${screen} changed ${(verdict.ratio * 100).toFixed(2)}% vs baseline (threshold ${(threshold * 100).toFixed(2)}%)`,
          diff: path.relative(appDir, diffPath),
          suggestedAction: `If this change is intended, accept it: node scripts/qa/visual-reg.mjs . --accept ${cell}/${screen}. Otherwise it's a real regression — fix the UI.`,
        });
      }
    }
  }

  if (dry) return;

  // Hard cap: keep an app's tracked baselines well under 10MB.
  const bytes = baselineBytes(baselineRoot);
  if (bytes > BASELINE_CAP_BYTES) {
    console.warn(`visual-reg: baselines are ${(bytes / 1048576).toFixed(1)}MB (> 10MB cap) — prune cells/screens or raise downscale.`);
  }

  // Merge visual proposals into the existing triage file (don't clobber other kinds).
  const triagePath = path.join(appDir, 'qa', 'qa-triage.json');
  let triage = {};
  try { triage = JSON.parse(fs.readFileSync(triagePath, 'utf8')); } catch {}
  triage.visualReg = { profile: valueOf('--profile') || 'full', compared, regressions, locked, proposals, capBytes: bytes };
  fs.mkdirSync(path.dirname(triagePath), { recursive: true });
  fs.writeFileSync(triagePath, JSON.stringify(triage, null, 2) + '\n');
  fs.writeFileSync(path.join(appDir, 'qa', 'visual-reg.json'),
    JSON.stringify({ app: path.basename(appDir), status: 'ok', compared, regressions, locked, proposals, capBytes: bytes }, null, 2) + '\n');

  console.log(`visual-reg: ${locked} locked, ${compared} compared, ${regressions} regression(s).`);
  if (regressions > 0) {
    console.log(`  regressions (read qa/qa-triage.json → visualReg):`);
    for (const p of proposals.filter((p) => p.kind === 'visual/regression')) console.log(`    · ${p.summary}`);
    console.log(`  Accept an intended change: node scripts/qa/visual-reg.mjs . --accept <cell>/<screen>`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
