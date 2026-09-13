#!/usr/bin/env node
/**
 * action-coverage.mjs — Uplevel-3 T3 stage 1: the action-coverage audit.
 *
 * Tier-2 journeys prove the happy path boots and the main flow works; they do
 * NOT prove that EVERY user-facing action works. This audit enumerates the
 * app's user-facing actions from src/**, maps each to its proof (a Tier-2
 * outcome assertion, an RNTL component test, or a trust-core unit test), and
 * keeps a tracked registry (qa/actions.json) honest against the code so it
 * can't drift like prose. Gaps (proof.kind "none") are the backfill work-list.
 *
 *   node scripts/qa/action-coverage.mjs <app>          # reconcile + write + summary
 *   node scripts/qa/action-coverage.mjs <app> --json   # + machine-readable to stdout
 *   node scripts/qa/action-coverage.mjs <app> --check   # read-only; exit 1 if any gap
 *   node scripts/qa/action-coverage.mjs --self-test      # pure-logic tests (no app)
 *
 * The registry is the TRACKED TRUTH. This script NEVER silently rewrites a
 * proof — it only appends new-in-code actions (proof.kind "none"), refreshes
 * the code-derived `where`/`label` fields, and flags entries whose action no
 * longer exists in the code as `stale: true`. Human-owned fields (proof, note)
 * are preserved verbatim. If the script and registry disagree about an action's
 * existence, the registry is flagged, never overwritten — a human decides.
 *
 * ─ Enumeration is grep/regex-level, not a full AST. Honest limits:
 *   • Scans src/screens, src/components, src/shell only (where interactive
 *     elements live — not store/, data/, lib/, sync/, qa/).
 *   • Recognises: <Pressable>/<TouchableOpacity>/<TouchableHighlight>/
 *     <TouchableWithoutFeedback>/<RectButton>/<Button> with an on(Press|LongPress)
 *     handler; <Switch> with onValueChange; <TextInput> with onSubmitEditing;
 *     and Alert.alert(...) action buttons (a button object with text+onPress,
 *     excluding style:'cancel').
 *   • Labels resolve in priority order: accessibilityLabel literal → the i18n
 *     key inside accessibilityLabel={t('…')} → placeholder (TextInput) → testID
 *     → a positional fallback (tag+ordinal) for a dynamically-labelled element.
 *     Child-text labels are NOT read (grep-level).
 *   • Actions hidden behind a bespoke wrapper component, a spread handler, or a
 *     fully dynamic render are not seen — those are the residual a human maps by
 *     hand into the registry (they still get a proof, they just aren't
 *     auto-appended). This is a floor on the action set, not a ceiling.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------- comment stripping (string-aware; keeps string contents) ----------
// Mirrors qa-canonical.mjs stripComments: drop // and /* */ comments so a tag
// or handler named in a doc-comment never matches, but keep string/template
// literals verbatim (labels live in them) and preserve newlines for line nums.
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === "'") { state = 'sq'; out += ch; i += 1; continue; }
      if (ch === '"') { state = 'dq'; out += ch; i += 1; continue; }
      if (ch === '`') { state = 'tpl'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') { if (ch === '\n') { state = 'code'; out += ch; } i += 1; continue; }
    if (state === 'block') { if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; } if (ch === '\n') out += ch; i += 1; continue; }
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
    if (state === 'sq' && ch === "'") { state = 'code'; out += ch; i += 1; continue; }
    if (state === 'dq' && ch === '"') { state = 'code'; out += ch; i += 1; continue; }
    if (state === 'tpl' && ch === '`') { state = 'code'; out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
}

// Read a JSX opening tag starting at `<` (startIdx). Returns { attrs, end } where
// attrs is the raw `<Tag …` slice up to (not including) the closing `>`; brace
// nesting + string state are respected so a `>` inside an inline arrow handler
// (onPress={() => …}) or a string doesn't end the tag early.
export function readOpenTag(code, startIdx) {
  let i = startIdx + 1;
  let depth = 0; // {} depth
  let state = 'code'; // code | sq | dq | tpl
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (state === 'sq') { if (ch === '\\') { i += 2; continue; } if (ch === "'") state = 'code'; i++; continue; }
    if (state === 'dq') { if (ch === '\\') { i += 2; continue; } if (ch === '"') state = 'code'; i++; continue; }
    if (state === 'tpl') { if (ch === '\\') { i += 2; continue; } if (ch === '`') state = 'code'; i++; continue; }
    if (ch === "'") { state = 'sq'; i++; continue; }
    if (ch === '"') { state = 'dq'; i++; continue; }
    if (ch === '`') { state = 'tpl'; i++; continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    if (ch === '>' && depth === 0) return { attrs: code.slice(startIdx, i), end: i };
    i++;
  }
  return null;
}

// Balanced (…) run whose opening `(` is at `open`. Comments stripped; strings
// kept, so a stray paren inside a string could skew depth — acceptable for the
// Alert.alert arg scan (button-text strings rarely carry an unbalanced paren).
function matchParens(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return { inner: code.slice(open + 1, i), end: i }; }
  }
  return null;
}

// Slug for the id fragment. Dots are KEPT — an i18n-key label ("home.add")
// reads far better as an id than "home-add", and dots are already stable.
const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/-+/g, '-') || 'x';

// idBase = path relative to src/, without extension (e.g. screens/ListsHomeScreen).
function idBaseFor(relPath) {
  return relPath.replace(/\\/g, '/').replace(/^src\//, '').replace(/\.(t|j)sx?$/, '');
}

const lineAt = (code, idx) => code.slice(0, idx).split('\n').length;

// ---------- stable identity for an unnamed action ----------
//
// An action with no accessibilityLabel / placeholder / testID used to be keyed by
// its LINE NUMBER (`#pressable-56`). A line number is not an identity: any edit
// above it re-points the element and the registry row goes stale, so counts
// wobbled between batches, ~40% of tend's and home-maintenance's rows were
// positional, and a whole reconcile stage (52 stale rows across two apps) was
// spent repairing drift that no one had caused. It also meant a file-size split
// could not land without a registry reconcile in the same commit.
//
// So fall back in order of how well the handle survives an edit:
//   1. the handler's own identity  — onPress={onAdd} → #pressable-onadd
//   2. enclosing component + ordinal — #pressable-aboutrow-1
//   3. file ordinal                 — #pressable-1
// Only the set of unnamed actions changing can move these, which is the point.

/** The expression a handler prop is bound to, e.g. `onPress={…}` → the `…`. */
function handlerExpr(attrs) {
  const m = attrs.match(/\bon(?:Press|LongPress|ValueChange|SubmitEditing)\s*=\s*\{/);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < attrs.length; i++) {
    if (attrs[i] === '{') depth++;
    else if (attrs[i] === '}') { depth--; if (depth === 0) return attrs.slice(open + 1, i).trim(); }
  }
  return null;
}

/** A stable name from the handler binding, or null.
 *  `onAdd` → onAdd · `nav.goBack` → nav.goBack · `() => save(x)` → save. */
export function handlerIdentity(attrs) {
  const expr = handlerExpr(attrs);
  if (!expr) return null;
  const ident = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
  if (ident.test(expr)) return expr;
  // An inline arrow/function: the first thing it CALLS is the action's name.
  // Control-flow keywords are followed by `(` too and must not be mistaken for
  // the call — `() => { if (a) { save(); } }` is a save, not an "if".
  const KEYWORD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'function', 'do', 'void', 'delete', 'yield']);
  for (const m of expr.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g)) {
    if (!KEYWORD.has(m[1])) return m[1];
  }
  return null;
}

/** Nearest preceding component/function declaration name (capitalised), or null.
 *  Deliberately coarse — it only has to be the same name after a line shift. */
export function enclosingName(code, idx) {
  const re = /(?:function\s+([A-Z][\w$]*)|(?:const|let|var)\s+([A-Z][\w$]*)\s*[:=])/g;
  let name = null, m;
  while ((m = re.exec(code)) !== null) {
    if (m.index >= idx) break;
    name = m[1] || m[2];
  }
  return name;
}

const INTERACTIVE = {
  Pressable: /\bon(?:Press|LongPress)\s*=/,
  TouchableOpacity: /\bon(?:Press|LongPress)\s*=/,
  TouchableHighlight: /\bon(?:Press|LongPress)\s*=/,
  TouchableWithoutFeedback: /\bon(?:Press|LongPress)\s*=/,
  RectButton: /\bon(?:Press|LongPress)\s*=/,
  BorderlessButton: /\bon(?:Press|LongPress)\s*=/,
  Button: /\bon(?:Press)\s*=|<\s*Button\b/, // <Button> always carries an onPress
  Switch: /\bonValueChange\s*=/,
  TextInput: /\bonSubmitEditing\s*=/,
};

// Extract a human label + source from an opening-tag attr string.
function extractLabel(attrs, tag) {
  let m;
  // accessibilityLabel="literal" / ='literal'
  m = attrs.match(/accessibilityLabel\s*=\s*"([^"]+)"/) || attrs.match(/accessibilityLabel\s*=\s*'([^']+)'/);
  if (m) return { label: m[1], source: 'a11y' };
  // accessibilityLabel={t('key' …)}  — i18n key is the most stable id source
  m = attrs.match(/accessibilityLabel\s*=\s*\{\s*t\(\s*['"`]([^'"`]+)['"`]/);
  if (m) return { label: m[1], source: 'i18n' };
  // TextInput: placeholder as the label
  m = attrs.match(/placeholder\s*=\s*\{\s*t\(\s*['"`]([^'"`]+)['"`]/) ||
      attrs.match(/placeholder\s*=\s*"([^"]+)"/) || attrs.match(/placeholder\s*=\s*'([^']+)'/);
  if (m) return { label: m[1], source: 'placeholder' };
  // testID as a last stable handle
  m = attrs.match(/testID\s*=\s*\{?\s*['"`]([^'"`]+)['"`]/);
  if (m) return { label: m[1], source: 'testID' };
  return { label: null, source: 'dynamic' };
}

const activeHandler = (attrs) => {
  if (/\bon(?:Press|LongPress)\s*=/.test(attrs)) return /\bonLongPress\s*=/.test(attrs) && !/\bonPress\s*=/.test(attrs) ? 'onLongPress' : 'onPress';
  if (/\bonValueChange\s*=/.test(attrs)) return 'onValueChange';
  if (/\bonSubmitEditing\s*=/.test(attrs)) return 'onSubmitEditing';
  return 'onPress';
};

/**
 * Enumerate user-facing actions from one source file's text.
 * @param {string} source  raw file text
 * @param {string} relPath path relative to the app root (e.g. src/screens/Foo.tsx)
 * @returns {Array<{id,label,where,note}>}
 */
export function extractActions(source, relPath) {
  const code = stripComments(source);
  const base = idBaseFor(relPath);
  const out = [];
  const seen = new Map(); // slug -> count, for collision disambiguation
  const ordinals = new Map(); // scope -> count of unnamed actions so far

  const emit = (labelInfo, tag, handler, idx, attrs = '') => {
    let labelSlug;
    if (labelInfo.label) {
      labelSlug = slug(labelInfo.label);
    } else {
      const fromHandler = handlerIdentity(attrs);
      if (fromHandler) {
        labelSlug = `${slug(tag)}-${slug(fromHandler)}`;
      } else {
        const scope = enclosingName(code, idx);
        const key = scope || '';
        const n = (ordinals.get(key) || 0) + 1;
        ordinals.set(key, n);
        labelSlug = `${slug(tag)}-${scope ? `${slug(scope)}-` : ''}${n}`;
      }
    }
    let key = labelSlug;
    const prior = seen.get(labelSlug);
    if (prior != null) { seen.set(labelSlug, prior + 1); key = `${labelSlug}-${prior + 1}`; }
    else seen.set(labelSlug, 1);
    const label = labelInfo.label ?? `${tag} (dynamic label)`;
    out.push({
      id: `${base}#${key}`,
      label,
      where: `${relPath}:${lineAt(code, idx)}`,
      note: `${tag} · ${handler}${labelInfo.source === 'dynamic' ? ' · dynamic/child-text label' : ''}`,
    });
  };

  // 1) Interactive JSX tags.
  const tagNames = Object.keys(INTERACTIVE).join('|');
  const tagRe = new RegExp(`<\\s*(${tagNames})\\b`, 'g');
  let tm;
  while ((tm = tagRe.exec(code)) !== null) {
    const tag = tm[1];
    const open = readOpenTag(code, tm.index);
    if (!open) continue;
    const attrs = open.attrs;
    if (!INTERACTIVE[tag].test(attrs)) continue; // present but no active handler → not an action
    emit(extractLabel(attrs, tag), tag, activeHandler(attrs), tm.index, attrs);
    tagRe.lastIndex = open.end; // skip past this tag's attrs
  }

  // 2) Alert.alert(...) action buttons.
  const alertRe = /\bAlert\s*\.\s*alert\s*\(/g;
  let am;
  while ((am = alertRe.exec(code)) !== null) {
    const open = code.indexOf('(', am.index);
    const bal = matchParens(code, open);
    if (!bal) continue;
    // Button objects: { text: '…' … onPress … } with style !== 'cancel'.
    for (const bm of bal.inner.matchAll(/\{[^{}]*\}/g)) {
      const obj = bm[0];
      if (!/\bonPress\s*:/.test(obj)) continue;
      if (/\bstyle\s*:\s*['"]cancel['"]/.test(obj)) continue;
      const tx = obj.match(/\btext\s*:\s*\{?\s*t\(\s*['"`]([^'"`]+)['"`]/) ||
                 obj.match(/\btext\s*:\s*['"]([^'"]+)['"]/);
      const label = tx ? tx[1] : 'alert-action';
      const labelSlug = `alert-${slug(label)}`;
      let key = labelSlug;
      const prior = seen.get(labelSlug);
      if (prior != null) { seen.set(labelSlug, prior + 1); key = `${labelSlug}-${prior + 1}`; }
      else seen.set(labelSlug, 1);
      out.push({
        id: `${base}#${key}`,
        label,
        where: `${relPath}:${lineAt(code, am.index)}`,
        note: `Alert.alert · button`,
      });
    }
    alertRe.lastIndex = bal.end;
  }

  return out;
}

// ---------- reconcile ----------
// Merge freshly-extracted actions into the tracked registry WITHOUT rewriting
// human-owned fields. Refresh code-derived where/label on surviving entries,
// flag entries whose action id is gone from the code as stale, append new ones
// with proof.kind "none". Preserves existing order; appends new at the end.
export function reconcile(extracted, registry) {
  const prev = Array.isArray(registry?.actions) ? registry.actions : [];
  const extractedById = new Map(extracted.map((e) => [e.id, e]));

  // An entry whose id no longer appears in the code is usually a deleted action —
  // but it can also be the SAME action under a new id (the id scheme changed, or
  // an unnamed action gained a label). Re-staling those throws away the
  // human-owned proof mapping, which is the expensive half of this registry. So
  // before calling anything stale, try to RE-POINT it onto an unclaimed
  // extracted action, by the two signals that survive an id change:
  //   1. same file:line — the id scheme changed under a motionless action
  //   2. same file + label + note, and exactly one candidate — the line moved
  // Ambiguity is never resolved by guessing: 2+ candidates fall through to stale,
  // where a human decides.
  const claimed = new Set(prev.filter((a) => extractedById.has(a.id)).map((a) => a.id));
  const unclaimed = extracted.filter((e) => !claimed.has(e.id));
  const fileOf = (where) => String(where || '').replace(/:\d+$/, '');
  // A human's note is the machine-generated prefix plus their own " — why" tail
  // ("Pressable · onPress · dynamic/child-text label — presses a cross-promo row
  // and asserts the catalog store URL opens"). Match on the machine prefix only,
  // or every hand-annotated row — which is every row worth keeping — fails to
  // re-point and loses its proof.
  const baseNote = (note) => String(note || '').split(' — ')[0].trim();
  const index = (keyFn) => {
    const m = new Map();
    for (const e of unclaimed) {
      const k = keyFn(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return m;
  };
  const byWhere = index((e) => e.where);
  const byLabelNote = index((e) => JSON.stringify([fileOf(e.where), e.label, baseNote(e.note)]));
  const taken = new Set();
  const only = (bucket) => {
    const free = (bucket || []).filter((e) => !taken.has(e.id));
    return free.length === 1 ? free[0] : null;
  };

  const repointed = [];
  const knownIds = new Set(prev.map((a) => a.id));
  const out = [];
  for (const a of prev) {
    let e = extractedById.get(a.id);
    const entry = { ...a };
    if (!e && !a.stale) {
      e = only(byWhere.get(a.where)) ||
          only(byLabelNote.get(JSON.stringify([fileOf(a.where), a.label, baseNote(a.note)])));
      if (e) {
        taken.add(e.id);
        repointed.push({ from: a.id, to: e.id });
        entry.id = e.id;
      }
    }
    if (e) {
      entry.label = e.label;   // code-derived, safe to refresh
      entry.where = e.where;   // code-derived, safe to refresh
      delete entry.stale;
    } else {
      entry.stale = true;      // flag, never delete — a human decides
    }
    out.push(entry);
  }
  const held = new Set(out.map((a) => a.id));
  for (const e of extracted) {
    if (knownIds.has(e.id) || held.has(e.id)) continue;
    out.push({ id: e.id, label: e.label, where: e.where, proof: { kind: 'none' }, note: e.note });
  }
  return { actions: out, repointed };
}

// Does a registry entry's proof reference actually exist?
//   tier2-assert → ref is a journey waypoint/selector anchor (with or without @)
//   rntl | unit  → ref is a test file that exists on disk
//   none         → unproven (never "valid")
export function checkProofRef(proof, ctx) {
  if (!proof || !proof.kind || proof.kind === 'none') return false;
  if (proof.kind === 'tier2-assert') {
    if (!proof.ref) return false;
    const ref = String(proof.ref).replace(/^@/, '');
    return ctx.anchors.has(ref) || ctx.waypoints.has(ref);
  }
  if (proof.kind === 'rntl' || proof.kind === 'unit') {
    if (!proof.ref) return false;
    return ctx.fileExists(proof.ref);
  }
  return false;
}

export function summarize(registry, ctx) {
  const actions = Array.isArray(registry?.actions) ? registry.actions : [];
  let proven = 0, unproven = 0, stale = 0, brokenRef = 0;
  for (const a of actions) {
    if (a.stale) { stale++; continue; }
    const kind = a.proof?.kind || 'none';
    if (kind === 'none') { unproven++; continue; }
    if (checkProofRef(a.proof, ctx)) proven++;
    else brokenRef++;
  }
  return { total: actions.length, proven, unproven, stale, brokenRef };
}

// ---------- CLI plumbing ----------

const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SCAN_DIRS = ['screens', 'components', 'shell'];

function walkSource(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkSource(full, acc);
    else if (SRC_EXT.has(path.extname(e.name)) && !/\.(test|spec)\./.test(e.name)) acc.push(full);
  }
  return acc;
}

function collectExtracted(appDir) {
  const files = [];
  for (const d of SCAN_DIRS) {
    const root = path.join(appDir, 'src', d);
    if (fs.existsSync(root)) walkSource(root, files);
  }
  files.sort();
  const out = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(appDir, f).replace(/\\/g, '/');
    out.push(...extractActions(text, rel));
  }
  return out;
}

function buildCtx(appDir) {
  const anchors = new Set();
  const waypoints = new Set();
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const sel = readJson(path.join(appDir, 'qa', 'selectors.json'));
  if (sel && sel.anchors) for (const k of Object.keys(sel.anchors)) anchors.add(k);
  const journey = readJson(path.join(appDir, 'qa', 'journey.json'));
  const collect = (steps) => {
    for (const step of steps || []) {
      for (const k of ['waitFor', 'assert', 'assertNot', 'tap', 'scrollUntilVisible']) {
        if (typeof step[k] === 'string' && step[k].startsWith('@')) waypoints.add(step[k].slice(1));
      }
    }
  };
  if (journey) { collect(journey.steps); collect(journey.survival && journey.survival.steps); }
  return { anchors, waypoints, fileExists: (ref) => fs.existsSync(path.join(appDir, ref)) };
}

function runSelfTest() {
  const assert = (cond, msg) => { if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; } else console.log(`  ✓ ${msg}`); };

  // --- extraction ---
  const src = `
    import { Pressable, TouchableOpacity, Switch, TextInput, Alert } from 'react-native';
    // a doc mention of <Pressable onPress> must NOT match
    export function S() {
      return (
        <>
          <Pressable onPress={onAdd} accessibilityLabel={t('home.add')}>
            <Plus />
          </Pressable>
          <Pressable style={s.row} accessibilityLabel="Open list">
            {/* no handler → not an action */}
          </Pressable>
          <TouchableOpacity onPress={() => go(a > b ? 1 : 2)} accessibilityLabel="Go">
            <Text>Go</Text>
          </TouchableOpacity>
          <Switch onValueChange={setOn} accessibilityLabel={t('settings.toggle')} />
          <TextInput onSubmitEditing={submit} placeholder="New item" />
          <Pressable onPress={x}>plain</Pressable>
        </>
      );
    }
    function ask() {
      Alert.alert('Delete?', 'Sure?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  `;
  const acts = extractActions(src, 'src/screens/Sample.tsx');
  const ids = acts.map((a) => a.id);
  assert(ids.includes('screens/Sample#home.add'), 'i18n-key label → stable id');
  assert(ids.includes('screens/Sample#open-list') === false, 'Pressable without a handler is NOT an action');
  assert(ids.includes('screens/Sample#go'), 'TouchableOpacity with inline arrow (with a > inside) is captured');
  assert(ids.includes('screens/Sample#settings.toggle'), 'Switch onValueChange captured');
  assert(ids.includes('screens/Sample#new-item'), 'TextInput onSubmitEditing captured (placeholder label)');
  assert(ids.includes('screens/Sample#alert-delete'), 'Alert.alert non-cancel button captured');
  assert(!ids.includes('screens/Sample#alert-cancel'), 'Alert.alert style:cancel button excluded');
  const plain = acts.find((a) => a.note.startsWith('Pressable · onPress') && a.id.includes('#pressable-'));
  assert(!!plain, 'dynamically/child-text-labelled Pressable still gets a fallback id');
  assert(acts.every((a) => /:\d+$/.test(a.where)), 'every action carries a where with a line number');

  // --- stable identity for unnamed actions (no line numbers in ids) ---
  assert(acts.every((a) => !/#\w+-\d+$/.test(a.id) || !/-\d{2,}$/.test(a.id)),
    'no extracted id ends in a line number');
  assert(plain.id === 'screens/Sample#pressable-x', 'an unnamed Pressable is keyed by its handler, not its line');
  const idsBefore = extractActions(src, 'src/screens/Sample.tsx').map((a) => a.id).join(',');
  const idsAfter = extractActions(`\n\n// two new lines above\n${src}`, 'src/screens/Sample.tsx').map((a) => a.id).join(',');
  assert(idsBefore === idsAfter, 'shifting every line changes no id (the whole point)');
  assert(handlerIdentity('<Pressable onPress={onAdd}') === 'onAdd', 'a bare handler identifier is the id');
  assert(handlerIdentity('<Pressable onPress={nav.goBack}') === 'nav.goBack', 'a dotted handler is the id');
  assert(handlerIdentity('<Pressable onPress={() => save(item, { force: true })}') === 'save',
    'an inline arrow is keyed by the function it calls');
  assert(handlerIdentity('<Pressable onPress={() => { if (a) { b(); } }}') === 'b',
    'brace nesting inside a handler is read correctly');
  assert(handlerIdentity('<Pressable style={s.row}') === null, 'a non-handler prop is not a handler identity');
  const anon = extractActions(
    `function Row() { return <Pressable onPress={() => {}}><X/></Pressable>; }\n` +
    `function Foot() { return <Pressable onPress={() => {}}><Y/></Pressable>; }`,
    'src/components/K.tsx');
  assert(anon[0].id === 'components/K#pressable-row-1' && anon[1].id === 'components/K#pressable-foot-1',
    'a handler with no callable name falls back to enclosing component + ordinal');
  assert(enclosingName('function A() {}\nfunction B() {}\n', 30) === 'B', 'enclosingName takes the nearest preceding declaration');
  assert(enclosingName('const useThing = () => {}\n', 30) === null, 'a lowercase helper is not a component');

  // collision disambiguation
  const dup = extractActions(`<Pressable onPress={a} accessibilityLabel="Save"/><Pressable onPress={b} accessibilityLabel="Save"/>`, 'src/components/C.tsx');
  assert(dup[0].id !== dup[1].id, 'duplicate labels in one file get distinct ids');

  // --- reconcile ---
  const extracted = [
    { id: 'screens/A#one', label: 'one', where: 'src/screens/A.tsx:5', note: 'Pressable · onPress' },
    { id: 'screens/A#two', label: 'two', where: 'src/screens/A.tsx:9', note: 'Pressable · onPress' },
  ];
  const registry = { actions: [
    { id: 'screens/A#one', label: 'stale-label', where: 'src/screens/A.tsx:1', proof: { kind: 'tier2-assert', ref: '@added' }, note: 'human note' },
    { id: 'screens/A#gone', label: 'gone', where: 'src/screens/A.tsx:99', proof: { kind: 'unit', ref: 'x.test.ts' }, note: '' },
  ] };
  const merged = reconcile(extracted, registry);
  const one = merged.actions.find((a) => a.id === 'screens/A#one');
  assert(one.proof.kind === 'tier2-assert', 'reconcile NEVER rewrites an existing proof');
  assert(one.note === 'human note', 'reconcile preserves a human-owned note');
  assert(one.where === 'src/screens/A.tsx:5' && one.label === 'one', 'reconcile refreshes code-derived where/label');
  assert(merged.actions.find((a) => a.id === 'screens/A#gone').stale === true, 'reconcile flags a vanished action stale (never deletes)');
  assert(merged.actions.find((a) => a.id === 'screens/A#two')?.proof.kind === 'none', 'reconcile appends a new action as proof none');

  // --- re-point, don't re-stale, when only the id changed ---
  // The migration this shipped for: 54 rows across tend + home-maintenance were
  // keyed by line number, and re-staling them would have thrown away every
  // human-owned proof mapping on them.
  const renamed = reconcile(
    [{ id: 'screens/A#pressable-onadd', label: 'Pressable (dynamic label)', where: 'src/screens/A.tsx:56', note: 'Pressable · onPress · dynamic/child-text label' }],
    { actions: [{ id: 'screens/A#pressable-56', label: 'Pressable (dynamic label)', where: 'src/screens/A.tsx:56', proof: { kind: 'rntl', ref: 'src/a.test.tsx' }, note: 'Pressable · onPress · dynamic/child-text label' }] });
  assert(renamed.actions.length === 1, 're-point does not duplicate the action');
  assert(renamed.actions[0].id === 'screens/A#pressable-onadd', 're-point adopts the new id');
  assert(renamed.actions[0].proof.kind === 'rntl', 're-point keeps the human-owned proof');
  assert(!renamed.actions[0].stale, 're-pointed entries are never marked stale');
  assert(renamed.repointed[0].from === 'screens/A#pressable-56', 're-points are reported, not silent');

  // the line moved AND the id changed → matched on label+note within the file
  const moved = reconcile(
    [{ id: 'screens/A#pressable-onadd', label: 'L', where: 'src/screens/A.tsx:88', note: 'Pressable · onPress' }],
    { actions: [{ id: 'screens/A#pressable-56', label: 'L', where: 'src/screens/A.tsx:56', proof: { kind: 'unit', ref: 'x' }, note: 'Pressable · onPress' }] });
  assert(moved.actions[0].id === 'screens/A#pressable-onadd' && moved.actions[0].proof.kind === 'unit',
    'a moved line re-points on label+note within the same file');

  // ambiguity is never guessed away
  const ambiguous = reconcile(
    [{ id: 'screens/A#p-1', label: 'L', where: 'src/screens/A.tsx:10', note: 'N' },
     { id: 'screens/A#p-2', label: 'L', where: 'src/screens/A.tsx:20', note: 'N' }],
    { actions: [{ id: 'screens/A#pressable-56', label: 'L', where: 'src/screens/A.tsx:56', proof: { kind: 'unit', ref: 'x' }, note: 'N' }] });
  assert(ambiguous.actions[0].stale === true, 'two equally-good candidates go stale for a human, never a coin flip');
  assert(ambiguous.actions.length === 3, 'an unmatched extracted action is still appended');

  // a genuinely deleted action must still go stale
  const deleted = reconcile([], { actions: [{ id: 'screens/A#x', label: 'x', where: 'src/screens/A.tsx:3', proof: { kind: 'unit', ref: 'y' }, note: '' }] });
  assert(deleted.actions[0].stale === true && deleted.repointed.length === 0, 'a deleted action is still flagged stale');

  // stale clears when the action reappears
  const back = reconcile([...extracted, { id: 'screens/A#gone', label: 'gone', where: 'src/screens/A.tsx:12', note: '' }], merged);
  assert(!back.actions.find((a) => a.id === 'screens/A#gone').stale, 'stale flag clears when the action returns');

  // --- proof-ref checking ---
  const ctx = { anchors: new Set(['added']), waypoints: new Set(['done-toast']), fileExists: (r) => r === 'src/x.test.ts' };
  assert(checkProofRef({ kind: 'tier2-assert', ref: '@added' }, ctx) === true, 'tier2-assert ref resolves to a selector anchor');
  assert(checkProofRef({ kind: 'tier2-assert', ref: 'done-toast' }, ctx) === true, 'tier2-assert ref resolves to a journey waypoint');
  assert(checkProofRef({ kind: 'tier2-assert', ref: '@missing' }, ctx) === false, 'tier2-assert broken ref detected');
  assert(checkProofRef({ kind: 'unit', ref: 'src/x.test.ts' }, ctx) === true, 'unit ref resolves to an existing file');
  assert(checkProofRef({ kind: 'unit', ref: 'src/nope.test.ts' }, ctx) === false, 'unit broken ref detected');
  assert(checkProofRef({ kind: 'none' }, ctx) === false, 'kind none is never proven');

  // --- summarize ---
  const sum = summarize({ actions: [
    { id: 'a', proof: { kind: 'tier2-assert', ref: 'added' } },
    { id: 'b', proof: { kind: 'none' } },
    { id: 'c', proof: { kind: 'unit', ref: 'src/nope.test.ts' } },
    { id: 'd', stale: true },
  ] }, ctx);
  assert(sum.total === 4 && sum.proven === 1 && sum.unproven === 1 && sum.brokenRef === 1 && sum.stale === 1, 'summary counts total/proven/unproven/brokenRef/stale');

  console.log(process.exitCode ? '\naction-coverage self-test FAILED' : '\naction-coverage self-test PASSED');
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  if (flags.has('--self-test')) { runSelfTest(); return; }

  const appDir = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  if (!fs.existsSync(appDir)) { console.error(`App directory does not exist: ${appDir}`); process.exit(2); }

  const extracted = collectExtracted(appDir);
  const regPath = path.join(appDir, 'qa', 'actions.json');
  let registry = { actions: [] };
  if (fs.existsSync(regPath)) {
    try { registry = JSON.parse(fs.readFileSync(regPath, 'utf8')); }
    catch (e) { console.error(`qa/actions.json is not valid JSON: ${e.message}`); process.exit(2); }
  }
  const merged = reconcile(extracted, registry);
  // Preserve a leading $comment if the registry carried one.
  if (registry.$comment) merged.$comment = registry.$comment;
  else merged.$comment = 'Action-coverage registry (Uplevel-3 T3). Every user-facing action mapped to its proof: tier2-assert (a qa/journey.json waypoint) | rntl (a component test) | unit (a trust-core test) | none (a gap to backfill). Maintained by scripts/qa/action-coverage.mjs — it appends new-in-code actions + flags stale ones, never rewrites a proof by hand.';
  const ordered = { $comment: merged.$comment, actions: merged.actions };

  const ctx = buildCtx(appDir);
  const summary = summarize(ordered, ctx);

  if (!flags.has('--check')) {
    fs.mkdirSync(path.dirname(regPath), { recursive: true });
    fs.writeFileSync(regPath, JSON.stringify(ordered, null, 2) + '\n');
  }

  if (flags.has('--json')) {
    console.log(JSON.stringify({ appDir, summary, actions: ordered.actions }, null, 2));
  } else {
    const rel = path.relative(process.cwd(), appDir) || '.';
    console.log(`action-coverage · ${rel}`);
    console.log(`  ${summary.total} actions · ${summary.proven} proven · ${summary.unproven} unproven · ${summary.stale} stale · ${summary.brokenRef} broken-ref`);
    if (merged.repointed?.length) {
      console.log(`  re-pointed ${merged.repointed.length} entr${merged.repointed.length === 1 ? 'y' : 'ies'} (same action, new id — proof kept):`);
      for (const r of merged.repointed) console.log(`    · ${r.from}  →  ${r.to}`);
    }
    if (summary.unproven) {
      const gaps = ordered.actions.filter((a) => !a.stale && (!a.proof || a.proof.kind === 'none'));
      console.log('  gaps (proof: none):');
      for (const g of gaps) console.log(`    · ${g.id}  (${g.where})`);
    }
    if (summary.stale) {
      for (const s of ordered.actions.filter((a) => a.stale)) console.log(`    stale: ${s.id}`);
    }
  }

  if (flags.has('--check') && (summary.unproven || summary.stale || summary.brokenRef)) process.exit(1);
}

main();
