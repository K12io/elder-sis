-- 14-scheduling.sql — Scheduling module (slice-owned).
-- Idempotent: safe to re-run on every boot. Owns courses and section_roster.
-- Does NOT alter any table owned by schema.sql or other slices.

-- ---- Course catalog ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
    id           SERIAL PRIMARY KEY,
    course_name  TEXT NOT NULL UNIQUE,
    department   TEXT,
    credits      NUMERIC(4,1) NOT NULL DEFAULT 1.0,
    grade_levels TEXT,
    description  TEXT
);

-- Seed courses from the distinct section course names (idempotent).
INSERT INTO courses (course_name)
SELECT DISTINCT s.course_name
FROM sections s
WHERE NOT EXISTS (
    SELECT 1 FROM courses c WHERE c.course_name = s.course_name
);

-- Default catalog attributes for courses seeded above (only when unset).
UPDATE courses c
SET department = COALESCE(NULLIF(v.dept, ''), c.department),
    credits = COALESCE(v.credits, c.credits),
    grade_levels = COALESCE(v.grade_levels, c.grade_levels),
    description = COALESCE(v.description, c.description)
FROM (VALUES
    ('Algebra I',            'Mathematics',   1.0, '9-12', 'First-year algebra: linear equations, polynomials.'),
    ('Algebra II',           'Mathematics',   1.0, '10-12', 'Quadratics, complex numbers, functions.'),
    ('American Government',  'Social Studies',1.0, '12',    'Civics and the structure of U.S. government.'),
    ('American History',     'Social Studies',1.0, '9-11',  'U.S. history survey.'),
    ('Art I',                'Arts',          1.0, '9-12',  'Foundations of drawing and design.'),
    ('Band',                 'Arts',          1.0, '9-12',  'Concert band performance.'),
    ('Biology',              'Science',       1.0, '9-10',  'Cell biology, genetics, ecology.'),
    ('Chemistry',            'Science',       1.0, '10-12', 'Matter, reactions, stoichiometry.'),
    ('English 10',           'English',       1.0, '10',    'World literature and composition.'),
    ('English 11',           'English',       1.0, '11',    'American literature and rhetoric.'),
    ('English 9',            'English',       1.0, '9',     'Genres, grammar, and writing.'),
    ('Geometry',             'Mathematics',   1.0, '9-11',  'Proofs, congruence, coordinate geometry.'),
    ('Health',               'PE/Health',     0.5, '9',     'Wellness, nutrition, first aid.'),
    ('Physical Education',   'PE/Health',     0.5, '9-12',  'Fitness and team sports.')
) AS v(name, dept, credits, grade_levels, description)
WHERE c.department IS NULL
  AND c.course_name = v.name;
-- Any course still missing department gets a sensible fallback.
UPDATE courses SET department = 'General' WHERE department IS NULL;

-- ---- Section roster (real section membership) --------------------------------
CREATE TABLE IF NOT EXISTS section_roster (
    id          SERIAL PRIMARY KEY,
    section_id  INTEGER NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
    student_id  INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
    assigned_on DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE (section_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_section_roster_student ON section_roster (student_id);
CREATE INDEX IF NOT EXISTS idx_section_roster_section ON section_roster (section_id);
