/**
 * Best-effort text file IO for the feedback diagnostics log — a tiny abstraction
 * over expo-file-system's `File`/`Paths` class API (SDK 52+). Every call is
 * wrapped so a missing/older dependency or an IO error degrades to a no-op
 * (null / silent) rather than crashing the app.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * IMPORTANT (React Native / Metro): the import is a STATIC named import of the
 * package ROOT — never `require(variable)` (Metro's bundler rejects a dynamic
 * require with a non-literal argument) and never a `/legacy` subpath. The legacy
 * functional API (`writeAsStringAsync`/`readAsStringAsync`/`getInfoAsync`/
 * `deleteAsync`) is deprecated on SDK 54+ and emits a runtime warning, so this
 * uses the `File`/`Paths` classes exclusively.
 *
 * Everything here is local-device IO only (cache + document dirs). Nothing is
 * uploaded; the file is read only when the user attaches it to a feedback email.
 */

import { File, Paths } from 'expo-file-system';

/** The cache directory URI (transient — for attachment temp files), or null. */
export function cacheDir(): string | null {
  try {
    return Paths.cache.uri ?? null;
  } catch {
    /* new-API access threw — no cache dir available */
  }
  return null;
}

/** The document directory URI (persistent — for the prior-session log), or null. */
export function docDir(): string | null {
  try {
    return Paths.document.uri ?? null;
  } catch {
    /* no document dir available */
  }
  return null;
}

/** Write text to a file URI. Returns the URI on success, null on any failure. */
export async function writeText(uri: string, text: string): Promise<string | null> {
  try {
    const f = new File(uri);
    try {
      f.create({ overwrite: true, intermediates: true });
    } catch {
      /* may already exist */
    }
    f.write(text);
    return f.uri || uri;
  } catch {
    /* IO failed — best effort */
  }
  return null;
}

/** Read a file URI back to text. Returns null if it's missing or IO is unavailable. */
export async function readText(uri: string): Promise<string | null> {
  try {
    const f = new File(uri);
    if (f.exists === false) return null;
    return f.text();
  } catch {
    /* missing or unreadable */
  }
  return null;
}

/** Delete a file URI if present. Never throws. */
export async function remove(uri: string): Promise<void> {
  try {
    const f = new File(uri);
    if (f.exists !== false && typeof f.delete === 'function') f.delete();
  } catch {
    /* best effort */
  }
}
