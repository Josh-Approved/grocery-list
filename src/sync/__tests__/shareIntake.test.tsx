/**
 * Share-link intake — regression for the customer report of 2026-10-24:
 * "When we share using the QR code, it opens the app but doesn't give the
 * shared list."
 *
 * The phone camera hands the link to a CLOSED app. The old handler joined the
 * moment `Linking.getInitialURL()` resolved, which is before the store has
 * read the disk; `hydrate()` then replaced the store and the joined list was
 * gone from the screen (it only came back after a full restart). It also tried
 * to open the list once, 500 ms in, while the splash was still up.
 *
 * Failing-first: the cold-start case below fails when the intake joins
 * without waiting for `ready` (the old ordering), and passes with the fix.
 */

// SQLite can't load in node. loadAllLists is held open so the test controls
// exactly when hydrate() finishes, which is the whole race.
let finishLoad: (lists: unknown[]) => void = () => {};
jest.mock('../../store/db', () => ({
  loadAllLists: jest.fn(
    () =>
      new Promise((resolve) => {
        finishLoad = resolve;
      })
  ),
  saveList: jest.fn(async () => {}),
  deleteListFromDb: jest.fn(async () => {}),
  putTombstone: jest.fn(async () => {}),
  removeTombstone: jest.fn(async () => {}),
  getSyncMeta: jest.fn(async () => null),
  setSyncMeta: jest.fn(async () => {}),
  loadAllKits: jest.fn(async () => []),
  saveKit: jest.fn(async () => {}),
}));

import { Linking } from 'react-native';
import { renderHook, act } from '@testing-library/react-native';
import {
  useShareLinkIntake,
  OPEN_RETRY_MS,
  OPEN_GIVE_UP_MS,
} from '../shareIntake';
import { buildShareLink } from '../share';
import { useListsStore } from '../../store/lists';
import { makeList } from '../../data/list';

const SECRET = 'S'.repeat(44); // plausible base64 length

let initialUrl: string | null = null;
let urlListener: ((e: { url: string }) => void) | null = null;

beforeEach(() => {
  initialUrl = null;
  urlListener = null;
  jest.spyOn(Linking, 'getInitialURL').mockImplementation(async () => initialUrl);
  jest
    .spyOn(Linking, 'addEventListener')
    .mockImplementation(((_: string, fn: (e: { url: string }) => void) => {
      urlListener = fn;
      return { remove: () => (urlListener = null) };
    }) as unknown as typeof Linking.addEventListener);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('cold start (the app was closed when the link was opened)', () => {
  it('keeps the joined list once the stores finish loading, and opens it', async () => {
    const existing = makeList('Weekend');
    const hydrating = useListsStore.getState().hydrate();
    initialUrl = buildShareLink(SECRET);
    const opened: string[] = [];

    const { rerender } = await renderHook(
      ({ ready }: { ready: boolean }) =>
        useShareLinkIntake({
          ready,
          join: (s) => useListsStore.getState().joinShared(s),
          open: (id) => {
            opened.push(id);
            return true;
          },
        }),
      { initialProps: { ready: false } }
    );

    // The disk read lands after the link did.
    await act(async () => {
      finishLoad([existing]);
      await hydrating;
    });
    await rerender({ ready: useListsStore.getState().hydrated });

    const lists = useListsStore.getState().lists;
    const joined = lists.find((l) => l.shareIdentity?.secret === SECRET);
    expect(joined).toBeDefined();
    expect(lists.some((l) => l.id === existing.id)).toBe(true);
    expect(opened).toEqual([joined!.id]);
  });

  it('does nothing with the link until the app is ready', async () => {
    initialUrl = buildShareLink(SECRET);
    const join = jest.fn(() => 'id-1');
    const open = jest.fn(() => true);
    const { rerender } = await renderHook(
      ({ ready }: { ready: boolean }) => useShareLinkIntake({ ready, join, open }),
      { initialProps: { ready: false } }
    );
    expect(join).not.toHaveBeenCalled();
    await rerender({ ready: true });
    expect(join).toHaveBeenCalledWith(SECRET);
    expect(open).toHaveBeenCalledWith('id-1');
  });

  it('keeps trying to open the list while navigation is still mounting', async () => {
    jest.useFakeTimers();
    initialUrl = buildShareLink(SECRET);
    let navReadyAfter = 4;
    const open = jest.fn(() => --navReadyAfter <= 0);
    await renderHook(() =>
      useShareLinkIntake({ ready: true, join: () => 'id-1', open })
    );
    await act(async () => {
      jest.advanceTimersByTime(OPEN_RETRY_MS * 10);
    });
    expect(open).toHaveBeenCalledTimes(4);
    expect(open).toHaveBeenLastCalledWith('id-1');
  });

  it('gives up opening (but stays joined) if navigation never comes up', async () => {
    jest.useFakeTimers();
    initialUrl = buildShareLink(SECRET);
    const join = jest.fn(() => 'id-1');
    const open = jest.fn(() => false);
    await renderHook(() => useShareLinkIntake({ ready: true, join, open }));
    await act(async () => {
      jest.advanceTimersByTime(OPEN_GIVE_UP_MS + OPEN_RETRY_MS * 5);
    });
    const calls = open.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(OPEN_RETRY_MS * 20);
    });
    expect(open.mock.calls.length).toBe(calls);
    expect(join).toHaveBeenCalledTimes(1);
  });
});

describe('warm start (the app was already running)', () => {
  it('joins and opens straight away', async () => {
    const join = jest.fn(() => 'id-2');
    const open = jest.fn(() => true);
    await renderHook(() => useShareLinkIntake({ ready: true, join, open }));
    await act(async () => {
      urlListener!({ url: buildShareLink(SECRET) });
    });
    expect(join).toHaveBeenCalledWith(SECRET);
    expect(open).toHaveBeenCalledWith('id-2');
  });

  it('treats the same link arriving twice on one launch as one', async () => {
    initialUrl = buildShareLink(SECRET);
    const join = jest.fn(() => 'id-3');
    const open = jest.fn(() => true);
    await renderHook(() => useShareLinkIntake({ ready: true, join, open }));
    await act(async () => {
      urlListener!({ url: buildShareLink(SECRET) });
    });
    expect(join).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('accepts old app-scheme links and ignores links that are not invites', async () => {
    const join = jest.fn(() => 'id-4');
    await renderHook(() =>
      useShareLinkIntake({ ready: true, join, open: () => true })
    );
    await act(async () => {
      urlListener!({ url: 'grocerylist://somewhere-else' });
      urlListener!({ url: `grocerylist://join?s=${encodeURIComponent(SECRET)}` });
    });
    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith(SECRET);
  });
});
