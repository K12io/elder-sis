-- 30-rosters.sql — Section rosters (data completeness slice).
-- Owns ONLY section roster rows. Idempotent and deterministic: re-runs on every
-- boot without creating duplicates, never deletes or modifies existing rows.
--
-- Strategy
--   * Course -> grade-fit mapping is derived from each section's course_name and
--     mirrors the catalog grade_levels in 14-scheduling.sql (e.g. 'Biology' =
--     9-10, 'Grade 3 Core' = 3). Narrow, course-specific bands keep demand inside
--     section capacity so pass 2 has open seats to complete the roster.
--   * Every value comes from existing ids/columns; assigned_on is the current
--     term's starts_on (not CURRENT_DATE / now()), so rows are stable across runs.
--   * Pass 1 (round-robin): for each course, eligible students of the section's
--     OWN school are dealt across that course's sections in ascending student-id
--     order, so rosters spread evenly instead of the same low-id students landing
--     in every section. Each student takes a course at most once. Seats are
--     capped at the section's remaining capacity.
--   * Pass 2 (top-up): students still short of 2 sections are spread one-for-one
--     across their own school's open seats (neediest/lowest id first), never
--     exceeding capacity. Rounds 3-4 are a last-resort coverage net (see below).
--   * ON CONFLICT DO NOTHING guards unique(section_id, student_id); a second run
--     inserts nothing.

-- ---------------------------------------------------------------------------
-- Pass 1: deal eligible students across each course's sections round-robin,
-- deterministic by student id, capped by the section's open seat count.
-- ---------------------------------------------------------------------------
INSERT INTO section_roster (section_id, student_id, assigned_on)
SELECT cand.section_id,
       cand.student_id,
       (SELECT t.starts_on FROM terms t WHERE t.is_current LIMIT 1)
FROM (
    SELECT s.id AS section_id,
           st.id AS student_id,
           row_number() OVER (PARTITION BY s.id ORDER BY st.id) AS seat_rank
    FROM students st
    JOIN sections s
      ON s.school_id = st.school_id
    JOIN (VALUES
        ('Algebra I',      9,  9),
        ('Geometry',       9, 11),
        ('Algebra II',    10, 12),
        ('Biology',        9, 10),
        ('Chemistry',     10, 12),
        ('Physics',       11, 12),
        ('English 9',      9,  9),
        ('English 10',    10, 10),
        ('World History',  9, 10),
        ('U.S. History',  11, 11),
        ('Spanish I',      9, 10),
        ('Band',           9, 12),
        ('Math 7',         7,  7),
        ('Life Science',   7,  8),
        ('English 7',      7,  7),
        ('PE 7/8',         6,  8),
        ('Grade 3 Core',   3,  3),
        ('Grade 4 Core',   4,  4),
        ('Grade 5 Core',   5,  5),
        ('Music',          0,  5)
    ) AS band(course_name, lo, hi)
      ON band.course_name = s.course_name
    -- Section's rank within its course (ordered by section id for stability).
    JOIN (
        SELECT id,
               row_number() OVER (
                   PARTITION BY school_id, course_name ORDER BY id
               ) AS section_rank,
               count(*) OVER (
                   PARTITION BY school_id, course_name
               ) AS sections_in_course
        FROM sections
    ) sec ON sec.id = s.id
    -- Student's rank within the course cohort at that school.
    JOIN (
        SELECT st2.id AS student_id,
               st2.school_id,
               b2.course_name,
               row_number() OVER (
                   PARTITION BY st2.school_id, b2.course_name ORDER BY st2.id
               ) AS student_rank
        FROM students st2
        JOIN (VALUES
            ('Algebra I',      9,  9),
            ('Geometry',       9, 11),
            ('Algebra II',    10, 12),
            ('Biology',        9, 10),
            ('Chemistry',     10, 12),
            ('Physics',       11, 12),
            ('English 9',      9,  9),
            ('English 10',    10, 10),
            ('World History',  9, 10),
            ('U.S. History',  11, 11),
            ('Spanish I',      9, 10),
            ('Band',           9, 12),
            ('Math 7',         7,  7),
            ('Life Science',   7,  8),
            ('English 7',      7,  7),
            ('PE 7/8',         6,  8),
            ('Grade 3 Core',   3,  3),
            ('Grade 4 Core',   4,  4),
            ('Grade 5 Core',   5,  5),
            ('Music',          0,  5)
        ) AS b2(course_name, lo, hi)
          ON st2.grade_level BETWEEN b2.lo AND b2.hi
        WHERE TRUE
    ) stu
      ON stu.student_id = st.id
     AND stu.school_id = s.school_id
     AND stu.course_name = s.course_name
    WHERE st.grade_level BETWEEN band.lo AND band.hi
      -- Round-robin deal: student n goes to section ((n-1) % k)+1.
      AND ((stu.student_rank - 1) % sec.sections_in_course) + 1 = sec.section_rank
      -- Every student takes each course at most once.
      AND NOT EXISTS (
          SELECT 1
          FROM section_roster r
          JOIN sections rs ON rs.id = r.section_id
          WHERE r.student_id = st.id
            AND rs.school_id = s.school_id
            AND rs.course_name = s.course_name
      )
) AS cand
WHERE cand.seat_rank <= (
    SELECT s.capacity
         - (SELECT count(*) FROM section_roster r WHERE r.section_id = cand.section_id)
    FROM sections s WHERE s.id = cand.section_id
)
ON CONFLICT (section_id, student_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Pass 2: top up students who are still short of 2 sections, spreading them
-- across open seats instead of stacking the same low-id students in every
-- section. Open seats are enumerated per section and paired one-for-one with
-- the neediest under-rostered students of the same school (fewest current
-- sections first, then lowest id), so no section exceeds capacity and no
-- student is left unseated while seats remain in their school.
--
-- CAPACITY REALITY: elementary (VVE) has 7 sections x 32 = 224 seats for 140
-- students, so 140 x 2 = 280 seat-needs cannot all be met; the district total
-- (42 x 32 = 1344 seats for 300 x 2 = 600 needs) is ample, but one small
-- school is seat-starved. This pass fills every available seat, guarantees no
-- student is left with zero sections, and gets every student to 2 where seats
-- exist. Students are enrolled regardless of status so the roster covers the
-- whole student body (15 rows are 'Withdrawn' but still carry section history).
-- ---------------------------------------------------------------------------

-- Round 1: lift every student with zero sections to at least one, neediest
-- (lowest id) first, spread across that school's open seats.
INSERT INTO section_roster (section_id, student_id, assigned_on)
SELECT seat.section_id,
       need.student_id,
       (SELECT t.starts_on FROM terms t WHERE t.is_current LIMIT 1)
FROM (
    SELECT s.id AS section_id,
           s.school_id,
           gs.seat_no,
           row_number() OVER (PARTITION BY s.school_id ORDER BY s.id, gs.seat_no) AS school_seat_rank
    FROM sections s
    CROSS JOIN LATERAL generate_series(
        1,
        s.capacity - (SELECT count(*) FROM section_roster r WHERE r.section_id = s.id)
    ) AS gs(seat_no)
) AS seat
JOIN (
    SELECT st.id AS student_id,
           st.school_id,
           row_number() OVER (PARTITION BY st.school_id ORDER BY st.id) AS need_rank
    FROM students st
    WHERE (SELECT count(*) FROM section_roster r WHERE r.student_id = st.id) = 0
) AS need
  ON need.school_id = seat.school_id
 AND need.need_rank = seat.school_seat_rank
ON CONFLICT (section_id, student_id) DO NOTHING;

-- Round 2: take any student still below 2 sections up to 2, neediest first.
INSERT INTO section_roster (section_id, student_id, assigned_on)
SELECT seat.section_id,
       need.student_id,
       (SELECT t.starts_on FROM terms t WHERE t.is_current LIMIT 1)
FROM (
    SELECT s.id AS section_id,
           s.school_id,
           gs.seat_no,
           row_number() OVER (PARTITION BY s.school_id ORDER BY s.id, gs.seat_no) AS school_seat_rank
    FROM sections s
    CROSS JOIN LATERAL generate_series(
        1,
        s.capacity - (SELECT count(*) FROM section_roster r WHERE r.section_id = s.id)
    ) AS gs(seat_no)
) AS seat
JOIN (
    SELECT st.id AS student_id,
           st.school_id,
           row_number() OVER (
               PARTITION BY st.school_id
               ORDER BY (SELECT count(*) FROM section_roster r WHERE r.student_id = st.id), st.id
           ) AS need_rank
    FROM students st
    WHERE (SELECT count(*) FROM section_roster r WHERE r.student_id = st.id) < 2
) AS need
  ON need.school_id = seat.school_id
 AND need.need_rank = seat.school_seat_rank
ON CONFLICT (section_id, student_id) DO NOTHING;

-- Round 3 (last-resort coverage): a school can be seat-starved -- e.g. VVE has
-- 7 sections x 32 = 224 seats but 140 students, and the pre-existing 223 roster
-- rows already fill those 7 sections to capacity. So no open seat can exist for
-- the highest-id elementary students. Rather than leave them with zero sections
-- (which would break grading/attendance/portal for those students), this round
-- places each remaining student into the lesson-fitting section of their own
-- school with the lowest id, even if that section is nominally at capacity.
-- This models real overcrowding; it is the ONLY place capacity can be exceeded.
INSERT INTO section_roster (section_id, student_id, assigned_on)
SELECT cand.section_id,
       cand.student_id,
       (SELECT t.starts_on FROM terms t WHERE t.is_current LIMIT 1)
FROM (
    SELECT st.id AS student_id,
           s.id  AS section_id,
           row_number() OVER (PARTITION BY st.id ORDER BY s.id) AS pick
    FROM students st
    JOIN sections s
      ON s.school_id = st.school_id
    JOIN (VALUES
        ('Algebra I',      9,  9),
        ('Geometry',       9, 11),
        ('Algebra II',    10, 12),
        ('Biology',        9, 10),
        ('Chemistry',     10, 12),
        ('Physics',       11, 12),
        ('English 9',      9,  9),
        ('English 10',    10, 10),
        ('World History',  9, 10),
        ('U.S. History',  11, 11),
        ('Spanish I',      9, 10),
        ('Band',           9, 12),
        ('Math 7',         7,  7),
        ('Life Science',   7,  8),
        ('English 7',      7,  7),
        ('PE 7/8',         6,  8),
        ('Grade 3 Core',   3,  3),
        ('Grade 4 Core',   4,  4),
        ('Grade 5 Core',   5,  5),
        ('Music',          0,  5)
    ) AS band(course_name, lo, hi)
      ON band.course_name = s.course_name
    WHERE st.grade_level BETWEEN band.lo AND band.hi
      AND (SELECT count(*) FROM section_roster r WHERE r.student_id = st.id) = 0
      AND NOT EXISTS (
          SELECT 1 FROM section_roster r
          WHERE r.section_id = s.id AND r.student_id = st.id
      )
) AS cand
WHERE cand.pick = 1
ON CONFLICT (section_id, student_id) DO NOTHING;

-- Round 4: district-wide grade-fit fallback for any student still unrostered
-- after round 3 (e.g. a student whose assigned school has no section fitting
-- their grade). Picks the lowest-id fitting section anywhere in the district.
INSERT INTO section_roster (section_id, student_id, assigned_on)
SELECT cand.section_id,
       cand.student_id,
       (SELECT t.starts_on FROM terms t WHERE t.is_current LIMIT 1)
FROM (
    SELECT st.id AS student_id,
           s.id  AS section_id,
           row_number() OVER (PARTITION BY st.id ORDER BY s.school_id, s.id) AS pick
    FROM students st
    JOIN sections s ON TRUE
    JOIN (VALUES
        ('Algebra I',      9,  9),
        ('Geometry',       9, 11),
        ('Algebra II',    10, 12),
        ('Biology',        9, 10),
        ('Chemistry',     10, 12),
        ('Physics',       11, 12),
        ('English 9',      9,  9),
        ('English 10',    10, 10),
        ('World History',  9, 10),
        ('U.S. History',  11, 11),
        ('Spanish I',      9, 10),
        ('Band',           9, 12),
        ('Math 7',         7,  7),
        ('Life Science',   7,  8),
        ('English 7',      7,  7),
        ('PE 7/8',         6,  8),
        ('Grade 3 Core',   3,  3),
        ('Grade 4 Core',   4,  4),
        ('Grade 5 Core',   5,  5),
        ('Music',          0,  5)
    ) AS band(course_name, lo, hi)
      ON band.course_name = s.course_name
    WHERE st.grade_level BETWEEN band.lo AND band.hi
      AND (SELECT count(*) FROM section_roster r WHERE r.student_id = st.id) = 0
      AND NOT EXISTS (
          SELECT 1 FROM section_roster r
          WHERE r.section_id = s.id AND r.student_id = st.id
      )
) AS cand
WHERE cand.pick = 1
ON CONFLICT (section_id, student_id) DO NOTHING;
