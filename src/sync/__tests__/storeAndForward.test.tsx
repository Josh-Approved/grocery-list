/**
 * Regression — defect grocery-list-20261018-1: a shared list only synced while
 * BOTH phones had the app open at the same moment.
 *
 * As shipped, list state left the device only as an ephemeral relay event
 * (kind 20001 — relays forward it to whoever is listening right now and keep
 * nothing), and the cold-start "hello" handshake only works if a live partner
 * answers it. So an edit made while the other phone was closed was never
 * delivered: it sat on the editing phone until both apps happened to be open
 * together. Store-and-forward fixes it: the engine now DEPOSITS its latest
 * full state in the drop box as a replaceable event (kind 30078, one slot per
 * channel + author), relays keep the latest copy, and a device that connects
 * later REQUESTS those slots on open — no partner needed.
 *
 * Three layers, each proven failing-first on the pre-fix code:
 *   • Engine (fake transport + fake drop box): device A edits with B offline,
 *     A closes, B opens ALONE → B has A's edit. Kits ride the same path. A
 *     hello is never deposited (it would overwrite the state slot).
 *   • Transport (REAL DropBoxTransport over fake WebSockets): the stored
 *     filter is requested on open, deposits are kind-30078 replaceable events
 *     under a stable per-device author, a replayed slot from the partner is
 *     delivered with its publish time, our own slot is skipped.
 *   • Status bar: "Connected" means the drop boxes are reachable, NOT that the
 *     partner is there — the bar now says when the other phone was last heard
 *     from, so the two can never be confused again.
 */

jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
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
// @noble/* is pure ESM (jest doesn't transform it). The transport's wire
// protocol IS the SUT here, so stub only the crypto primitives: real sha256
// via node, a pubkey that is a pure function of the private key (so two
// transports built from the same seed share an author and two different seeds
// do not), and an inert signature (fake relays don't verify).
jest.mock('@noble/curves/secp256k1.js', () => ({
  schnorr: {
    getPublicKey: (priv: Uint8Array) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createHash } = require('crypto');
      return new Uint8Array(createHash('sha256').update(Buffer.from(priv)).digest());
    },
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

import { useListsStore } from '../../store/lists';
import { useKitsStore } from '../../store/kits';
import { channelId, newSecret, seal, open } from '../crypto';
import { DropBoxTransport, STORED_KIND, LIVE_KIND, STORED_WINDOW_S } from '../transport';
import { useSyncStatusStore, markConnected, markReceived } from '../status';
import {
  startSyncEngine,
  stopSyncEngine,
  __setTransportFactory,
  type EngineTransport,
} from '../index';
import { SyncStatusBar } from '../../components/SyncStatusBar';
import type { GroceryList } from '../../data/list';
import type { Kit } from '../../data/kit';

const SECRET = newSecret();
const CHANNEL = channelId(SECRET);

function list(id: string, items: GroceryList['items'] = []): GroceryList {
  const at = 1000;
  return {
    id,
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
function kit(id: string): Kit {
  return { id, name: id, nameUpdatedAt: 1000, items: [], createdAt: 1000, updatedAt: 1000 };
}

// ---------------------------------------------------------------------------
// Layer 1 — the engine deposits state and merges what the drop box replays
// ---------------------------------------------------------------------------

/** What a relay swarm holds for a channel: the latest deposit per slot per
 *  author. Ephemeral publishes are forwarded to whoever is listening and kept
 *  nowhere — exactly the public-relay contract. */
class FakeDropBox {
  stored = new Map<string, { ct: string; at: number; author: string }>();
}

/** The engine-facing transport, as a device would see it. `author` stands in
 *  for the per-device signing key; `start()` replays the other authors' slots
 *  the way the real transport does after its stored REQ. */
class FakeTransport implements EngineTransport {
  live: string[] = [];
  constructor(
    private box: FakeDropBox,
    public author: string,
    public channel: string,
    public onMessage: (ct: string, at?: number) => void,
    public onReconnect: () => void,
    public onStatus: (openRelays: number) => void
  ) {}
  start() {
    this.onStatus(1);
    for (const [key, rec] of this.box.stored) {
      if (key.startsWith(this.channel + ':') && rec.author !== this.author) {
        this.onMessage(rec.ct, rec.at);
      }
    }
    this.onReconnect();
  }
  publish(ct: string) {
    this.live.push(ct);
  }
  publishStored(ct: string, slot: string) {
    this.box.stored.set(`${this.channel}:${slot}`, { ct, at: Date.now(), author: this.author });
  }
  close() {}
}

describe('engine store-and-forward (defect grocery-list-20261018-1)', () => {
  let box: FakeDropBox;
  let device: string;
  let restore: () => void;
  let transports: FakeTransport[];

  beforeEach(() => {
    jest.useFakeTimers();
    box = new FakeDropBox();
    transports = [];
    restore = __setTransportFactory((channel, onMessage, onReconnect, onStatus) => {
      const t = new FakeTransport(box, device, channel, onMessage, onReconnect, onStatus);
      transports.push(t);
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

  /** One phone's session: boot the engine over this phone's local copy. */
  function openAs(name: string, lists: GroceryList[], kits: Kit[] = []) {
    device = name;
    useListsStore.setState({ lists, hydrated: true });
    useKitsStore.setState({ kits, hydrated: true });
    startSyncEngine();
  }
  function closeApp() {
    stopSyncEngine();
    jest.advanceTimersByTime(5000);
  }

  test('A edits while B is closed, A closes, B opens ALONE → B has the edit', () => {
    // Phone A, alone: adds milk. Its debounced publish fires; nobody is listening.
    openAs('A', [list('a-local', [item('milk', 2000)])]);
    jest.advanceTimersByTime(700);
    closeApp();

    // Hours later, phone B opens — A is closed, no live partner, no hello answer.
    openAs('B', [list('b-local', [])]);

    const b = useListsStore.getState().lists[0];
    expect(b.items.map((i) => i.id)).toEqual(['milk']);
  });

  test('a kit created while the partner is closed arrives the same way', () => {
    openAs('A', [list('a-local', [item('eggs')])], [kit('taco-night')]);
    jest.advanceTimersByTime(700);
    closeApp();

    openAs('B', [list('b-local', [item('eggs')])]);

    expect(useKitsStore.getState().kits.map((k) => k.id)).toContain('taco-night');
  });

  test('the hello handshake is never deposited — it must not overwrite a state slot', () => {
    openAs('A', [list('a-local', [item('milk')])]);
    jest.advanceTimersByTime(700);
    // onReconnect (fired by start) sent a hello; it must have gone out LIVE only.
    const decodedLive = transports[0].live.map((ct) => JSON.parse(open(SECRET, ct) as string));
    expect(decodedLive.some((m) => m._sync === 'hello')).toBe(true);
    for (const rec of box.stored.values()) {
      const m = JSON.parse(open(SECRET, rec.ct) as string);
      expect(m._sync === 'hello').toBe(false);
    }
  });

  test('"last heard from the other phone" is the time it deposited, not the time we read it', () => {
    jest.setSystemTime(new Date('2026-10-18T08:00:00Z'));
    openAs('A', [list('a-local', [item('milk')])]);
    jest.advanceTimersByTime(700);
    closeApp();

    jest.setSystemTime(new Date('2026-10-18T20:00:00Z'));
    openAs('B', [list('b-local', [])]);

    // A deposited at 08:00 (its connect-time force-publish); B read it at 20:00.
    const at = useSyncStatusStore.getState().bySecret[SECRET]?.lastReceivedAt;
    expect(at).toBe(new Date('2026-10-18T08:00:00Z').getTime());
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the REAL transport speaks the replaceable-event protocol
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
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
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  events(): any[] {
    return this.frames().filter((m) => m[0] === 'EVENT').map((m) => m[1]);
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

describe('DropBoxTransport replaceable deposits (kind 30078)', () => {
  const seedA = new Uint8Array(32).fill(1);
  const seedB = new Uint8Array(32).fill(2);

  function openTransport(onMessage = jest.fn(), seed: Uint8Array = seedA) {
    const tr = new DropBoxTransport('chan/sf+1=', onMessage, jest.fn(), jest.fn(), jest.fn(), seed);
    tr.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    return { tr, ws };
  }

  test('on open it REQs the live window AND the stored slots (wide since)', () => {
    const { tr, ws } = openTransport();
    const req = ws.frames().find((m) => m[0] === 'REQ');
    const filters = req.slice(2);
    const live = filters.find((f: any) => f.kinds?.includes(LIVE_KIND));
    const stored = filters.find((f: any) => f.kinds?.includes(STORED_KIND));
    expect(live?.['#t']).toEqual(['chan/sf+1=']);
    expect(stored?.['#t']).toEqual(['chan/sf+1=']);
    const now = Math.floor(Date.now() / 1000);
    expect(now - stored.since).toBeGreaterThanOrEqual(STORED_WINDOW_S - 5);
    expect(now - stored.since).toBeLessThanOrEqual(STORED_WINDOW_S + 5);
    tr.close();
  });

  test('publishStored emits a replaceable event addressed by channel + slot', () => {
    const { tr, ws } = openTransport();
    tr.publishStored('ct-1', 'list');
    const ev = ws.events()[0];
    expect(ev.kind).toBe(STORED_KIND);
    expect(ev.tags).toEqual(expect.arrayContaining([['d', 'chan/sf+1=:list'], ['t', 'chan/sf+1=']]));
    expect(ev.content).toBe('ct-1');
    tr.close();
  });

  test('two deposits in the same second never share a created_at (relays keep the newest)', () => {
    const { tr, ws } = openTransport();
    tr.publishStored('ct-1', 'list');
    tr.publishStored('ct-2', 'list');
    const [a, b] = ws.events();
    expect(b.created_at).toBeGreaterThan(a.created_at);
    tr.close();
  });

  test('the author is stable per seed: same seed → same pubkey, different seed → different', () => {
    const { tr: a1, ws: w1 } = openTransport();
    a1.publishStored('x', 'list');
    a1.close();
    FakeWebSocket.instances = [];
    const { tr: a2, ws: w2 } = openTransport(jest.fn(), seedA);
    a2.publishStored('y', 'list');
    a2.close();
    FakeWebSocket.instances = [];
    const { tr: b, ws: w3 } = openTransport(jest.fn(), seedB);
    b.publishStored('z', 'list');
    b.close();
    expect(w1.events()[0].pubkey).toBe(w2.events()[0].pubkey);
    expect(w1.events()[0].pubkey).not.toBe(w3.events()[0].pubkey);
  });

  test("a replayed slot from the partner is delivered with ITS publish time; our own slot is not", () => {
    const onMessage = jest.fn();
    const { tr, ws } = openTransport(onMessage);
    tr.publishStored('mine', 'list');
    const mine = ws.events()[0];

    // The relay replays our own slot (a cold start forgets its event ids).
    ws.receive(['EVENT', 'sub', { ...mine, id: 'replayed-own-id' }]);
    expect(onMessage).not.toHaveBeenCalled();

    // …and the partner's slot, deposited 3 hours ago.
    const at = Math.floor(Date.now() / 1000) - 3 * 3600;
    ws.receive([
      'EVENT',
      'sub',
      {
        id: 'partner-id',
        pubkey: 'f'.repeat(64),
        created_at: at,
        kind: STORED_KIND,
        tags: [['d', 'chan/sf+1=:list'], ['t', 'chan/sf+1=']],
        content: 'theirs',
        sig: '',
      },
    ]);
    expect(onMessage).toHaveBeenCalledWith('theirs', at * 1000);
    tr.close();
  });

  test('a live ephemeral event still arrives (the both-online path is untouched)', () => {
    const onMessage = jest.fn();
    const { tr, ws } = openTransport(onMessage);
    ws.receive([
      'EVENT',
      'sub',
      {
        id: 'live-id',
        pubkey: 'e'.repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind: LIVE_KIND,
        tags: [['t', 'chan/sf+1=']],
        content: 'hello-ct',
        sig: '',
      },
    ]);
    expect(onMessage).toHaveBeenCalledWith('hello-ct', expect.any(Number));
    tr.close();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the status bar tells drop-box reachability and partner apart
// ---------------------------------------------------------------------------

describe('SyncStatusBar: connected ≠ partner present', () => {
  const S = 'bar-secret';
  beforeEach(() => {
    useSyncStatusStore.setState({ bySecret: {} });
  });
  afterEach(() => cleanup());

  test('connected with nothing from the partner says so, and never claims the partner is there', async () => {
    await render(<SyncStatusBar secret={S} />);
    await act(async () => markConnected(S, true));
    expect(screen.getByText(/^Connected/)).toBeTruthy();
    expect(screen.getByText(/Nothing from the other phone yet/)).toBeTruthy();
  });

  test('once the partner has been heard from, the bar says when', async () => {
    await render(<SyncStatusBar secret={S} />);
    await act(async () => {
      markConnected(S, true);
      markReceived(S, Date.now() - 3 * 3600 * 1000);
    });
    expect(screen.getByText(/^Connected · Other phone seen 3 h ago/)).toBeTruthy();
  });

  test('an older replayed slot never rolls "last heard" backwards', () => {
    markReceived(S, 5000);
    markReceived(S, 2000);
    expect(useSyncStatusStore.getState().bySecret[S].lastReceivedAt).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — the deposit fits the relays that carry it
// ---------------------------------------------------------------------------

describe('deposit size stays under the relay ceilings (probed 2026-10-18)', () => {
  /** A list of `live` long-named items plus `dead` fresh tombstones (names
   *  still attached — they are stripped only after a week), sealed. */
  function sealedSize(live: number, dead: number): number {
    const now = 1_760_000_000_000;
    const items: GroceryList['items'] = [];
    for (let i = 0; i < live; i++) {
      items.push({
        ...item(`item-${now.toString(36)}-${i}-abcdef`, now - i),
        name: `A fairly long grocery item name number ${i}`,
        quantity: 2,
        checked: i % 3 === 0,
        checkedUpdatedAt: now - i,
        note: i % 5 === 0 ? 'organic if they have it, otherwise the usual one' : undefined,
      } as GroceryList['items'][number]);
    }
    for (let i = 0; i < dead; i++) {
      items.push({
        ...item(`dead-${now.toString(36)}-${i}-abcdef`, now - i),
        name: `A deleted item that still carries its tombstone ${i}`,
        deletedAt: now - i,
      } as GroceryList['items'][number]);
    }
    return seal(SECRET, JSON.stringify(list('l-big', items))).length;
  }

  test('a 100-item list at the 150-tombstone cap clears the 80 KB ceiling of the roomier relays', () => {
    // damus / primal / snort / oxtr accepted 80 KB; one accepting relay is
    // enough for delivery, and an all-reject is surfaced as "Not syncing".
    expect(sealedSize(100, 150)).toBeLessThan(80_000);
  });

  test('a 60-item list at the 150-tombstone cap clears the strictest 64 KB ceiling (nos.lol, nostr.mom)', () => {
    expect(sealedSize(60, 150)).toBeLessThan(64_000);
  });

  test('(measurement) bytes per record, for the budget note', () => {
    const per = (sealedSize(200, 0) - sealedSize(100, 0)) / 100;
    expect(per).toBeGreaterThan(100);
    expect(per).toBeLessThan(400);
  });
});
