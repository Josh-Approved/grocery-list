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
  },
  // Donation prompt (DonationModal). The button label reuses about.support.
  donate: {
    body: "{app} has no ads and no subscriptions — it's supported by the people who use it. If it's earned a place in your day, your support keeps it going.",
    supportA11y: 'Support this app, opens in your browser',
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
} as const;
