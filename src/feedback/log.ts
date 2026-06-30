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
 */

import { AppState, Platform } from 'react-native';
import { cacheDir, docDir, writeText, readText } from './fileStore';

export type LogLevel = 'info' | 'warn' | 'error';

type LogEntry = {
  /** ms since app start (monotonic-ish; survives wall-clock changes). */
  t: number;
  level: LogLevel;
  tag: string;
  msg: string;
  data?: Record<string, string | number | boolean | null>;
};

// ---- bounds (keep the report small + content from pooling) ----
const MAX_ENTRIES = 400;
const MAX_MSG = 240;
const MAX_FIELD = 120;
const MAX_REPORT_BYTES = 128 * 1024;

const BOOT = Date.now();
const buffer: LogEntry[] = [];
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

function scrubData(
  data?: Record<string, unknown>
): Record<string, string | number | boolean | null> | undefined {
  if (!data) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of Object.keys(data).slice(0, 16)) out[k] = scrub(data[k]);
  return out;
}

function push(level: LogLevel, tag: string, msg: string, data?: Record<string, unknown>): void {
  buffer.push({
    t: Date.now() - BOOT,
    level,
    tag: clip(String(tag), 40),
    msg: clip(String(msg), MAX_MSG),
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
  const stack = e && e.stack ? clip(e.stack, 4000) : undefined;
  push('error', tag, msg, { ...data, ...(stack ? { stack } : {}) });
}

/** Convenience: note a screen/route change (the breadcrumb trail for "how did
 *  they get here"). The route NAME only — never params, which can carry content. */
export function logNav(routeName: string): void {
  push('info', 'nav', routeName);
}

// ---------- serialization ----------

function fmt(e: LogEntry): string {
  const secs = (e.t / 1000).toFixed(2).padStart(7, ' ');
  let line = `${secs}s ${e.level.toUpperCase().padEnd(5)} ${e.tag}: ${e.msg}`;
  if (e.data && Object.keys(e.data).length) {
    const parts = Object.entries(e.data)
      .filter(([k]) => k !== 'stack')
      .map(([k, v]) => `${k}=${v}`);
    if (parts.length) line += `  {${parts.join(', ')}}`;
    if (e.data.stack) line += `\n${e.data.stack}`;
  }
  return line;
}

/** The current session's events as text (newest last). */
export function serializeCurrent(): string {
  return buffer.map(fmt).join('\n');
}

/** The full attachable log: the previous run (if any) + this run, byte-capped. */
export function serialize(): string {
  const cur = serializeCurrent();
  let out = '';
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

/** Patch console.warn/console.error + the global JS error handler into the buffer
 *  and start crash-persistence. Idempotent and side-effect-light; safe to call on
 *  every app launch. */
export function installDiagnostics(): void {
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
            push(level, 'console', clip(msg, MAX_MSG), stack ? { stack: clip(stack, 4000) } : undefined);
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

  // Capture uncaught JS errors (the ones that kill the app), then defer to the
  // platform handler so the red box / crash behaviour is unchanged.
  const g = globalThis as any;
  if (g.ErrorUtils && typeof g.ErrorUtils.setGlobalHandler === 'function') {
    const prev = g.ErrorUtils.getGlobalHandler ? g.ErrorUtils.getGlobalHandler() : undefined;
    g.ErrorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => {
      logError('uncaught', err, { fatal: !!isFatal });
      void flush();
      if (typeof prev === 'function') prev(err, isFatal);
    });
  }

  // Flush when the app leaves the foreground (the last safe moment before a
  // background kill), so the file is fresh for the next launch.
  AppState.addEventListener('change', (s) => {
    if (s !== 'active') void flush();
  });

  logEvent('app', 'session start', { platform: Platform.OS, osVersion: String(Platform.Version) });
}

/** Drop a fresh attachment file with the supplied text into the cache dir; returns
 *  its URI or null. Used by compose.ts for the email attachment. */
export async function writeReportFile(text: string, name: string): Promise<string | null> {
  const dir = cacheDir();
  if (!dir) return null;
  return writeText(`${dir}${name}`, text);
}
