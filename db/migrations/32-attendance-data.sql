-- 32-attendance-data.sql — a term's worth of believable attendance history
-- (legacy side of the data-migration demo).
--
-- Owns ONLY rows in attendance_daily. This file re-runs on every boot inside the
-- schema transaction and must be idempotent AND deterministic:
--   * On conflict (student_id, section_id, on_date) we DO NOTHING, so a second
--     boot inserts nothing and never modifies a row a human may have edited.
--   * Every value is derived from existing ids/columns and a fixed demo "today"
--     (2026-09-30). No random(), no now()/CURRENT_DATE, no clock dependence.
--
-- Reads (never writes): section_roster, sections, terms, attendance_codes,
-- students. Nothing else is touched.
--
-- Strategy
--   * School days: Monday..Friday from the current term's starts_on through the
--     demo date 2026-09-30 (term runs 2026-09-01..2026-12-18) — the first ~22
--     school days of the term.
--   * For each school day x each section x each student rostered in that section,
--     one row whose code comes from a stable hash of (student_id, section_id,
--     day_idx) with baseline mix ~90% P / ~5% T / ~3% A / ~2% E.
--   * Targeted structure so reports have something to find:
--       - 12 absence-heavy students: extra A replacing P on every 3rd/4th school
--         day (5-9 A each, scattered across the term);
--       - 6 tardy-heavy students: extra T replacing P (~4-7 T each);
--       - 3 students with a 2-3 day consecutive E (excused) run;
--       - ~2% of (student, section, day) combinations deliberately omitted (a gap
--         a migration would flag). 2026-09-30 is forced complete so "today"
--         screens are never empty.
--
-- Volume knobs: DEMO_TODAY (the CTE literal), GAP_MOD (skip when h_gap%100 < 2),
-- the baseline thresholds 900/950/980/1000, and the cohort slice moduli below.

-- ---------------------------------------------------------------------------
-- Deterministic integer pseudo-hash in [0, 1000). Multiplicative mix then mod;
-- integer-only so the same bytes come out on every run and platform.
-- ---------------------------------------------------------------------------
WITH RECURSIVE
term AS (
    SELECT id, starts_on
      FROM terms
     WHERE is_current
     ORDER BY id
     LIMIT 1
),
days AS (
    -- Monday..Friday school days from term start through the demo date.
    SELECT gs::date AS on_date,
           row_number() OVER (ORDER BY gs) - 1 AS day_idx,
           count(*) OVER () AS day_count
      FROM generate_series(
             (SELECT starts_on FROM term),
             DATE '2026-09-30',
             INTERVAL '1 day'
           ) AS gs
     WHERE extract(isodow FROM gs) BETWEEN 1 AND 5
),
students_ranked AS (
    -- Every student, ranked by id: the stable basis for cohort selection.
    SELECT st.id AS student_id,
           row_number() OVER (ORDER BY st.id) AS srank
      FROM students st
),
-- Absence-heavy cohort: exactly 12 students (ranks 1,26,51,... over ~300).
absence_heavy AS (
    SELECT student_id, srank FROM students_ranked WHERE (srank - 1) % 25 = 0
),
-- Tardy-heavy cohort: exactly 6 students, offset so they do not overlap.
tardy_heavy AS (
    SELECT student_id, srank FROM students_ranked WHERE (srank - 1) % 50 = 12
),
-- Excused-run cohort: exactly 3 students, offset again.
excused_run AS (
    SELECT student_id, srank FROM students_ranked WHERE (srank - 1) % 100 = 19
),
primary_section AS (
    -- Each student's lowest-id rostered section. The heavy/run overrides apply
    -- ONLY there, so a student in 3 sections gets ~7 absences, not ~21.
    SELECT student_id, min(section_id) AS section_id
      FROM section_roster
     GROUP BY student_id
),
grid AS (
    SELECT r.student_id,
           r.section_id,
           (ps.section_id = r.section_id) AS is_primary_section,
           d.on_date,
           d.day_idx,
           d.day_count,
           -- baseline code selector, in [0, 1000)
           (((r.student_id * 7919 + r.section_id * 104729 + d.day_idx * 1299709) % 1000)
             + 1000) % 1000 AS h,
           -- independent selector for the ~2% gap holes
           (((r.student_id * 2654435761::bigint + r.section_id * 40503
              + d.day_idx * 6151) % 1000) + 1000) % 1000 AS h_gap
      FROM section_roster r
      JOIN primary_section ps ON ps.student_id = r.student_id
      CROSS JOIN days d
),
scored AS (
    SELECT g.student_id,
           g.section_id,
           g.on_date,
           g.day_idx,
           g.h,
           g.h_gap,
           (ah.student_id IS NOT NULL) AS in_absence_cohort,
           (th.student_id IS NOT NULL) AS in_tardy_cohort,
           (er.student_id IS NOT NULL) AS in_excused_cohort,
           -- Overrides fire only in the student's primary section; elsewhere the
           -- heavy student's baseline A/T is suppressed to P so their term total
           -- stays in the intended 5-9 / 4-7 band instead of multiplying across
           -- sections.
           (ah.student_id IS NOT NULL AND g.is_primary_section) AS is_absence_heavy,
           (th.student_id IS NOT NULL AND g.is_primary_section) AS is_tardy_heavy,
           (er.student_id IS NOT NULL AND g.is_primary_section) AS is_excused_run,
           -- stable per-student offsets for the excused run's start day
           CASE WHEN er.student_id IS NOT NULL
                THEN (g.student_id * 15401) % GREATEST(g.day_count - 2, 1)
                ELSE NULL END AS e_run_start
      FROM grid g
      LEFT JOIN absence_heavy ah ON ah.student_id = g.student_id
      LEFT JOIN tardy_heavy   th ON th.student_id = g.student_id
      LEFT JOIN excused_run   er ON er.student_id = g.student_id
),
coded AS (
    SELECT student_id,
           section_id,
           on_date,
           h_gap,
           CASE
             -- Excused cohort: 2-3 consecutive E days, starting at a fixed
             -- per-student offset; this wins over every other rule.
             WHEN is_excused_run
                  AND day_idx >= e_run_start
                  AND day_idx < e_run_start + (2 + (student_id % 2))
               THEN 'E'
             -- Absence-heavy: A replaces the baseline on every 3rd school day
             -- (some students every 4th) -> 5-9 scattered absences.
             WHEN is_absence_heavy
                  AND (day_idx + (student_id % 2)) % (3 + (student_id % 2)) = 0
               THEN 'A'
             -- Tardy-heavy: same idea, ~4-7 scattered tardies.
             WHEN is_tardy_heavy
                  AND (day_idx + (student_id % 3)) % (4 + (student_id % 2)) = 0
               THEN 'T'
             -- Heavy students outside their primary section: no baseline A/T, so
             -- the term totals stay in the intended band.
             WHEN (in_absence_cohort OR in_tardy_cohort)
                  AND (h >= 900 AND h < 980)
               THEN 'P'
             -- Baseline mix ~90% P / ~5% T / ~3% A / ~2% E.
             WHEN h < 900 THEN 'P'
             WHEN h < 950 THEN 'T'
             WHEN h < 980 THEN 'A'
             ELSE 'E'
           END AS code
      FROM scored
)
INSERT INTO attendance_daily (student_id, section_id, on_date, code)
SELECT c.student_id,
       c.section_id,
       c.on_date,
       c.code
  FROM coded c
 WHERE EXISTS (SELECT 1 FROM attendance_codes ac WHERE ac.code = c.code)
   -- Force the most recent school day complete so "today" views are non-empty;
   -- otherwise drop ~2% of combinations (h_gap in [0,20)) as migration gaps.
   AND (c.on_date = DATE '2026-09-30' OR c.h_gap >= 20)
ON CONFLICT (student_id, section_id, on_date) DO NOTHING;
