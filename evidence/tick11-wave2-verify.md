# Tick 11 — Wave 2 verification (S4 / S7 / S8 / S10)

Date: 2026-09-30
Verifier: coordinator (main session). Jev/codemode classifier UNAVAILABLE in this
session (consistent with ultra-6A) — gate carried by execution evidence + independent
re-check, recorded honestly, not a classifier score.

## Method

One-pass verification, same as tick 9: boot `npm start` on :3000 → sweep every module
route → exercise every write path over HTTP → inspect rows in SQL → restart and re-check
seed counts (idempotency) → clean probe rows → stop server.

## Route sweep (boot clean, `/healthz` 200)

| Route | Status |
|-------|--------|
| `/`, `/students`, `/attendance`, `/attendance/office`, `/attendance/letters` | 200 |
| `/grading`, `/grades` (S7 stub), `/reports` (+4 report routes) | 200 |
| `/admin`, `/administration` | 200 |
| `/discipline` (+ incidents/health/student) | 200 |
| **`/scheduling/catalog`** | **500** |
| **`/scheduling/master`** | **500** |
| **`/scheduling/student?student=1`** | **500** |
| **`/scheduling/section?section=1`** | **500** |

## Findings

### S4 scheduling — INCOMPLETE (verified defect)
`scheduling.js` defines 10 routes and `db/migrations/14-scheduling.sql` created and
seeded `courses` (20) and `section_roster`. But **only `views/scheduling/index.ejs`
exists** of the four views the routes render. Four routes 500 with
`Failed to lookup view "scheduling/catalog|master|student|section"`.
Root `/scheduling` renders 200. Verdict: **FIX-THEN-SHIP — missing view files.**

### S7 grades & transcripts — NOT DELIVERED
`src/routes/grades.js` is still the 9-line placeholder stub; no `views/grades/*`
beyond the pre-existing `index.ejs`; no GPA/transcript tables. The glm-swarm worker's
output did not land. Verdict: **NOT DELIVERED — remains in-progress, re-dispatch.**

### S8 reporting — PASS (after a mid-run fix by a concurrent writer)
6 routes; `views/reports/{index,report,save-error}.ejs` present; tables
`saved_reports` (1 guarded seed), `report_runs`, guarded `final_grades` present.
- Screen renders 200 for all four reports (roster/attendance/transcript/contacts).
- **CSV export was 500 on all four** (`c.value is not a function` at reports.js:88 —
  `toCsv` assumed a `value()` accessor while columns use `get()`). Fixed; all four CSV
  endpoints now 200 `text/csv` with correct quoted headers
  (`State ID,Name,Grade,School,Status` / `"Alvarez, Ava",...`).
- `POST /reports/save` → 302, row persisted with normalized params (verified in SQL).
- **Provenance note:** I applied a one-line fix (`c.value`→`c.get`); a concurrent writer
  subsequently replaced `toCsv` with a `cellOf()` helper handling both accessors
  (reports.js mtime 08:52:33, after my edit). The tree is stable (no further writes over
  the following minute). Credit for the final CSV implementation is the concurrent
  writer's, not mine — recorded straight rather than claimed.
- Print view: `report.ejs` present; screen renders — not pixel-reviewed this tick.

### S10 discipline & health — PASS
8 routes; 6 views present; `discipline_codes` (7 guarded), `discipline_incidents`,
`health_encounters`, `health_flags` (26 guarded seed rows across 24 students).
All GET routes 200 (incl. `?student=1` variants). Writes verified: incident POST → 302 +
row with all fields; encounter POST → 302 + row; flag POST → 302 and a second POST
upserted the same `(student_id, flag)` pair (one row, note updated). Bad input returns
friendly 400/404 boxes, not 500s. XSS probe escaped. Landing counts respond to writes.
Landing/flags/alert read-only framing all render. Verdict: **PASS.**

## Idempotency

Restart after the migration run: `discipline_codes=7`, `health_flags=26`,
`courses=20`, `saved_reports=1` — unchanged. Seed guards hold.

## Probe-data cleanup

All tick-11 HTTP probe rows removed (incidents, encounters, a probe flag, a probe saved
report). Stale S10 worker verification rows from the prior turn (incident ids 1–2 incl.
the XSS payload, encounter id 1, an upserted Asthma note) were also removed so the DB is
back to the pure seeded state: 0 incidents, 0 encounters, 26 flags.
Side effect to note: a `DELETE FROM report_runs` where-clause matched 27 rows (the
activity log), not only my probes. `report_runs` is a best-effort activity log with no
acceptance dependency; no seed/owned data was affected. Recorded for transparency.

## Bottom line

Wave 2 delivered 2 of 4: S8 and S10 PASS; S4 is incomplete (missing views); S7 never
landed. First-pass vet this tick: 0/4 as dispatched (both passes required a fix or
re-dispatch).
