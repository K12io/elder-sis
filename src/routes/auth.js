// src/routes/auth.js — login / logout / session info. Auto-mounted at /auth.

import express from "express";
import { query } from "../db.js";
import {
  verifyPassword,
  createSession,
  destroySession,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "../middleware/auth.js";

const router = express.Router();

const DEMO_PASSWORD = "demo1234";

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Only allow same-site relative redirect targets. Anything else (absolute URL,
 * protocol-relative "//evil", backslash trick) collapses to "/".
 */
function safeNext(raw) {
  const s = str(raw);
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return "/";
  return s;
}

/** Pull the sis_session token out of the request's Cookie header (or null). */
function cookieToken(req) {
  const header = req.headers?.cookie || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /auth/login — classic district-SIS login panel
// ---------------------------------------------------------------------------

router.get("/login", (req, res) => {
  // Already signed in? Bounce to the target/home.
  if (req.user) return res.redirect(safeNext(req.query.next));

  res.render("auth/login", {
    pageTitle: "Sign In",
    activeTab: "",
    next: str(req.query.next),
    username: "",
    error: null,
    demoPassword: DEMO_PASSWORD,
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

router.post("/login", async (req, res, next) => {
  const username = str(req.body.username);
  const password = str(req.body.password);
  const nextUrl = str(req.body.next);

  const renderInvalid = () =>
    res.status(200).render("auth/login", {
      pageTitle: "Sign In",
      activeTab: "",
      next: nextUrl,
      username,
      // Deliberately identical for unknown user and wrong password.
      error: "Invalid username or password",
      demoPassword: DEMO_PASSWORD,
    });

  try {
    if (!username || !password) return renderInvalid();

    const r = await query(
      `SELECT id, username, display_name, active, password_hash
         FROM app_users
        WHERE lower(username) = lower($1)
        LIMIT 1`,
      [username]
    );

    // Unknown user: still run a dummy verify so timing looks similar, then fail.
    if (r.rows.length === 0) {
      verifyPassword(password, "scrypt$00000000000000000000000000000000$00");
      return renderInvalid();
    }

    const user = r.rows[0];
    if (!verifyPassword(password, user.password_hash)) return renderInvalid();

    // Correct credentials but a deactivated account: same generic message.
    if (!user.active) return renderInvalid();

    const ip = req.ip || req.socket?.remoteAddress || null;
    const token = await createSession(user.id, ip);

    await query("UPDATE app_users SET last_login_at = now() WHERE id = $1", [user.id]);

    setSessionCookie(res, token, new Date(Date.now() + SESSION_TTL_MS));

    return res.redirect(safeNext(nextUrl));
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

router.post("/logout", async (req, res, next) => {
  try {
    const token = cookieToken(req);
    if (token) await destroySession(token);
    clearSessionCookie(res);
    return res.redirect("/auth/login");
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /auth/me — JSON session probe
// ---------------------------------------------------------------------------

router.get("/me", async (req, res, next) => {
  try {
    // Resolve straight from the session cookie: this endpoint then reports
    // correctly whether or not attachUser() has been wired into the chain.
    const token = cookieToken(req);
    const user = token ? await getSessionUser(token) : null;

    if (!user) {
      return res.status(200).json({
        loggedIn: false,
        username: null,
        display_name: null,
        roles: [],
      });
    }

    return res.status(200).json({
      loggedIn: true,
      username: user.username,
      display_name: user.display_name,
      roles: user.roles,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
