// render-screenshots.mjs — generate framed store screenshots for an app.
//
// Usage:
//   node scripts/render-screenshots.mjs <app-name> [--store ios|android|chrome|ipad] [--shot <id>]
//   node scripts/render-screenshots.mjs <app-name> --contact-sheet [--store ios]
//
// Reads <app>/qa/screenshots.config.json. For each shot, drives the user's
// installed Chrome in headless mode against templates/screenshots/frame.html
// and writes the framed PNG to <app>/store-assets/screenshots/<store>/<n>-<id>.png.
// Raw captures (the input) live at <app>/qa/captures/ — populated by Layer 2
// e2e flows (Maestro/Playwright), or dropped manually for one-offs.
//
// --contact-sheet mode: instead of rendering, packs the ALREADY-framed PNGs of
// each store into a single downscaled montage (≤1000px wide) at
// <app>/store-assets/contact-sheet[-<store>].png. This is the token-cheap way
// to eyeball a whole set — one small image, never two dozen full-res phone PNGs
// (which also get rejected in many-image agent requests). The capture
// orchestrator renders first, then calls this; it can also be run standalone.
//
// Each store key maps to one or more render VARIANTS. Most stores are a single
// variant; Google Play tablets are two (the 7" and 10" slots are separate
// uploads), so one `androidTablet` config entry fans out into both sets — no
// config duplication. Every output filename carries the variant's `label` so a
// store's asset manager (Play in particular hides the source folder) shows at a
// glance which file is phone vs 7" tablet vs 10" tablet.
//
//   ios            — 1320 x 2868   Apple 6.9" iPhone 17 Pro Max (largest iPhone; upload to
//                                  the 6.9" shelf, ASC scales it down to every smaller iPhone)
//   ipad           — 2064 x 2752   Apple 13" iPad (REQUIRED when supportsTablet:true)
//   android        — 1080 x 1920   Google Play phone
//   androidTablet  — 1206 x 2144   Play 7" tablet slot  ┐ both 9:16, both within Play's
//                  — 1440 x 2560   Play 10" tablet slot ┘ tablet constraints (side 320–3840,
//                                  long ≤ 2× short); Play wants a set per declared slot
//   chrome         — 1280 x  800   Chrome Web Store
//
// dir   — output subfolder under store-assets/screenshots/
// label — filename infix (…/<NN>-<label>-<id>.png), so files self-describe their device

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from './lib/find-chrome.mjs';

const SURFACES = {
  ios:     [{ surface: 'iphone',  width: 1320, height: 2868, dir: 'ios',     label: 'iphone-6.9in' }],
  ipad:    [{ surface: 'ipad',    width: 2064, height: 2752, dir: 'ipad',    label: 'ipad-13in' }],
  android: [{ surface: 'android', width: 1080, height: 1920, dir: 'android', label: 'android-phone' }],
  androidTablet: [
    { surface: 'android-tablet', width: 1206, height: 2144, dir: 'androidTablet-7in',  label: 'android-tablet-7in' },
    { surface: 'android-tablet', width: 1440, height: 2560, dir: 'androidTablet-10in', label: 'android-tablet-10in' },
  ],
  chrome:  [{ surface: 'chrome',  width: 1280, height:  800, dir: 'chrome',  label: 'chrome' }],
};

// ---------- contact-sheet montage ----------

// Read a PNG's intrinsic pixel size straight from the IHDR chunk — zero deps.
// PNG layout: 8-byte signature, then a length(4)+"IHDR"(4) chunk header, then
// width(4) + height(4), big-endian, starting at byte 16.
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Pack a store's framed PNGs into one downscaled montage. Deterministic: we
// read each PNG's real size, scale every thumb to a fixed row height, greedily
// wrap rows under a fixed content width, compute the exact canvas, then let
// headless Chrome screenshot an absolutely-positioned HTML page at that size.
function buildContactSheets(appDir, only, screensRootOverride) {
  const chromePath = findChrome();
  const screensRoot = screensRootOverride || path.join(appDir, 'store-assets', 'screenshots');
  if (!fs.existsSync(screensRoot)) {
    console.error(`No framed screenshots at ${screensRoot} — render before --contact-sheet.`);
    process.exit(1);
  }

  // A "sheet" is one output dir of framed PNGs (the same grain render writes:
  // ios, android, androidTablet-7in, …). --store filters by the store key,
  // expanding to that key's variant dirs.
  const wantDirs = only
    ? (SURFACES[only] || []).map((v) => v.dir)
    : fs.readdirSync(screensRoot).filter((d) =>
        fs.statSync(path.join(screensRoot, d)).isDirectory());
  if (only && wantDirs.length === 0) {
    console.error(`Unknown store "${only}". Choose from: ${Object.keys(SURFACES).join(', ')}`);
    process.exit(1);
  }

  const ROW_H = 300;   // thumb height in px (aspect preserved)
  const MAX_W = 960;   // content width — keeps the sheet ≤ ~1000px wide
  const GAP = 14;
  const CAP_H = 26;    // caption strip under each thumb
  const PAD = 20;

  let made = 0;
  for (const dir of wantDirs.sort()) {
    const abs = path.join(screensRoot, dir);
    if (!fs.existsSync(abs)) continue;
    const pngs = fs.readdirSync(abs).filter((f) => f.endsWith('.png')).sort();
    if (pngs.length === 0) continue;

    // Lay thumbs out into rows, wrapping when the next thumb would overflow.
    const thumbs = pngs.map((name) => {
      const size = pngSize(path.join(abs, name)) || { w: 9, h: 19 };
      const w = Math.round((size.w / size.h) * ROW_H);
      return { name, w, h: ROW_H, url: pathToFileURL(path.join(abs, name)).href };
    });
    const rows = [];
    let row = [];
    let rowW = 0;
    for (const t of thumbs) {
      const add = (row.length ? GAP : 0) + t.w;
      if (row.length && rowW + add > MAX_W) {
        rows.push(row);
        row = [];
        rowW = 0;
      }
      row.push(t);
      rowW += (row.length > 1 ? GAP : 0) + t.w;
    }
    if (row.length) rows.push(row);

    // Place absolutely so the canvas size is known exactly (no reflow surprises).
    let y = PAD;
    let canvasW = 0;
    const cells = [];
    for (const r of rows) {
      let x = PAD;
      for (const t of r) {
        cells.push(
          `<div class="cell" style="left:${x}px;top:${y}px;width:${t.w}px">` +
          `<img src="${t.url}" style="height:${ROW_H}px;width:${t.w}px">` +
          `<div class="cap">${t.name.replace(/\.png$/, '')}</div></div>`
        );
        x += t.w + GAP;
      }
      canvasW = Math.max(canvasW, x - GAP + PAD);
      y += ROW_H + CAP_H + GAP;
    }
    const canvasH = y - GAP + PAD;

    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;background:#fff}
      .cell{position:absolute;font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#3a3a3c}
      .cell img{display:block;border:1px solid #e5e5e5;border-radius:6px;object-fit:contain}
      .cap{height:${CAP_H}px;line-height:${CAP_H}px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    </style><body>${cells.join('')}</body>`;

    const htmlPath = path.join(os.tmpdir(), `contact-${dir}-${process.pid}.html`);
    fs.writeFileSync(htmlPath, html);
    const outPath = path.join(path.dirname(screensRoot), `contact-sheet-${dir}.png`);

    const result = spawnSync(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-sandbox',
      '--force-device-scale-factor=1',
      `--window-size=${canvasW},${canvasH}`,
      `--screenshot=${outPath}`,
      '--virtual-time-budget=4000',
      pathToFileURL(htmlPath).href,
    ], { stdio: 'pipe' });
    fs.rmSync(htmlPath, { force: true });

    if (result.status !== 0 || !fs.existsSync(outPath)) {
      console.warn(`  [fail] ${dir}: chrome exited ${result.status}`);
      if (result.stderr) console.warn(result.stderr.toString().split('\n').slice(0, 5).join('\n'));
      continue;
    }
    made++;
    console.log(`  [ok]   ${path.relative(appDir, outPath)}  (${pngs.length} shots, ${canvasW}×${canvasH})`);
  }

  console.log('');
  console.log(`Contact sheet: ${made} montage${made === 1 ? '' : 's'} written.`);
  process.exit(made > 0 ? 0 : 2);
}

const args = process.argv.slice(2);
// Track indices that follow a value-taking flag so they aren't mistaken
// for the optional <app-name> positional (factory mode).
const VALUE_FLAGS = new Set(['--store', '--shot', '--out', '--config']);
const consumedAsValue = new Set();
for (let i = 0; i < args.length; i++) {
  if (VALUE_FLAGS.has(args[i])) consumedAsValue.add(i + 1);
}
const positional = args.filter((a, i) => !a.startsWith('--') && !consumedAsValue.has(i));
const appNameArg = positional[0];
const storeFlagIdx = args.indexOf('--store');
const onlyStore = storeFlagIdx >= 0 ? args[storeFlagIdx + 1] : null;
const shotFlagIdx = args.indexOf('--shot');
const onlyShot = shotFlagIdx >= 0 ? args[shotFlagIdx + 1] : null;
const contactSheet = args.includes('--contact-sheet');
// --out <dir>     write framed PNGs under <dir>/<surface.dir>/ instead of
//                 <app>/store-assets/screenshots/ (preview renders that must NOT
//                 mutate an app's committed store assets).
// --config <path> read the slot config from <path> instead of the app's own
//                 qa/screenshots.config.json (prototype a look without editing it).
const outFlagIdx = args.indexOf('--out');
const outBaseOverride = outFlagIdx >= 0 ? path.resolve(args[outFlagIdx + 1]) : null;
const configFlagIdx = args.indexOf('--config');
const configOverride = configFlagIdx >= 0 ? path.resolve(args[configFlagIdx + 1]) : null;

if (onlyStore && !SURFACES[onlyStore]) {
  console.error(`Unknown store "${onlyStore}". Choose from: ${Object.keys(SURFACES).join(', ')}`);
  process.exit(1);
}

// Two run modes:
//   factory mode:  node <factory>/scripts/render-screenshots.mjs <app-name>
//   vendored mode: node <app>/scripts/render-screenshots.mjs        (no app-name arg)
//
// In factory mode, the script lives at <factory>/scripts/, so frame.html is
// at <factory>/templates/screenshots/frame.html. In vendored mode the script
// lives at <app>/scripts/ and frame.html is at <app>/qa/frame.html.
const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const scriptParent = path.dirname(scriptDir);

let appDir, framePath;
if (appNameArg) {
  // factory mode
  const factoryDir = scriptParent;
  appDir = path.join(path.dirname(factoryDir), appNameArg);
  framePath = path.join(factoryDir, 'templates', 'screenshots', 'frame.html');
} else {
  // vendored mode — script lives at <app>/scripts/; <app> is its parent
  appDir = scriptParent;
  framePath = path.join(appDir, 'qa', 'frame.html');
}

const configPath = configOverride || path.join(appDir, 'qa', 'screenshots.config.json');
const frameUrl = pathToFileURL(framePath).href;

if (!fs.existsSync(appDir)) {
  console.error(`App directory not found: ${appDir}`);
  process.exit(1);
}

// --contact-sheet short-circuits the normal render: it montages the framed
// PNGs that already exist under store-assets/screenshots/. Nothing to render,
// no frame.html / config needed.
if (contactSheet) {
  buildContactSheets(appDir, onlyStore, outBaseOverride);
  // buildContactSheets calls process.exit itself.
}

if (!fs.existsSync(framePath)) {
  console.error(`frame.html not found at ${framePath}`);
  console.error(`In vendored mode, the framer expects qa/frame.html alongside qa/screenshots.config.json.`);
  process.exit(1);
}
if (!fs.existsSync(configPath)) {
  console.error(`No screenshots.config.json at ${configPath}`);
  console.error(`Copy templates/qa/screenshots.config.example.json into <app>/qa/ to get started.`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Per-app look. The accent is read from the app's own appAccent.ts (one source
// of truth) unless the config overrides it. style/motif are app-wide defaults
// any per-slot field can override. Default style "flat" reproduces the original
// output exactly, so an un-migrated app renders byte-for-byte as before.
function readAppAccent(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, 'src', 'theme', 'appAccent.ts'), 'utf8').match(/#[0-9A-Fa-f]{6}/);
    return m ? m[0] : null;
  } catch { return null; }
}
const appAccent = config.accent || readAppAccent(appDir);
const appStyle = config.style || 'flat';
const appMotif = config.motif || (appStyle === 'signature' ? 'dots' : 'none');

const stores = onlyStore ? [onlyStore] : Object.keys(config.stores || {});
if (stores.length === 0) {
  console.error('No stores defined in screenshots.config.json.');
  process.exit(1);
}

const chromePath = findChrome();
console.log(`Chrome: ${chromePath}`);
console.log(`App:    ${appDir}`);
console.log('');

let total = 0;
let written = 0;

for (const storeKey of stores) {
  const variants = SURFACES[storeKey];
  if (!variants) {
    console.warn(`  Skipping unknown store "${storeKey}" in config.`);
    continue;
  }
  const shots = config.stores[storeKey] || [];
  if (shots.length === 0) {
    console.log(`[${storeKey}] no shots defined, skipping.`);
    continue;
  }

  // A store key may render into several variants (e.g. Play 7" + 10" tablet).
  for (const surface of variants) {
    const outDir = path.join(outBaseOverride || path.join(appDir, 'store-assets', 'screenshots'), surface.dir);
    fs.mkdirSync(outDir, { recursive: true });

    // On a full render, clear stale PNGs first so a removed/renamed slot (or an
    // old naming convention) can't leave orphans behind. This is the root-cause
    // fix for grocery-list's "two 1s, two 2s, one 4" mess: the framer used to
    // only ever ADD files, so dropping the `share` slot + the label-infix rename
    // left three overlapping generations on disk. A targeted `--shot` re-render
    // deliberately skips this so it can refresh one slot without wiping siblings.
    if (!onlyShot) {
      const removed = fs.readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.png'));
      for (const f of removed) fs.rmSync(path.join(outDir, f), { force: true });
      if (removed.length) console.log(`[${storeKey}] cleared ${removed.length} stale PNG${removed.length === 1 ? '' : 's'} in ${path.relative(appDir, outDir)}`);
    }

    console.log(`[${storeKey}${variants.length > 1 ? ` · ${surface.label}` : ''}] ${shots.length} shot${shots.length === 1 ? '' : 's'} → ${path.relative(appDir, outDir)}`);

    shots.forEach((shot, i) => {
      if (onlyShot && shot.id !== onlyShot) return;
      total++;

      // Two shot kinds: an app screen framed in device chrome (default), or a
      // generated card with no source file (currently only the Josh Approved
      // slot-2 card; identical across every app).
      // Shared "look" params (style/theme/motif/accent) ride every shot; the
      // per-slot fields (bg→theme, style, motif) override the app-wide defaults.
      const theme = shot.theme || (shot.bg === 'ink' ? 'dark' : 'light');
      const style = shot.style || appStyle;
      const motifVal = shot.motif || appMotif;
      const look = `&style=${encodeURIComponent(style)}`
        + `&theme=${encodeURIComponent(theme)}`
        + `&motif=${encodeURIComponent(motifVal)}`
        + (appAccent ? `&accent=${encodeURIComponent(appAccent)}` : '');

      let url;
      if (shot.kind === 'card') {
        url = `${frameUrl}?surface=josh-card`
          + look
          + `&bg=${encodeURIComponent(shot.bg || 'paper')}`;
      } else {
        const sourcePath = path.isAbsolute(shot.source)
          ? shot.source
          : path.join(appDir, 'qa', 'captures', shot.source);
        if (!fs.existsSync(sourcePath)) {
          console.warn(`  [skip] ${shot.id}: source not found — ${path.relative(appDir, sourcePath)}`);
          return;
        }
        const screenUrl = pathToFileURL(sourcePath).href;
        url = `${frameUrl}?surface=${surface.surface}`
          + `&screen=${encodeURIComponent(screenUrl)}`
          + `&caption=${encodeURIComponent(shot.caption || '')}`
          + look
          + `&layout=${encodeURIComponent(shot.layout || 'hero')}`
          + (shot.crop ? `&crop=${encodeURIComponent(shot.crop)}` : '')
          + `&bg=${encodeURIComponent(shot.bg || 'paper')}`;
      }

      // Filename carries the device label so each PNG self-describes in a
      // store's asset manager: <NN>-<label>-<id>.png.
      const seq = String(i + 1).padStart(2, '0');
      const fileName = `${seq}-${surface.label}-${shot.id}.png`;
      const outPath = path.join(outDir, fileName);

      const result = spawnSync(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-sandbox',
        '--default-background-color=00000000',
        `--window-size=${surface.width},${surface.height}`,
        `--screenshot=${outPath}`,
        // Wait long enough for fonts + image to load, then capture.
        '--virtual-time-budget=4000',
        url,
      ], { stdio: 'pipe' });

      if (result.status !== 0 || !fs.existsSync(outPath)) {
        console.warn(`  [fail] ${shot.id}: chrome exited ${result.status}`);
        if (result.stderr) console.warn(result.stderr.toString().split('\n').slice(0, 5).join('\n'));
        return;
      }
      written++;
      console.log(`  [ok]   ${surface.dir}/${fileName}`);
    });
  }
}

console.log('');
console.log(`Done. ${written}/${total} shot${total === 1 ? '' : 's'} written.`);
if (written < total) process.exit(2);
