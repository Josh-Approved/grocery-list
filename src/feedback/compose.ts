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
 */

import { Linking } from 'react-native';
import { t } from '../i18n';
import { collectDiagnostics, formatDiagnostics, type Diagnostics } from './diagnostics';
import { serialize, writeReportFile } from './log';

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
  attachedLog: boolean;
};

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

function buildEmailBody(input: FeedbackInput, d: Diagnostics, opts: { inlineLog: boolean }): string {
  const sections: string[] = [];
  const user = buildUserBody(input);
  if (user) sections.push(user);
  else sections.push(t(`feedback.${input.type}.placeholder`));

  sections.push('--------');
  sections.push(`${t('feedback.body.envHeader')}\n${formatDiagnostics(d)}`);

  if (opts.inlineLog) {
    // mailto fallback: no attachment possible, so include a bounded tail of the
    // log inline and note that the full file needs a mail app that can attach.
    const tail = serialize().slice(-1500);
    sections.push(`${t('feedback.body.logHeader')}\n${tail}`);
    sections.push(t('feedback.body.logTruncatedNote'));
  }
  return sections.join('\n\n');
}

function resolveMailComposer(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-mail-composer');
  } catch {
    return null;
  }
}

async function openMailto(input: FeedbackInput, d: Diagnostics, inlineLog: boolean): Promise<SendResult> {
  const subject = buildSubject(input.type, d);
  const body = buildEmailBody(input, d, { inlineLog });
  const url = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try {
    await Linking.openURL(url);
    return { status: 'mailto', attachedLog: false };
  } catch {
    return { status: 'failed', attachedLog: false };
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
  }

  const MailComposer = resolveMailComposer();
  if (MailComposer && typeof MailComposer.composeAsync === 'function') {
    try {
      const available =
        typeof MailComposer.isAvailableAsync === 'function'
          ? await MailComposer.isAvailableAsync()
          : true;
      if (available) {
        await MailComposer.composeAsync({
          recipients: [FEEDBACK_EMAIL],
          subject: buildSubject(input.type, d),
          body: buildEmailBody(input, d, { inlineLog: false }),
          isHtml: false,
          attachments: attachmentUri ? [attachmentUri] : undefined,
        });
        return { status: 'composed', attachedLog: !!attachmentUri };
      }
    } catch {
      /* fall through to mailto */
    }
  }

  // No mail account / composer unavailable: pre-filled mailto, log inlined if asked.
  return openMailto(input, d, input.includeLogs && !attachmentUri ? true : input.includeLogs);
}
