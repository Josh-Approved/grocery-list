#!/usr/bin/env node
/**
 * heal.mjs — the self-learning half of the traversal pipeline.
 *
 * Problem: even with anchors centralized, copy/label changes still break a
 * selector. We don't want to hand-chase those. So when a run can't find an
 * anchor, heal reads the LIVE screen, figures out which element the anchor now
 * refers to, and repairs qa/selectors.json — automatically when the match is
 * unambiguous, as a written proposal when it's a judgement call. It also LEARNS:
 * every green run records what each anchor resolved to, and those baselines
 * anchor future matches.
 *
 * This mirrors the factory's reconcile doctrine: auto-apply the objectively-
 * correct/reversible fix; gate genuine judgement behind a human.
 *
 * Modes:
 *   --record    qa is GREEN. Snapshot, per resolving anchor, the element it
 *               matched (text + id) into qa/journey.baseline.json. This is the
 *               "learned" state used to anchor future repairs.
 *   (default)   qa is RED. For each targeted anchor that no longer resolves in
 *               the live tree, score every on-screen element against the
 *               anchor's last-known text and propose the best match. Writes
 *               qa/heal-report.json. With --apply, also rewrites confident
 *               matches into qa/selectors.json (prefers upgrading to a testID).
 *
 * Hierarchy source (one of):
 *   --hierarchy <file.json>   a saved `maestro hierarchy` dump (offline / tests)
 *   --from-device            run `maestro hierarchy` against the connected device
 *
 * Targeting:
 *   --anchor a,b,c   only consider these anchors (the orchestrator passes the
 *                    one Maestro reported as not-found). Default: all anchors
 *                    the journey references that don't resolve on this screen.
 *
 * Usage:
 *   node scripts/qa/heal.mjs [app-dir] --from-device --anchor first-item [--apply]
 *   node scripts/qa/heal.mjs [app-dir] --hierarchy tree.json --record
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------- hierarchy parsing ----------

/** Flatten a `maestro hierarchy` JSON tree into {text, id} leaves+nodes. */
export function flattenHierarchy(root) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const a = node.attributes || node;
    const text = (a.text || a['text'] || a.accessibilityText || a.hintText || '').trim();
    const id = (a['resource-id'] || a.resourceId || a.accessibilityIdentifier || a.identifier || '').trim();
    if (text || id) out.push({ text, id });
    const kids = node.children || a.children || [];
    if (Array.isArray(kids)) kids.forEach(visit);
  };
  // `maestro hierarchy` wraps the tree; tolerate either {..,children} or an array.
  if (Array.isArray(root)) root.forEach(visit);
  else visit(root);
  return out;
}

// ---------- similarity ----------

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 0..1 similarity blending normalized edit distance with token-set Jaccard. */
export function similarity(aRaw, bRaw) {
  const a = norm(aRaw), b = norm(bRaw);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jac = inter / (ta.size + tb.size - inter);
  return 0.5 * lev + 0.5 * jac;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- resolution ----------

function anchorResolves(anchor, nodes) {
  if (anchor.testID) return nodes.some((n) => n.id === anchor.testID);
  if (anchor.text) {
    let re;
    try { re = new RegExp(anchor.text); } catch { re = null; }
    return nodes.some((n) => (re ? re.test(n.text) : n.text.includes(anchor.text)));
  }
  return false;
}

const CONFIDENT = 0.6;   // absolute score to auto-apply
const MARGIN = 0.15;     // top must beat runner-up by this much

/** Rank on-screen elements as replacements for a broken anchor. */
export function proposeForAnchor(key, anchor, baseline, nodes) {
  const want = (baseline && baseline.text) || anchor.text || key;
  const scored = nodes
    .filter((n) => n.text)
    .map((n) => ({ ...n, score: similarity(want, n.text) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  const confident = !!top && top.score >= CONFIDENT && (!second || top.score - second.score >= MARGIN);

  // Build the suggested anchor. Prefer a stable testID when the matched node has
  // one — that's the permanent cure for churn, not just a patched string.
  let suggestion = null;
  if (top) {
    suggestion = top.id
      ? { testID: top.id, text: escapeRegex(top.text) }
      : { text: escapeRegex(top.text) };
  }

  return {
    anchor: key,
    was: anchor,
    suggestion,
    confident,
    candidates: scored.slice(0, 4).map((c) => ({ text: c.text, id: c.id || null, score: +c.score.toFixed(3) })),
  };
}

// ---------- I/O helpers ----------

const readJson = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
};
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

function getHierarchy(appDir, flags, valueOf) {
  const file = valueOf('--hierarchy');
  if (file) {
    const j = readJson(path.resolve(file), null);
    if (!j) { console.error(`Could not read hierarchy JSON: ${file}`); process.exit(1); }
    return j;
  }
  if (flags.has('--from-device')) {
    // Pass --device through: with more than one sim/emulator booted, a bare
    // `maestro hierarchy` can't choose and fails (the capture orchestrator
    // already knows the target udid, so it threads it here).
    const dev = valueOf('--device');
    const argv = dev ? ['--device', dev, 'hierarchy'] : ['hierarchy'];
    const r = spawnSync('maestro', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) { console.error('maestro hierarchy failed:\n' + (r.stderr || '')); process.exit(1); }
    // maestro prints some log lines before the JSON; slice from the first brace.
    const i = r.stdout.indexOf('{');
    try { return JSON.parse(i >= 0 ? r.stdout.slice(i) : r.stdout); }
    catch (e) { console.error('Could not parse maestro hierarchy output: ' + e.message); process.exit(1); }
  }
  console.error('Provide --hierarchy <file.json> or --from-device.');
  process.exit(1);
}

// ---------- main ----------

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const valueOf = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  // The optional positional is the app dir. Skip the VALUES of value-taking
  // flags so e.g. `--device <udid>` doesn't get mistaken for the app dir.
  const VALUE_FLAGS = new Set(['--device', '--anchor', '--hierarchy']);
  const appDir = path.resolve(
    args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1])) || process.cwd()
  );

  const selectorsPath = path.join(appDir, 'qa', 'selectors.json');
  const journeyPath = path.join(appDir, 'qa', 'journey.json');
  const baselinePath = path.join(appDir, 'qa', 'journey.baseline.json');
  const reportPath = path.join(appDir, 'qa', 'heal-report.json');

  const selectors = readJson(selectorsPath, { anchors: {} });
  const journey = readJson(journeyPath, { steps: [] });
  const anchors = selectors.anchors || {};
  const baseline = readJson(baselinePath, { anchors: {} });

  const referenced = new Set();
  for (const step of journey.steps || []) {
    for (const k of ['waitFor', 'assert', 'tap']) {
      if (typeof step[k] === 'string' && step[k].startsWith('@')) referenced.add(step[k].slice(1));
    }
  }

  const nodes = flattenHierarchy(getHierarchy(appDir, flags, valueOf));

  // --record: learn the green state.
  if (flags.has('--record')) {
    baseline.anchors = baseline.anchors || {};
    let learned = 0;
    for (const key of referenced) {
      const a = anchors[key];
      if (!a) continue;
      // Record the element this anchor currently matches (text + any id).
      let node = null;
      if (a.testID) node = nodes.find((n) => n.id === a.testID);
      if (!node && a.text) {
        let re; try { re = new RegExp(a.text); } catch { re = null; }
        node = nodes.find((n) => (re ? re.test(n.text) : n.text.includes(a.text)));
      }
      if (node) { baseline.anchors[key] = { text: node.text, id: node.id || null }; learned++; }
    }
    writeJson(baselinePath, baseline);
    console.log(`Recorded baseline for ${learned}/${referenced.size} anchors → ${path.relative(appDir, baselinePath)}`);
    return;
  }

  // default: repair. Determine which anchors to consider.
  const targetArg = valueOf('--anchor');
  const targets = targetArg
    ? targetArg.split(',').map((s) => s.trim()).filter(Boolean)
    : [...referenced];

  const broken = targets.filter((key) => anchors[key] && !anchorResolves(anchors[key], nodes));
  if (broken.length === 0) {
    console.log(`heal: all ${targets.length} targeted anchor(s) still resolve on this screen — nothing to repair.`);
    return;
  }

  const proposals = broken.map((key) =>
    proposeForAnchor(key, anchors[key], (baseline.anchors || {})[key], nodes));

  const apply = flags.has('--apply');
  let applied = 0;
  for (const p of proposals) {
    if (apply && p.confident && p.suggestion) {
      anchors[p.anchor] = { ...anchors[p.anchor], ...p.suggestion };
      p.applied = true;
      applied++;
    } else {
      p.applied = false;
    }
  }

  if (applied > 0) {
    selectors.anchors = anchors;
    writeJson(selectorsPath, selectors);
  }
  writeJson(reportPath, { generatedFor: appDir, applied, proposals });

  // Human summary.
  for (const p of proposals) {
    const verb = p.applied ? 'FIXED ' : p.confident ? 'READY ' : 'REVIEW';
    const sug = p.suggestion
      ? (p.suggestion.testID ? `id:${p.suggestion.testID}` : `text:${p.suggestion.text}`)
      : '(no candidate)';
    console.log(`  [${verb}] @${p.anchor}: was ${JSON.stringify(p.was)} → ${sug}  (score ${p.candidates[0]?.score ?? 'n/a'})`);
    if (!p.applied && p.candidates.length) {
      for (const c of p.candidates) console.log(`           · ${c.score}  ${c.id ? `id:${c.id} ` : ''}"${c.text}"`);
    }
  }
  console.log('');
  console.log(
    `heal: ${broken.length} broken, ${applied} auto-fixed${apply ? '' : ' (dry-run; pass --apply to write)'}, ` +
    `${proposals.filter((p) => !p.applied).length} need review → ${path.relative(appDir, reportPath)}`);
  // Non-zero only when there's unresolved work, so the orchestrator can branch.
  process.exit(proposals.some((p) => !p.applied) ? 3 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
