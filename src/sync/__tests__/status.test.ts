/**
 * Live sync status (sync/status.ts) — the data behind the only honest
 * liveness signal a shared list has.
 *
 * The engine writes here and SyncStatusBar reads it, so every field is a claim
 * made to the user's face ("Connected", "Not syncing", "Offline"). Two shapes
 * of bug are invisible without this suite:
 *
 *  • A DEFAULT THAT ISN'T THERE. The UI branches on `connected` and
 *    `publishRejected` before anything has ever been reported. If a field can
 *    arrive `undefined` instead of its default, the bar renders a state nobody
 *    designed — and `undefined` reads as "false" often enough to hide it in
 *    review. The full default shape is asserted, not just the field under test.
 *
 *  • A STATUS THAT OUTLIVES ITS LIST. Unsharing a list drops its channel; if
 *    the status entry survives, a list that is no longer shared keeps a stale
 *    "Connected" attached to a secret nothing is listening on.
 *
 * Nothing here is persisted — status is per-run by design — so the store is
 * reset between tests exactly as a cold start would leave it.
 */

import { renderHook, act } from '@testing-library/react-native';

import {
  useSyncStatusStore,
  useChannelStatus,
  markConnected,
  markReceived,
  markSent,
  markDelivered,
  dropStatus,
  type ChannelStatus,
} from '../status';

/** What a list that has never reported anything must look like. */
const DEFAULTS: ChannelStatus = {
  connected: false,
  lastReceivedAt: null,
  lastSentAt: null,
  publishRejected: false,
};

const A = 'secret-list-a';
const B = 'secret-list-b';
const AT = 1_700_000_000_000;

beforeEach(() => {
  useSyncStatusStore.setState({ bySecret: {} });
});

describe('defaults', () => {
  it('a list nothing has reported on reads the full default shape', async () => {
    const { result } = await renderHook(() => useChannelStatus(A));
    expect(result.current).toEqual(DEFAULTS);
  });

  it('a solo list — no share secret at all — reads the same defaults', async () => {
    const { result } = await renderHook(() => useChannelStatus(undefined));
    expect(result.current).toEqual(DEFAULTS);
  });

  it('the hook picks up an update the engine makes while the bar is on screen', async () => {
    const { result } = await renderHook(() => useChannelStatus(A));
    expect(result.current.connected).toBe(false);

    await act(async () => markConnected(A, true));

    expect(result.current.connected).toBe(true);
  });
});

describe('what each engine marker records', () => {
  it('markConnected sets only the socket state', () => {
    markConnected(A, true);
    expect(useSyncStatusStore.getState().bySecret[A]).toEqual({
      ...DEFAULTS,
      connected: true,
    });
  });

  it('markReceived records when a peer copy last landed', () => {
    markReceived(A, AT);
    expect(useSyncStatusStore.getState().bySecret[A]).toEqual({
      ...DEFAULTS,
      lastReceivedAt: AT,
    });
  });

  it('markSent records when we last published', () => {
    markSent(A, AT);
    expect(useSyncStatusStore.getState().bySecret[A]).toEqual({
      ...DEFAULTS,
      lastSentAt: AT,
    });
  });

  it('markDelivered(false) raises publishRejected; (true) clears it', () => {
    // "Delivered" is the inverse of "rejected" — the field the UI reads is
    // publishRejected, so the polarity flip here is the whole point of the
    // honesty fix (defect grocery-list-20260704-8).
    markDelivered(A, false);
    expect(useSyncStatusStore.getState().bySecret[A].publishRejected).toBe(true);

    markDelivered(A, true);
    expect(useSyncStatusStore.getState().bySecret[A].publishRejected).toBe(false);
  });

  it('later markers merge in — a reconnect does not wipe the timestamps', () => {
    markReceived(A, AT);
    markSent(A, AT + 5);
    markConnected(A, true);
    markDelivered(A, false);

    expect(useSyncStatusStore.getState().bySecret[A]).toEqual({
      connected: true,
      lastReceivedAt: AT,
      lastSentAt: AT + 5,
      publishRejected: true,
    });
  });

  it('keeps each shared list separate', () => {
    markConnected(A, true);
    markConnected(B, false);
    markReceived(B, AT);

    expect(useSyncStatusStore.getState().bySecret[A]).toEqual({
      ...DEFAULTS,
      connected: true,
    });
    expect(useSyncStatusStore.getState().bySecret[B]).toEqual({
      ...DEFAULTS,
      lastReceivedAt: AT,
    });
  });
});

describe('dropStatus (a list stopped being shared)', () => {
  it('forgets that list entirely — no stale "Connected" left behind', async () => {
    markConnected(A, true);
    markSent(A, AT);

    dropStatus(A);

    expect(useSyncStatusStore.getState().bySecret[A]).toBeUndefined();
    expect(await readChannelStatus(A)).toEqual(DEFAULTS);
  });

  it('leaves the other shared lists alone', () => {
    markConnected(A, true);
    markConnected(B, true);

    dropStatus(A);

    expect(useSyncStatusStore.getState().bySecret[B]).toEqual({
      ...DEFAULTS,
      connected: true,
    });
  });

  it('is a true no-op for a secret it never knew — same object, no re-render', () => {
    markConnected(A, true);
    const before = useSyncStatusStore.getState().bySecret;

    dropStatus('never-paired');

    // Identity, not equality: handing React a fresh object here would re-render
    // every mounted status bar for nothing.
    expect(useSyncStatusStore.getState().bySecret).toBe(before);
  });
});

/** Render the hook once and read what a status bar would have shown. */
async function readChannelStatus(secret: string): Promise<ChannelStatus> {
  const { result } = await renderHook(() => useChannelStatus(secret));
  return result.current;
}
