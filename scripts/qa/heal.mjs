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

/**
 * Does this anchor still find something on this screen?
 *
 * EITHER half counts — a testID OR the text. Maestro matches on either, so an
 * anchor whose testID isn't exposed in the tree (common on iOS, where RN's
 * testID often surfaces only as the accessibility identifier) but whose text is
 * plainly there has NOT drifted. Treating it as broken is how a correct anchor
 * gets "repaired" into a wrong one.
 */
export function anchorResolves(anchor, nodes) {
  if (anchor.testID && nodes.some((n) => n.id === anchor.testID)) return true;
  if (anchor.text) {
    let re;
    try { re = new RegExp(anchor.text); } catch { re = null; }
    return nodes.some((n) => (re ? re.test(n.text) : n.text.includes(anchor.text)));
  }
  return false;
}

const CONFIDENT = 0.6;   // absolute score to auto-apply
const MARGIN = 0.15;     // top must beat runner-up by this much

/** Case/punctuation/whitespace-insensitive equality — `norm` already strips all
 *  three, so this is "the same words, styled differently". */
function sameWords(a, b) {
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Rank on-screen elements as replacements for a broken anchor.
 *
 * `opts.appDisplayName` is the app's BUNDLE display name (app.json). It is worth
 * naming explicitly because it is the one string guaranteed to sit in every
 * accessibility tree on every screen, which makes it the default winner for any
 * title-ish anchor that happens not to resolve on the screen heal was pointed
 * at. On 2026-08-13 that is exactly what happened to workout-timer: the healer
 * rewrote a correct in-app `Workout timer` anchor to the bundle's
 * `Workout Timer`, and the drift lint would then have defended the wrong value.
 *
 * Two guards follow from that, and both are refusals to AUTO-APPLY, never
 * refusals to report — a real drift still shows up for review:
 *   1. The bundle display name is never an auto-applied replacement unless the
 *      anchor was already pointing at it. In-app copy is the source of truth for
 *      an in-app anchor.
 *   2. A candidate that is the current text with different casing/punctuation is
 *      not drift. Copy that did not change cannot have broken the anchor; a
 *      case-only "fix" means we matched a DIFFERENT element that says the same
 *      words, which is precisely the platform-specific trap above.
 */
export function proposeForAnchor(key, anchor, baseline, nodes, opts = {}) {
  const appDisplayName = opts.appDisplayName || '';
  const want = (baseline && baseline.text) || anchor.text || key;
  const scored = nodes
    .filter((n) => n.text)
    .map((n) => ({ ...n, score: similarity(want, n.text) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  let confident = !!top && top.score >= CONFIDENT && (!second || top.score - second.score >= MARGIN);
  let blockedReason = null;

  if (top && confident) {
    // EXACT, not sameWords: the whole failure mode is an in-app string that
    // matches the bundle name apart from its casing. A loose compare here would
    // classify that anchor as "already the bundle name" and wave the rewrite
    // straight through — which is the bug, not the guard.
    const anchorIsAlreadyTheBundleName = !!anchor.text && anchor.text === appDisplayName;
    if (sameWords(top.text, appDisplayName) && !anchorIsAlreadyTheBundleName) {
      confident = false;
      blockedReason =
        `best match "${top.text}" is the app's bundle display name, not in-app copy — ` +
        `an in-app anchor is not repaired from the bundle name`;
    } else if (anchor.text && sameWords(top.text, anchor.text) && top.text !== anchor.text) {
      confident = false;
      blockedReason =
        `best match "${top.text}" differs from the current anchor only in case/punctuation — ` +
        `the copy did not change, so this is a different element saying the same words, not drift`;
    }
  }

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
    ...(blockedReason ? { blockedReason } : {}),
    candidates: scored.slice(0, 4).map((c) => ({ text: c.text, id: c.id || null, score: +c.score.toFixed(3) })),
  };
}

/** The app's bundle display name, as it appears in an accessibility tree. */
export function readAppDisplayName(appJson) {
  const e = (appJson && appJson.expo) || appJson || {};
  return (
    (e.ios && e.ios.infoPlist && e.ios.infoPlist.CFBundleDisplayName) ||
    e.name ||
    ''
  );
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

  const appDisplayName = readAppDisplayName(readJson(path.join(appDir, 'app.json'), null));
  const proposals = broken.map((key) =>
    proposeForAnchor(key, anchors[key], (baseline.anchors || {})[key], nodes, { appDisplayName }));

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
    if (p.blockedReason) console.log(`           ! held back: ${p.blockedReason}`);
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

// ---------- self-test ----------

function selfTest() {
  let pass = 0;
  const fails = [];
  const check = (name, cond) => { if (cond) pass++; else fails.push(name); };

  // The 2026-08-13 workout-timer screen: the in-app sentence-case title, plus
  // the iOS bundle DISPLAY NAME, which sits in the tree on every screen.
  const screen = [
    { text: 'Workout Timer', id: '' },   // bundle display name
    { text: 'Workout timer', id: '' },   // in-app title (the anchor's real target)
    { text: 'Start', id: 'start-btn' },
  ];
  const titleAnchor = { text: 'Workout timer', note: 'parity guard' };

  check('an anchor whose text is on screen resolves', anchorResolves(titleAnchor, screen));
  check('an anchor whose text is absent does not resolve',
    !anchorResolves({ text: 'Nowhere' }, screen));
  check('a testID anchor resolves on its id', anchorResolves({ testID: 'start-btn' }, screen));
  // The gap that let a correct anchor be declared broken: testID missing from
  // the tree (iOS) while the text is plainly there.
  check('an anchor resolves on its TEXT when its testID is absent from the tree',
    anchorResolves({ testID: 'not-exposed', text: 'Workout timer' }, screen));
  check('an anchor with neither half present does not resolve',
    !anchorResolves({ testID: 'not-exposed', text: 'Nowhere' }, screen));

  // Guard 1 — the bundle display name is never an auto-applied replacement.
  // The real 2026-08-13 shape: heal ran untargeted after some OTHER anchor
  // failed, so the screen it read did not carry the in-app title at all — and
  // the bundle name, which is on every screen, was the only close match.
  const offTitleScreen = [
    { text: 'Workout Timer', id: '' },   // bundle display name
    { text: 'Rest', id: 'rest-btn' },
  ];
  let p = proposeForAnchor('app-title', titleAnchor, null, offTitleScreen, { appDisplayName: 'Workout Timer' });
  check('the bundle display name is not auto-applied over in-app copy', p.confident === false);
  check('the bundle-name refusal says why', /bundle display name/.test(p.blockedReason || ''));
  check('the bundle-name refusal still reports candidates for review', p.candidates.length > 0);

  // ...unless the anchor was already pointing at the bundle name (then it is a
  // legitimate target and a real repair must still be possible).
  p = proposeForAnchor('app-title', { text: 'Workout Timer' }, null,
    [{ text: 'Workout Timer', id: 'title' }], { appDisplayName: 'Workout Timer' });
  check('an anchor already on the bundle name can still be repaired', p.confident === true);

  // Guard 2 — a case-only variant is not drift, even with no bundle name known.
  p = proposeForAnchor('app-title', titleAnchor, null,
    [{ text: 'Workout Timer', id: '' }], {});
  check('a case-only "repair" is not auto-applied', p.confident === false);
  check('the case-only refusal says the copy did not change',
    /only in case\/punctuation/.test(p.blockedReason || ''));

  // Genuine drift still heals — that is the whole point of the tool, and the
  // guards above are worthless if they cost it.
  p = proposeForAnchor('add-row', { text: 'Add item' }, null,
    [{ text: 'Add an item', id: 'row-1' }, { text: 'Settings', id: '' }], { appDisplayName: 'Workout Timer' });
  check('genuine copy drift is still confident', p.confident === true);
  check('genuine drift upgrades to a testID when the matched node has one',
    p.suggestion && p.suggestion.testID === 'row-1');
  check('a clean proposal carries no blockedReason', p.blockedReason === undefined);

  // An ambiguous screen stays a judgement call (unchanged behaviour).
  p = proposeForAnchor('x', { text: 'Save' }, null,
    [{ text: 'Saved', id: '' }, { text: 'Saves', id: '' }], {});
  check('an ambiguous match is not auto-applied', p.confident === false);

  check('display name reads ios.infoPlist.CFBundleDisplayName first',
    readAppDisplayName({ expo: { name: 'wt', ios: { infoPlist: { CFBundleDisplayName: 'Workout Timer' } } } }) === 'Workout Timer');
  check('display name falls back to expo.name',
    readAppDisplayName({ expo: { name: 'Workout Timer' } }) === 'Workout Timer');
  check('a missing app.json yields no display name', readAppDisplayName(null) === '');

  check('flattenHierarchy walks nested children',
    flattenHierarchy({ attributes: { text: 'a' }, children: [{ attributes: { text: 'b' } }] }).length === 2);
  check('similarity is 1 for the same string', similarity('Workout timer', 'Workout timer') === 1);
  check('similarity ignores case', similarity('Workout timer', 'Workout Timer') === 1);

  console.log(fails.length
    ? `heal --self-test: ${pass} passed, ${fails.length} FAILED\n` + fails.map((f) => `  ✗ ${f}`).join('\n')
    : `heal --self-test: ${pass} checks passed`);
  return fails.length === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  main();
}
