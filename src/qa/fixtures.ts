// QA fixtures — deterministic data the app boots with under QA_MODE (the capture
// pipeline builds with EXPO_PUBLIC_QA_MODE=1). Built with the app's OWN
// constructors so it's valid by construction; ids/timestamps don't appear in
// screenshots, so their randomness is harmless. Names span aisles to fill the
// categorized list nicely.
import { makeList, makeItem, type GroceryList } from '../data/list';
import { makeKit, makeKitItem, type Kit } from '../data/kit';

// Two-device sync demo: when a fixed shared secret is injected at build time
// (EXPO_PUBLIC_QA_SHARE_SECRET, set by the factory's demo-capture --dual run),
// the Weekly-shop seed becomes a SHARED list carrying that identity, so two
// simulators booting the same build rendezvous on the same relay channel. The
// seed is also made DETERMINISTIC (stable item ids + fixed timestamps) because
// the merge is by item id: without stable ids the two identical copies would
// union into duplicates on the first hello handshake. Unset in production and
// in normal QA/tests → the whole branch is a no-op (env inlined by Metro).
const QA_SHARE_SECRET = process.env.EXPO_PUBLIC_QA_SHARE_SECRET || '';

export function qaLists(): GroceryList[] {
  const list = makeList('Weekly shop');
  const names = [
    'Bananas', 'Whole milk', 'Sourdough', 'Eggs', 'Chicken thighs',
    'Baby spinach', 'Cheddar', 'Olive oil', 'Coffee beans', 'Greek yogurt',
    'Tomatoes', 'Pasta',
  ];
  list.items = names.map((name) => makeItem(name));
  // A couple checked off so the progress UI reads as a real, mid-shop list.
  for (const i of [1, 4]) {
    list.items[i].checked = true;
    list.items[i].checkedAt = list.items[i].updatedAt;
  }

  if (QA_SHARE_SECRET) {
    // Deterministic across both devices: a fixed epoch and stable ids so the
    // two seeded copies merge idempotently (same id → LWW keeps one), never
    // doubling. A local edit (the demo's added item) is stamped by the logical
    // clock at real time, which is far past BASE, so it out-clocks the seed and
    // syncs cleanly to the peer.
    const BASE = 1_700_000_000_000; // 2023-11-14, safely below real now()
    list.nameUpdatedAt = BASE;
    list.createdAt = BASE;
    list.updatedAt = BASE;
    list.items = list.items.map((it, idx) => ({
      ...it,
      id: `i-qa-sync-${idx}`,
      addedAt: BASE + idx,
      updatedAt: BASE + idx,
      checkedAt: it.checked ? BASE + idx : undefined,
    }));
    list.shareIdentity = { secret: QA_SHARE_SECRET, createdAt: BASE };
  }
  return [list];
}

export function qaKits(): Kit[] {
  // A couple of kits so the Kits tab reads as a real, lived-in collection.
  const chickenSalad = makeKit('Chicken salad');
  chickenSalad.items = [
    makeKitItem('Rotisserie chicken'),
    makeKitItem('Celery'),
    makeKitItem('Mayonnaise'),
    makeKitItem('Red grapes'),
    makeKitItem('Sliced almonds'),
  ];
  const tacoNight = makeKit('Taco night');
  tacoNight.items = [
    makeKitItem('Ground beef'),
    makeKitItem('Taco shells'),
    makeKitItem('Cheddar'),
    makeKitItem('Salsa'),
    makeKitItem('Sour cream'),
  ];
  return [chickenSalad, tacoNight];
}
