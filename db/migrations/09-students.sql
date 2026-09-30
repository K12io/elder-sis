-- 09-students.sql — Student Records slice (S2).
-- Module-scoped tables for Student 360: contacts + alerts.
-- Idempotent: tables use IF NOT EXISTS; seed rows only insert when absent.

CREATE TABLE IF NOT EXISTS student_contacts (
    id           SERIAL PRIMARY KEY,
    student_id   INTEGER NOT NULL REFERENCES students (id),
    name         TEXT NOT NULL,
    relationship TEXT,
    phone        TEXT,
    email        TEXT,
    is_primary   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS student_alerts (
    id         SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students (id),
    alert_date DATE,
    alert_type TEXT,
    message    TEXT
);

CREATE INDEX IF NOT EXISTS idx_student_contacts_student ON student_contacts (student_id);
CREATE INDEX IF NOT EXISTS idx_student_alerts_student   ON student_alerts (student_id);

-- ---- Deterministic seed: contacts for a fixed subset of students ------------
-- Students id 1..12 get two contacts each (a primary and a secondary), built from
-- their own name/state_id so the data reads plausibly and is reproducible.

INSERT INTO student_contacts (student_id, name, relationship, phone, email, is_primary)
SELECT s.id,
       s.last_name || ', ' || s.first_name || ' (Primary)',
       CASE WHEN s.gender = 'F' THEN 'Mother' ELSE 'Father' END,
       '(540) 555-' || lpad(((s.id * 37) % 9000 + 1000)::text, 4, '0'),
       lower(s.first_name) || '.' || lower(s.last_name) || '@example.org',
       TRUE
FROM students s
WHERE s.id BETWEEN 1 AND 12
  AND NOT EXISTS (SELECT 1 FROM student_contacts c WHERE c.student_id = s.id);

INSERT INTO student_contacts (student_id, name, relationship, phone, email, is_primary)
SELECT s.id,
       s.last_name || ', Guardian Two',
       'Guardian',
       '(540) 555-' || lpad(((s.id * 53) % 9000 + 1000)::text, 4, '0'),
       'guardian' || s.id || '@example.org',
       FALSE
FROM students s
WHERE s.id BETWEEN 1 AND 12
  AND (SELECT count(*) FROM student_contacts c WHERE c.student_id = s.id) = 1;

-- ---- Deterministic seed: 0-2 alerts for a fixed subset ----------------------
-- Odd students id 1..11 get one alert; students divisible by 4 also get a second.

INSERT INTO student_alerts (student_id, alert_date, alert_type, message)
SELECT s.id,
       '2026-09-15'::date,
       'Medical',
       'Carries emergency medication; office has a health plan on file.'
FROM students s
WHERE s.id BETWEEN 1 AND 11
  AND s.id % 2 = 1
  AND NOT EXISTS (SELECT 1 FROM student_alerts a WHERE a.student_id = s.id);

INSERT INTO student_alerts (student_id, alert_date, alert_type, message)
SELECT s.id,
       '2026-08-28'::date,
       'Custody',
       'Restricted pickup list; verify guardian identity before release.'
FROM students s
WHERE s.id BETWEEN 1 AND 12
  AND s.id % 4 = 0
  AND NOT EXISTS (
    SELECT 1 FROM student_alerts a
    WHERE a.student_id = s.id AND a.alert_type = 'Custody'
  );
