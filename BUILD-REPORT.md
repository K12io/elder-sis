# BUILD-REPORT — fake-sis

Fake, old-fashioned school Student Information System (SIS) for synthetic demo data.
Express 4 + EJS + PostgreSQL, plain JavaScript on Node 26. Built by 12 module slices,
followed by a final QA pass and one targeted attendance fix.

This report is factual. It records what was verified in the final QA pass, what is a
deliberate stub, and what remains a known limitation.

---

## Module summary

| Module | Route prefix | Main screens | What works (verified 2026-09-30) | What is stubbed / limited |
|---|---|---|---|---|
| Home / shell | `/` | `home.ejs` | Landing page with links to every module; `content-type` and header nav render. | None. |
| Health | `/healthz` | (JSON) | Returns 200; used to confirm DB connectivity at boot. | None. |
| Students | `/students` | Roster list, student detail, quick search | List (300 students, 3 schools), filter by last name, detail page, quick search by name/State ID. | Detail edits persist only the fields the view posts; no admissions workflow. |
| Enrollment | `/enrollment` | Landing, new enrollment, confirm, register, withdraw | New-enrollment form writes `students` + `enrollments`; withdraw sets status. | `enrollment_events` rows are written but there is no UI that lists them (see Gaps). |
| Attendance | `/attendance` | Grid, office filter/correct, letters | Section grid rosters **exactly** the students in `section_roster` for the section; save upserts `attendance_daily` per student/section/date; office lists and corrects marks; mass apply; letters by absence threshold. | Mark-entry screen is text cells (code letters), not click-to-cycle. No bell-period scheduling. |
| Grading | `/grading` | Setup, scores, student, publish | Categories per section, assignments, score entry, bulk entry, publish to `final_grades`. | Only 2 seeded categories (see Gaps). |
| Grades | `/grades` | Landing, grade posting, GPA, transcript, corrections | Post final grades per section; GPA and transcript render for students with `final_grades`. | Corrections update grades; no audit trail screen beyond `grade_corrections` rows. |
| Scheduling | `/scheduling` | Landing, catalog, master, student schedule, section | Course catalog, section master grid, per-student schedule, assign/unassign with period-conflict guard, bulk auto-assign fills `section_roster`. | Capacity is advisory only; auto-assign is greedy, not an optimizer. |
| Reports | `/reports` | Landing, roster, attendance, transcript, contacts, saved reports | Roster/attendance/transcript/contacts render; `&format=csv` returns `text/csv`. | Saved reports store parameters only; no scheduler. |
| Admin | `/admin` | School year, codes, users, roles | School-year switching, attendance codes, app users and role assignment, role module visibility. | Role visibility is descriptive only (see Gaps). |
| Administration | `/administration` | Landing | Entry screen linking admin sub-areas. | Thin wrapper. |
| Discipline | `/discipline` | Incidents, health | Incident logging and health encounters/flags screens render and accept POSTs. | Seeded incident/health tables start empty; no reporting dashboard. |

---

## Verified data footprint (seeded)

| Table | Rows |
|---|---|
| students | 300 |
| schools | 3 |
| terms | 4 |
| sections | 42 |
| teachers | 12 |
| section_roster | 224 |
| enrollments | 300 |
| grade_scores | 37 |
| final_grades | 30 |
| app_users | 3 |
| attendance_daily | 0 (empty until marks are saved) |
| discipline_incidents | 0 (empty until logged) |
| health_encounters | 0 (empty until logged) |

---

## Run it from scratch

```bash
# 1. Install dependencies
cd /Users/timheckel/Projects/node/fake-sis
npm install

# 2. Provide a database URL (not printed here; see .env / your environment)
#    DATABASE_URL=postgres://user:pass@host:5432/fake_sis

# 3. Boot (migrations + seed run automatically, idempotently, on start)
npm start          # -> fake-sis listening on http://localhost:3000

# 4. Smoke check
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/healthz   # 200
```

Migrations live in `db/migrations/*.sql` and are applied in filename order on boot;
each is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-running is safe.

### Verify the attendance fix

```bash
# A section that HAS roster rows (42 here has 32) — count must match the DB
curl -s "http://localhost:3000/attendance/grid?section=42" | grep -o "Roster:</span>.*students"
psql "$DATABASE_URL" -c "SELECT count(*) FROM section_roster WHERE section_id=42;"

# A section with NO roster rows shows the pointer message
curl -s "http://localhost:3000/attendance/grid?section=1" | grep -o "No students assigned to this section[^<]*"
```

### Verify a report as CSV

```bash
curl -s -D - -o /dev/null "http://localhost:3000/reports/roster?school=1&grade=9&format=csv" | grep -i content-type
# Content-Type: text/csv; charset=utf-8
```

---

## QA pass — route sweep

Every listed route returned HTTP 200. Tested against a live server on port 3000.

| Route | Status |
|---|---|
| `/` | 200 |
| `/healthz` | 200 |
| `/students` | 200 |
| `/students?last=Alvarez` | 200 |
| `/students/1` | 200 |
| `/students/search?q=rivera` | 200 |
| `/enrollment` | 200 |
| `/enrollment/new` | 200 |
| `/attendance` | 200 |
| `/attendance/grid?section=42` | 200 |
| `/attendance/office` | 200 |
| `/attendance/letters` | 200 |
| `/grading` | 200 |
| `/grading/setup?section=1` | 200 |
| `/grading/scores?section=1` | 200 |
| `/grades` | 200 |
| `/grades/post?section=1` | 200 |
| `/grades/gpa?student=235` | 200 |
| `/grades/transcript?student=235` | 200 |
| `/scheduling` | 200 |
| `/scheduling/catalog` | 200 |
| `/scheduling/master` | 200 |
| `/scheduling/section?section=1` | 200 |
| `/scheduling/student?student=1` | 200 |
| `/reports` | 200 |
| `/reports/roster?school=1&grade=9` | 200 |
| `/reports/roster?school=1&grade=9&format=csv` | 200, `text/csv; charset=utf-8` |
| `/admin` | 200 |
| `/admin/school-year` | 200 |
| `/admin/codes` | 200 |
| `/admin/users` | 200 |
| `/admin/roles` | 200 |
| `/administration` | 200 |
| `/discipline` | 200 |
| `/discipline/incidents` | 200 |
| `/discipline/health` | 200 |

No non-200 responses. No defects found in the route sweep.

### Attendance save path (verified, then cleaned up)

- Section 42 grid rendered 32 student rows; `SELECT count(*) FROM section_roster WHERE section_id=42` returned 32.
- The 108 Active students of the same school that are **not** in `section_roster` were absent from the rendered grid (0 inputs each; exactly 32 distinct `code_<id>_` inputs).
- POSTing `section=42&date=2026-03-10&code_2_2026-03-10=A` returned 302 to `...&saved=1&n=1`.
- The row appeared in `attendance_daily` (student_id=2, section_id=42, on_date=2026-03-10, code=A).
- The probe row was then deleted; a follow-up count confirmed 0 remaining probe rows.

---

## Gaps — disposition

1. **No authentication/login anywhere.** Confirmed: no login, session, cookie, passport, or
   auth middleware exists in `src/app.js` or any route. Every page is open. This is the
   intended v1 design decision for a synthetic demo dataset — documented as an intentional
   limitation, not fixed.
2. **Role module-visibility in `/admin/roles` is descriptive only.** Confirmed by reading the
   rendered page: it states plainly "Module visibility is descriptive only. The header
   navigation is NOT driven by these checkboxes in this demo," and "This table is descriptive
   ... not enforced anywhere yet." Documented; not fixed.
3. **Grading ships few seeded categories.** Confirmed: only 2 seeded `grade_categories`
   rows — `Tests` (weight 60) and `Homework` (weight 40) — plus `grade_assignments` and
   `grade_scores`. The setup screen can add more. Documented.
4. **`enrollment_events` rows are written but have no UI listing.** Confirmed: the table is
   INSERTed from `src/routes/enrollment.js` (enroll and withdraw paths) but no route or view
   reads it back. Documented as a known limitation.
5. **Attendance roster approximation.** FIXED (see Part 1 / the attendance fix verification
   above). The grid now rosters exactly the students in `section_roster` for the section,
   ordered by last name, and shows "No students assigned to this section — assign them in
   Scheduling" when a section has no roster rows.
6. **Orphan `src/views/students/search.ejs` deleted.** Confirmed the `/students/search` route
   renders `students/index` and nothing rendered the orphan view. After deletion,
   `/students/search?q=rivera` still returns 200.

Additional honest note surfaced during QA (not in the original gap list): `attendance_daily`,
`discipline_incidents`, and `health_encounters` start **empty** — the write paths work, but no
seed rows exist for them, so office filters, discipline lists, and health lists are blank on a
fresh boot until a user posts data.

---

## Run metrics (honest)

- 12 module slices delivered (home/shell, students, enrollment, attendance, grading, grades,
  scheduling, reports, admin, administration, discipline, health).
- 1 final QA pass (this run): full route sweep, CSV content-type check, attendance-fix
  end-to-end probe.
- 1 fix delivered: attendance grid now uses real `section_roster` membership.
- 1 orphan file removed: `src/views/students/search.ejs`.
- Known limitations carried forward: 6 items in the Gaps section above.

---

## How to demo (click-through)

1. Open `http://localhost:3000/` — the home page links every module.
2. Go to **Students**, then **Find a student** (`/students/search?q=rivera`) and open a record.
3. Go to **Enrollment → New Enrollment**, enroll a student, land on the confirm screen.
4. Go to **Scheduling → Section** (pick section 42) and show the assigned roster (32 students).
5. Go to **Scheduling → Student** (e.g. student 1) and show the period-conflict guard by
   attempting a conflicting assignment.
6. Go to **Attendance**, pick section 42, and open the Week Grid — note the roster count (32)
   matches Scheduling. Type an `A` in a cell and **Save Week Attendance**.
7. Go to **Attendance → Office** and confirm the saved mark appears; correct it and see
   `updated_at` change.
8. Go to **Attendance → Letters** and generate letters at a threshold of 3 absences.
9. Go to **Grading**, pick a section, add a score, then **Grades → Post** and publish a final
   grade; open **Grades → Transcript** for that student.
10. Go to **Reports → Roster** with `&format=csv` in the URL to download a CSV, and finish in
    **Admin → Roles** to read the descriptive-only module-visibility note.

---

## Files changed by this QA pass

| File | Change |
|---|---|
| `src/routes/attendance.js` | `loadRoster` now reads from `section_roster` for the section, ordered by last name, instead of all Active students of the section's school. |
| `src/views/attendance/grid.ejs` | Empty-state message changed to "No students assigned to this section — assign them in Scheduling." |
| `src/views/students/search.ejs` | Deleted (orphan; route renders `students/index`). |
| `BUILD-REPORT.md` | This report (new). |

No other source, schema, migration, partial, or run-state file was modified.
