// render-screenshots.mjs — generate framed store screenshots for an app.
//
// Usage:
//   node scripts/render-screenshots.mjs <app-name> [--store ios|android|chrome|ipad] [--shot <id>]
//
// Reads <app>/qa/screenshots.config.json. For each shot, drives the user's
// installed Chrome in headless mode against templates/screenshots/frame.html
// and writes the framed PNG to <app>/store-assets/screenshots/<store>/<n>-<id>.png.
// Raw captures (the input) live at <app>/qa/captures/ — populated by Layer 2
// e2e flows (Maestro/Playwright), or dropped manually for one-offs.
//
// Surface dimensions (canonical, from canonical-store-listings.md):
//   ios     — 1290 x 2796   (Apple 6.9" iPhone)
//   ipad    — 2064 x 2752   (Apple 13" iPad)
//   android — 1080 x 1920   (Google Play phone)
//   chrome  — 1280 x  800   (Chrome Web Store)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from './lib/find-chrome.mjs';

const SURFACES = {
  ios:     { surface: 'iphone',  width: 1290, height: 2796 },
  ipad:    { surface: 'ipad',    width: 2064, height: 2752 },
  android: { surface: 'android', width: 1080, height: 1920 },
  chrome:  { surface: 'chrome',  width: 1280, height:  800 },
};

const args = process.argv.slice(2);
// Track indices that follow a value-taking flag so they aren't mistaken
// for the optional <app-name> positional (factory mode).
const VALUE_FLAGS = new Set(['--store', '--shot']);
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

const configPath = path.join(appDir, 'qa', 'screenshots.config.json');
const frameUrl = pathToFileURL(framePath).href;

if (!fs.existsSync(appDir)) {
  console.error(`App directory not found: ${appDir}`);
  process.exit(1);
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
  const surface = SURFACES[storeKey];
  if (!surface) {
    console.warn(`  Skipping unknown store "${storeKey}" in config.`);
    continue;
  }
  const shots = config.stores[storeKey] || [];
  if (shots.length === 0) {
    console.log(`[${storeKey}] no shots defined, skipping.`);
    continue;
  }

  const outDir = path.join(appDir, 'store-assets', 'screenshots', storeKey);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[${storeKey}] ${shots.length} shot${shots.length === 1 ? '' : 's'} → ${path.relative(appDir, outDir)}`);

  shots.forEach((shot, i) => {
    if (onlyShot && shot.id !== onlyShot) return;
    total++;

    // Two shot kinds: an app screen framed in device chrome (default), or a
    // generated card with no source file (currently only the Josh Approved
    // slot-2 card; identical across every app).
    let url;
    if (shot.kind === 'card') {
      url = `${frameUrl}?surface=josh-card`
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
        + `&bg=${encodeURIComponent(shot.bg || 'paper')}`;
    }

    const seq = String(i + 1).padStart(2, '0');
    const outPath = path.join(outDir, `${seq}-${shot.id}.png`);

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
    console.log(`  [ok]   ${seq}-${shot.id}.png`);
  });
}

console.log('');
console.log(`Done. ${written}/${total} shot${total === 1 ? '' : 's'} written.`);
if (written < total) process.exit(2);
