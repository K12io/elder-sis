# Tick 12 — S4 missing views fixed + wave-2 closeout

Date: 2026-09-30
Verifier: coordinator (main session). Jev/codemode classifier UNAVAILABLE in this
session (consistent with ultra-6A) — gate carried by execution evidence + direct SQL,
recorded honestly, not a classifier score.

## Chunk executed

Tick 11's verification found S4 (scheduling) INCOMPLETE: 4 of 10 routes 500 with
`Failed to lookup view "scheduling/catalog|master|student|section"` — only
`views/scheduling/index.ejs` existed. This tick supplied the missing views:

| View | Locals consumed | Notes |
|------|-----------------|-------|
| `catalog.ejs` | `courses`, `editing` | catalog table + add/edit form (POST /scheduling/catalog) |
| `master.ejs` | `schools, schoolId, periods, teachers, sections, teacherClash, roomClash` | periods × teachers grid, teacher + room clash highlighting |
| `student.ejs` | `student, schedule, totalCredits, sections, periods, msg, err` | schedule table, period grid, assign form, print block |
| `section.ejs` | `section, roster, msg, err` | roster table, unassign, bulk-assign-by-grade form |

## Verification (boot on :3000, all live)

Route sweep after the views landed — every previously-500 route now 200:

```
200  /scheduling
200  /scheduling/catalog
200  /scheduling/master
200  /scheduling/master?school=2
200  /scheduling/student?student=1
200  /scheduling/section?section=1
```

Full-module regression sweep (same boot): `/`, `/students`, `/attendance`,
`/attendance/office`, `/attendance/letters`, `/grading`, `/grades`, `/reports`,
`/reports/roster?status=Active`, `/admin`, `/administration`, `/discipline` — all 200.

Write paths exercised over HTTP:

| Action | Result |
|--------|--------|
| POST /scheduling/catalog (add) | 302 `msg=Course added: Probe Course Tick12.` |
| POST /scheduling/catalog (duplicate) | 302 `err=A course with that name already exists.` |
| POST /scheduling/catalog (blank name) | 302 `err=Course name is required.` |
| POST /scheduling/assign (student 1 → section 1, period 1) | 302 `msg=Assigned Algebra I (ALGEBRAI-001)`; roster row inserted (SQL-confirmed) |
| POST /scheduling/assign (section 4, also period 1) | 302 `err=CONFLICT: student already has Algebra I in period 1; cannot add Geometry.` |
| POST /scheduling/bulk (grade 0 into a high-school section) | 302 `msg=Bulk assign grade 0: 0 added, 0 skipped` |
| POST /scheduling/unassign | 302 `msg=Student removed from roster.` (row deleted) |

All probe rows removed: probe course deleted (SQL-confirmed 1 row), probe roster row
removed via the app's own unassign. DB returned to pure seeded state:
`courses=20, section_roster=0`.

## Idempotency

Full-app restart was **blocked** by a concurrent, in-flight writer on S7's file
(see below), so migration idempotency was proven directly against `src/db.js`
(which imports no routes):

```
before applyDb #1: {courses:20, roster:0, sections:42, students:300, saved:2, dcodes:7}
after  applyDb #1: {courses:20, roster:0, sections:42, students:300, saved:2, dcodes:7}
after  applyDb #2: {courses:20, roster:0, sections:42, students:300, saved:2, dcodes:7}
```

`applyDb()` twice: every seed count unchanged; `section_roster` persists. Migration 14
guards hold.

## Collision note (recorded, not fought)

`master.ejs` was authored by this tick then **overwritten by a concurrent writer** at
08:56:22; the surviving version was complete and good quality but referenced an
undefined `err` local (line 5), which 500'd the route *through* the route's `safe()`
wrapper (EJS RuntimeError on an undefined identifier is not caught the way a missing
view was — it reached Express's default handler). Minimal surgical fix applied:
guard the reference (`typeof err !== 'undefined'`), matching the pattern already used in
`student.ejs`/`section.ejs`. No content fight, no rewrite of the other writer's work.

Credit for `master.ejs` body: the concurrent writer, not this tick. Recorded straight.

## Blocker raised — S7 grades.js mid-write, app will not boot

At 08:56:54 a worker began landing the S7 (Grades & Transcripts) implementation as
`src/routes/grades.js` (the tick-11 stub was 9 lines; it grew to 659 → 561 lines).
It carries a **wrong import**: `import { pool, query } from "./db.js"` (should be
`../db.js`). `src/routes/db.js` does not exist, so `node src/app.js` fails at ESM link
time with `ERR_MODULE_NOT_FOUND` and **the entire app cannot boot** — every route,
not just S7.

The file is S7's, not this tick's; per the shared-checkout rule the coordinator does not
edit another slice's file, and the writer was still actively changing it (hash changed
at t+25s while polling). Left untouched. This is a blocker for the run: S7 must land a
correct import (or the file must be reverted) before any further execution verification
is possible.

## Bottom line

- **S4: fixed and verified — closes.** All 6 routes 200, all write paths proven, idempotency proven.
- **S8, S10: verified PASS in tick 11 — close.**
- **S7: blocked** (app-boot-breaking import, file still in flight).
- First-pass vet this tick: S4 is a rework of a tick-11 failure (not a first pass). Wave-2
  first-pass remains 0/4 as dispatched.
