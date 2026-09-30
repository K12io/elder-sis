-- Fake SIS schema. Plain SQL, safe on an empty database and re-runnable.

CREATE TABLE IF NOT EXISTS schools (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE
);

-- Terms are district-level: school_id is nullable (NULL = applies to all schools).
CREATE TABLE IF NOT EXISTS terms (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    school_id  INTEGER REFERENCES schools (id),
    starts_on  DATE,
    ends_on    DATE,
    is_current BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS students (
    id          SERIAL PRIMARY KEY,
    state_id    TEXT NOT NULL UNIQUE,
    last_name   TEXT NOT NULL,
    first_name  TEXT NOT NULL,
    middle_name TEXT,
    grade_level INTEGER,
    gender      TEXT,
    dob         DATE,
    school_id   INTEGER REFERENCES schools (id),
    status      TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS enrollments (
    id          SERIAL PRIMARY KEY,
    student_id  INTEGER NOT NULL REFERENCES students (id),
    school_id   INTEGER REFERENCES schools (id),
    term_id     INTEGER REFERENCES terms (id),
    entry_date  DATE,
    exit_date   DATE,
    grade_level INTEGER,
    code        TEXT
);

CREATE TABLE IF NOT EXISTS teachers (
    id      SERIAL PRIMARY KEY,
    code    TEXT NOT NULL UNIQUE,
    name    TEXT NOT NULL,
    dept    TEXT,
    school_id INTEGER REFERENCES schools (id)
);

CREATE TABLE IF NOT EXISTS sections (
    id          SERIAL PRIMARY KEY,
    section_code TEXT NOT NULL UNIQUE,
    course_name TEXT NOT NULL,
    school_id   INTEGER NOT NULL REFERENCES schools (id),
    teacher_id  INTEGER NOT NULL REFERENCES teachers (id),
    period      INTEGER,
    room        TEXT,
    term_id     INTEGER REFERENCES terms (id),
    capacity    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments (student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_term   ON enrollments (term_id);
CREATE INDEX IF NOT EXISTS idx_students_school    ON students (school_id);
CREATE INDEX IF NOT EXISTS idx_sections_school    ON sections (school_id);
CREATE INDEX IF NOT EXISTS idx_sections_teacher   ON sections (teacher_id);