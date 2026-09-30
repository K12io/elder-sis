-- Attendance module migration (slice 10). Idempotent; safe to re-run on every boot.
-- Owned objects: attendance_codes, attendance_daily. Nothing else is touched.

CREATE TABLE IF NOT EXISTS attendance_codes (
    code          TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    counts_absent BOOLEAN NOT NULL DEFAULT FALSE,
    excused       BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order    INTEGER NOT NULL DEFAULT 0
);

-- Seed the baseline codes idempotently. Only inserts rows that don't exist yet,
-- so a later human edit of a label is preserved across restarts.
INSERT INTO attendance_codes (code, label, counts_absent, excused, sort_order)
SELECT v.code, v.label, v.counts_absent, v.excused, v.sort_order
FROM (VALUES
    ('P', 'Present', FALSE, FALSE, 10),
    ('A', 'Absent',  TRUE,  FALSE, 20),
    ('T', 'Tardy',   FALSE, FALSE, 30),
    ('E', 'Excused', TRUE,  TRUE,  40)
) AS v(code, label, counts_absent, excused, sort_order)
WHERE NOT EXISTS (
    SELECT 1 FROM attendance_codes c WHERE c.code = v.code
);

CREATE TABLE IF NOT EXISTS attendance_daily (
    id         SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students (id),
    section_id INTEGER NOT NULL REFERENCES sections (id),
    on_date    DATE NOT NULL,
    code       TEXT NOT NULL REFERENCES attendance_codes (code),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attendance_daily_uniq UNIQUE (student_id, section_id, on_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_daily_date    ON attendance_daily (on_date);
CREATE INDEX IF NOT EXISTS idx_attendance_daily_section ON attendance_daily (section_id, on_date);
CREATE INDEX IF NOT EXISTS idx_attendance_daily_student ON attendance_daily (student_id);
