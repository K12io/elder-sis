-- 15-grades.sql — Academic Records module (final grades, GPA, transcripts).
-- Idempotent: safe to re-run on every boot. Owned by the grades slice.
-- Never touches schema.sql or another slice's migration.

-- ---- Final grades of record (per student + section + term) --------------------
CREATE TABLE IF NOT EXISTS final_grades (
    id         SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students (id),
    section_id INTEGER NOT NULL REFERENCES sections (id),
    term_id    INTEGER REFERENCES terms (id),
    percent    NUMERIC(5,2),
    letter     TEXT,
    points     NUMERIC,
    posted_on  DATE,
    posted_by  TEXT,
    CONSTRAINT uq_final_grades_sst UNIQUE (student_id, section_id, term_id)
);

CREATE INDEX IF NOT EXISTS idx_final_grades_student ON final_grades (student_id);
CREATE INDEX IF NOT EXISTS idx_final_grades_section ON final_grades (section_id);
CREATE INDEX IF NOT EXISTS idx_final_grades_term    ON final_grades (term_id);

-- Guard: if the table pre-existed without the unique constraint (e.g. created by
-- a guard in another slice's migration), add it. Tolerate duplicate-row failures.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_final_grades_sst'
    ) THEN
        ALTER TABLE final_grades
            ADD CONSTRAINT uq_final_grades_sst UNIQUE (student_id, section_id, term_id);
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ---- District grade scale (classic 4.0, plus plus/minus) ----------------------
CREATE TABLE IF NOT EXISTS grade_scale (
    letter       TEXT PRIMARY KEY,
    min_percent  NUMERIC(5,2) NOT NULL,
    max_percent  NUMERIC(5,2) NOT NULL,
    gpa_points   NUMERIC(3,2) NOT NULL,
    sort_order   INTEGER NOT NULL
);

INSERT INTO grade_scale (letter, min_percent, max_percent, gpa_points, sort_order)
SELECT v.letter, v.min_percent, v.max_percent, v.gpa_points, v.sort_order
FROM (VALUES
    ('A',  93.00, 200.00, 4.00,  1),
    ('A-', 90.00,  92.99, 3.70,  2),
    ('B+', 87.00,  89.99, 3.30,  3),
    ('B',  83.00,  86.99, 3.00,  4),
    ('B-', 80.00,  82.99, 2.70,  5),
    ('C+', 77.00,  79.99, 2.30,  6),
    ('C',  73.00,  76.99, 2.00,  7),
    ('C-', 70.00,  72.99, 1.70,  8),
    ('D+', 67.00,  69.99, 1.30,  9),
    ('D',  63.00,  66.99, 1.00, 10),
    ('D-', 60.00,  62.99, 0.70, 11),
    ('F',   0.00,  59.99, 0.00, 12)
) AS v(letter, min_percent, max_percent, gpa_points, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM grade_scale);

-- ---- GPA snapshots (written on each GPA computation) --------------------------
CREATE TABLE IF NOT EXISTS gpa_snapshots (
    id              SERIAL PRIMARY KEY,
    student_id      INTEGER NOT NULL REFERENCES students (id),
    term_id         INTEGER NOT NULL REFERENCES terms (id),
    term_gpa        NUMERIC(4,2),
    cumulative_gpa  NUMERIC(4,2),
    computed_on     DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE (student_id, term_id)
);

CREATE INDEX IF NOT EXISTS idx_gpa_snapshots_student ON gpa_snapshots (student_id);

-- ---- Grade correction log ------------------------------------------------------
CREATE TABLE IF NOT EXISTS grade_corrections (
    id            SERIAL PRIMARY KEY,
    student_id    INTEGER NOT NULL REFERENCES students (id),
    section_id    INTEGER NOT NULL REFERENCES sections (id),
    old_letter    TEXT,
    new_letter    TEXT,
    old_percent   NUMERIC(5,2),
    new_percent   NUMERIC(5,2),
    reason        TEXT NOT NULL,
    corrected_on  DATE NOT NULL DEFAULT CURRENT_DATE,
    corrected_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_grade_corrections_student ON grade_corrections (student_id);
