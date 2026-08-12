/**
 * Sync engine wiring (sync/index.ts) — the layer where the two shipped
 * shared-list defects actually lived (cold-start hello backfill, bidirectional
 * reconnect push, debounced force-publish, kits-ride-channels control message,
 * receive() dispatch). The merge primitives are exemplary-tested elsewhere
 * (syncSim/mergeRecordSet); this pins the ENGINE, which was untested because
 * DropBoxTransport is created inside the module and can't be reached.
 *
 * The __setTransportFactory seam swaps in a recording fake so we can drive the
 * onMessage / onReconnect callbacks and inspect (decrypt) what the engine
 * publishes. Everything flows through the REAL crypto (seal/open) and the REAL
 * stores, so this exercises the production dispatch, not a re-implementation.
 */

// Stub the SQLite-backed persistence so the stores load in node (expo-sqlite
// can't). Persist is fire-and-forget; the in-memory state is the SUT. Mirrors
// src/store/__tests__/kits.test.ts.
// The real DropBoxTransport pulls in @noble/* (pure ESM jest doesn't transform)
// and opens WebSockets. The engine never constructs it here — __setTransportFactory
// injects a fake — so stub the module out to keep the import graph node-loadable.
jest.mock('../transport', () => ({
  DropBoxTransport: class {
    start() {}
    publish() {}
    close() {}
  },
  RELAYS: [],
}));

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
import { newSecret, seal, open } from '../crypto';
import { useSyncStatusStore } from '../status';
import {
  startSyncEngine,
  stopSyncEngine,
  flushSyncEngine,
  resyncNow,
  __setTransportFactory,
  type EngineTransport,
} from '../index';
import type { GroceryList } from '../../data/list';
import type { Kit } from '../../data/kit';

const SECRET = newSecret();

/** Recording fake — captures published ciphertext and exposes the engine's
 *  callbacks so a test can simulate an inbound message / reconnect. */
class FakeTransport implements EngineTransport {
  published: string[] = [];
  started = false;
  closed = false;
  constructor(
    public channel: string,
    public onMessage: (ct: string) => void,
    public onReconnect: () => void,
    public onStatus: (openRelays: number) => void
  ) {}
  start() {
    this.started = true;
  }
  publish(ct: string) {
    this.published.push(ct);
  }
  close() {
    this.closed = true;
  }
  /** Decrypt each published message to a parsed object for assertions. */
  decoded(): any[] {
    return this.published.map((ct) => JSON.parse(open(SECRET, ct) as string));
  }
  deliver(plaintext: string) {
    this.onMessage(seal(SECRET, plaintext));
  }
}

let created: FakeTransport[];
let restore: () => void;

function sharedList(items: GroceryList['items'] = []): GroceryList {
  const at = 1000;
  return {
    id: 'l1',
    name: 'Groceries',
    nameUpdatedAt: at,
    items,
    categoryOrder: ['Other'],
    createdAt: at,
    updatedAt: at,
    shareIdentity: { secret: SECRET, createdAt: at },
  };
}

function item(id: string, updatedAt = 1000) {
  return {
    id,
    name: id,
    quantity: 1,
    category: 'Other' as const,
    checked: false,
    addedAt: updatedAt,
    updatedAt,
  };
}

/** The same list with no share identity — an ordinary, private, unshared list. */
function soloList(items: GroceryList['items'] = []): GroceryList {
  const l = sharedList(items);
  delete l.shareIdentity;
  return l;
}

function sampleKit(): Kit {
  return {
    id: 'k1',
    name: 'Taco night',
    nameUpdatedAt: 1000,
    items: [],
    createdAt: 1000,
    updatedAt: 1000,
  };
}

beforeEach(() => {
  created = [];
  restore = __setTransportFactory((channel, onMessage, onReconnect, onStatus) => {
    const t = new FakeTransport(channel, onMessage, onReconnect, onStatus);
    created.push(t);
    return t;
  });
  useListsStore.setState({ lists: [], hydrated: true });
  useKitsStore.setState({ kits: [], hydrated: true });
  useSyncStatusStore.setState({ bySecret: {} });
});

afterEach(() => {
  stopSyncEngine();
  restore();
  jest.useRealTimers();
});

/** Just the peer-visible messages of one kind, decrypted. */
function messagesOfKind(t: FakeTransport, kind: 'state' | 'hello' | 'kits'): any[] {
  return t
    .decoded()
    .filter((m) => (kind === 'state' ? m?.shareIdentity && !m?._sync : m?._sync === kind));
}

describe('channel lifecycle', () => {
  test('a shared list opens exactly one started channel; a solo list opens none', () => {
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();
    expect(created).toHaveLength(1);
    expect(created[0].started).toBe(true);
  });
});

describe('hello handshake (cold-start backfill)', () => {
  test('an inbound hello force-publishes our current list AND kits', () => {
    useListsStore.setState({ lists: [sharedList([item('milk')])], hydrated: true });
    useKitsStore.setState({ kits: [sampleKit()], hydrated: true });
    startSyncEngine();
    created[0].published = []; // ignore the debounced reconcile publish

    created[0].deliver(JSON.stringify({ _sync: 'hello' }));

    const msgs = created[0].decoded();
    // One bare-list state message + one kits control message, both immediate.
    const state = msgs.find((m) => m.shareIdentity && !m._sync);
    const kits = msgs.find((m) => m._sync === 'kits');
    expect(state?.items?.some((it: any) => it.id === 'milk')).toBe(true);
    expect(kits?.kits?.[0]?.id).toBe('k1');
  });
});

describe('reconnect (bidirectional)', () => {
  test('onReconnect pushes our state + kits AND sends a hello to pull theirs', () => {
    useListsStore.setState({ lists: [sharedList([item('eggs')])], hydrated: true });
    useKitsStore.setState({ kits: [sampleKit()], hydrated: true });
    startSyncEngine();
    created[0].published = [];

    created[0].onReconnect();

    const msgs = created[0].decoded();
    expect(msgs.some((m) => m.shareIdentity && !m._sync)).toBe(true); // pushed state
    expect(msgs.some((m) => m._sync === 'kits')).toBe(true); // pushed kits
    expect(msgs.some((m) => m._sync === 'hello')).toBe(true); // pulled via hello
  });
});

describe('debounced publish', () => {
  test('several rapid local edits coalesce into a single channel publish', () => {
    jest.useFakeTimers();
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();

    // Three quick edits within the debounce window.
    for (let n = 2; n <= 4; n++) {
      useListsStore.setState({
        lists: [sharedList([item('a'), item(`x${n}`, 1000 + n)])],
        hydrated: true,
      });
    }
    expect(created[0].published).toHaveLength(0); // nothing sent yet (still debouncing)

    jest.advanceTimersByTime(700);
    expect(created[0].published).toHaveLength(1); // coalesced to one send
  });
});

describe('receive() dispatch', () => {
  test('a peer state message with our secret is merged into the store', () => {
    useListsStore.setState({ lists: [sharedList([item('bread')])], hydrated: true });
    startSyncEngine();

    const remote = sharedList([item('bread'), item('butter', 5000)]);
    remote.id = 'peer-list-id'; // devices have different local ids; secret is the key
    created[0].deliver(JSON.stringify(remote));

    const merged = useListsStore.getState().lists[0];
    expect(merged.items.map((i) => i.id).sort()).toEqual(['bread', 'butter']);
  });

  test('a kits control message merges into the kits store', () => {
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();

    created[0].deliver(JSON.stringify({ _sync: 'kits', kits: [sampleKit()] }));

    expect(useKitsStore.getState().kits.map((k) => k.id)).toContain('k1');
  });

  test('an unknown _sync tag is ignored (forward wire-compat), no merge, no throw', () => {
    useListsStore.setState({ lists: [sharedList([item('rice')])], hydrated: true });
    startSyncEngine();
    const before = JSON.stringify(useListsStore.getState().lists);

    expect(() => created[0].deliver(JSON.stringify({ _sync: 'from-a-future-version', blob: 1 }))).not.toThrow();

    expect(JSON.stringify(useListsStore.getState().lists)).toBe(before);
  });

  test('a state message whose secret is not ours is ignored', () => {
    useListsStore.setState({ lists: [sharedList([item('rice')])], hydrated: true });
    startSyncEngine();
    const before = JSON.stringify(useListsStore.getState().lists);

    const foreign = sharedList([item('poison', 9000)]);
    foreign.shareIdentity = { secret: 'someone-elses-secret', createdAt: 1 };
    created[0].deliver(JSON.stringify(foreign));

    expect(JSON.stringify(useListsStore.getState().lists)).toBe(before);
  });

  test('garbage from a public relay is ignored, never thrown into the app', () => {
    useListsStore.setState({ lists: [sharedList([item('rice')])], hydrated: true });
    startSyncEngine();
    const before = JSON.stringify(useListsStore.getState().lists);

    // Anyone can push anything onto a public channel: text that decrypts but
    // isn't JSON, and bytes that don't decrypt at all.
    expect(() => created[0].deliver('<<not json at all>>')).not.toThrow();
    expect(() => created[0].onMessage('!!! not even base64 !!!')).not.toThrow();

    expect(JSON.stringify(useListsStore.getState().lists)).toBe(before);
  });
});

describe('unshared lists', () => {
  test('a solo list opens no channel (and does not crash the reconcile)', () => {
    useListsStore.setState({ lists: [soloList([item('milk')])], hydrated: true });
    startSyncEngine();
    expect(created).toHaveLength(0);
  });

  test('a solo list sitting beside a shared one leaves exactly one channel', () => {
    useListsStore.setState({
      lists: [soloList([item('milk')]), sharedList([item('eggs')])],
      hydrated: true,
    });
    startSyncEngine();
    expect(created).toHaveLength(1);
  });

  test('unsharing a list closes its channel and forgets its status', () => {
    useListsStore.setState({ lists: [sharedList([item('milk')])], hydrated: true });
    startSyncEngine();
    created[0].onStatus(2);
    expect(useSyncStatusStore.getState().bySecret[SECRET].connected).toBe(true);

    // The user turns sharing off. The relay socket must not outlive it, and no
    // stale "Connected" may stay attached to a secret nothing listens on.
    useListsStore.setState({ lists: [soloList([item('milk')])], hydrated: true });

    expect(created[0].closed).toBe(true);
    expect(useSyncStatusStore.getState().bySecret[SECRET]).toBeUndefined();
  });
});

describe('engine lifecycle', () => {
  test('starting twice opens only one channel', () => {
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    startSyncEngine();
    expect(created).toHaveLength(1);
  });

  test('starting twice leaves no orphan subscription behind after stop', () => {
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    startSyncEngine();

    stopSyncEngine();
    created = [];

    // After stop, an edit must reach no transport at all. A second, unreleased
    // store subscription would quietly re-open a relay socket right here.
    useListsStore.setState({
      lists: [sharedList([item('a'), item('b', 2000)])],
      hydrated: true,
    });
    expect(created).toHaveLength(0);
  });

  test('stopping closes the open channel and stops publishing', () => {
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    const transport = created[0];

    stopSyncEngine();

    expect(transport.closed).toBe(true);
    created = [];
    useListsStore.setState({
      lists: [sharedList([item('a'), item('b', 2000)])],
      hydrated: true,
    });
    expect(created).toHaveLength(0);
    expect(transport.published).toHaveLength(0);
  });
});

describe('publish dedupe', () => {
  test('a store touch that changes nothing sends no second copy', () => {
    jest.useFakeTimers();
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    jest.advanceTimersByTime(700);
    expect(messagesOfKind(created[0], 'state')).toHaveLength(1);

    // Re-setting an identical list (a rehydrate, an unrelated re-render) must
    // not put another copy of the whole list on a public relay.
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    jest.advanceTimersByTime(700);
    expect(messagesOfKind(created[0], 'state')).toHaveLength(1);
  });
});

describe('flushSyncEngine (the app is backgrounding)', () => {
  test('an edit still inside the debounce window leaves the device immediately', () => {
    jest.useFakeTimers();
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    jest.advanceTimersByTime(700);
    created[0].published = [];

    // Check something off, then switch apps at once: the 700ms debounce is
    // about to be suspended mid-wait, which is how a check used to be stranded.
    useListsStore.setState({
      lists: [sharedList([item('a'), item('milk', 3000)])],
      hydrated: true,
    });
    expect(created[0].published).toHaveLength(0);

    flushSyncEngine();

    const state = messagesOfKind(created[0], 'state');
    expect(state).toHaveLength(1);
    expect(state[0].items.some((it: any) => it.id === 'milk')).toBe(true);

    // The suspended debounce must not then fire a second, older copy.
    const sent = created[0].published.length;
    jest.advanceTimersByTime(700);
    expect(created[0].published).toHaveLength(sent);
  });

  test('a kit edit still inside its debounce window is pushed too', () => {
    jest.useFakeTimers();
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();
    jest.advanceTimersByTime(700);
    created[0].published = [];

    useKitsStore.setState({ kits: [sampleKit()], hydrated: true });
    expect(messagesOfKind(created[0], 'kits')).toHaveLength(0);

    flushSyncEngine();

    expect(messagesOfKind(created[0], 'kits')).toHaveLength(1);
    const sent = created[0].published.length;
    jest.advanceTimersByTime(700);
    expect(created[0].published).toHaveLength(sent);
  });
});

describe('resyncNow (the tap-to-resync affordance)', () => {
  test('pushes our list and kits and asks peers for theirs', () => {
    useListsStore.setState({ lists: [sharedList([item('eggs')])], hydrated: true });
    useKitsStore.setState({ kits: [sampleKit()], hydrated: true });
    startSyncEngine();
    created[0].published = [];

    resyncNow(SECRET);

    expect(messagesOfKind(created[0], 'state')).toHaveLength(1);
    expect(messagesOfKind(created[0], 'kits')).toHaveLength(1);
    expect(messagesOfKind(created[0], 'hello')).toHaveLength(1);
  });

  test('answering a peer hello cancels the pending copy, so nothing stale lands', () => {
    jest.useFakeTimers();
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    jest.advanceTimersByTime(700);
    created[0].published = [];

    useListsStore.setState({
      lists: [sharedList([item('a'), item('bread', 3000)])],
      hydrated: true,
    });
    created[0].deliver(JSON.stringify({ _sync: 'hello' }));

    const sent = created[0].published.length;
    jest.advanceTimersByTime(700);
    expect(created[0].published).toHaveLength(sent);
  });

  test('two reconnects in quick succession announce us only once', () => {
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    created[0].published = [];

    // Relays often report several sockets opening at nearly the same moment.
    created[0].onReconnect();
    created[0].onReconnect();

    expect(messagesOfKind(created[0], 'hello')).toHaveLength(1);
  });
});

describe('kits broadcast', () => {
  test('a real kit edit broadcasts once; an identical re-set broadcasts nothing', () => {
    jest.useFakeTimers();
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();
    jest.advanceTimersByTime(700);
    created[0].published = [];

    const kits = [sampleKit(), { ...sampleKit(), id: 'k2' }];
    useKitsStore.setState({ kits, hydrated: true });
    jest.advanceTimersByTime(700);
    expect(messagesOfKind(created[0], 'kits')).toHaveLength(1);

    useKitsStore.setState({ kits: [...kits], hydrated: true });
    jest.advanceTimersByTime(700);
    expect(messagesOfKind(created[0], 'kits')).toHaveLength(1);
  });
});

describe('connection status the bar reads', () => {
  test('no open relay reads as not connected; at least one reads as connected', () => {
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();

    created[0].onStatus(1);
    expect(useSyncStatusStore.getState().bySecret[SECRET].connected).toBe(true);

    created[0].onStatus(0);
    expect(useSyncStatusStore.getState().bySecret[SECRET].connected).toBe(false);
  });

  test('a peer copy timestamps the list as heard-from', () => {
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    expect(useSyncStatusStore.getState().bySecret[SECRET]?.lastReceivedAt ?? null).toBeNull();

    const remote = sharedList([item('a'), item('b', 5000)]);
    remote.id = 'peer-list-id';
    created[0].deliver(JSON.stringify(remote));

    expect(useSyncStatusStore.getState().bySecret[SECRET].lastReceivedAt).toBeGreaterThan(0);
  });

  test('peer kits count as hearing from them too', () => {
    useListsStore.setState({ lists: [sharedList()], hydrated: true });
    startSyncEngine();

    created[0].deliver(JSON.stringify({ _sync: 'kits', kits: [sampleKit()] }));

    expect(useSyncStatusStore.getState().bySecret[SECRET].lastReceivedAt).toBeGreaterThan(0);
  });

  test('our own publish timestamps the list as sent', () => {
    jest.useFakeTimers();
    useListsStore.setState({ lists: [sharedList([item('a')])], hydrated: true });
    startSyncEngine();
    expect(useSyncStatusStore.getState().bySecret[SECRET]?.lastSentAt ?? null).toBeNull();

    jest.advanceTimersByTime(700);

    expect(useSyncStatusStore.getState().bySecret[SECRET].lastSentAt).toBeGreaterThan(0);
  });
});
