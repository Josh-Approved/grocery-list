<!-- Synced per app by `sync.mjs qa` to qa/review-rubric.md. The fixed rubric for
the ONE bounded reviewer pass per release (uplevel/10-device-quality-net.md §5).
This is the ONLY place an AI looks at the device matrix — one downscaled mega
contact sheet, one pass, no follow-up loops, no full-res reads. Everything else
in the net is deterministic. -->

# Cross-device contact-sheet review — fixed rubric

You are reviewing **one** downscaled contact sheet showing every device cell ×
key screen from a full matrix run (`qa/qa-review-request.json` names the sheet,
the cells, and the screens). Make **one** pass. Do not ask for more images, do
not request full-resolution crops, do not loop. Write findings to
`qa/qa-triage.json` under `reviewerPass` (append; don't clobber other keys).

Judge each panel against these six checks only:

1. **Clipping / truncation** — text or controls cut off at an edge, ellipsized
   labels that shouldn't be, a title that runs under the status bar or notch.
2. **Overlap** — system chrome over content (the classic: Pixel-tablet dock or
   Android nav bar over a corner FAB/button), modals mis-aligned, layers fighting.
3. **Touch-target sanity** — primary actions that look smaller than ~44pt/48dp,
   or crowded so they'd be hard to hit. Eyeball, don't measure.
4. **Empty states** — a screen that should have content rendering blank or with
   a raw placeholder; a seeded list that didn't seed.
5. **Dark-mode contrast** — in `*-dark-*` cells, text or icons that wash out
   against the background; hairlines that vanish; an element stuck in light theme.
6. **Large-font layout** — in `*-f1.3-*` cells, broken wrapping, overlapping rows,
   a button whose label overflows its box.

For each finding emit one object:
```json
{ "cell": "<cell-label>", "screen": "<screen>", "check": "<1-6 name>",
  "severity": "blocker | major | minor",
  "summary": "<one sentence, what + where>" }
```

Rules of judgement:
- **A difference from iPhone is not automatically a defect.** Tablets get more
  whitespace; that's correct (canon § Cross-platform layout — one bounded 640px
  column). Only flag what a careful user would call broken.
- **Don't re-flag visual-regression diffs** — `qa/qa-triage.json → visualReg`
  already lists pixel changes vs baseline. Your job is *new* layout problems the
  baseline can't catch (a first-ever device, an intended change that's also ugly).
- **Default to NOT flagging** when unsure at this resolution. The deterministic
  layers (Tier-2 assertions, visual-reg) catch the measurable; you catch the
  obvious-to-a-human. False alarms cost Josh's time — be a high bar.
- If nothing is wrong, say so in one line. Empty `reviewerPass.findings: []` is a
  perfectly good result.
