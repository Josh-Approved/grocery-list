/**
 * On-device diagnostic log — a small, bounded, content-scrubbed ring buffer the
 * Send-feedback flow can attach to a bug report so a vague "it broke" still comes
 * with something triageable (canon § Funding & feedback, § Analytics & telemetry).
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * PRIVACY CONTRACT (load-bearing — the canon line is "no usage logs; if a crash
 * reporter is unavoidable, scrub everything except stack traces"):
 *   - Nothing here ever leaves the device on its own. The buffer lives in memory,
 *     plus ONE best-effort file so a crash survives a restart. It is read only
 *     when the user taps "Share logs" and sends the email themselves, and they
 *     can preview the exact text first (FeedbackSheet).
 *   - We record STRUCTURED EVENTS (a tag + short message + scalar fields) and
 *     ERRORS (message + stack — stack traces are the canon-exempt payload). We do
 *     NOT capture user content: callers pass `{ count: 12 }`, never the item text.
 *     Field values and intercepted console args are length-capped so stray
 *     content can't pool here, and we intercept only console.warn / console.error
 *     (diagnostic by nature), never console.log / .info / .debug.
 *
 * WHAT MAKES A LOG USEFUL (the 2026-08-09 rebuild — Josh filed a real bug and the
 * attached log was three copies of an Expo deprecation warning and nothing else):
 *   1. A BREADCRUMB TRAIL. The shell logs screen changes, foreground/background,
 *      database open, backup import/export, settings changes and every caught
 *      render error; apps log their own domain actions as scalars. Without that
 *      trail the buffer only ever holds whatever the runtime happened to warn
 *      about, which explains nothing.
 *   2. WALL-CLOCK TIME. "0.23s since boot" cannot be lined up with "it broke
 *      around 1pm". Every line carries local time-of-day.
 *   3. NO NOISE FLOOR. One warning repeated 40 times pushed the real events out
 *      of a 400-entry buffer. Repeats collapse to `×N` and a signature that keeps
 *      firing is suppressed after a handful.
 *   4. A HEADER THAT ANSWERS THE FIRST QUESTION. The report opens with a counted
 *      summary (errors / warnings / events, session length) so triage starts at
 *      the answer instead of scrolling.
 */

import { AppState, Platform } from 'react-native';
import { cacheDir, docDir, writeText, readText } from './fileStore';

export type LogLevel = 'info' | 'warn' | 'error';

type LogEntry = {
  /** Wall-clock ms (Date.now()) — rendered as local time-of-day. */
  w: number;
  level: LogLevel;
  tag: string;
  msg: string;
  data?: Record<string, string | number | boolean | null>;
  /** Repeat count for a collapsed run of identical entries (1 = not collapsed). */
  n?: number;
};

// ---- bounds (keep the report small + content from pooling) ----
const MAX_ENTRIES = 600;
const MAX_MSG = 240;
const MAX_FIELD = 120;
const MAX_STACK = 4000;
const MAX_REPORT_BYTES = 128 * 1024;
/** How many times one identical message may appear before it is suppressed. */
const MAX_REPEATS = 8;
/** Cap on the repeat-tracking map so a chatty app can't grow it unbounded. */
const MAX_SIGNATURES = 400;

const BOOT = Date.now();
const buffer: LogEntry[] = [];
/** signature → times seen this session (drives the noise-floor suppression). */
const seen = new Map<string, number>();
/** Text recovered from the previous run's file (e.g. the run that crashed). */
let priorSession = '';
let installed = false;
let reentry = false; // guard so our own console use can't recurse through the patch

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max})`;
}

/** Coerce a value into a safe scalar — objects collapse to a type tag, strings clip. */
function scrub(v: unknown): string | number | boolean | null {
  if (v == null) return null;
  const tv = typeof v;
  if (tv === 'number' || tv === 'boolean') return v as number | boolean;
  if (tv === 'string') return clip(v as string, MAX_FIELD);
  if (Array.isArray(v)) return `[array:${(v as unknown[]).length}]`;
  return `[${tv}]`;
}

/**
 * The two fields that carry a TRACE rather than a value. Stack traces are the
 * canon-exempt payload (canon § Analytics: "scrub everything except stack
 * traces"), and a trace clipped to the 120-char field cap is useless — it names
 * one frame. These get the much larger stack cap instead. Nothing else does.
 */
const TRACE_KEYS = new Set(['stack', 'componentStack']);

function scrubData(
  data?: Record<string, unknown>
): Record<string, string | number | boolean | null> | undefined {
  if (!data) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of Object.keys(data).slice(0, 16)) {
    const v = data[k];
    out[k] = TRACE_KEYS.has(k) && typeof v === 'string' ? clip(v, MAX_STACK) : scrub(v);
  }
  return out;
}

/** Two entries are "the same" for collapsing purposes when the level, tag and
 *  message match — field values (counts, ids) may differ and still be noise. */
function signature(level: LogLevel, tag: string, msg: string): string {
  return `${level}|${tag}|${msg}`;
}

function push(level: LogLevel, tag: string, msg: string, data?: Record<string, unknown>): void {
  const t = clip(String(tag), 40);
  const m = clip(String(msg), MAX_MSG);
  const sig = signature(level, t, m);

  // ---- noise floor: collapse a consecutive run, then suppress a chronic repeat.
  const last = buffer[buffer.length - 1];
  if (last && signature(last.level, last.tag, last.msg) === sig) {
    last.n = (last.n || 1) + 1;
    last.w = Date.now(); // the run's most recent occurrence
    return;
  }
  const count = (seen.get(sig) || 0) + 1;
  if (seen.size < MAX_SIGNATURES) seen.set(sig, count);
  if (count > MAX_REPEATS) return;

  buffer.push({
    w: Date.now(),
    level,
    tag: t,
    msg: count === MAX_REPEATS ? `${m}  [further repeats suppressed]` : m,
    data: scrubData(data),
  });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

// ---------- public capture API ----------

/** Record a structured event. `data` is for SCALARS (counts, ids, flags) — never
 *  user content (item text, notes, amounts). */
export function logEvent(tag: string, msg: string, data?: Record<string, unknown>): void {
  push('info', tag, msg, data);
}

export function logWarn(tag: string, msg: string, data?: Record<string, unknown>): void {
  push('warn', tag, msg, data);
}

/** Record an error. The message + stack are kept (stack traces are the
 *  canon-exempt payload); pass scalars only in `data`. */
export function logError(tag: string, err: unknown, data?: Record<string, unknown>): void {
  const e = err as { message?: string; stack?: string } | undefined;
  const msg = (e && (e.message || String(err))) || String(err);
  const stack = e && e.stack ? clip(e.stack, MAX_STACK) : undefined;
  push('error', tag, msg, { ...data, ...(stack ? { stack } : {}) });
}

/** Convenience: note a screen/route change (the breadcrumb trail for "how did
 *  they get here"). The route NAME only — never params, which can carry content. */
export function logNav(routeName: string): void {
  push('info', 'nav', routeName);
}

/**
 * Time an async operation and log its outcome — the shape most worth having in a
 * breadcrumb trail, because "it hung" and "it threw" look identical without it.
 * Re-throws so it is a drop-in wrapper. `data` is scalars only.
 */
export async function logTimed<T>(
  tag: string,
  msg: string,
  fn: () => Promise<T>,
  data?: Record<string, unknown>
): Promise<T> {
  const started = Date.now();
  try {
    const out = await fn();
    logEvent(tag, msg, { ...data, ms: Date.now() - started });
    return out;
  } catch (err) {
    logError(tag, err, { ...data, during: msg, ms: Date.now() - started });
    throw err;
  }
}

// ---------- serialization ----------

/** Local time-of-day, the only stamp a user can line up with "it broke at 1pm". */
function clock(w: number): string {
  const d = new Date(w);
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmt(e: LogEntry): string {
  let line = `${clock(e.w)} ${e.level.toUpperCase().padEnd(5)} ${e.tag}: ${e.msg}`;
  if (e.n && e.n > 1) line += ` (×${e.n})`;
  if (e.data && Object.keys(e.data).length) {
    // Scalars go inline in braces; traces go underneath on their own lines,
    // because a stack folded into a `{…}` blob is unreadable on a phone.
    const parts = Object.entries(e.data)
      .filter(([k]) => !TRACE_KEYS.has(k))
      .map(([k, v]) => `${k}=${v}`);
    if (parts.length) line += `  {${parts.join(', ')}}`;
    if (e.data.stack) line += `\n${e.data.stack}`;
    if (e.data.componentStack) line += `\ncomponent stack:${e.data.componentStack}`;
  }
  return line;
}

/** The counted summary that opens the report — triage starts here, not by
 *  scrolling. Reads only this session (the prior session carries its own). */
function summary(): string {
  let errors = 0;
  let warnings = 0;
  let events = 0;
  for (const e of buffer) {
    const n = e.n || 1;
    if (e.level === 'error') errors += n;
    else if (e.level === 'warn') warnings += n;
    else events += n;
  }
  const mins = Math.round((Date.now() - BOOT) / 60000);
  const started = new Date(BOOT);
  const day = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, '0')}-${String(
    started.getDate()
  ).padStart(2, '0')}`;
  return [
    `Session:  ${day} ${clock(BOOT)} local (${mins} min ago), times below are local`,
    `Recorded: ${errors} error(s), ${warnings} warning(s), ${events} event(s)`,
  ].join('\n');
}

/** The current session's events as text (newest last). */
export function serializeCurrent(): string {
  return buffer.map(fmt).join('\n');
}

/** The full attachable log: a counted header, the previous run (if any), this run. */
export function serialize(): string {
  const cur = serializeCurrent();
  let out = `${summary()}\n\n`;
  if (priorSession.trim()) {
    out += `──── previous session ────\n${priorSession.trim()}\n\n──── this session ────\n`;
  }
  out += cur || '(no events recorded this session)';
  if (out.length > MAX_REPORT_BYTES) {
    out = `…(${out.length - MAX_REPORT_BYTES} earlier chars trimmed)\n` + out.slice(-MAX_REPORT_BYTES);
  }
  return out;
}

/** Number of events held this session (for the preview summary). */
export function entryCount(): number {
  return buffer.length;
}

export function clear(): void {
  buffer.length = 0;
  seen.clear();
  priorSession = '';
}

// ---------- persistence (survive a crash/restart) ----------

function logFileUri(): string | null {
  const dir = docDir();
  return dir ? `${dir}ja-diagnostics.log` : null;
}

let flushing = false;
let lastFlush = 0;

/** Persist the current buffer so a crash (process death) still leaves a trail for
 *  the next launch. Best-effort + throttled; never throws. */
export async function flush(): Promise<void> {
  const uri = logFileUri();
  if (!uri || flushing) return;
  const now = Date.now();
  if (now - lastFlush < 1500) return;
  flushing = true;
  lastFlush = now;
  try {
    await writeText(uri, serializeCurrent());
  } finally {
    flushing = false;
  }
}

async function loadPriorSession(): Promise<void> {
  const uri = logFileUri();
  if (!uri) return;
  const prev = await readText(uri);
  if (prev && prev.trim()) priorSession = prev;
}

// ---------- one-time install (called by FeedbackProvider at app root) ----------

/**
 * Extra facts about this launch, supplied by the shell (which can read the app
 * version and the stored launch count) so the first line of the log answers
 * "which build, how long have they had it" without another round trip.
 */
export type SessionMeta = Record<string, string | number | boolean | null | undefined>;

/** Patch console.warn/console.error + the global JS error handler into the buffer
 *  and start crash-persistence. Idempotent and side-effect-light; safe to call on
 *  every app launch. */
export function installDiagnostics(meta?: SessionMeta): void {
  if (installed) return;
  installed = true;

  // Recover the previous run's trail (e.g. the crash that sent the user here).
  void loadPriorSession();

  // Intercept only warn/error (diagnostic by nature), keeping the originals so the
  // dev console is unaffected. Args are stringified + clipped so no large blob lands.
  const wrap = (level: 'warn' | 'error', orig: (...a: any[]) => void) => {
    return (...args: any[]) => {
      try {
        orig(...args);
      } finally {
        if (!reentry) {
          reentry = true;
          try {
            const msg = args
              .map((a) =>
                a instanceof Error ? a.message : typeof a === 'string' ? a : `[${typeof a}]`
              )
              .join(' ');
            const stack = args.find((a) => a instanceof Error)?.stack as string | undefined;
            push(level, 'console', clip(msg, MAX_MSG), stack ? { stack: clip(stack, MAX_STACK) } : undefined);
          } catch {
            /* never let logging break logging */
          } finally {
            reentry = false;
          }
        }
      }
    };
  };
  /* eslint-disable no-console */
  console.warn = wrap('warn', console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));
  /* eslint-enable no-console */

  const g = globalThis as any;

  // Capture uncaught JS errors (the ones that kill the app), then defer to the
  // platform handler so the red box / crash behaviour is unchanged.
  if (g.ErrorUtils && typeof g.ErrorUtils.setGlobalHandler === 'function') {
    const prev = g.ErrorUtils.getGlobalHandler ? g.ErrorUtils.getGlobalHandler() : undefined;
    g.ErrorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => {
      logError('uncaught', err, { fatal: !!isFatal });
      void flush();
      if (typeof prev === 'function') prev(err, isFatal);
    });
  }

  // Unhandled promise rejections — the most common way a failure goes completely
  // invisible in production (an awaited call throws, nothing catches, no red box,
  // the screen just doesn't update). Hermes ships a tracker but React Native only
  // arms it in __DEV__, so arm it ourselves in release. Never in dev: RN already
  // owns the hook there and re-registering would silence LogBox's warning.
  if (!(g.__DEV__ ?? false)) {
    try {
      if (typeof g.HermesInternal?.enablePromiseRejectionTracker === 'function') {
        g.HermesInternal.enablePromiseRejectionTracker({
          allRejections: true,
          onUnhandled: (_id: number, err: unknown) => logError('unhandledRejection', err),
          onHandled: () => {
            /* rejection was handled late — not worth a line */
          },
        });
      }
    } catch {
      /* tracker unavailable on this engine — best effort */
    }
  }

  // Foreground/background transitions: the breadcrumb that explains "it was fine,
  // then I came back to it". Also the last safe moment to flush before a
  // background kill, so the file is fresh for the next launch.
  AppState.addEventListener('change', (s) => {
    logEvent('app', s === 'active' ? 'foreground' : `background (${s})`);
    if (s !== 'active') void flush();
  });

  logEvent('app', 'session start', {
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    ...meta,
  });
}

/** Drop a fresh attachment file with the supplied text into the cache dir; returns
 *  its URI or null. Used by compose.ts for the email attachment. */
export async function writeReportFile(text: string, name: string): Promise<string | null> {
  const dir = cacheDir();
  if (!dir) return null;
  return writeText(`${dir}${name}`, text);
}
