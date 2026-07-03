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

Judge each panel against these checks. The first six are layout; the rest are the
**UX interaction baseline** (canon studio-20260702-1) — the recurring on-device
basics, judged here from the affordances a still actually shows.

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
7. **Commit affordance on create/edit** — a create/edit screen must show a visible
   Save/Done control; the back arrow is never the only way off it (users read back
   as destructive). Flag a create/edit panel where the only exit is back.
8. **Action / info separation** — on a detail screen, interactive actions sit in a
   visually distinct region, separate from read-only information; one control reads
   as one predictable action. Flag a screen that overloads a state-changing action
   onto what looks like a reveal/expand, or scatters tap targets through read-only text.
9. **Existing before new** — where a flow references an entity the app already
   stores (a person, an account, a list), it offers "choose from existing" and does
   not force a duplicate. Flag a picker/entry panel that only offers "create new"
   for something the app clearly already has.
10. **Direct value entry + clean modals** — wherever a slider or stepper sets a
    value, the value itself reads as tappable for direct numeric entry. A modal has
    exactly one confirm affordance and no dead/greyed buttons that look tappable.
11. **Platform-metaphor controls** — navigation and transport controls match the
    platform's established metaphors (a media-player back = previous item /
    restart-then-previous, not "exit"). Flag a control whose icon promises one thing
    and is captioned/placed as another.

*Checks 7–11 also have non-visual dimensions a still can't show — whether an import
actually ends in a visible outcome, whether back discards a draft rather than saving
a blank, whether a value entry round-trips. Those ride the pre-ship review and the
on-device pass (canon § UX interaction baseline); here, flag only what the panel
makes visible.*

For each finding emit one object:
```json
{ "cell": "<cell-label>", "screen": "<screen>", "check": "<check name>",
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
