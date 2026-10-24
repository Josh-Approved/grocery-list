/**
 * Canonical, app-agnostic — synced by `sync.mjs qa`; do not fork. Fix a false
 * alarm or a miss in the factory template (templates/qa/edge-inset/) and
 * re-sync, so every app gets the fix.
 *
 * Edge-inset audit — catches content sitting flush against the inside edge of
 * a card, sheet, or button (defect: workout-timer's Settings "Sounds" card
 * shipped with "Warm up start" touching the card's left border, because
 * DrilldownRow brings no horizontal padding and the card supplied none either).
 *
 * Works on a rendered host tree (`render(...).toJSON()`), so it runs in jest on
 * every PR with no device. For each piece of visible leaf content (a Text run,
 * a TextInput, or an SVG icon) it walks up to the nearest *surface* — a view with a fill or
 * a side border, i.e. something with a visible edge — and adds up every
 * padding and margin in between on the side(s) the content actually reaches.
 * Content that can't reach an edge (centered, or a middle child of a row) is
 * skipped; content that reaches one with less than MIN_EDGE_INSET of clearance
 * is a finding.
 *
 * It reads styles, not measured layout, so it judges the common cases (rows,
 * columns, stretch/center alignment) and stays quiet when it can't tell —
 * percentages, `auto` margins, absolute positioning. A miss is possible; a
 * false alarm should be rare enough to fix rather than suppress.
 *
 * Known blind spot: CENTERED text is skipped. Whether it reaches an edge
 * depends on its measured width against its box, which a style read can't
 * see — a short label centered in a full-width button is fine with no side
 * padding, the same label in a narrow segment of a segmented control may not
 * be (packing-list's "How thoroughly to pack" in German, 2026-10). Flagging
 * centered text was tried and fired on every full-width button in the fleet.
 * The review rubric's "Edge crowding" check and the large-font matrix cells
 * cover that case.
 *
 * Wiring: src/qa/edgeInsetAudit.tsx renders a screen and runs this;
 * src/qa/__tests__/edgeInset.proof.test.tsx (canonical) proves it catches the
 * shape that shipped; src/qa/__tests__/edgeInset.screens.test.tsx (app-owned)
 * lists the screens it runs over.
 */

import { StyleSheet } from 'react-native';
import { space } from '../theme/tokens';

export type LayoutNode = {
  type: string;
  props: Record<string, any>;
  children: (LayoutNode | string)[] | null;
};

export type EdgeInsetFinding = {
  /** The text run, or the icon's host type. */
  content: string;
  edge: 'start' | 'end';
  /** Total clearance found between the content and the surface edge, in pt. */
  inset: number;
};

/** Less clearance than this between content and a visible edge reads as touching. */
export const MIN_EDGE_INSET = space.s3;

type Style = Record<string, any>;
type Side = 'start' | 'end';

const flat = (node: LayoutNode): Style => (StyleSheet.flatten(node.props.style) ?? {}) as Style;

const isLeaf = (n: LayoutNode) =>
  n.type === 'Text' || n.type === 'TextInput' || n.type.startsWith('RNSVGSvgView');

// A side value, most specific first. NaN = unknowable (a percentage / 'auto').
function sideValue(s: Style, prop: 'padding' | 'margin', side: Side): number {
  const physical = side === 'start' ? 'Left' : 'Right';
  const logical = side === 'start' ? 'Start' : 'End';
  const v =
    s[`${prop}${logical}`] ?? s[`${prop}${physical}`] ?? s[`${prop}Horizontal`] ?? s[prop] ?? 0;
  return typeof v === 'number' ? v : NaN;
}

function borderValue(s: Style, side: Side): number {
  const physical = side === 'start' ? 'Left' : 'Right';
  const logical = side === 'start' ? 'Start' : 'End';
  const v = s[`border${logical}Width`] ?? s[`border${physical}Width`] ?? s.borderWidth ?? 0;
  return typeof v === 'number' ? v : 0;
}

function isTransparent(color: unknown): boolean {
  if (color == null || color === 'transparent') return true;
  if (typeof color === 'string') {
    const rgba = color.match(/^rgba\(.*,\s*([\d.]+)\s*\)$/);
    if (rgba) return Number(rgba[1]) === 0;
    if (/^#[0-9a-f]{8}$/i.test(color)) return color.slice(7).toLowerCase() === '00';
  }
  return false;
}

/**
 * Has a visible edge on this side: a border on that side, or a fill that
 * differs from what's behind it (`backdrop`, the nearest filled ancestor's
 * colour). A fill matching its backdrop draws no edge — grocery-list's swipe
 * rows paint their content layer the screen colour only to hide the Delete
 * action beneath it.
 */
function isSurface(s: Style, side: Side, backdrop?: unknown): boolean {
  if (borderValue(s, side) > 0) return true;
  return !isTransparent(s.backgroundColor) && s.backgroundColor !== backdrop;
}

/** The fill showing behind ancestors[i]: the nearest filled ancestor above it. */
function backdropOf(ancestors: LayoutNode[], i: number): unknown {
  for (let j = i - 1; j >= 0; j--) {
    const bg = flat(ancestors[j]).backgroundColor;
    if (!isTransparent(bg)) return bg;
  }
  return undefined;
}

function textOf(n: LayoutNode): string {
  return (n.children ?? [])
    .map((c) => (typeof c === 'string' ? c : textOf(c)))
    .join('');
}

/** Children that take part in flow layout (absolutely positioned ones don't). */
function flowChildren(n: LayoutNode): LayoutNode[] {
  return (n.children ?? []).filter(
    (c): c is LayoutNode => typeof c !== 'string' && flat(c).position !== 'absolute'
  );
}

function contentOf(leaf: LayoutNode): string {
  if (leaf.type === 'Text') return textOf(leaf);
  if (leaf.type === 'TextInput') return `TextInput "${leaf.props.value || leaf.props.placeholder || ''}"`;
  return leaf.type;
}

function auditLeaf(leaf: LayoutNode, ancestors: LayoutNode[]): EdgeInsetFinding[] {
  const own = flat(leaf);
  if (own.position === 'absolute') return [];
  // A filled or bordered input is its own surface: what it types sits inside
  // its own padding, so that padding is the clearance. A bare input is judged
  // like text, against whatever surface it sits in.
  if (leaf.type === 'TextInput') {
    const tight = (['start', 'end'] as Side[]).filter(
      (s) => isSurface(own, s) && sideValue(own, 'padding', s) < MIN_EDGE_INSET
    );
    if (tight.length > 0 || isSurface(own, 'start') || isSurface(own, 'end')) {
      return tight.map((s) => ({ content: contentOf(leaf), edge: s, inset: sideValue(own, 'padding', s) }));
    }
  }
  const reaches = { start: true, end: true };
  if (leaf.type === 'Text') {
    if (own.textAlign === 'center') return [];
    if (own.textAlign === 'right') reaches.start = false;
  }
  const inset = { start: 0, end: 0 };
  const sides: Side[] = ['start', 'end'];

  // Borders never count as clearance: a border *is* the visible edge.
  let child = leaf;
  for (const s of sides) inset[s] += sideValue(own, 'margin', s) + sideValue(own, 'padding', s);

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i];
    const ps = flat(parent);
    const cs = flat(child);
    const siblings = flowChildren(parent);
    const idx = siblings.indexOf(child);
    const dir = ps.flexDirection ?? 'column';

    if (dir === 'row' || dir === 'row-reverse') {
      const first = dir === 'row' ? 0 : siblings.length - 1;
      const last = dir === 'row' ? siblings.length - 1 : 0;
      if (idx !== first) reaches.start = false;
      if (idx !== last) reaches.end = false;
      const justify = ps.justifyContent ?? 'flex-start';
      if (['center', 'space-around', 'space-evenly'].includes(justify)) return [];
      if (justify === 'flex-end') reaches.start = false;
    } else {
      const align = cs.alignSelf && cs.alignSelf !== 'auto' ? cs.alignSelf : ps.alignItems ?? 'stretch';
      // `width: '100%'` fills the line whatever the alignment (boundedContent).
      const fills = cs.width === '100%';
      if (align === 'center' && !fills) return [];
      if (!fills && align === 'flex-end') reaches.start = false;
      if (!fills && (align === 'flex-start' || align === 'baseline')) reaches.end = false;
    }
    if (!reaches.start && !reaches.end) return [];

    const backdrop = backdropOf(ancestors, i);
    const surfaceSides = sides.filter((s) => reaches[s] && isSurface(ps, s, backdrop));
    for (const s of sides) inset[s] += sideValue(ps, 'padding', s);
    if (surfaceSides.length > 0) {
      return surfaceSides
        .filter((s) => !Number.isNaN(inset[s]) && inset[s] < MIN_EDGE_INSET)
        .map((s) => ({
          content: contentOf(leaf),
          edge: s,
          inset: inset[s],
        }));
    }
    for (const s of sides) inset[s] += sideValue(ps, 'margin', s);
    if (sides.every((s) => !reaches[s] || Number.isNaN(inset[s]))) return [];
    child = parent;
  }
  return [];
}

// The jest host tree hangs a ScrollView's `contentContainerStyle` on the
// scroll view itself and leaves the inner content view unstyled; on device that
// style lives on the inner view. Move it there so the padding is counted.
function withContentContainers(node: LayoutNode): LayoutNode {
  const kids = (node.children ?? []).map((c) => (typeof c === 'string' ? c : withContentContainers(c)));
  const ccs = node.props.contentContainerStyle;
  const first = kids[0];
  if (ccs && first && typeof first !== 'string') {
    kids[0] = { ...first, props: { ...first.props, style: [ccs, first.props.style] } };
  }
  return { ...node, children: kids };
}

/** How many text runs and icons the audit would look at — 0 means nothing rendered. */
export function countContentLeaves(root: LayoutNode | LayoutNode[] | null): number {
  const count = (node: LayoutNode): number =>
    isLeaf(node)
      ? 1
      : (node.children ?? []).reduce((n, c) => n + (typeof c === 'string' ? 0 : count(c)), 0);
  return (Array.isArray(root) ? root : root ? [root] : []).reduce((n, r) => n + count(r), 0);
}

/** Every leaf in the tree that sits closer than MIN_EDGE_INSET to a visible edge. */
export function findEdgeInsetViolations(
  root: LayoutNode | LayoutNode[] | null
): EdgeInsetFinding[] {
  const findings: EdgeInsetFinding[] = [];
  const visit = (node: LayoutNode, ancestors: LayoutNode[]) => {
    if (isLeaf(node)) {
      findings.push(...auditLeaf(node, ancestors));
      return; // nested Text runs belong to their outer Text
    }
    for (const c of node.children ?? []) {
      if (typeof c !== 'string') visit(c, [...ancestors, node]);
    }
  };
  for (const r of Array.isArray(root) ? root : root ? [root] : []) visit(withContentContainers(r), []);
  return findings;
}
