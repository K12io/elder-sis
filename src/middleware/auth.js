// src/middleware/auth.js — password hashing, sessions, and route guards.
//
// Session cookie: `sis_session`, httpOnly + sameSite=lax + path=/, 12h expiry.
// We deliberately do NOT depend on cookie-parser (app.js is owned elsewhere),
// so the Cookie header is parsed here.

import crypto from "node:crypto";
import { query } from "../db.js";

export const SESSION_COOKIE = "sis_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** Hash a plaintext password as `scrypt$<salt-hex>$<key-hex>`. */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const key = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN).toString("hex");
  return `${SCRYPT_PREFIX}$${salt}$${key}`;
}

/**
 * Verify a plaintext password against a stored `scrypt$salt$key` string.
 * Returns false (never throws) for malformed or missing stored values.
 * Comparison is constant-time.
 */
export function verifyPassword(plain, stored) {
  if (typeof stored !== "string" || typeof plain !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;

  let expected;
  try {
    expected = Buffer.from(expectedHex, "hex");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(plain, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Create a session row and return its opaque token. */
export async function createSession(userId, ip = null) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO auth_sessions (token, user_id, expires_at, ip)
     VALUES ($1, $2, $3, $4)`,
    [token, userId, expiresAt, ip]
  );
  return token;
}

/** Delete a session row (logout). Tolerates unknown tokens. */
export async function destroySession(token) {
  if (!token) return;
  await query("DELETE FROM auth_sessions WHERE token = $1", [token]);
}

/**
 * Resolve a token to { id, username, display_name, roles, modules } or null.
 * Expired rows are deleted and treated as logged out. Inactive users are
 * rejected (and their session removed) as well.
 */
export async function getSessionUser(token) {
  if (!token || typeof token !== "string") return null;

  const s = await query(
    `SELECT s.token, s.user_id, s.expires_at,
            u.id, u.username, u.display_name, u.active
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [token]
  );
  if (s.rows.length === 0) return null;

  const row = s.rows[0];

  // Expiry: delete the row, treat as logged out.
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    await destroySession(token);
    return null;
  }

  // Deactivated account: revoke the session immediately.
  if (!row.active) {
    await destroySession(token);
    return null;
  }

  const r = await query(
    `SELECT ar.name, ar.visible_modules
       FROM user_roles ur
       JOIN app_roles ar ON ar.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY ar.name`,
    [row.user_id]
  );

  const roles = [];
  const modules = new Set();
  for (const role of r.rows) {
    roles.push(role.name);
    for (const m of String(role.visible_modules || "").split(",")) {
      const key = m.trim();
      if (key) modules.add(key);
    }
  }

  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    roles,
    modules: [...modules],
  };
}

// ---------------------------------------------------------------------------
// Cookie helpers + middleware
// ---------------------------------------------------------------------------

/** Read one cookie value out of the request's Cookie header. */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Set the session cookie (not `secure`: local http demo). */
export function setSessionCookie(res, token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (expiresAt) attrs.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  res.append("Set-Cookie", attrs.join("; "));
}

/** Clear the session cookie. */
export function clearSessionCookie(res) {
  res.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

/**
 * Express middleware: attach req.user and res.locals.currentUser.
 * Never throws — a DB error degrades to "logged out".
 */
export async function attachUser(req, res, next) {
  req.user = null;
  res.locals.currentUser = null;
  try {
    const token = readCookie(req, SESSION_COOKIE);
    const user = await getSessionUser(token);
    if (user) {
      req.user = user;
      res.locals.currentUser = user;
    }
  } catch {
    // Treat any session lookup failure as anonymous rather than 500.
  }
  next();
}

/** Redirect anonymous visitors to the login page, preserving the target. */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  const next_ = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(`/auth/login?next=${next_}`);
}

/** Require at least one of the named roles; otherwise a styled 403 page. */
export function requireRole(...names) {
  const wanted = names.map((n) => String(n).toLowerCase());
  return function requireRoleMiddleware(req, res, next) {
    const roles = (req.user?.roles || []).map((r) => String(r).toLowerCase());
    if (req.user && roles.some((r) => wanted.includes(r))) return next();
    return res.status(403).render("auth/error", {
      pageTitle: "Access Denied",
      activeTab: "",
      status: 403,
      message:
        "Your account does not have permission to view this page. " +
        "Contact the district SIS administrator if you believe this is an error.",
    });
  };
}
