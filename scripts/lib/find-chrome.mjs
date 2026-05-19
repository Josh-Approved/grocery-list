// find-chrome.mjs — locate the user's installed Chrome / Chromium / Edge for
// headless screenshot rendering. Zero npm deps; checks well-known install paths
// per OS, then PATH. Override with CHROME_PATH env var.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const WIN_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

function which(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cmd], { stdio: 'pipe', shell: true })
    : spawnSync('which', [cmd], { stdio: 'pipe' });
  if (probe.status !== 0) return null;
  const first = probe.stdout.toString().split(/\r?\n/).find(Boolean);
  return first ? first.trim() : null;
}

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = process.platform === 'win32' ? WIN_CANDIDATES
    : process.platform === 'darwin' ? MAC_CANDIDATES
    : LINUX_CANDIDATES;

  for (const p of candidates) if (fs.existsSync(p)) return p;

  for (const cmd of ['chrome', 'google-chrome', 'chromium', 'msedge']) {
    const found = which(cmd);
    if (found) return found;
  }

  throw new Error(
    'Could not locate Chrome / Chromium / Edge. Install Chrome, or set CHROME_PATH to the executable.'
  );
}
