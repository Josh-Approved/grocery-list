#!/usr/bin/env node
/**
 * recomposite-tablet.mjs — erase the Pixel-tablet system taskbar/dock from a
 * capture by extending the app's own paper down over the dock band, then (if
 * given) pasting a saved corner FAB back on top.
 *
 * Why this exists: the Pixel-tablet AVD's system taskbar can't be hidden via adb
 * and overlaps a corner FAB in landscape/portrait captures. The clean fix is a
 * taskbar-disabled AVD, but until that's standard this is the deterministic
 * stopgap the runbook documented by hand (factory CLAUDE.md / P9 item 8) — now
 * scripted. It's a presentation cleanup for store/contact-sheet captures only;
 * it never runs against a baseline used for regression (visual-reg owns those).
 *
 * Approach: the dock sits in the bottom band of the frame. For each column we
 * sample the app pixel just ABOVE the band and extend it straight down — so the
 * app's background paper continues cleanly where the dock was. A `--fab` crop is
 * re-pasted at the chosen corner so an action button the dock covered survives.
 *
 * Usage:
 *   node scripts/qa/recomposite-tablet.mjs <capture.png> [--dock-frac 0.10]
 *        [--fab <fab.png> --fab-corner br|bl] [--out <path>]
 *   node scripts/qa/recomposite-tablet.mjs --self-test
 *
 * Dependency: pngjs (dev-dependency). Absent => skipped with a clear note.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------- pure core (exercised by --self-test) ----------

/**
 * Extend each column's paper down over the dock band. Pure on an RGBA buffer.
 * Samples the row at `bandTop - 1` per column and copies it down to the bottom.
 */
export function extendPaper(img, dockFrac) {
  const { width, height, data } = img;
  const bandTop = Math.max(1, Math.floor(height * (1 - dockFrac)));
  const out = new Uint8Array(data); // copy
  for (let x = 0; x < width; x++) {
    const srcRow = bandTop - 1;
    const si = (srcRow * width + x) * 4;
    for (let y = bandTop; y < height; y++) {
      const di = (y * width + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { width, height, data: out };
}

/** Paste a smaller RGBA `fab` into `img` at pixel (x0,y0). Pure. Clipped to bounds. */
export function pasteAt(img, fab, x0, y0) {
  const out = new Uint8Array(img.data);
  for (let y = 0; y < fab.height; y++) {
    for (let x = 0; x < fab.width; x++) {
      const dx = x0 + x, dy = y0 + y;
      if (dx < 0 || dy < 0 || dx >= img.width || dy >= img.height) continue;
      const si = (y * fab.width + x) * 4;
      if (fab.data[si + 3] === 0) continue; // skip transparent
      const di = (dy * img.width + dx) * 4;
      out[di] = fab.data[si]; out[di + 1] = fab.data[si + 1]; out[di + 2] = fab.data[si + 2]; out[di + 3] = fab.data[si + 3];
    }
  }
  return { width: img.width, height: img.height, data: out };
}

function selfTest() {
  let failures = 0;
  const ok = (c, m) => { if (!c) { failures++; console.error(`  ✗ ${m}`); } else { console.log(`  ✓ ${m}`); } };

  // 4x4: top 3 rows white paper, bottom row "dock" black. Extend should overwrite
  // the black row with the white sample.
  const W = 4, H = 4;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const isDock = i >= W * 3;
    const v = isDock ? 0 : 255;
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const ext = extendPaper({ width: W, height: H, data }, 0.25); // 0.25*4 = band of 1 row
  const lastRowStart = (W * 3) * 4;
  ok(ext.data[lastRowStart] === 255 && ext.data[lastRowStart + 1] === 255, 'extendPaper overwrites dock band with paper');
  ok(ext.data[0] === 255, 'extendPaper leaves the app area untouched');

  // pasteAt: a 1x1 red dot into the corner.
  const dot = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) };
  const pasted = pasteAt(ext, dot, 3, 0);
  ok(pasted.data[(0 * W + 3) * 4] === 255 && pasted.data[(0 * W + 3) * 4 + 1] === 0, 'pasteAt writes the fab pixel');
  const transparent = { width: 1, height: 1, data: new Uint8Array([9, 9, 9, 0]) };
  const pasted2 = pasteAt(ext, transparent, 0, 0);
  ok(pasted2.data[0] === 255, 'pasteAt skips fully-transparent fab pixels');

  console.log(failures === 0 ? '\nself-test PASSED' : `\nself-test FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  if (flags.has('--self-test')) return selfTest();

  const valueOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const VALUE = new Set(['--dock-frac', '--fab', '--fab-corner', '--out']);
  const src = args.find((a, i) => !a.startsWith('--') && !VALUE.has(args[i - 1]));
  if (!src) { console.error('Usage: recomposite-tablet.mjs <capture.png> [--dock-frac 0.10] [--fab f.png --fab-corner br] [--out p]'); process.exit(1); }
  const dockFrac = valueOf('--dock-frac') ? Number(valueOf('--dock-frac')) : 0.10;
  const out = valueOf('--out') || src;

  let PNG;
  try { ({ PNG } = await import('pngjs')); }
  catch {
    console.warn('recomposite-tablet: pngjs not installed — skipped (npm i -D pngjs).');
    return;
  }
  const read = (f) => { const p = PNG.sync.read(fs.readFileSync(f)); return { width: p.width, height: p.height, data: new Uint8Array(p.data) }; };
  const write = (f, img) => { const p = new PNG({ width: img.width, height: img.height }); p.data = Buffer.from(img.data); fs.writeFileSync(f, PNG.sync.write(p)); };

  let img = extendPaper(read(src), dockFrac);
  const fab = valueOf('--fab');
  if (fab && fs.existsSync(fab)) {
    const f = read(fab);
    const corner = valueOf('--fab-corner') || 'br';
    const pad = Math.round(img.width * 0.04);
    const x0 = corner.includes('l') ? pad : img.width - f.width - pad;
    const y0 = Math.floor(img.height * (1 - dockFrac)) - f.height - pad;
    img = pasteAt(img, f, x0, y0);
  }
  write(out, img);
  console.log(`recomposite-tablet: dock band (${(dockFrac * 100).toFixed(0)}%) recomposited → ${path.relative(process.cwd(), out)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
