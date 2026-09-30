-- 16-reports.sql — Reporting module (slice-owned). Idempotent: safe to re-run.
-- Owns: saved_reports, report_runs.
-- Also guards `final_grades` (Grading/Academic) with CREATE TABLE IF NOT EXISTS so
-- the Transcript Batch report can read it even when the grading slice has not yet
-- created it or has not posted any grades. If the grading slice owns it, this is a
-- no-op and its definition wins.
-- Never touches schema.sql or another slice's migration.

-- ---- Transcript source (guarded; owned by the grading slice if present) ------
CREATE TABLE IF NOT EXISTS final_grades (
    id         SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students (id),
    section_id INTEGER NOT NULL REFERENCES sections (id),
    term_id    INTEGER REFERENCES terms (id),
    percent    NUMERIC(5,2),
    letter     TEXT,
    points     NUMERIC,
    posted_on  DATE,
    posted_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_final_grades_student ON final_grades (student_id);
CREATE INDEX IF NOT EXISTS idx_final_grades_section ON final_grades (section_id);
CREATE INDEX IF NOT EXISTS idx_final_grades_term    ON final_grades (term_id);

-- ---- Saved report definitions ------------------------------------------------
-- report_key selects the report; params is the exact query string as jsonb so a
-- saved report re-runs byte-for-byte. Name is unique so a re-save is idempotent.
CREATE TABLE IF NOT EXISTS saved_reports (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    report_key  TEXT NOT NULL,
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by  TEXT,
    created_on  DATE NOT NULL DEFAULT CURRENT_DATE
);

-- ---- Report run log ----------------------------------------------------------
-- Every report execution (screen or CSV) appends one row.
CREATE TABLE IF NOT EXISTS report_runs (
    id         SERIAL PRIMARY KEY,
    report_key TEXT NOT NULL,
    params     JSONB NOT NULL DEFAULT '{}'::jsonb,
    row_count  INTEGER NOT NULL DEFAULT 0,
    ran_on     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ran_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_report_runs_key ON report_runs (report_key);
CREATE INDEX IF NOT EXISTS idx_report_runs_ran ON report_runs (ran_on DESC);

-- ---- Guarded demo seed -------------------------------------------------------
-- One bookmarkable saved report so the index is not empty on a fresh DB. Only
-- inserted when no saved report with that name exists, so edits survive restarts.
INSERT INTO saved_reports (name, report_key, params, created_by)
SELECT v.name, v.report_key, v.params::jsonb, v.created_by
FROM (VALUES
    ('All Active Students',
     'roster',
     '{"school":"","grade":"","status":"Active","cols":"phone"}',
     'Registrar')
) AS v(name, report_key, params, created_by)
WHERE NOT EXISTS (
    SELECT 1 FROM saved_reports sr WHERE sr.name = v.name
);
