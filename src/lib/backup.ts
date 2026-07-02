/**
 * Generic manual export / import mechanics — canon § Backup & restore Layer 3.
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * This file owns the *plumbing* (write a JSON envelope to a cache file, hand it
 * to the system share sheet; pick a file back, parse the envelope). The app's
 * own `lib/transfer.ts` owns the domain-shaped part — building the payload and
 * sanitizing/merging an imported payload into its records (additive, never
 * destructive; a colliding id is re-minted by the importer).
 *
 * Layer 1 (automatic OS backup) needs no code here: keep the SQLite DB in the
 * app's default Documents location (see storage/kv.ts) so it rides iCloud /
 * Android auto-backup for free.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';

export interface Envelope<T> {
  app: string;
  version: number;
  exportedAt: number;
  payload: T;
}

/** Write `payload` as a dated JSON envelope and present the system share sheet.
 *  Nothing leaves the device until the user picks a destination. */
export async function exportEnvelope<T>(
  app: string,
  version: number,
  payload: T
): Promise<void> {
  const envelope: Envelope<T> = {
    app,
    version,
    exportedAt: Date.now(),
    payload,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const uri = `${FileSystem.cacheDirectory}${app}-${stamp}.json`;
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(envelope, null, 2));
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      dialogTitle: `Export ${app}`,
      UTI: 'public.json',
    });
  }
}

/** Pick a JSON file and return its parsed envelope (untyped — the caller
 *  sanitizes `payload`). Returns null on cancel / unreadable / bad JSON. */
export async function pickEnvelope(): Promise<Envelope<unknown> | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets?.[0]) return null;
  let text: string;
  try {
    text = await FileSystem.readAsStringAsync(res.assets[0].uri);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Envelope<unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}
