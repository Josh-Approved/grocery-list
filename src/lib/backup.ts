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
import { logEvent, logWarn, logError } from '../feedback/log';

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
  const json = JSON.stringify(envelope, null, 2);
  // Size + outcome only — never the payload. "My export was empty" and "the
  // share sheet never appeared" are different bugs and look identical otherwise.
  try {
    await FileSystem.writeAsStringAsync(uri, json);
  } catch (err) {
    logError('backup', err, { during: 'export write', bytes: json.length });
    throw err;
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      dialogTitle: `Export ${app}`,
      UTI: 'public.json',
    });
    logEvent('backup', 'export shared', { version, bytes: json.length });
  } else {
    logWarn('backup', 'export written but sharing is unavailable', { bytes: json.length });
  }
}

/** Pick a JSON file and return its parsed envelope (untyped — the caller
 *  sanitizes `payload`). Returns null on cancel / unreadable / bad JSON. */
export async function pickEnvelope(): Promise<Envelope<unknown> | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets?.[0]) {
    logEvent('backup', 'import cancelled');
    return null;
  }
  let text: string;
  try {
    text = await FileSystem.readAsStringAsync(res.assets[0].uri);
  } catch (err) {
    // "I picked my backup and nothing happened" — three different failures wear
    // that face (unreadable file, not JSON, wrong shape). Name which one.
    logError('backup', err, { during: 'import read' });
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Envelope<unknown>;
    if (!parsed || typeof parsed !== 'object') {
      logWarn('backup', 'import file parsed but is not an envelope', { bytes: text.length });
      return null;
    }
    logEvent('backup', 'import file read', {
      bytes: text.length,
      app: String((parsed as Envelope<unknown>).app || 'unknown'),
      version: Number((parsed as Envelope<unknown>).version) || 0,
    });
    return parsed;
  } catch (err) {
    logError('backup', err, { during: 'import parse', bytes: text.length });
    return null;
  }
}
