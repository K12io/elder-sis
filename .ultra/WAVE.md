# WAVE IN FLIGHT — do not act on these slices

## Active workers (wave 3 — build-out)

- `F1` auth — flash-fleet. Files: src/middleware/auth.js, src/routes/auth.js, src/views/auth/, db/migrations/18-auth.sql
- `F2` teacher workspace — free-worker. Files: src/routes/teacher.js, src/views/teacher/
- `F3` portal — flash-fleet (re-dispatch after a free-lane 429). Files: src/routes/portal.js, src/views/portal/
- `F4` communications — free-nemotron. Files: src/routes/communications.js, src/views/communications/, db/migrations/20-communications.sql
- `F5` fees — flash-fleet (re-dispatch after a free-lane 429). Files: src/routes/fees.js, src/views/fees/, db/migrations/21-fees.sql
- `F6` assessment — flash-fleet. Files: src/routes/assessment.js, src/views/assessment/, db/migrations/22-assessment.sql

## Rules while this list is non-empty
- Do NOT verify, grade, or write verdicts for the slices listed — files are mid-write.
- Do NOT dispatch replacements. Do NOT write their files yourself.
- You MAY verify slices NOT listed, or record a no-op tick. That is a complete tick.

## Clear this file when the wave has finished
