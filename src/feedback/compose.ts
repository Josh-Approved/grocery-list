/**
 * Turn a filled feedback form into an email and hand it to the user's mail app —
 * the system mail composer (with the diagnostic log attached as a .txt file) when
 * one is available, falling back to a pre-filled `mailto:` link otherwise.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * Why the composer and not just `mailto:`: a `mailto:` URL can pre-fill the
 * recipient/subject/body but CANNOT carry an attachment, and long bodies hit URL
 * limits. expo-mail-composer attaches the log file and is fully cross-platform
 * (iOS system composer / Android intent chooser). The `mailto:` path stays as the
 * floor so feedback still works on a device with no mail account configured.
 *
 * THE ATTACHMENT IS NEVER THE ONLY CARRIER (2026-08-09). Writing the file can
 * fail — it silently did on every shipped iOS build for weeks, because the
 * `writeAsStringAsync` this module's file layer called doesn't just warn on
 * SDK 54, it throws, and the failure was swallowed. So the log the user agreed
 * to share arrived nowhere and nothing said so. The rule now: if the attachment
 * file could not be written, the report goes INLINE in the body instead. The
 * user opted into sharing a log; the delivery mechanism is our problem, not
 * theirs, and a silent drop is the one outcome that is never acceptable.
 */

import { Linking } from 'react-native';
import * as MailComposer from 'expo-mail-composer';
import { t } from '../i18n';
import { collectDiagnostics, formatDiagnostics, type Diagnostics } from './diagnostics';
import { serialize, writeReportFile, logEvent, logWarn } from './log';

export type FeedbackType = 'bug' | 'feature' | 'general';

/** The studio feedback inbox (canon § Funding & feedback — pinned, all apps). */
export const FEEDBACK_EMAIL = 'feedback@joshapproved.com';

export type FeedbackInput = {
  type: FeedbackType;
  /** Field key → the user's text. Keys per type are defined in FIELDS below. */
  fields: Record<string, string>;
  includeLogs: boolean;
};

export type SendResult = {
  status: 'composed' | 'mailto' | 'failed';
  /** The log rode along as a file attachment. */
  attachedLog: boolean;
  /** The log rode along inside the email body (the fallback, and the whole body
   *  on the `mailto:` path). Exactly one of these is true when the user opted in. */
  inlinedLog: boolean;
};

/** How much of the report can go inline in a COMPOSER body. The system composer
 *  takes a large string happily, but a wall of text the user has to scroll past
 *  is user-hostile, so this is a compromise: enough to be triageable, not enough
 *  to bury their own words. The newest lines are the ones kept. */
const MAX_INLINE_COMPOSER = 16 * 1024;
/** How much can go inline in a `mailto:` URL — far smaller, because the whole
 *  report is percent-encoded into a URL that iOS and Android both truncate. */
const MAX_INLINE_MAILTO = 1500;

/** The guided fields per feedback type, in render + email order. `labelKey` and
 *  `hintKey` resolve through i18n so the form and the email are localized; the
 *  bug set mirrors the good-bug-report checklist (what happened / expected /
 *  steps / frequency), the feature set draws out the "why". */
export const FIELDS: Record<FeedbackType, { key: string; labelKey: string; hintKey: string; lines: number }[]> = {
  bug: [
    { key: 'whatHappened', labelKey: 'feedback.bug.whatHappened', hintKey: 'feedback.bug.whatHappenedHint', lines: 3 },
    { key: 'expected', labelKey: 'feedback.bug.expected', hintKey: 'feedback.bug.expectedHint', lines: 2 },
    { key: 'steps', labelKey: 'feedback.bug.steps', hintKey: 'feedback.bug.stepsHint', lines: 4 },
    { key: 'frequency', labelKey: 'feedback.bug.frequency', hintKey: 'feedback.bug.frequencyHint', lines: 1 },
  ],
  feature: [
    { key: 'want', labelKey: 'feedback.feature.want', hintKey: 'feedback.feature.wantHint', lines: 3 },
    { key: 'goal', labelKey: 'feedback.feature.goal', hintKey: 'feedback.feature.goalHint', lines: 3 },
    { key: 'workaround', labelKey: 'feedback.feature.workaround', hintKey: 'feedback.feature.workaroundHint', lines: 2 },
  ],
  general: [
    { key: 'message', labelKey: 'feedback.general.message', hintKey: 'feedback.general.messageHint', lines: 5 },
  ],
};

/** Stable, ASCII, English subject tag so the studio inbox can filter regardless
 *  of the sender's language. */
function subjectTag(type: FeedbackType): string {
  return type === 'bug' ? 'Bug' : type === 'feature' ? 'Feature' : 'Feedback';
}

function buildSubject(type: FeedbackType, d: Diagnostics): string {
  return `[${subjectTag(type)}] ${d.app} ${d.version}`;
}

/** The user-written sections, each under its localized label (blank fields skipped). */
function buildUserBody(input: FeedbackInput): string {
  const parts: string[] = [];
  for (const f of FIELDS[input.type]) {
    const v = (input.fields[f.key] || '').trim();
    if (v) parts.push(`${t(f.labelKey)}:\n${v}`);
  }
  return parts.join('\n\n');
}

/** The full attachable report: environment block + the event log. */
export function buildLogReport(d: Diagnostics): string {
  return `${t('feedback.body.envHeader')}\n${formatDiagnostics(d)}\n\n${t('feedback.body.logHeader')}\n${serialize()}`;
}

function buildEmailBody(
  input: FeedbackInput,
  d: Diagnostics,
  opts: { inlineLog: false | number }
): string {
  const sections: string[] = [];
  const user = buildUserBody(input);
  if (user) sections.push(user);
  else sections.push(t(`feedback.${input.type}.placeholder`));

  sections.push('--------');
  sections.push(`${t('feedback.body.envHeader')}\n${formatDiagnostics(d)}`);

  if (opts.inlineLog !== false) {
    // No attachment on this path (the file couldn't be written, or we're on the
    // mailto floor, which cannot carry one) — so the log the user opted into
    // rides in the body. The NEWEST lines are the ones worth keeping.
    const full = serialize();
    const kept = full.length > opts.inlineLog ? full.slice(-opts.inlineLog) : full;
    sections.push(`${t('feedback.body.logHeader')}\n${kept}`);
    if (kept.length < full.length) sections.push(t('feedback.body.logTruncatedNote'));
  }
  return sections.join('\n\n');
}

async function openMailto(input: FeedbackInput, d: Diagnostics, inlineLog: boolean): Promise<SendResult> {
  const subject = buildSubject(input.type, d);
  const body = buildEmailBody(input, d, { inlineLog: inlineLog ? MAX_INLINE_MAILTO : false });
  const url = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try {
    await Linking.openURL(url);
    return { status: 'mailto', attachedLog: false, inlinedLog: inlineLog };
  } catch {
    return { status: 'failed', attachedLog: false, inlinedLog: false };
  }
}

/**
 * Compose + open the feedback email. Tries the system mail composer (with the log
 * attached when the user opted in); falls back to a pre-filled `mailto:`.
 */
export async function sendFeedback(input: FeedbackInput): Promise<SendResult> {
  const d = collectDiagnostics();

  // Write the attachment up front (best-effort) so we know whether we can attach.
  let attachmentUri: string | null = null;
  if (input.includeLogs) {
    const name = `feedback-${d.app.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${Date.now()}.txt`;
    attachmentUri = await writeReportFile(buildLogReport(d), name);
    // Say so in the log itself. If the write failed, the inline copy the user
    // ends up sending now explains why there is no .txt on the email — the
    // failure that used to be invisible is on the record they send us.
    if (attachmentUri) logEvent('feedback', 'log file written for attachment');
    else logWarn('feedback', 'could not write the log file; sending it inline instead');
  }

  const mc = MailComposer as any;
  if (typeof mc.composeAsync === 'function') {
    try {
      const available =
        typeof mc.isAvailableAsync === 'function' ? await mc.isAvailableAsync() : true;
      if (available) {
        // The attachment is the nice path; the body is the reliable one. When the
        // file isn't there, inline rather than silently dropping what the user
        // agreed to share.
        const inline = input.includeLogs && !attachmentUri ? MAX_INLINE_COMPOSER : false;
        await mc.composeAsync({
          recipients: [FEEDBACK_EMAIL],
          subject: buildSubject(input.type, d),
          body: buildEmailBody(input, d, { inlineLog: inline }),
          isHtml: false,
          attachments: attachmentUri ? [attachmentUri] : undefined,
        });
        return {
          status: 'composed',
          attachedLog: !!attachmentUri,
          inlinedLog: inline !== false,
        };
      }
    } catch {
      /* fall through to mailto */
    }
  }

  // No mail account / composer unavailable: pre-filled mailto, which can never
  // carry an attachment, so the log always goes inline when the user opted in.
  return openMailto(input, d, input.includeLogs);
}
