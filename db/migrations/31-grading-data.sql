-- 31-grading-data.sql — District-wide gradebook fill (data completeness slice).
--
-- Owns ONLY grade_categories / grade_assignments / grade_scores rows. Never
-- modifies or deletes pre-existing rows (the 2 categories, 4 assignments and 37
-- scores that already exist in section 1 are left byte-for-byte alone).
--
-- Idempotent + deterministic: re-runs on every boot and inserts nothing new.
-- Every value is derived from existing ids/columns; no random(), no now(),
-- no CURRENT_DATE. Scores are gated by a stable arithmetic hash of
-- (assignment id, student id) so the exact same (assignment, student) pairs are
-- skipped on every run.
--
-- ---------------------------------------------------------------------------
-- WHO GETS GRADED (read this before changing anything)
-- ---------------------------------------------------------------------------
-- The gradebook routes (src/routes/grading.js rosterFor and
-- src/routes/grades.js rosterForSection) do NOT read section_roster. They derive
-- a section's roster as the first 30 Active students of the section's school,
-- windowed by a section-id offset. This slice therefore grades:
--
--     section_roster(section)  UNION  <that derived 30-student window>
--
-- so that (a) every genuinely rostered student carries grades, which is the
-- requirement, and (b) the score grid / final-grade posting actually see data.
-- Grading only section_roster would leave ~25 of each grid's 30 rows blank and
-- would make POST /grades/post post almost nobody. The derived window is
-- replicated here exactly as the routes compute it (same ORDER BY st.id, same
-- offset `(section_id * 7) % span`, same LIMIT 30, status 'Active'). If a route
-- ever switches to reading section_roster this UNION keeps working.
--
-- ---------------------------------------------------------------------------
-- VOLUME (target 126 categories / 350-420 assignments / 12k-16k scores)
--   * Categories : 3 per section. Sections with 0 (41 of 42) get Homework 30,
--                  Quiz 30, Test 40. Section 1 already has Tests 60 + Homework
--                  40 (100); it gets Quiz 0 so it also has exactly 3 and totals
--                  100. Total = 126.
--   * Assignments: 8 new for odd-id sections, 9 for even-id sections
--                  (4 Homework, 3 Quiz, 2 or 3 Test). 361 rows including the 4
--                  pre-existing -> inside 350-420.
--   * Scores     : every union-roster student x every assignment in their
--                  section; ~6% of pairs are deliberately left with no row at
--                  all. Of the rest ~82% numeric / ~12% M / ~6% X. ~15.3k rows.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1) CATEGORIES — exactly 3 per section, weights total 100.
-- ===========================================================================
-- Canonical set. A section "covers" a slot when an existing category's name
-- equals the canonical name or shares its first four letters (so a legacy
-- 'Tests' row already satisfies the 'Test' slot). Only uncovered slots are
-- inserted, and only enough of them to bring the section up to exactly 3
-- categories.
--
-- The weight of the LAST inserted category for a section is set to
-- `100 - (existing weight total) - (weights of the other new categories)` so
-- the section totals exactly 100 without ever editing an existing row. For the
-- 41 empty sections this reproduces 30/30/40 exactly; for section 1
-- (Tests 60 + Homework 40 = 100) it yields a single Quiz 0 row.
WITH canon AS (
    SELECT * FROM (VALUES
        ('Homework', 30::numeric, 1),
        ('Quiz',     30::numeric, 2),
        ('Test',     40::numeric, 3)
    ) AS c(name, canonical_weight, ord)
),
sec AS (
    SELECT s.id AS section_id,
           COALESCE((SELECT sum(gc.weight) FROM grade_categories gc
                      WHERE gc.section_id = s.id), 0) AS existing_weight,
           (SELECT count(*) FROM grade_categories gc
             WHERE gc.section_id = s.id) AS existing_count
    FROM sections s
),
-- Uncovered canonical slots, ranked; keep only as many as needed
-- (3 - existing_count), preferring Homework, then Quiz, then Test.
miss AS (
    SELECT sec.section_id,
           sec.existing_weight,
           canon.name,
           canon.canonical_weight,
           canon.ord,
           row_number() OVER (PARTITION BY sec.section_id ORDER BY canon.ord ASC) AS rn_asc
    FROM sec
    JOIN canon ON NOT EXISTS (
        SELECT 1 FROM grade_categories gc
        WHERE gc.section_id = sec.section_id
          AND left(lower(gc.name), 4) = left(lower(canon.name), 4)
    )
),
chosen AS (
    SELECT section_id, existing_weight, name, canonical_weight, ord,
           row_number() OVER (PARTITION BY section_id ORDER BY rn_asc DESC) AS rn_desc
    FROM miss
    WHERE rn_asc <= GREATEST(0, 3 - (SELECT existing_count FROM sec
                                      WHERE sec.section_id = miss.section_id))
),
weighted AS (
    SELECT section_id,
           name,
           CASE WHEN rn_desc = 1
                THEN GREATEST(0, 100 - existing_weight
                       - COALESCE((SELECT sum(canonical_weight) FROM chosen c2
                                    WHERE c2.section_id = chosen.section_id
                                      AND c2.rn_desc > 1), 0))
                ELSE canonical_weight
           END AS weight
    FROM chosen
)
INSERT INTO grade_categories (section_id, name, weight)
SELECT section_id, name, weight FROM weighted
ON CONFLICT (section_id, name) DO NOTHING;

-- ===========================================================================
-- 2) ASSIGNMENTS — 8 (odd section id) or 9 (even) new per section.
-- ===========================================================================
-- Name / category / points / due-on all come from the assignment index so the
-- same seed always produces the same rows. Published: 8 of every 9, 7 of every
-- 8 (index > 1 unpublished => ~20% left unpublished).
WITH cat AS (
    SELECT section_id, name, id
    FROM grade_categories
    WHERE name IN ('Homework', 'Quiz', 'Test')
),
plan AS (
    -- [slot index, category name, points, name template, week offset]
    SELECT * FROM (VALUES
        (1, 'Homework', 20::numeric, 'Homework 1',      1),
        (2, 'Homework', 20::numeric, 'Homework 2',      2),
        (3, 'Homework', 25::numeric, 'Homework 3',      3),
        (4, 'Homework', 10::numeric, 'Homework 4',      4),
        (5, 'Quiz',     25::numeric, 'Quiz: Chapter 1', 5),
        (6, 'Quiz',     25::numeric, 'Quiz: Chapter 2', 6),
        (7, 'Quiz',     20::numeric, 'Quiz: Chapter 3', 7),
        (8, 'Test',     50::numeric, 'Unit Test 1',     8),
        (9, 'Test',    100::numeric, 'Unit Test 2',     9)
    ) AS p(slot, cat_name, pts, aname, week_offset)
),
sec AS (
    SELECT s.id AS section_id,
           (SELECT t.starts_on FROM terms t WHERE t.is_current LIMIT 1) AS starts_on,
           -- Top up to 8 (odd id) or 9 (even) TOTAL assignments, counting any
           -- pre-existing rows in the section, so no section ends over 9.
           GREATEST(0,
               (CASE WHEN s.id % 2 = 0 THEN 9 ELSE 8 END)
               - (SELECT count(*) FROM grade_assignments a WHERE a.section_id = s.id)
           ) AS n_new
    FROM sections s
),
desired AS (
    SELECT sec.section_id, sec.starts_on, plan.slot, plan.cat_name,
           plan.pts, plan.aname, plan.week_offset
    FROM sec
    JOIN plan ON plan.slot <= sec.n_new
)INSERT INTO grade_assignments (section_id, category_id, name, points, due_on, published)
SELECT d.section_id,
       (SELECT c.id FROM cat c
         WHERE c.section_id = d.section_id AND c.name = d.cat_name LIMIT 1),
       d.aname,
       d.pts,
       (d.starts_on + (d.week_offset * 7)),            -- never past 2026-10-XXX
       (d.slot <= 7)                                   -- ~80% published
FROM desired d
WHERE d.starts_on IS NOT NULL
  AND NOT EXISTS (                                      -- idempotency
      SELECT 1 FROM grade_assignments a
      WHERE a.section_id = d.section_id AND a.name = d.aname
  );

-- ===========================================================================
-- 3) SCORES — union roster x every assignment, deterministic gaps and kinds.
-- ===========================================================================
-- Roster = section_roster UNION the routes' derived 30-student window.
WITH derived AS (
    SELECT s.id AS section_id, st.id AS student_id
    FROM sections s
    JOIN LATERAL (
        SELECT st.id
        FROM students st
        WHERE st.school_id = s.school_id
          AND st.status = 'Active'
        ORDER BY st.id
        OFFSET GREATEST(
            ((s.id * 7) % GREATEST(
                (SELECT count(*) FROM students st2
                  WHERE st2.school_id = s.school_id AND st2.status = 'Active') - 30 + 1,
                1)), 0)
        LIMIT 30
    ) st ON TRUE
),
union_roster AS (
    SELECT section_id, student_id FROM section_roster
    UNION
    SELECT section_id, student_id FROM derived
),
pairs AS (
    SELECT a.id          AS assignment_id,
           a.section_id,
           a.points      AS assignment_points,
           ur.student_id,
           -- Stable arithmetic hash of (assignment, student). Same on every run.
           ((a.id * 7919 + ur.student_id * 104729) % 100) AS h1,
           ((a.id * 1543  + ur.student_id * 6151)   % 100) AS h2
    FROM grade_assignments a
    JOIN union_roster ur ON ur.section_id = a.section_id
),
kinded AS (
    SELECT assignment_id,
           student_id,
           assignment_points,
           h1,
           h2,
           -- 6% skipped entirely (no row). Of the rest: 82% numeric,
           -- 12% missing 'M', 6% exempt 'X'.
           CASE
               WHEN h2 < 82 THEN 'NUM'
               WHEN h2 < 94 THEN 'M'
               ELSE 'X'
           END AS kind
    FROM pairs
    WHERE h1 >= 6
)
INSERT INTO grade_scores (assignment_id, student_id, code, points)
SELECT k.assignment_id,
       k.student_id,
       CASE k.kind WHEN 'M' THEN 'M' WHEN 'X' THEN 'X' ELSE NULL END,
       CASE k.kind
           WHEN 'NUM' THEN
               -- 55%..100% of max, integer-valued, deterministic in (h1, h2).
               round(k.assignment_points *
                     (55 + ((k.h1 * 7 + k.h2 * 13) % 46))::numeric / 100.0)
           ELSE NULL
       END
FROM kinded k
ON CONFLICT (assignment_id, student_id) DO NOTHING;
