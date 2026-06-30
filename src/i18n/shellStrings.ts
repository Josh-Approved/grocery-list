/**
 * Canonical, app-agnostic copy — the strings the SHELL renders (Settings /
 * About / common actions). Synced by `sync.mjs app-shell`; edit HERE, not per
 * app. App-specific copy lives in the app-owned `appStrings.ts`.
 *
 * Voice canon applies (canonical-voice.md): sentence case, plain second person,
 * no emoji, no urgency. These are locked copies — the About-stamp one-liner and
 * the donation/funding labels are pinned by canonical-requirements.md.
 */

export const SHELL_STRINGS = {
  common: {
    back: 'Back',
    cancel: 'Cancel',
    done: 'Done',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    rename: 'Rename',
    add: 'Add',
    maybeLater: 'Maybe later',
    notNow: 'Not now',
  },
  settings: {
    title: 'Settings',
    appearance: 'Appearance',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
    language: 'Language',
    languageSystem: 'System',
    languageSystemHint: 'Match your phone',
    yourData: 'Your data',
    about: 'About',
    export: 'Export',
    import: 'Import',
    nothingImported: 'Nothing imported.',
    couldntExport: "Couldn't export.",
    couldntRead: "Couldn't read that file.",
  },
  about: {
    support: 'Support this app',
    supportShort: 'Support',
    feedback: 'Send feedback',
    review: 'Leave a review',
    privacy: 'Privacy',
    source: 'Source code',
    acknowledgements: 'Acknowledgements',
    version: 'Version',
    // Locked by canon § Settings / About (the attribution stamp one-liner).
    oneLiner:
      'Privacy-first replacements for paywalled utility apps. Open source. Pay what you want.',
    learnMore: 'Learn more',
    learnMoreA11y: 'Learn more at joshapproved.com',
    // Cross-promo section label (MoreFromJA). "Josh Approved" stays inline as the
    // brand; the surrounding words translate per locale.
    moreFrom: 'More from Josh Approved',
  },
  // Donation prompt (DonationModal). The button label reuses about.support.
  donate: {
    body: "{app} has no ads and no subscriptions — it's supported by the people who use it. If it's earned a place in your day, your support keeps it going.",
    supportA11y: 'Support this app, opens in your browser',
  },
  // Tip jar (TipJarSheet) — the IAP funding surface. Locked copy, canon § Tip
  // jar: reaffirm free + studio-supported-by-tips, never "nothing unlocks", no
  // guilt. The dismiss label reuses common.maybeLater; the done label reuses
  // common.done. Prices come from the store (displayPrice), never copy.
  tip: {
    title: 'Support Josh Approved',
    body: "Everything's free and stays free — no ads, no tracking. Josh Approved runs entirely on tips like this one. Thank you for keeping it going.",
    thanksTitle: 'Thank you',
    thanks: 'That genuinely helps keep Josh Approved going.',
    unavailable: "Tips aren't available right now. Please try again in a moment.",
    tierA11y: 'Tip {price}',
  },
  // Review prompt (ReviewModal). The button label reuses about.review;
  // the dismiss label reuses common.notNow.
  review: {
    title: 'Enjoying {app}?',
    body: 'A quick rating helps more people find this app.',
    leaveA11y: 'Leave a review on the app store',
  },
  // Top-level error boundary fallback (ErrorBoundary).
  error: {
    title: 'Something went wrong',
    body: 'The app hit an unexpected error. Reopen it to keep going — your data is safe on this device.',
  },
  // Acknowledgements screen (Credits). The header title reuses about.acknowledgements.
  credits: {
    footnote: "Full license texts live in each project's repository.",
    linkHint: 'Opens the project page in your browser',
  },
  // Send-feedback flow (FeedbackSheet) — the guided bug / feature / general report
  // that opens the user's email with the environment auto-filled and, for bugs, the
  // diagnostic log attached. Voice canon: calm, plain, no urgency. The bug fields
  // mirror the standard good-report checklist; the feature prompts draw out the WHY.
  feedback: {
    title: 'Send feedback',
    lead: 'What would you like to share?',
    type: {
      bug: 'Report a bug',
      bugDesc: 'Something is broken or not working right',
      feature: 'Request a feature',
      featureDesc: 'Suggest something the app could do',
      general: 'General feedback',
      generalDesc: 'Share a thought, a question, or thanks',
    },
    bug: {
      title: 'Report a bug',
      guidanceTitle: 'A clear report helps us fix it faster',
      guidance:
        "Tell us what happened, what you expected instead, and the steps to see it again. Be specific — we can't see your screen.",
      whatHappened: 'What happened?',
      whatHappenedHint: 'e.g. The app closed when I tapped Save',
      expected: 'What did you expect to happen?',
      expectedHint: 'e.g. It should have saved and gone back to the list',
      steps: 'Steps to reproduce',
      stepsHint: '1. Open a list\n2. Tap the + button\n3. …',
      frequency: 'How often does it happen?',
      frequencyHint: 'Every time, sometimes, or just once?',
      placeholder: '[Describe the bug here]',
    },
    feature: {
      title: 'Request a feature',
      want: 'What would you like to be able to do?',
      wantHint: 'e.g. Sort my list by aisle',
      goal: 'What are you trying to get done?',
      goalHint: 'The goal behind it — what would this help you accomplish?',
      workaround: 'How do you handle this today?',
      workaroundHint: 'e.g. I keep a separate note, or do it by hand',
      placeholder: '[Describe your idea here]',
    },
    general: {
      title: 'General feedback',
      message: 'Your feedback',
      messageHint: 'Anything you want to share',
      placeholder: '[Your feedback here]',
    },
    logs: {
      label: 'Share diagnostic logs',
      hint: 'A short technical record of what the app did and any errors. No names, notes, or list contents.',
      view: "View what's shared",
      previewTitle: "What's shared",
      previewLead:
        'This is the exact text attached to your email. Nothing leaves your device until you send it.',
    },
    body: {
      autoIncluded: 'Included automatically',
      envHeader: 'App & device',
      logHeader: 'Diagnostic log',
      logTruncatedNote:
        '(Your mail app could not attach the full log file, so a short excerpt is included above.)',
    },
    send: {
      action: 'Continue to email',
      note: 'This opens your email with everything filled in. You can review and edit before sending.',
      failed: "Couldn't open your email app. You can reach us at feedback@joshapproved.com.",
    },
  },
} as const;
