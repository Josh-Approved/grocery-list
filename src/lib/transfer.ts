/**
 * Manual export / import — canon § Backup & restore Layer 3.
 *
 * Export hands a single JSON file to the system share sheet; the user picks
 * where it goes (nothing leaves until they do). Import is additive and never
 * destructive: a colliding id is re-minted and the list gets " (imported)"
 * so an import can't clobber what's already there. Round-trip safe.
 *
 * Layer 1 (automatic OS backup) needs no code here: the SQLite DB lives in
 * the app's default document storage, which rides iCloud / Android auto-
 * backup. This file is the always-available escape hatch, independent of the
 * shared-list sync.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { makeId } from './id';
import {
  type GroceryList,
  type GroceryItem,
  makeList,
} from '../data/list';
import { DEFAULT_CATEGORY_ORDER, type Category } from '../data/categories';

const EXPORT_VERSION = 1;

interface ExportEnvelope {
  app: 'grocery-list';
  version: number;
  exportedAt: number;
  lists: GroceryList[];
}

export async function exportLists(lists: GroceryList[]): Promise<void> {
  const envelope: ExportEnvelope = {
    app: 'grocery-list',
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    lists,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const uri = `${FileSystem.cacheDirectory}grocery-list-${stamp}.json`;
  await FileSystem.writeAsStringAsync(
    uri,
    JSON.stringify(envelope, null, 2)
  );
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      dialogTitle: 'Export grocery lists',
      UTI: 'public.json',
    });
  }
}

/** Coerce one untrusted parsed object into a safe GroceryList. Unknown shapes
 *  are skipped, not crashed on (an import file may be hand-edited). */
function sanitizeList(raw: unknown): GroceryList | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !Array.isArray(r.items)) return null;
  const base = makeList(r.name);
  const items: GroceryItem[] = [];
  for (const it of r.items as unknown[]) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.name !== 'string') continue;
    const now = Date.now();
    items.push({
      id: makeId('i'),
      name: o.name,
      quantity:
        typeof o.quantity === 'number' && o.quantity > 0
          ? Math.round(o.quantity)
          : 1,
      note: typeof o.note === 'string' ? o.note : undefined,
      category: DEFAULT_CATEGORY_ORDER.includes(o.category as Category)
        ? (o.category as Category)
        : 'Other',
      checked: o.checked === true,
      addedAt: typeof o.addedAt === 'number' ? o.addedAt : now,
      updatedAt: now,
    });
  }
  return {
    ...base,
    name: `${r.name} (imported)`,
    items,
    categoryOrder: Array.isArray(r.categoryOrder)
      ? (r.categoryOrder as Category[]).filter((x) =>
          DEFAULT_CATEGORY_ORDER.includes(x)
        )
      : [...DEFAULT_CATEGORY_ORDER],
  };
}

/** Pick a file and return the lists to add. Returns [] on cancel / bad file. */
export async function pickAndParseLists(): Promise<GroceryList[]> {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets?.[0]) return [];
  const text = await FileSystem.readAsStringAsync(res.assets[0].uri);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const env = parsed as Partial<ExportEnvelope>;
  const rawLists = Array.isArray(env?.lists) ? env.lists : [];
  const out: GroceryList[] = [];
  for (const raw of rawLists) {
    const safe = sanitizeList(raw);
    if (safe) out.push(safe);
  }
  return out;
}
