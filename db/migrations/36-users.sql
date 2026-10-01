-- 36-users.sql — Demo user accounts expansion (auth/role demo slice).
-- Idempotent: re-executed on every boot inside the schema transaction.
-- Owns: additional rows in app_users and user_roles (tables created by 13-admin.sql).
-- Does NOT modify the three seeded users (registrar, teacher, admin), their role
-- links, or the app_roles rows themselves.
--
-- DEMO CREDENTIALS ONLY — synthetic data for a fake SIS.
-- Every account seeded here (and the three pre-existing demo users) signs in
-- with the SAME demo password:  demo1234
-- The password_hash literal below is copied verbatim from 18-auth.sql (the
-- seeded `admin` row). It is a valid `scrypt$<salt-hex>$<key-hex>` value that
-- verifyPassword() in src/middleware/auth.js accepts for "demo1234".
-- Do NOT invent a new hash format; reuse this literal for every new row.
--
-- ---- Demo password hash literal (password: demo1234) ----
--   scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5

-- ---------------------------------------------------------------------------
-- New app_users rows.
-- Each INSERT is guarded by WHERE NOT EXISTS on the unique username, so a
-- reboot never duplicates or overwrites an operator's edits (including a
-- changed password_hash). Teachers chosen below map to real rows in `teachers`
-- (P. Okonkwo T102 @ High, J. Harkness T106 @ High, K. Yamagata T109 @ Middle);
-- usernames are first-initial + lowercase last name, emails are
-- first.last@valleyview.k12.demo.
-- ---------------------------------------------------------------------------

-- 1) Second registrar (Middle School), Registrar role.
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'h.benton', 'Hana Benton', 'hana.benton@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'h.benton');

-- 2) High School counselor, Counselor role.
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'm.okafor', 'Marcus Okafor', 'marcus.okafor@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'm.okafor');

-- 3) Middle School counselor, Counselor role.
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'j.reyes', 'Julia Reyes', 'julia.reyes@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'j.reyes');

-- 4) Teacher (real staff: P. Okonkwo, Science), Teacher role.
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'p.okonkwo', 'Priya Okonkwo', 'priya.okonkwo@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'p.okonkwo');

-- 5) Teacher (real staff: J. Harkness, Social Science), Teacher role.
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'j.harkness', 'Jonah Harkness', 'jonah.harkness@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'j.harkness');

-- 6) Teacher (real staff: K. Yamagata, Mathematics @ Middle), Teacher role.
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'k.yamagata', 'Kenji Yamagata', 'kenji.yamagata@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'k.yamagata');

-- 7) School nurse, Counselor role (health/student-services access).
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'n.alvarez', 'Nina Alvarez', 'nina.alvarez@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'n.alvarez');

-- 8) Fees clerk, MULTI-ROLE (Registrar + Counselor) — the single multi-role demo user.
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'f.garcia', 'Felix Garcia', 'felix.garcia@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'f.garcia');

-- 9) Vice principal, Administrator role (district-level access demo).
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 'v.hughes', 'Vivian Hughes', 'vivian.hughes@valleyview.k12.demo', TRUE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 'v.hughes');

-- 10) INACTIVE account (active = FALSE) — demonstrates the sign-in rejection
--     path: correct password, still refused with the generic invalid message.
INSERT INTO app_users (username, display_name, email, active, password_hash)
SELECT 't.mercer', 'Travis Mercer', 'travis.mercer@valleyview.k12.demo', FALSE,
       'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE username = 't.mercer');

-- ---------------------------------------------------------------------------
-- Role links for the new users. ON CONFLICT (user_id, role_id) DO NOTHING
-- respects the unique pair constraint and keeps reboot re-runs a no-op.
-- Existing users' role rows are untouched.
-- ---------------------------------------------------------------------------
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM (VALUES
    ('h.benton',   'Registrar'),
    ('m.okafor',   'Counselor'),
    ('j.reyes',    'Counselor'),
    ('p.okonkwo',  'Teacher'),
    ('j.harkness', 'Teacher'),
    ('k.yamagata', 'Teacher'),
    ('n.alvarez',  'Counselor'),
    ('f.garcia',   'Registrar'),
    ('f.garcia',   'Counselor'),
    ('v.hughes',   'Administrator'),
    ('t.mercer',   'Teacher')
) AS v(username, role_name)
JOIN app_users u ON u.username = v.username
JOIN app_roles r ON r.name = v.role_name
ON CONFLICT (user_id, role_id) DO NOTHING;
