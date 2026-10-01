# BUILD-REPORT — fake-sis (legacy reference SIS for data-migration demos)

A dense, old-fashioned school **Student Information System** built to sit *alongside* a newer
SIS as the **legacy source system** in migration demonstrations: extract from here, map, load
there, and adapt the mapping ad hoc as the new system's requirements move.

Express + EJS + PostgreSQL, plain JavaScript on Node 26, server-rendered. **No client-side
JavaScript, no bundler** — by design: a legacy system that behaves and looks like one.

**Scale:** 15 routers · **100 route handlers** · 63 EJS views · 20 migrations · 38 tables ·
**~42,000 rows** of synthetic district data.

---

## 1. Run it

```bash
cd ~/Projects/node/fake-sis
npm install          # first time only
npm start            # http://localhost:3000
```

`DATABASE_URL` lives in `.env` (PostgreSQL 16). Migrations in `db/migrations/*.sql` apply
automatically on boot, in filename order, inside one transaction, and are **idempotent** — every
seed is guarded, so restarting never duplicates rows. That is the property that makes the demo
repeatable: `npm start` twice and the row counts are identical.

**Sign in** (demo password for every account: `demo1234`): `admin` (Administrator),
`registrar` (Registrar), `teacher` (Teacher), plus 10 more — `h.benton`, `r.nader`, a nurse, a
fees clerk, a vice principal, one **inactive** account for the rejection path.

Access model: everything is public except **`/admin`** (Administrator), **`/fees`**
(Administrator|Registrar) and **`/discipline`** (any staff role). Those redirect to
`/auth/login?next=<page>` when signed out and render a styled 403 when the role is wrong. The
header nav hides modules the signed-in roles may not open.

---

## 2. Data inventory (what a migration would be extracting)

| Domain | Rows | Notes |
|---|---|---|
| students | 300 | grades K–12 across 3 schools; 15 `Withdrawn`, 10 mid-year entrants, 2 duplicate-name pairs, 8 NULL middle names, 5 NULL DOBs |
| enrollments | 900 | current term plus two prior years — longitudinal history |
| section_roster | 936 | all 42 sections covered; every student in ≥1 section |
| sections / courses / teachers | 42 / 20 / 12 | period, room, capacity, term |
| grade_categories | 126 | 3 per section, weights total exactly 100 |
| grade_assignments | 357 | ~8–10 per section, ~80% published |
| grade_scores | 15,215 | 12,496 numeric, 1,790 `M` (missing), 929 `X` (exempt) |
| attendance_daily | 20,204 | 22 school days (2026-09-01→09-30), P/T/A/E mix, 38 absence-heavy + 98 tardy-heavy students |
| final_grades | 41 | written by the app's own "post grades" action — the demo's live write path |
| student_contacts | 408 | every student covered; 3 deliberately missing a phone |
| student_alerts | 68 | medical, custody, academic, behaviour, transport |
| discipline_incidents / health_encounters / health_flags | 134 / 90 / 76 | spread across the term; 26 incidents not parent-notified |
| app_users / app_roles / user_roles | 13 / 4 / 14 | every role represented; one multi-role user |
| student_fees / fee_payments | 600 / 225 | $19,250 billed, $5,100 collected, $14,150 outstanding, 10 waivers |
| assessments / assessment_scores | 6 / 669 | benchmark windows across grade bands |
| announcements / announcement_recipients | 15 / 1,676 | audience targeting materialised per recipient, delivery tracked |

**Deliberate messiness** (the point of a migration fixture): withdrawn students with exit dates,
mid-year entries, duplicate names, NULLs in optional fields, missing score rows (~6% of
assignment×student pairs), gaps in attendance (~2%), partial payments, and inactive accounts.

---

## 3. Screens (all server-rendered, all working)

| Module | Route | What works |
|---|---|---|
| Start Page | `/` | district overview with live counts |
| Student Records | `/students`, `/students/:id` | criteria search (name/ID/grade/status), results grid, Student-360 (demographics, contacts, enrolment history, alerts), demographics edit |
| Enrollment | `/enrollment` | recent enrolments, registration with duplicate detection, enrol/withdraw writing enrolment events |
| Scheduling | `/scheduling` | course catalog, master schedule grid with clash detection, section rosters, student schedule + print, auto-assign |
| Attendance | `/attendance` | teacher week grid, office corrections, mass entry, absence letters |
| Grading | `/grading` | categories/weights, assignment setup, score grid (`.col-current` on the active column), missing/exempt codes, bulk fill, publish |
| Grades & Transcripts | `/grades` | posting from scores, GPA + snapshots, transcript, report card, corrections |
| Reports | `/reports` | four parameterised reports, column selection, CSV export, print views |
| Administration | `/admin` | school year/terms, grade codes, users, roles (nav visibility is enforced) |
| Communications | `/communications` | announcements, audience targeting, recipient materialisation, delivery log + CSV |
| Fees | `/fees` | catalog, bulk assignment, payments/waivers, balances report + CSV |
| Assessment | `/assessment` | score entry, per-school/grade summaries + CSV |
| Discipline & Health | `/discipline` | incidents, encounters, flags, per-student views |
| Teacher Workspace | `/teacher` | my classes, section standings, quick attendance save |
| Family Portal | `/portal` | student search, schedule, grades, attendance summary, contacts, alerts, print sheet |
| Auth | `/auth/login` | scrypt-hashed sessions, login/logout, `/auth/me` |

Visual language follows the reference capture corpus (`reference/captures/`,
`reference/captures-v1/`): navy two-tier header with control cluster, dark-blue section bars with
action buttons and carets, accordion setup rows, left rails, pill buttons, circular
conflict/scheduled status icons, student steppers, results bars, grouped table header bands,
dense 11px grids, print stylesheets. No JS means a few controls are deliberately inert and say so
on-page.

---

## 4. Demo script for a migration walkthrough

1. `npm start` → open http://localhost:3000. Note the density: every panel has data.
2. **Pick a source record**: `/students` → search `Alvarez` → open a student → read demographics,
   contacts, enrolment history and alerts. This is the "extract one entity with its satellites"
   shape.
3. **Show longitudinal history**: same student → enrolment history rows for the current term and
   two prior years.
4. **Show bulk grading data**: `/grading/scores?section=1` → the score grid with the active column
   highlighted, missing/exempt codes in the cells.
5. **Exercise the live write path**: on `/grades/post?section=1` press *Post final grades* — the
   app computes weighted percents (categories must total 100) and writes `final_grades`. Read it
   back on `/grades/transcript?student=<id>` and `/grades/gpa?student=<id>`.
6. **Attendance story**: `/attendance/grid?section=1&date=2026-09-30` (a day of data),
   `/attendance/office` (790 rows to correct), `/attendance/letters` (740 rows of students over
   the absence threshold).
7. **Messy-record cases for the mapper**: filter `/students` for withdrawn students, the two
   duplicate-name pairs, students with NULL DOB, and contacts with no phone.
8. **Role-gated surfaces**: browse `/admin` anonymously → redirected to login; sign in as
   `teacher` → `/admin` is 403 while `/teacher` works; sign in as `admin` → both work.
9. **Exports**: `/reports/roster?school=1&grade=9&format=csv`, `/fees/balances?format=csv`,
   `/assessment/summary?assessment=2&format=csv` — the "extract to file" path.
10. **Prove repeatability**: restart the server and re-run the row counts from §2 — identical.

---

## 5. Honest limitations

- No password reset, MFA, or session revocation beyond logout; demo credentials are shared.
- Role visibility drives the nav and three gated modules; per-route permissions beyond those three
  are not modelled.
- A few controls are inert by design (no JS): accordion headers, collapse carets, "fuzzy search",
  "keep group", print buttons that would need scripting. Each says so on-page.
- PDF generation is out of scope: printing uses browser print stylesheets, exports use CSV.
- Blended fidelity: the chrome follows PowerSchool/Aeries-era patterns while individual screens
  mimic whichever classic capture matched that screen type; a single-vendor match was not the goal.
- Notification delivery is modelled in the database only (no email transport).

## 6. Provenance

Built by parallel worker agents across four waves (12 module slices → auth/teacher/portal/
communications/fees/assessment → data population → visual fidelity), each slice owning one route
file, one view directory and one idempotent migration, with every slice verified by execution
(boot, curl, SQL) plus a coordinator pass. Run history, decisions (ADR-001…005), vet verdicts and
metrics live in `LOOP.md` and `registry.json`.
