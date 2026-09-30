# WAVE IN FLIGHT — do not act on these slices

## Active workers

- `qa-final` (flash-fleet) — final QA pass: run-wide verification, gap walk, orphan view
  deletion, `BUILD-REPORT.md`. Owns: src/routes/attendance.js (gap fix), BUILD-REPORT.md,
  deletion of src/views/students/search.ejs.

## Rules while this list is non-empty

- Do NOT verify, grade, or write verdicts for the slices listed above — files are mid-write.
- Do NOT dispatch replacements.
- You MAY verify slices NOT listed, or record a no-op tick. That is a complete tick.

## Clear this file when the wave has finished
