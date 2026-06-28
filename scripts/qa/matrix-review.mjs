#!/usr/bin/env node
/**
 * matrix-review.mjs — prepare the ONE bounded reviewer pass per release.
 *
 * After a full matrix run, the net's single allowed token spend is one review of
 * one downscaled mega contact sheet against the fixed rubric (qa/review-rubric.md).
 * This script does the deterministic PREP — it assembles that one image and a
 * compact request manifest — and stops. It NEVER spawns an agent or reads images
 * in a loop; the recurring release/fleet-health job invokes exactly one bounded
 * reviewer agent with the manifest (see runbooks/device-quality-net.md §5).
 *
 * Output:
 *   qa/captures/matrix/contact-sheet.png   one montage: cells (rows) × screens
 *   qa/qa-review-request.json              { sheet, rubric, cells, screens, instruction }
 *
 * Zero npm deps — drives the user's installed Chrome headless, exactly like
 * render-screenshots.mjs's contact-sheet montage.
 *
 * Usage:
 *   node scripts/qa/matrix-review.mjs <app-dir> [--profile full]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findChrome } from '../lib/find-chrome.mjs';

function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; } finally { fs.closeSync(fd); }
}

const args = process.argv.slice(2);
const valueOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const appDir = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--profile') || process.cwd());
const profile = valueOf('--profile') || 'full';

// Source resolution: prefer the fresh full-res captures, but fall back to the
// tracked qa/baselines when captures are absent or sparse. Captures are
// gitignored + cleaned between runs; baselines are the committed canonical set,
// so the release-gate reviewer pass must be able to assemble its one sheet off
// committed state alone (token-free, no device). `--source captures|baselines`
// forces one; default = auto.
const cellCount = (d) => fs.existsSync(d)
  ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).length
  : 0;
const capturesDir = path.join(appDir, 'qa', 'captures', 'matrix');
const baselinesDir = path.join(appDir, 'qa', 'baselines');
const forced = valueOf('--source');
let matrixDir;
if (forced === 'captures') matrixDir = capturesDir;
else if (forced === 'baselines') matrixDir = baselinesDir;
else matrixDir = cellCount(capturesDir) >= cellCount(baselinesDir) && cellCount(capturesDir) > 0
  ? capturesDir : baselinesDir;
if (cellCount(matrixDir) === 0) {
  console.error('matrix-review: no cells in qa/captures/matrix or qa/baselines — run matrix.mjs first.');
  process.exit(1);
}
if (matrixDir === baselinesDir) console.log('matrix-review: building sheet from qa/baselines (tracked canonical set).');

const cells = fs.readdirSync(matrixDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();

// Lay out one row per cell, one thumb per screen. Compact + downscaled.
const ROW_H = 220, GAP = 10, PAD = 16, LABEL_W = 150, CAP_H = 18;
const allScreens = new Set();
const rows = [];
for (const cell of cells) {
  const dir = path.join(matrixDir, cell);
  const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  const thumbs = pngs.map((name) => {
    const s = pngSize(path.join(dir, name)) || { w: 9, h: 19 };
    allScreens.add(name.replace(/\.png$/, ''));
    return { screen: name.replace(/\.png$/, ''), w: Math.round((s.w / s.h) * ROW_H), url: pathToFileURL(path.join(dir, name)).href };
  });
  if (thumbs.length) rows.push({ cell, thumbs });
}

if (rows.length === 0) {
  console.error('matrix-review: matrix dir has no captured PNGs yet.');
  process.exit(1);
}

let y = PAD, canvasW = 0;
const nodes = [];
for (const row of rows) {
  nodes.push(`<div class="lab" style="left:${PAD}px;top:${y}px;width:${LABEL_W}px;height:${ROW_H}px">${row.cell}</div>`);
  let x = PAD + LABEL_W + GAP;
  for (const t of row.thumbs) {
    nodes.push(`<div class="cell" style="left:${x}px;top:${y}px;width:${t.w}px">` +
      `<img src="${t.url}" style="height:${ROW_H}px;width:${t.w}px">` +
      `<div class="cap">${t.screen}</div></div>`);
    x += t.w + GAP;
  }
  canvasW = Math.max(canvasW, x - GAP + PAD);
  y += ROW_H + CAP_H + GAP;
}
const canvasH = y - GAP + PAD;

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#fff}
  .cell{position:absolute;font:11px -apple-system,Segoe UI,Roboto,sans-serif;color:#3a3a3c}
  .cell img{display:block;border:1px solid #e5e5e5;border-radius:5px;object-fit:contain}
  .cap{height:${CAP_H}px;line-height:${CAP_H}px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .lab{position:absolute;font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;display:flex;align-items:center}
</style><body>${nodes.join('')}</body>`;

const htmlPath = path.join(os.tmpdir(), `matrix-sheet-${process.pid}.html`);
fs.writeFileSync(htmlPath, html);
// Always write the sheet into the gitignored captures dir — never into the
// tracked baselines dir, even when baselines were the source.
fs.mkdirSync(capturesDir, { recursive: true });
const outPath = path.join(capturesDir, 'contact-sheet.png');
const chromePath = findChrome();
const r = spawnSync(chromePath, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
  '--force-device-scale-factor=1', `--window-size=${canvasW},${canvasH}`,
  `--screenshot=${outPath}`, '--virtual-time-budget=5000', pathToFileURL(htmlPath).href,
], { stdio: 'pipe' });
fs.rmSync(htmlPath, { force: true });

if (r.status !== 0 || !fs.existsSync(outPath)) {
  console.error(`matrix-review: chrome exited ${r.status} — sheet not written.`);
  if (r.stderr) console.error(r.stderr.toString().split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

const request = {
  app: path.basename(appDir),
  profile,
  sheet: path.relative(appDir, outPath),
  rubric: 'qa/review-rubric.md',
  cells,
  screens: [...allScreens].sort(),
  instruction: 'ONE bounded reviewer pass: read the sheet + rubric once, write findings to qa/qa-triage.json under reviewerPass. No follow-up loops, no full-res reads. This is the only AI in the device net.',
};
fs.writeFileSync(path.join(appDir, 'qa', 'qa-review-request.json'), JSON.stringify(request, null, 2) + '\n');

console.log(`matrix-review: wrote ${request.sheet} (${rows.length} cells × ${allScreens.size} screens, ${canvasW}×${canvasH}).`);
console.log(`  request manifest: qa/qa-review-request.json — the release job runs ONE reviewer pass against qa/review-rubric.md.`);
