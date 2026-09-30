-- 12-enrollment.sql — Enrollment slice owned objects.
-- Idempotent: re-executed on every boot inside the schema transaction.

CREATE TABLE IF NOT EXISTS enrollment_events (
    id          SERIAL PRIMARY KEY,
    student_id  INTEGER NOT NULL REFERENCES students (id),
    action      TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_enrollment_events_student
    ON enrollment_events (student_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_events_occurred
    ON enrollment_events (occurred_at);

-- Convenience index for the duplicate check (last name + birth date, ci).
CREATE INDEX IF NOT EXISTS idx_students_last_dob
    ON students (lower(last_name), dob);

-- Seed-free: this slice inserts only via the UI. Nothing to guard-insert here.
