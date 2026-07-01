/**
 * Best-effort text file IO for the feedback diagnostics log — a tiny abstraction
 * over expo-file-system that survives the SDK split at RUNTIME (the legacy
 * functional API `writeAsStringAsync` vs the SDK-54+ `File`/`Paths` API) and
 * degrades to a no-op when neither is available, so a missing/older dependency
 * never crashes the app.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * IMPORTANT (React Native / Metro): the import is a STATIC `import * as` of the
 * package ROOT — never `require(variable)` (Metro's bundler rejects a dynamic
 * require with a non-literal argument) and never a `/legacy` subpath (it isn't
 * present on every SDK the fleet runs). Which concrete API the installed version
 * exposes is decided at runtime by feature-detection below.
 *
 * Everything here is local-device IO only (cache + document dirs). Nothing is
 * uploaded; the file is read only when the user attaches it to a feedback email.
 */

import * as FileSystem from 'expo-file-system';

// `any` on purpose — the surface differs across versions (functional vs File API).
const fs = FileSystem as any;

/** The cache directory URI (transient — for attachment temp files), or null. */
export function cacheDir(): string | null {
  if (fs.cacheDirectory) return fs.cacheDirectory as string;
  try {
    if (fs.Paths && fs.Paths.cache && fs.Paths.cache.uri) return fs.Paths.cache.uri as string;
  } catch {
    /* new-API access threw — fall through */
  }
  return null;
}

/** The document directory URI (persistent — for the prior-session log), or null. */
export function docDir(): string | null {
  if (fs.documentDirectory) return fs.documentDirectory as string;
  try {
    if (fs.Paths && fs.Paths.document && fs.Paths.document.uri) return fs.Paths.document.uri as string;
  } catch {
    /* fall through */
  }
  return null;
}

/** Write text to a file URI. Returns the URI on success, null on any failure. */
export async function writeText(uri: string, text: string): Promise<string | null> {
  try {
    if (typeof fs.writeAsStringAsync === 'function') {
      await fs.writeAsStringAsync(uri, text);
      return uri;
    }
    if (typeof fs.File === 'function') {
      const f = new fs.File(uri);
      try {
        f.create({ overwrite: true, intermediates: true });
      } catch {
        /* may already exist */
      }
      f.write(text);
      return (f.uri as string) || uri;
    }
  } catch {
    /* IO failed — best effort */
  }
  return null;
}

/** Read a file URI back to text. Returns null if it's missing or IO is unavailable. */
export async function readText(uri: string): Promise<string | null> {
  try {
    if (typeof fs.readAsStringAsync === 'function') {
      if (typeof fs.getInfoAsync === 'function') {
        const info = await fs.getInfoAsync(uri);
        if (!info || !info.exists) return null;
      }
      return await fs.readAsStringAsync(uri);
    }
    if (typeof fs.File === 'function') {
      const f = new fs.File(uri);
      if (f.exists === false) return null;
      return f.text();
    }
  } catch {
    /* missing or unreadable */
  }
  return null;
}

/** Delete a file URI if present. Never throws. */
export async function remove(uri: string): Promise<void> {
  try {
    if (typeof fs.deleteAsync === 'function') {
      await fs.deleteAsync(uri, { idempotent: true });
      return;
    }
    if (typeof fs.File === 'function') {
      const f = new fs.File(uri);
      if (f.exists !== false && typeof f.delete === 'function') f.delete();
    }
  } catch {
    /* best effort */
  }
}
