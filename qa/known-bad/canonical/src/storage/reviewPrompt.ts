// KNOWN-BAD FIXTURE — do not "fix" this. See ../../../README.md.
//
// Trips: review-prompt/wired.
//
// This is the review-prompt module, synced and present. The fixture's App.tsx
// mounts <AppShell> WITHOUT the `review={…}` prop, so the shell never counts a
// session and the prompt can never fire — a module that ships in the binary and
// no user can ever see. That exact shape (module synced, nothing triggering it)
// is how tend and tally reached both stores with dead prompts, which is the
// defect the session-based rewrite of 2026-07-27 exists to make impossible.
//
// Only the surface the rule reads matters here; the real implementation lives
// in josh-approved-factory/templates/review-prompt/reviewPrompt.ts.

export const REVIEW_CONFIG = {
  promptAtSessions: [3, 15, 30],
};

export async function recordSessionStart(): Promise<boolean> {
  return false;
}

export async function markReviewPromptShown(): Promise<void> {}

export async function markReviewOpened(): Promise<void> {}
