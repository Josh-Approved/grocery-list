// KNOWN-BAD FIXTURE — do not "fix" this. See ../../../README.md.
//
// This half is deliberately CORRECT: a current app shell that calls
// recordSessionStart and mounts <ReviewModal>. It is here so the fixture isolates
// the one thing that is wrong — App.tsx never passes the `review={…}` prop — and
// review-prompt/wired must still FAIL on that alone. A fixture missing all three
// halves would pass the gate for the wrong reason and hide a broken prop check.
import React, { useEffect, useState } from 'react';
import ReviewModal from '../components/ReviewModal';
import { recordSessionStart } from '../storage/reviewPrompt';

export function AppShell({ ready, children, review }: any) {
  const [showReview, setShowReview] = useState(false);
  useEffect(() => {
    if (!review || !ready) return;
    recordSessionStart().then(setShowReview);
  }, [ready]);
  return (
    <>
      {children}
      {review && (
        <ReviewModal
          visible={showReview}
          onDismiss={() => setShowReview(false)}
          appName={review.appName}
          iosAppStoreId={review.iosAppStoreId}
          androidPackageName={review.androidPackageName}
        />
      )}
    </>
  );
}
