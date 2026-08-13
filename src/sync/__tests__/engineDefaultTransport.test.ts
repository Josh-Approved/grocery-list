/**
 * The engine's PRODUCTION transport wiring (sync/index.ts, the default
 * `makeTransport` factory).
 *
 * Every other engine test injects a fake through the `__setTransportFactory`
 * test seam, so the one line that actually runs on a user's phone — the default
 * factory that constructs a `DropBoxTransport` and hands it the engine's five
 * callbacks — was never executed by the suite. A factory that built nothing,
 * or wired the callbacks to the wrong parameters, would have shipped green:
 * shared lists would simply never connect, and no test would notice.
 *
 * This file deliberately does NOT install a factory. It stubs the transport
 * MODULE instead (the real one opens WebSockets and pulls in pure-ESM
 * @noble/*), so the engine takes its real production path into `new
 * DropBoxTransport(...)`, and then drives each captured callback to prove it
 * lands on the behaviour the engine documents.
 */

/** What the engine's production factory hands the transport constructor. */
interface StubTransport {
  channel: string;
  onMessage: (ct: string) => void;
  onReconnect: () => void;
  onStatus: (openRelays: number) => void;
  onPublishResult?: (delivered: boolean, reason: string) => void;
  started: boolean;
  closed: boolean;
  published: string[];
}

// The stub records every construction so the test can inspect the arguments
// the REAL default factory passed. Declared inside the factory (jest hoists
// this call above the imports, so it may not close over outer bindings).
jest.mock('../transport', () => {
  const built: unknown[] = [];
  // NOTE: nothing in here may name a variable inside a TYPE ANNOTATION, and it
  // may not use TS parameter properties. Jest hoists this factory above the
  // imports and babel's out-of-scope check runs BEFORE types are stripped, so
  // `constructor(public channel: string, onMessage: (ct: string) => void)`
  // reads as references to out-of-scope `channel` / `ct`. The shape is pinned
  // by the StubTransport interface above, where the test actually reads it.
  function DropBoxTransport(...args: unknown[]) {
    const t = {
      channel: args[0],
      onMessage: args[1],
      onReconnect: args[2],
      onStatus: args[3],
      onPublishResult: args[4],
      started: false,
      closed: false,
      published: [] as unknown[],
      start() {
        t.started = true;
      },
      publish(ct: unknown) {
        t.published.push(ct);
      },
      close() {
        t.closed = true;
      },
    };
    built.push(t);
    return t;
  }
  return { DropBoxTransport, RELAYS: [], __built: built };
});

/** Every transport the engine constructed, in order, with its callbacks. */
const built = (jest.requireMock('../transport') as { __built: StubTransport[] }).__built;

// Same SQLite stub as engine.test.ts — the stores must load under node.
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

import { useListsStore } from '../../store/lists';
import { useKitsStore } from '../../store/kits';
import { channelId, newSecret, seal, open } from '../crypto';
import { useSyncStatusStore } from '../status';
import { startSyncEngine, stopSyncEngine } from '../index';
import type { GroceryList } from '../../data/list';

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

beforeEach(() => {
  built.length = 0;
  useListsStore.setState({ lists: [], hydrated: true });
  useKitsStore.setState({ kits: [], hydrated: true });
  useSyncStatusStore.setState({ bySecret: {} });
});

afterEach(() => {
  stopSyncEngine();
  jest.useRealTimers();
});

describe('the default (production) transport factory', () => {
  test('a shared list builds a real transport on the channel derived from its secret, and starts it', () => {
    useListsStore.setState({ lists: [sharedList()], hydrated: true });

    startSyncEngine();

    expect(built).toHaveLength(1);
    // The channel is derived from the secret — never the secret itself, and
    // never the list id (devices hold different local ids for one shared list).
    expect(built[0].channel).toBe(channelId(SECRET));
    expect(built[0].channel).not.toContain(SECRET);
    expect(built[0].started).toBe(true);
  });

  test('the callbacks it is handed are the engine ones, in the order the transport calls them', () => {
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();
    const t = built[0];

    // 2nd arg — inbound message → the engine decrypts and merges a peer copy.
    const peer = { ...sharedList(), id: 'peer-list-id', name: 'Renamed', nameUpdatedAt: 9000 };
    t.onMessage(seal(SECRET, JSON.stringify(peer)));
    expect(useListsStore.getState().lists[0].name).toBe('Renamed');
    expect(useSyncStatusStore.getState().bySecret[SECRET].lastReceivedAt).toBeGreaterThan(0);

    // 3rd arg — reconnect → push our state and ask peers for theirs (hello).
    t.published = [];
    t.onReconnect();
    const kinds = t.published.map((ct) => JSON.parse(open(SECRET, ct) as string));
    expect(kinds.some((m) => m?._sync === 'hello')).toBe(true);
    expect(kinds.some((m) => m?.shareIdentity && !m?._sync)).toBe(true);

    // 4th arg — relay count → the honest connected/offline indicator.
    t.onStatus(1);
    expect(useSyncStatusStore.getState().bySecret[SECRET].connected).toBe(true);
    t.onStatus(0);
    expect(useSyncStatusStore.getState().bySecret[SECRET].connected).toBe(false);

    // 5th arg — publish result → "sent" is not "delivered".
    t.onPublishResult?.(false, 'rejected');
    expect(useSyncStatusStore.getState().bySecret[SECRET].publishRejected).toBe(true);
    t.onPublishResult?.(true, '');
    expect(useSyncStatusStore.getState().bySecret[SECRET].publishRejected).toBe(false);
  });

  test('stopping the engine closes the real transport it built', () => {
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();

    stopSyncEngine();

    expect(built[0].closed).toBe(true);
  });
});
