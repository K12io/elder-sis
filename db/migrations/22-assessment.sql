-- 22-assessment.sql — Assessment module (state/benchmark test scores).
-- Idempotent: safe to re-run on every boot. Owned by the assessment slice.
-- Never touches schema.sql or another slice's migration.

-- ---- Assessments (one benchmark/state test administration) -------------------
CREATE TABLE IF NOT EXISTS assessments (
    id               SERIAL PRIMARY KEY,
    name             TEXT NOT NULL,
    subject          TEXT NOT NULL,
    grade_levels     TEXT NOT NULL,            -- e.g. 'K-5', '6-8', '3-8'
    administered_on  DATE NOT NULL,
    max_score        NUMERIC(6,2) NOT NULL,
    proficiency_cut  NUMERIC(6,2) NOT NULL,    -- scale score at/above which a
                                               -- student is Proficient (see banding)
    test_window      TEXT,                     -- e.g. 'Fall 2026'
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_assessments_name_date UNIQUE (name, administered_on)
);

CREATE INDEX IF NOT EXISTS idx_assessments_subject ON assessments (subject);
CREATE INDEX IF NOT EXISTS idx_assessments_window  ON assessments (test_window);

-- ---- Per-student scale scores (one row per assessment + student) -------------
CREATE TABLE IF NOT EXISTS assessment_scores (
    id                 SERIAL PRIMARY KEY,
    assessment_id      INTEGER NOT NULL REFERENCES assessments (id),
    student_id         INTEGER NOT NULL REFERENCES students (id),
    scale_score        NUMERIC(6,2),
    performance_level  TEXT,
    CONSTRAINT uq_assessment_scores_as UNIQUE (assessment_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_assessment_scores_assessment ON assessment_scores (assessment_id);
CREATE INDEX IF NOT EXISTS idx_assessment_scores_student    ON assessment_scores (student_id);

-- Guard: tolerate a pre-existing table created without the unique constraint.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_assessment_scores_as') THEN
        ALTER TABLE assessment_scores
            ADD CONSTRAINT uq_assessment_scores_as UNIQUE (assessment_id, student_id);
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Guard: tolerate a pre-existing table created without the name/date constraint.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_assessments_name_date') THEN
        ALTER TABLE assessments
            ADD CONSTRAINT uq_assessments_name_date UNIQUE (name, administered_on);
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ---- Assessment catalogue seed (guarded; never duplicates) --------------------
-- Four realistic benchmarks spanning elementary, middle, and high school.
INSERT INTO assessments (name, subject, grade_levels, administered_on, max_score, proficiency_cut, test_window, active)
SELECT v.name, v.subject, v.grade_levels, v.administered_on::date, v.max_score, v.proficiency_cut, v.test_window, TRUE
FROM (VALUES
    ('Fall Reading Benchmark',  'Reading', 'K-5',  '2026-09-22', 100.00, 70.00, 'Fall 2026'),
    ('Math Standards Check',    'Math',    '6-8',  '2026-09-24', 120.00, 84.00, 'Fall 2026'),
    ('Science Benchmark',       'Science', '9-12', '2026-09-25', 100.00, 68.00, 'Fall 2026'),
    ('Writing Sample',          'Writing', '3-8',  '2026-09-28',  24.00, 16.00, 'Fall 2026')
) AS v(name, subject, grade_levels, administered_on, max_score, proficiency_cut, test_window)
WHERE NOT EXISTS (
    SELECT 1 FROM assessments a WHERE a.name = v.name AND a.administered_on = v.administered_on::date
);

-- ---- Deterministic score seed -------------------------------------------------
-- PERFORMANCE BANDING (documented; mirrored exactly in src/routes/assessment.js):
--   Let s = scale score, cut = assessments.proficiency_cut.
--     s < cut * 0.70              -> 'Below Basic'
--     cut * 0.70 <= s < cut       -> 'Basic'
--     cut <= s < cut * 1.20       -> 'Proficient'
--     s >= cut * 1.20             -> 'Advanced'
--
-- SCORE MATH (deterministic, reproducible from students.id alone):
--   raw    = (id * 37) % 41          -> 0..40
--   pct    = 46 + raw * 1.2          -> 46.0 .. 94.0  (a believable spread around cut)
--   score  = ROUND(max_score * pct / 100, 2), clamped to [0, max_score]
-- Scores are seeded for every student whose grade_level falls inside the
-- assessment's grade_levels range. Guarded with NOT EXISTS + ON CONFLICT so
-- re-running on every boot never adds or changes rows.
WITH bands AS (
    SELECT
        a.id AS assessment_id,
        a.max_score,
        a.proficiency_cut,
        LEAST(
            a.max_score,
            GREATEST(0,
                ROUND(a.max_score * (46 + ((st.id * 37) % 41) * 1.2) / 100.0, 2)
            )
        ) AS scale_score,
        st.id AS student_id
    FROM assessments a
    JOIN students st
      ON st.grade_level BETWEEN
           (CASE WHEN split_part(a.grade_levels, '-', 1) = 'K'
                 THEN 0 ELSE split_part(a.grade_levels, '-', 1)::int END)
           AND
           (CASE WHEN split_part(a.grade_levels, '-', 2) = 'K'
                 THEN 0 ELSE split_part(a.grade_levels, '-', 2)::int END)
)
INSERT INTO assessment_scores (assessment_id, student_id, scale_score, performance_level)
SELECT
    b.assessment_id,
    b.student_id,
    b.scale_score,
    CASE
        WHEN b.scale_score <  b.proficiency_cut * 0.70 THEN 'Below Basic'
        WHEN b.scale_score <  b.proficiency_cut        THEN 'Basic'
        WHEN b.scale_score <  b.proficiency_cut * 1.20 THEN 'Proficient'
        ELSE 'Advanced'
    END
FROM bands b
WHERE (SELECT count(*) FROM students) > 0
ON CONFLICT (assessment_id, student_id) DO NOTHING;
