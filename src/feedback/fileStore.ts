/**
 * Best-effort text file IO for the feedback diagnostics log — a tiny abstraction
 * over expo-file-system that survives the SDK split (the legacy functional API
 * vs the SDK-54+ `File`/`Paths` API) and degrades to a no-op when neither is
 * available, so a missing/older dependency never crashes the app.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * Everything here is local-device IO only (cache + document dirs). Nothing is
 * uploaded; the file is read only when the user attaches it to a feedback email.
 */

// Resolved lazily and cached. `any` on purpose — the export shape differs across
// expo-file-system versions, and a static import would break tsc on whichever
// version a given app pins. A require keeps the file compiling everywhere.
let fs: any | null = null;
let resolved = false;

function resolveFs(): any | null {
  if (resolved) return fs;
  resolved = true;
  // Prefer the stable legacy functional API; it's the one present (directly or
  // via the /legacy entry) across every SDK the fleet runs.
  for (const mod of ['expo-file-system/legacy', 'expo-file-system']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require(mod);
      if (m && typeof m.writeAsStringAsync === 'function') {
        fs = m;
        return fs;
      }
    } catch {
      /* try the next entry point */
    }
  }
  fs = null;
  return fs;
}

/** The cache directory URI (transient — for attachment temp files), or null. */
export function cacheDir(): string | null {
  const m = resolveFs();
  return (m && (m.cacheDirectory as string)) || null;
}

/** The document directory URI (persistent — for the prior-session log), or null. */
export function docDir(): string | null {
  const m = resolveFs();
  return (m && (m.documentDirectory as string)) || null;
}

/** Write text to a file URI. Returns the URI on success, null on any failure. */
export async function writeText(uri: string, text: string): Promise<string | null> {
  const m = resolveFs();
  if (!m) return null;
  try {
    await m.writeAsStringAsync(uri, text);
    return uri;
  } catch {
    return null;
  }
}

/** Read a file URI back to text. Returns null if it's missing or IO is unavailable. */
export async function readText(uri: string): Promise<string | null> {
  const m = resolveFs();
  if (!m) return null;
  try {
    if (typeof m.getInfoAsync === 'function') {
      const info = await m.getInfoAsync(uri);
      if (!info || !info.exists) return null;
    }
    return await m.readAsStringAsync(uri);
  } catch {
    return null;
  }
}

/** Delete a file URI if present. Never throws. */
export async function remove(uri: string): Promise<void> {
  const m = resolveFs();
  if (!m || typeof m.deleteAsync !== 'function') return;
  try {
    await m.deleteAsync(uri, { idempotent: true });
  } catch {
    /* best effort */
  }
}
