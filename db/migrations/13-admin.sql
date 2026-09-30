-- 13-admin.sql — Administration module (slice-owned).
-- Idempotent: safe to re-run on every boot. Owns grade_codes, app_users,
-- app_roles, user_roles. Does NOT touch attendance_codes or grade categories
-- (other slices own those).

-- ---- Grade scale codes ------------------------------------------------------
CREATE TABLE IF NOT EXISTS grade_codes (
    id          SERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    min_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
    max_percent NUMERIC(5,2) NOT NULL DEFAULT 100,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

-- Classic scale: A 90-100, B 80-89, C 70-79, D 60-69, F 0-59.
INSERT INTO grade_codes (code, label, min_percent, max_percent, sort_order)
SELECT * FROM (VALUES
    ('A', 'Excellent',        90, 100, 10),
    ('B', 'Good',             80,  89, 20),
    ('C', 'Satisfactory',     70,  79, 30),
    ('D', 'Needs Improvement',60,  69, 40),
    ('F', 'Failing',           0,  59, 50)
) AS v(code, label, min_percent, max_percent, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM grade_codes);

-- ---- Application users ------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_users (
    id           SERIAL PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email        TEXT,
    active       BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO app_users (username, display_name, email, active)
SELECT * FROM (VALUES
    ('registrar', 'Dana Whitfield',  'dana.whitfield@vvsd.example', TRUE),
    ('teacher',   'Ray Nader',       'ray.nader@vvsd.example',      TRUE),
    ('admin',     'Patricia Osei',   'patricia.osei@vvsd.example',  TRUE)
) AS v(username, display_name, email, active)
WHERE NOT EXISTS (SELECT 1 FROM app_users);

-- ---- Roles ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_roles (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT,
    -- Descriptive only: the visible nav modules a role would see. The header
    -- nav is NOT wired to this column yet (see /admin/roles).
    visible_modules TEXT NOT NULL DEFAULT ''
);

INSERT INTO app_roles (name, description, visible_modules)
SELECT * FROM (VALUES
    ('Registrar',     'Maintains student records, enrollment, and school calendar.', 'students,schedule,reports'),
    ('Teacher',       'Takes attendance and enters grades for assigned sections.',   'attend,grades'),
    ('Administrator', 'Full district-level access to every module.',                  'students,schedule,attend,grades,transcripts,reports,admin'),
    ('Counselor',     'Reviews transcripts, schedules, and student records.',         'students,schedule,transcripts,reports')
) AS v(name, description, visible_modules)
WHERE NOT EXISTS (SELECT 1 FROM app_roles);

-- ---- User <-> role assignments ---------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles (
    id      SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES app_roles (id) ON DELETE CASCADE,
    UNIQUE (user_id, role_id)
);

-- Link the three demo users to sensible default roles (guarded, idempotent).
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM app_users u
JOIN app_roles r ON (
        (u.username = 'registrar' AND r.name = 'Registrar')
     OR (u.username = 'teacher'   AND r.name = 'Teacher')
     OR (u.username = 'admin'     AND r.name = 'Administrator')
)
ON CONFLICT (user_id, role_id) DO NOTHING;
