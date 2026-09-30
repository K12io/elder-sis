# LOOP.md — long-horizon run: build the fake SIS

> **This file is the run's living memory.** It evolves every tick: the plan refines,
> decisions get recorded, the changelog grows. `registry.json` (same directory) is the
> machine-readable status truth for individual work items. If the two ever disagree on
> status, **registry.json wins** and this file gets corrected.

- **Goal:** Build a fake, old-fashioned SIS ("a fake PowerSchool") with working core-module
  screens whose UI matches the reference captures in the Vera SIS UI research library
  (<https://vera-sis-ui-research.zarathustra7.chatgpt.site>). Traditional behavior: server
  rendered pages, forms, data tables, tabs — working create/read/update against seeded
  fake district data. No students are real; the data is synthetic from the start.
- **Run protocol:** the `/long-run` prompt template (`~/.pi/agent/prompts/long-run.md`).
  One bounded chunk per tick; orchestration and the Jev vet loop follow the rules in
  `~/.pi/agent/prompts/ultra.md`.
- **Status:** OPEN · **Tick:** 0 (see registry.json)

## Reference corpus (harvested facts)

- `reference/catalog-data.js` is a local copy of the library's asset catalog:
  **8,195 assets**, dictionary-encoded (`tables` = per-column value dicts, `rows` =
  index arrays). Each asset: `vendor, module, canonical_module, submodule, title,
  product_edition, source_date, capture_type, source_url, width, height, notes,
  surface_type`, plus `thumbnail`/`path` (WEBP on the site) and `source_path` (PNG).
- Image URLs resolve under `https://vera-sis-ui-research.zarathustra7.chatgpt.site/<path>`.
- Density by canonical module (top): grading 1593, scheduling 1521, attendance 611,
  student-records 589, grades-and-transcripts 544, communications 519, health 338,
  administration 338, discipline 317, reporting 316.
- "Old-fashioned / traditional" style anchors: PowerSchool (177 assets), Aeries (306),
  Skyward (207), Synergy (2260), Focus (3737). Prefer these over Aspen's modern styling
  when a screen's look must read as "classic SIS".
- The library's `UI-SURFACE-MAP.html` defines the 9 canonical workflows — those became
  the work items in `registry.json` (S0–S10 + QA).

## Stack decision

- **Status: PROPOSED (S0 decides and records the final ADR here).**
- Proposal: **Express + EJS (server-rendered) + SQLite via better-sqlite3**, no bundler.
  Rationale: "traditional" naturally = server-rendered forms/tables; zero build step is
  robust under many parallel agents; per-module route files minimize cross-slice file
  conflicts; seeding synthetic district data is trivial.
- Alternatives (operator may override at any tick): Next.js + SQLite; Vite React SPA +
  Express API.

## Work queue

Mirrors `registry.json` — ids are stable, details move there. In-flight items must have
disjoint `files` lists or run in worktrees (ultra rule 1).

| ID | Slice | Acceptance criteria (what "done" means) |
|----|-------|------------------------------------------|
| S0 | Bootstrap | Stack decision recorded here as ADR; app boots (`npm start` → 200); design-system CSS extracted from ~12 PowerSchool/Aeries captures into `public/css/app.css`; seed DB schema + synthetic district (≈300 students, 30 courses, 2 terms) |
| S1 | Shell + nav | Header/nav/tabs/footer on every page; nav reaches all implemented modules; classic styling throughout |
| S2 | Student records | Search (name/ID/grade) → results table → student 360 page with demographics, contacts, enrollment history, alert banner; edits save |
| S3 | Enrollment | Registration form → duplicate check → admit/enroll writes enrollment history; withdraw works |
| S4 | Scheduling | Course catalog + section list; assign a student to sections with visible conflict detection; student schedule print view |
| S5 | Attendance | Teacher grid (students × day) with code entry; office correction screen; mass entry by reason; persisted daily |
| S6 | Grading | Assignment + category/weight setup; score grid (students × assignments) with missing/exempt codes and bulk fill; publish flag |
| S7 | Grades & transcripts | Final-grade posting from assignment averages; GPA computed; transcript + report-card preview (print stylesheet) |
| S8 | Reporting | At least 3 parameterized reports (roster, attendance summary, transcript batch) with column selection, CSV export, print view |
| S9 | Administration | School year/terms, grade levels, attendance + grade codes, users and role matrix (role gates nav visibility) |
| S10 | Stretch | Discipline incidents + health encounters lists with create forms |
| QA | Final pass | Every claimed screen renders with fresh seed data; writes persist; `BUILD-REPORT.md` lists each screen with a test procedure; Jev triage on the full report |

## Tick protocol (summary — the authoritative version is /long-run)

1. Read `registry.json` + this file. Pick the next ready item (deps done, not blocked).
2. Execute ONE chunk sized to the tick (a screen, a sub-flow, or a review pass).
   Orchestrate per ultra rules; workers self-vet with Jev; coordinator batch-triages.
3. Update `registry.json` (status, vet verdicts, evidence paths) and **append** one
   changelog entry below. Never rewrite changelog history.
4. End-of-tick: if all items done → write `BUILD-REPORT.md`, set this file to CLOSED,
   cancel the loop schedule. If a tick made no progress twice on the same item → mark
   blocked, move on, flag in the report.

## Jev gate config (from ultra rule 6)

- Worker self-vet questions: `complete`, `on_task` — both ≥ 0.8 to report first-pass.
- Coordinator triage questions: `matches_evidence`, `ready_to_ship` — both ≥ 0.85 to
  accept; below → one retry with the false answer as the revision directive; then escalate.
- Metrics first-pass rate is tracked in registry.json — trend it in the changelog.

## Open questions for the operator

1. Stack: accept the Express + EJS + SQLite proposal? (S0 records the ADR.)
2. Scope cut line: is S10 (discipline/health) in or out for v1?
3. Fidelity bar: match ONE vendor's look (PowerSchool classic) as the primary chrome, or
   blend per-module ("best-looking module UI wins")? Current plan assumes PowerSchool
   classic as the chrome, with per-module UI matched to the densest classic source.

## Changelog (append-only)

- 2026-09-30 · tick 0 (setup, by main session) · Research complete: corpus catalog
  (8,195 assets) downloaded to reference/catalog-data.js; surface-map workflows turned
  into registry items S0–S10+QA; stack proposed. Loop protocol set (/long-run).
  Statuses: all queued. No code written yet.