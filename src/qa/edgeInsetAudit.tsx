/**
 * Canonical, app-agnostic — synced by `sync.mjs qa`; do not fork.
 *
 * Renders one screen the way the edge-inset audit (./edgeInset.ts) needs it
 * and returns the findings: inside a SafeAreaProvider with fixed phone metrics
 * (a 390 x 844 iPhone with a notch and a home indicator), after the screen has
 * finished loading. Pass `readyText` — text that only appears once async data
 * or a sheet has landed — or the audit reads the loading frame. Wrap a screen
 * that needs app context (a store provider, a navigation container) before
 * passing it in.
 *
 * Test-only: imported from __tests__, never from app code.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  countContentLeaves,
  findEdgeInsetViolations,
  type EdgeInsetFinding,
  type LayoutNode,
} from './edgeInset';

export const AUDIT_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * Render `ui`, wait for `readyText` if given, run `interact` if given (tap the
 * row that opens a picker, then wait for it), and audit what's on screen.
 * Throws when nothing rendered at all, so a sheet left closed or a screen
 * missing its data can't pass by having no content to check.
 */
export async function auditScreen(
  ui: React.ReactElement,
  opts: { readyText?: string | RegExp; interact?: () => Promise<void> } = {}
): Promise<EdgeInsetFinding[]> {
  const r = await render(<SafeAreaProvider initialMetrics={AUDIT_METRICS}>{ui}</SafeAreaProvider>);
  if (opts.readyText) await screen.findByText(opts.readyText);
  if (opts.interact) await opts.interact();
  const tree = r.toJSON() as LayoutNode | LayoutNode[] | null;
  if (countContentLeaves(tree) === 0) {
    throw new Error(
      'auditScreen: rendered no text or icons, so there is nothing to audit. Check the props ' +
        '(a sheet needs `visible`), the data it needs, or pass readyText to wait for it to load.'
    );
  }
  return findEdgeInsetViolations(tree);
}
