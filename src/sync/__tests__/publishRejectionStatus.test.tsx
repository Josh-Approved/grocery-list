/**
 * Regression — defect grocery-list-20260704-8: sync-status honesty under
 * publish rejection.
 *
 * As shipped, the UI said "Connected" while every relay was rejecting our
 * publishes (NIP-20 OK-false: rate limit, max event size, …) — the socket was
 * up but nothing we published left the device. The fix threads a rejection
 * signal through the whole path:
 *
 *   transport.onWire(['OK', id, false, reason])  — every recipient rejected
 *     → onPublishResult(false, reason)           (transport.ts)
 *     → markDelivered(secret, false)             (engine wiring, sync/index.ts)
 *     → status.publishRejected = true            (status.ts)
 *     → SyncStatusBar renders "Not syncing"      (not "Connected")
 *
 * This suite pins both ends of that path, failing-first proven against a
 * locally neutered fix:
 *   • Transport level: the REAL DropBoxTransport over fake WebSockets — a
 *     rejection from every socket that received the event fires
 *     onPublishResult(false, reason); one acceptance anywhere fires (true).
 *   • Engine → status → UI: the REAL engine wiring (via __setTransportFactory,
 *     as engine.test.ts does) driving the REAL status store, with the REAL
 *     SyncStatusBar asserting the on-screen label reads "Not syncing" — and
 *     NOT "Connected" — while rejections are live, then recovers to
 *     "Connected" on the next accepted publish.
 */

// Native side-effect stubs — the standard component-test preamble (see
// ScreenHeader.component.test.tsx): mock native side-effects, never the SUT.
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// SQLite can't load in node; persistence is fire-and-forget and not the SUT.
jest.mock('../../store/db', () => ({
  loadAllLists: jest.fn(async () => []),
  saveList: jest.fn(async () => {}),
  deleteListFromDb: jest.fn(async () => {}),
  putTombstone: jest.fn(async () => {}),
  removeTombstone: jest.fn(async () => {}),
  getSyncMeta: jest.fn(async () => null),
  setSyncMeta: jest.fn(async () => {}),
  loadAllKits: jest.fn(async () => []),
  saveKit: jest.fn(async () => {}),
}));

// @noble/* is pure ESM (jest doesn't transform it — see engine.test.ts). Here
// the transport's NIP-20 protocol handling IS the SUT, so instead of stubbing
// the whole transport module we stub only its crypto primitives: real sha256
// via node (event ids stay unique + deterministic), inert schnorr key/sig
// (fake relays don't verify signatures).
jest.mock('@noble/curves/secp256k1.js', () => ({
  schnorr: {
    getPublicKey: () => new Uint8Array(32).fill(7),
    sign: () => new Uint8Array(64).fill(9),
  },
}));
jest.mock('@noble/hashes/sha2.js', () => ({
  sha256: (data: Uint8Array) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto');
    return new Uint8Array(createHash('sha256').update(Buffer.from(data)).digest());
  },
}));
jest.mock('@noble/hashes/utils.js', () => ({
  bytesToHex: (b: Uint8Array) => Buffer.from(b).toString('hex'),
  utf8ToBytes: (s: string) => new Uint8Array(Buffer.from(s, 'utf8')),
}));

import React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react-native';

import { DropBoxTransport } from '../transport';
import { useSyncStatusStore } from '../status';
import { useListsStore } from '../../store/lists';
import { newSecret } from '../crypto';
import {
  startSyncEngine,
  stopSyncEngine,
  __setTransportFactory,
  type EngineTransport,
} from '../index';
import { SyncStatusBar } from '../../components/SyncStatusBar';
import type { GroceryList } from '../../data/list';

// ---------------------------------------------------------------------------
// Fake WebSocket — lets the REAL transport run its wire protocol in node.
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
  /** Test-side: the relay accepts the connection. */
  open() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  /** Test-side: the relay sends us a frame. */
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The Nostr event id of the EVENT frame this socket was sent, if any. */
  publishedEventId(): string | undefined {
    const ev = this.sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'EVENT');
    return ev?.[1]?.id;
  }
}

const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeAll(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
});
afterAll(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
});

beforeEach(() => {
  FakeWebSocket.instances = [];
});

// ---------------------------------------------------------------------------
// Layer 1 — DropBoxTransport surfaces NIP-20 rejections via onPublishResult
// ---------------------------------------------------------------------------

describe('DropBoxTransport publish-rejection (NIP-20 OK-false)', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  function openTransport(onPublishResult: jest.Mock) {
    const tr = new DropBoxTransport(
      'chan-honesty',
      jest.fn(),
      jest.fn(),
      jest.fn(),
      onPublishResult
    );
    tr.start();
    const sockets = FakeWebSocket.instances;
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    sockets[0].open();
    sockets[1].open();
    return { tr, a: sockets[0], b: sockets[1] };
  }

  test('every recipient relay rejecting the publish fires onPublishResult(false, reason)', () => {
    const onPublishResult = jest.fn();
    const { tr, a, b } = openTransport(onPublishResult);

    tr.publish('ciphertext-payload-1');
    const id = a.publishedEventId();
    expect(id).toBeTruthy();
    expect(b.publishedEventId()).toBe(id); // both open relays got it

    // First rejection: not yet conclusive — the other recipient may accept.
    a.receive(['OK', id, false, 'rate-limited: slow down']);
    expect(onPublishResult).not.toHaveBeenCalled();

    // Second (= every recipient) rejection: the publish silently failed.
    b.receive(['OK', id, false, 'invalid: event too large']);
    expect(onPublishResult).toHaveBeenCalledTimes(1);
    expect(onPublishResult).toHaveBeenCalledWith(false, 'invalid: event too large');

    tr.close();
  });

  test('one acceptance anywhere means delivered — fires (true), later rejects ignored', () => {
    const onPublishResult = jest.fn();
    const { tr, a, b } = openTransport(onPublishResult);

    tr.publish('ciphertext-payload-2');
    const id = a.publishedEventId();

    a.receive(['OK', id, true, '']);
    expect(onPublishResult).toHaveBeenCalledTimes(1);
    expect(onPublishResult).toHaveBeenCalledWith(true, '');

    b.receive(['OK', id, false, 'rate-limited: slow down']);
    expect(onPublishResult).toHaveBeenCalledTimes(1); // still just the acceptance

    tr.close();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — engine wiring → status store → SyncStatusBar label honesty
// ---------------------------------------------------------------------------

const SECRET = newSecret();

function sharedList(): GroceryList {
  const at = 1000;
  return {
    id: 'l1',
    name: 'Groceries',
    nameUpdatedAt: at,
    items: [],
    categoryOrder: ['Other'],
    createdAt: at,
    updatedAt: at,
    shareIdentity: { secret: SECRET, createdAt: at },
  };
}

describe('sync status honesty: rejection reads "Not syncing", never "Connected"', () => {
  let onStatus: ((openRelays: number) => void) | undefined;
  let onPublishResult: ((delivered: boolean, reason: string) => void) | undefined;
  let restore: () => void;

  beforeEach(() => {
    restore = __setTransportFactory((_channel, _onMessage, _onReconnect, st, pr) => {
      onStatus = st;
      onPublishResult = pr;
      const fake: EngineTransport = { start() {}, publish() {}, close() {} };
      return fake;
    });
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();
  });

  afterEach(() => {
    // Unmount any rendered SyncStatusBar BEFORE resetting the stores it
    // subscribes to — a bare setState against a mounted tree logs act() noise.
    cleanup();
    stopSyncEngine();
    restore();
    useListsStore.setState({ lists: [], hydrated: true });
    useSyncStatusStore.setState({ bySecret: {} });
    onStatus = undefined;
    onPublishResult = undefined;
  });

  test('engine wiring: a rejected publish sets publishRejected while connected stays true', () => {
    onStatus!(2); // two relays open — the socket IS up
    expect(useSyncStatusStore.getState().bySecret[SECRET]?.connected).toBe(true);

    onPublishResult!(false, 'invalid: event too large');

    const st = useSyncStatusStore.getState().bySecret[SECRET];
    // The exact shipped-defect shape: socket up, but our state is NOT leaving
    // the device. "Connected" here would be dishonest.
    expect(st.connected).toBe(true);
    expect(st.publishRejected).toBe(true);

    // The next accepted publish clears it.
    onPublishResult!(true, '');
    expect(useSyncStatusStore.getState().bySecret[SECRET].publishRejected).toBe(false);
  });

  test('UI: SyncStatusBar shows "Not syncing" during rejection, recovers to "Connected"', async () => {
    onStatus!(2); // relays open before the bar mounts

    await render(<SyncStatusBar secret={SECRET} />);

    // Healthy connection: honest "Connected".
    expect(screen.getByText('Connected')).toBeTruthy();

    // Every relay rejects our publishes → the label must stop claiming
    // "Connected" (the reported defect) and read "Not syncing".
    await act(async () => onPublishResult!(false, 'rate-limited: slow down'));
    expect(screen.getByText('Not syncing')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();

    // An accepted publish restores the honest "Connected".
    await act(async () => onPublishResult!(true, ''));
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.queryByText('Not syncing')).toBeNull();
  });
});
