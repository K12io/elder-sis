-- 17-discipline.sql — Discipline + Health module (slice-owned).
-- Idempotent: re-executed on every boot inside the schema transaction.
-- Owns: discipline_codes, discipline_incidents, health_encounters, health_flags.
-- Reads (does not write): students, schools, terms, student_alerts.

-- ---- Discipline reason codes (classic district set) -------------------------
CREATE TABLE IF NOT EXISTS discipline_codes (
    code        TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    severity    INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

-- Guarded insert: only when the table is empty, so an operator's edits survive.
INSERT INTO discipline_codes (code, label, severity, description, sort_order)
SELECT * FROM (VALUES
    ('TAR', 'Tardy',                1, 'Late to class or school without valid excuse.',       10),
    ('DIS', 'Disruption',           2, 'Behavior that materially disrupts instruction.',      20),
    ('INS', 'Insubordination',      3, 'Refusal to follow a reasonable staff direction.',     30),
    ('TEC', 'Technology misuse',    2, 'Unauthorized or improper use of district devices.',   40),
    ('BUL', 'Bullying',             4, 'Repeated aggressive conduct toward another student.', 50),
    ('FFT', 'Fighting / assault',   4, 'Physical altercation or assault on a person.',        60),
    ('OTH', 'Other',                1, 'Infraction not covered by another code.',             90)
) AS v(code, label, severity, description, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM discipline_codes);

-- ---- Discipline incidents ---------------------------------------------------
CREATE TABLE IF NOT EXISTS discipline_incidents (
    id              SERIAL PRIMARY KEY,
    student_id      INTEGER NOT NULL REFERENCES students (id),
    incident_date   DATE NOT NULL,
    code            TEXT NOT NULL REFERENCES discipline_codes (code),
    description     TEXT,
    action_taken    TEXT,
    reported_by     TEXT,
    parent_notified BOOLEAN NOT NULL DEFAULT FALSE,
    follow_up_date  DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discipline_incidents_student ON discipline_incidents (student_id);
CREATE INDEX IF NOT EXISTS idx_discipline_incidents_date    ON discipline_incidents (incident_date);
CREATE INDEX IF NOT EXISTS idx_discipline_incidents_code    ON discipline_incidents (code);

-- ---- Health encounters (nurse office visits) --------------------------------
CREATE TABLE IF NOT EXISTS health_encounters (
    id             SERIAL PRIMARY KEY,
    student_id     INTEGER NOT NULL REFERENCES students (id),
    encounter_date DATE NOT NULL,
    encounter_type TEXT NOT NULL,
    complaint      TEXT,
    treatment      TEXT,
    disposition    TEXT,
    seen_by        TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_health_encounters_student ON health_encounters (student_id);
CREATE INDEX IF NOT EXISTS idx_health_encounters_date    ON health_encounters (encounter_date);
CREATE INDEX IF NOT EXISTS idx_health_encounters_type    ON health_encounters (encounter_type);

-- ---- Health flags (persistent conditions / notes) ---------------------------
CREATE TABLE IF NOT EXISTS health_flags (
    id          SERIAL PRIMARY KEY,
    student_id  INTEGER NOT NULL REFERENCES students (id),
    flag        TEXT NOT NULL,
    note        TEXT,
    recorded_on DATE NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT health_flags_student_flag_key UNIQUE (student_id, flag)
);

CREATE INDEX IF NOT EXISTS idx_health_flags_student ON health_flags (student_id);
CREATE INDEX IF NOT EXISTS idx_health_flags_flag    ON health_flags (flag);

-- ---- Deterministic seed: flags for a fixed subset of students ---------------
-- Asthma: students whose id is a multiple of 7 (1..60).
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id,
       'Asthma',
       'Rescue inhaler kept in the health office; exercise-induced trigger noted.',
       '2026-08-25'::date
FROM students s
WHERE s.id BETWEEN 1 AND 60
  AND s.id % 7 = 0
  AND NOT EXISTS (
    SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Asthma'
  );

-- Peanut allergy: students whose id is a multiple of 11 (1..70).
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id,
       'Peanut allergy',
       'Severe allergy; epinephrine auto-injector on file. No cafeteria peanut products.',
       '2026-08-25'::date
FROM students s
WHERE s.id BETWEEN 1 AND 70
  AND s.id % 11 = 0
  AND NOT EXISTS (
    SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Peanut allergy'
  );

-- Medication on file: students whose id is a multiple of 5, up to 40.
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id,
       'Medication on file',
       'Daily medication authorized by guardian and physician; administered by health office.',
       '2026-08-25'::date
FROM students s
WHERE s.id BETWEEN 1 AND 40
  AND s.id % 5 = 0
  AND NOT EXISTS (
    SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Medication on file'
  );

-- Seizure care plan: a very small fixed set.
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id,
       'Seizure care plan',
       'Individual health plan on file; staff trained on response protocol.',
       '2026-08-25'::date
FROM students s
WHERE s.id IN (3, 19, 44, 88)
  AND NOT EXISTS (
    SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Seizure care plan'
  );
