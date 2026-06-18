/**
 * User appearance preference — System / Light / Dark — for the whole app.
 *
 * Canonical mirror; synced into each app at src/theme/themePreference.ts by
 * `sync.mjs design-system-native`. Edit HERE, not per app.
 *
 * Self-contained on purpose: it persists with AsyncStorage (every app already
 * depends on it) and applies the scheme with React Native's `Appearance` — no
 * dependency on the app shell, i18n, or SQLite, so it works in every app
 * regardless of whether it has adopted the app-shell yet.
 *
 * How it drives the UI: `Appearance.setColorScheme(...)` overrides what
 * `useColorScheme()` returns process-wide, and the canonical `useTheme()`
 * (colors.ts) reads `useColorScheme()`. So setting the preference re-renders
 * every themed surface — no extra context plumbing through the tree.
 *
 *   // App root (or AppShell), once:
 *   useApplyThemePreference();
 *
 *   // The toggle (or any surface that needs to read/set it):
 *   const { pref, setPref } = useThemePreference();
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemePref = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'ja.theme.preference';

// Module-level singleton store. A toggle on the Settings screen and the
// apply-on-launch hook at the root must share one source of truth without a
// React context wrapping the tree — so the state lives here and components
// subscribe via useSyncExternalStore.
let current: ThemePref = 'system';
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 'unspecified' hands control back to the OS; 'light'/'dark' force it. It's the
 * runtime value the native module wants on every supported RN version (RN 0.81
 * / SDK 54 coerces it internally, RN 0.85 / SDK 56 takes it directly) — but
 * older RN's `ColorSchemeName` type omits the literal, so cast past the
 * per-version union instead of branching on SDK.
 */
function applyScheme(pref: ThemePref): void {
  const scheme = pref === 'system' ? 'unspecified' : pref;
  Appearance.setColorScheme(scheme as Parameters<typeof Appearance.setColorScheme>[0]);
}

function coerce(value: string | null): ThemePref {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Persist + apply a new preference. Exported for non-React call sites (e.g.
 *  QA seeding); UI should prefer the `useThemePreference` hook. */
export function setThemePreference(pref: ThemePref): void {
  current = pref;
  applyScheme(pref);
  emit();
  AsyncStorage.setItem(STORAGE_KEY, pref).catch(() => {});
}

let loadStarted = false;

/** Load the saved preference from disk and apply it. Idempotent — safe to call
 *  from more than one mounted component; the read happens once. */
export function loadThemePreference(): void {
  if (loadStarted) return;
  loadStarted = true;
  AsyncStorage.getItem(STORAGE_KEY)
    .then((value) => {
      current = coerce(value);
      applyScheme(current);
    })
    .catch(() => {})
    .finally(emit);
}

/**
 * Call ONCE near the app root (App.tsx, or the canonical AppShell for shell
 * apps): on mount it restores the saved appearance and applies it before the
 * user touches anything. Without this the app silently falls back to following
 * the OS, ignoring a saved Light/Dark choice.
 */
export function useApplyThemePreference(): void {
  useEffect(() => {
    loadThemePreference();
  }, []);
}

/** Reactive accessor for the toggle UI and anything that branches on the
 *  user's explicit choice (vs. the resolved scheme, which is `useTheme()`). */
export function useThemePreference(): { pref: ThemePref; setPref: (pref: ThemePref) => void } {
  const pref = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
  const setPref = useCallback((next: ThemePref) => setThemePreference(next), []);
  return { pref, setPref };
}
