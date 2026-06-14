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
  },
} as const;
