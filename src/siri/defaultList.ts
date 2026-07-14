/**
 * The user's "Siri adds to this list" choice.
 *
 * When more than one list exists and the user doesn't name one out loud, the
 * intent falls back to this default. Stored in the canonical `app_settings`
 * key/value table (account-level pref, rides the same backup as everything
 * else). An empty stored value means "no explicit default" (the intent then
 * uses the only-list rule, or asks).
 */

const KEY = 'siri.defaultListId';

// kv is loaded lazily so that merely importing the Siri module graph doesn't
// pull in expo-sqlite. These functions only run on iOS builds where Siri is
// actually supported, so the SQLite load happens on demand, never at import.
export async function getSiriDefaultListId(): Promise<string | null> {
  const { getAppSetting } = await import('../storage/kv');
  const v = await getAppSetting(KEY);
  return v && v.length > 0 ? v : null;
}

export async function setSiriDefaultListId(id: string | null): Promise<void> {
  const { setAppSetting } = await import('../storage/kv');
  await setAppSetting(KEY, id ?? '');
}
