/**
 * Live sync status, per shared list (keyed by secret).
 *
 * The engine writes here; the UI reads it to show an honest "Connected /
 * Offline" indicator and a tap-to-resync affordance on shared lists. This is
 * the minimal, always-on health signal — it makes a stale list visible instead
 * of silent (the "honest about live-ness" tenet), and it's the first rung of
 * the user-volunteered diagnostics direction.
 *
 * Nothing here leaves the device. It's in-memory only (status is ephemeral —
 * connection state on this run), so it costs no storage and collects nothing.
 */

import { create } from 'zustand';

export interface ChannelStatus {
  /** At least one relay socket is currently open for this list's channel. */
  connected: boolean;
  /** ms of the last list copy received from a peer (null = none this run). */
  lastReceivedAt: number | null;
  /** ms of the last copy we published. */
  lastSentAt: number | null;
}

const EMPTY: ChannelStatus = { connected: false, lastReceivedAt: null, lastSentAt: null };

interface SyncStatusState {
  bySecret: Record<string, ChannelStatus>;
  patch: (secret: string, patch: Partial<ChannelStatus>) => void;
  drop: (secret: string) => void;
}

export const useSyncStatusStore = create<SyncStatusState>((set) => ({
  bySecret: {},
  patch: (secret, p) =>
    set((s) => ({
      bySecret: {
        ...s.bySecret,
        [secret]: { ...EMPTY, ...s.bySecret[secret], ...p },
      },
    })),
  drop: (secret) =>
    set((s) => {
      if (!(secret in s.bySecret)) return s;
      const next = { ...s.bySecret };
      delete next[secret];
      return { bySecret: next };
    }),
}));

// ---- Engine-side helpers (not React) --------------------------------------

export function markConnected(secret: string, connected: boolean): void {
  useSyncStatusStore.getState().patch(secret, { connected });
}
export function markReceived(secret: string, at: number): void {
  useSyncStatusStore.getState().patch(secret, { lastReceivedAt: at });
}
export function markSent(secret: string, at: number): void {
  useSyncStatusStore.getState().patch(secret, { lastSentAt: at });
}
export function dropStatus(secret: string): void {
  useSyncStatusStore.getState().drop(secret);
}

/** React selector hook: this list's status, or a stable default. */
export function useChannelStatus(secret: string | undefined): ChannelStatus {
  return useSyncStatusStore((s) => (secret ? s.bySecret[secret] ?? EMPTY : EMPTY));
}
