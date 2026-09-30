-- 18-auth.sql — Authentication module (slice-owned).
-- Idempotent: re-executed on every boot inside the schema transaction.
-- Owns: the password_hash / last_login_at columns on app_users and auth_sessions.
-- Reads (does not re-create): app_users, app_roles, user_roles (owned by 13-admin.sql).

-- ---- app_users: credential + audit columns ---------------------------------
-- ADD COLUMN IF NOT EXISTS keeps this re-runnable; existing rows get NULL.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_login_at timestamp;

-- ---- Sessions ---------------------------------------------------------------
-- One row per active browser session. Token is the opaque cookie value
-- (32 random bytes, hex). expires_at is enforced in getSessionUser(); expired
-- rows are deleted on read so the table self-prunes.
CREATE TABLE IF NOT EXISTS auth_sessions (
    token      text PRIMARY KEY,
    user_id    integer REFERENCES app_users (id) ON DELETE CASCADE,
    created_at timestamp DEFAULT now(),
    expires_at timestamp,
    ip         text
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user    ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at);

-- ---- Demo credential seed ---------------------------------------------------
-- DEMO CREDENTIALS ONLY. Every seeded demo account uses the password:
--     demo1234
-- These rows are synthetic demo data for a fake SIS; they are NOT real
-- credentials and must never be reused outside this project.
--
-- Hash format: scrypt$<salt-hex>$<derived-key-hex>
--   * <salt-hex>      16 random bytes from crypto.randomBytes(16), hex-encoded
--   * <derived-key>   node crypto.scryptSync(plain, salt, 64), hex-encoded
-- verifyPassword() in src/middleware/auth.js parses this same format, so the
-- values below are stable literals (a SQL migration cannot call node crypto).
--
-- Only rows whose password_hash is still NULL are touched, so an operator
-- changing a password (or adding a user) is never overwritten on reboot.
UPDATE app_users SET password_hash =
    'scrypt$9d6753159c9f617e8026037b2a5101f3$f43b247432c54fe9ee1bdd835aef54c0bc501b8decd04682f00b04cec19c9dc1b8049c091f4fd31cd85cb43998afe5b2024492ff8137fddbbc4267282c62dac5'
WHERE username = 'registrar' AND password_hash IS NULL;

UPDATE app_users SET password_hash =
    'scrypt$d6c7d9e1a466cb0bff612e2430305726$427c5ee1b7fa7c98bb1f9a9a178fa9a96ef86def85aeaeb5bdbead843f438b63acb82651cb74e0b971ee68209ff0ccb9455774c0e3c0ff373b8d363c3bf55383'
WHERE username = 'teacher' AND password_hash IS NULL;

UPDATE app_users SET password_hash =
    'scrypt$b89e6e485fd9dc8719ee2034c60683fc$7300d147fdba2b29317d3655b841746cffbd5d9b7c19f4202c7279e7f966d5ecc8a254a552674b2fd0a00870db88ffa28d0ec6a0d1281a27086c1ec779c398f5'
WHERE username = 'admin' AND password_hash IS NULL;
