-- 11-grading.sql — Grading module (gradebook). Idempotent: safe to re-run.
-- Owned by the grading slice; do not edit schema.sql.

CREATE TABLE IF NOT EXISTS grade_categories (
    id         SERIAL PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES sections (id),
    name       TEXT NOT NULL,
    weight     NUMERIC NOT NULL DEFAULT 0,
    UNIQUE (section_id, name)
);

CREATE TABLE IF NOT EXISTS grade_assignments (
    id          SERIAL PRIMARY KEY,
    section_id  INTEGER NOT NULL REFERENCES sections (id),
    category_id INTEGER REFERENCES grade_categories (id),
    name        TEXT NOT NULL,
    points      NUMERIC NOT NULL DEFAULT 100,
    due_on      DATE,
    published   BOOLEAN NOT NULL DEFAULT FALSE
);

-- code: NULL/'' = missing, 'M' = missing, 'X' = exempt. points: NULL = no score yet.
CREATE TABLE IF NOT EXISTS grade_scores (
    id            SERIAL PRIMARY KEY,
    assignment_id INTEGER NOT NULL REFERENCES grade_assignments (id),
    student_id    INTEGER NOT NULL REFERENCES students (id),
    code          TEXT,
    points        NUMERIC,
    UNIQUE (assignment_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_grade_categories_section  ON grade_categories (section_id);
CREATE INDEX IF NOT EXISTS idx_grade_assignments_section ON grade_assignments (section_id);
CREATE INDEX IF NOT EXISTS idx_grade_assignments_cat     ON grade_assignments (category_id);
CREATE INDEX IF NOT EXISTS idx_grade_scores_assignment   ON grade_scores (assignment_id);
CREATE INDEX IF NOT EXISTS idx_grade_scores_student      ON grade_scores (student_id);
