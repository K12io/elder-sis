import express from "express";
import { pool, query } from "../db.js";

const router = express.Router();

// ---- helpers ----------------------------------------------------------------

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

// Parse a numeric input; returns null when blank/invalid.
function num(v) {
  const s = text(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseModules(v) {
  const raw = Array.isArray(v) ? v : v == null ? [] : [v];
  return raw
    .map((x) => text(x))
    .filter(Boolean)
    .join(",");
}

// The module keys a role may be granted visibility to (descriptive only).
const NAV_MODULES = [
  ["students", "Student Records"],
  ["schedule", "Scheduling"],
  ["attend", "Attendance"],
  ["grades", "Grading"],
  ["transcripts", "Grades & Transcripts"],
  ["reports", "Reports"],
  ["admin", "Administration"],
];

async function currentTerm() {
  const r = await query(
    "SELECT name, starts_on, ends_on, is_current FROM terms WHERE is_current LIMIT 1"
  );
  return r.rows[0] ?? null;
}

// ---- dashboard --------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const [terms, codes, users, roles, cur] = await Promise.all([
      query("SELECT count(*)::int AS n FROM terms"),
      query("SELECT count(*)::int AS n FROM grade_codes"),
      query("SELECT count(*)::int AS n FROM app_users"),
      query("SELECT count(*)::int AS n FROM app_roles"),
      currentTerm(),
    ]);
    res.render("admin/index", {
      pageTitle: "Administration",
      activeTab: "admin",
      termName: cur ? cur.name : undefined,
      counts: {
        terms: terms.rows[0].n,
        codes: codes.rows[0].n,
        users: users.rows[0].n,
        roles: roles.rows[0].n,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---- school year / terms ----------------------------------------------------

router.get("/school-year", async (req, res, next) => {
  try {
    const [terms, cur] = await Promise.all([
      query(
        `SELECT t.id, t.name, t.starts_on, t.ends_on, t.is_current, s.name AS school_name
           FROM terms t
           LEFT JOIN schools s ON s.id = t.school_id
          ORDER BY t.starts_on NULLS LAST, t.id`
      ),
      currentTerm(),
    ]);
    res.render("admin/school-year", {
      pageTitle: "School Year & Terms",
      activeTab: "admin",
      terms: terms.rows,
      current: cur,
      termName: cur ? cur.name : undefined,
      message: text(req.query.message) || null,
      error: text(req.query.error) || null,
    });
  } catch (err) {
    next(err);
  }
});

// Set the chosen term as current: clear all others, set this one, one transaction.
router.post("/school-year/current", async (req, res, next) => {
  const id = Number(text(req.body.term_id));
  if (!Number.isInteger(id) || id <= 0) {
    return res.redirect("/admin/school-year?error=" + encodeURIComponent("Invalid term."));
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id, name FROM terms WHERE id = $1", [id]);
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return res.redirect("/admin/school-year?error=" + encodeURIComponent("Term not found."));
    }
    await client.query("UPDATE terms SET is_current = FALSE WHERE is_current = TRUE AND id <> $1", [id]);
    await client.query("UPDATE terms SET is_current = TRUE WHERE id = $1", [id]);
    await client.query("COMMIT");
    res.redirect("/admin/school-year?message=" + encodeURIComponent(`${found.rows[0].name} is now the current term.`));
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    next(err);
  } finally {
    client.release();
  }
});

router.post("/school-year", async (req, res, next) => {
  const name = text(req.body.name);
  const start = text(req.body.starts_on);
  const end = text(req.body.ends_on);
  const fail = (msg) =>
    res.status(400).render("admin/school-year", {
      pageTitle: "School Year & Terms",
      activeTab: "admin",
      terms: [],
      current: null,
      error: msg,
      message: null,
    });
  if (!name) return fail("Term name is required.");
  if (!isDate(start) || !isDate(end)) return fail("Start and end dates must be YYYY-MM-DD.");
  if (start > end) return fail("Start date must be on or before the end date.");
  try {
    await query(
      "INSERT INTO terms (name, school_id, starts_on, ends_on, is_current) VALUES ($1, NULL, $2, $3, FALSE)",
      [name, start, end]
    );
    res.redirect("/admin/school-year?message=" + encodeURIComponent(`Term "${name}" added.`));
  } catch (err) {
    next(err);
  }
});

// ---- grade codes ------------------------------------------------------------

async function renderCodes(res, extra = {}) {
  const r = await query(
    "SELECT id, code, label, min_percent, max_percent, sort_order FROM grade_codes ORDER BY sort_order, code"
  );
  res.status(extra.status ?? 200).render("admin/codes", {
    pageTitle: "Grade Codes",
    activeTab: "admin",
    codes: r.rows,
    error: null,
    message: null,
    termName: undefined,
    ...extra,
  });
}

// Validate one row: min <= max, within 0..100.
function rowError(code, min, max) {
  if (!code) return "Every row needs a code.";
  if (min == null || max == null) return `Code ${code}: min and max must be numbers.`;
  if (min < 0 || max > 100) return `Code ${code}: percentages must be between 0 and 100.`;
  if (min > max) return `Code ${code}: min (${min}) is greater than max (${max}).`;
  return null;
}

// Ranges must not overlap (touch-free interiors): sort by min, check adjacency.
function overlapError(rows) {
  const sorted = [...rows].sort((a, b) => a.min - b.min);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min <= sorted[i - 1].max) {
      return `Range overlap: ${sorted[i - 1].code} (max ${sorted[i - 1].max}) overlaps ${sorted[i].code} (min ${sorted[i].min}).`;
    }
  }
  return null;
}

router.get("/codes", async (req, res, next) => {
  try {
    await renderCodes(res, {
      message: text(req.query.message) || null,
      error: text(req.query.error) || null,
    });
  } catch (err) {
    next(err);
  }
});

// Upsert all existing codes + optionally add a new one. All-or-nothing.
router.post("/codes", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.id) ? req.body.id : [req.body.id];
    const codeVals = Array.isArray(req.body.code) ? req.body.code : [req.body.code];
    const labelVals = Array.isArray(req.body.label) ? req.body.label : [req.body.label];
    const minVals = Array.isArray(req.body.min_percent) ? req.body.min_percent : [req.body.min_percent];
    const maxVals = Array.isArray(req.body.max_percent) ? req.body.max_percent : [req.body.max_percent];

    const rows = [];
    ids.forEach((rawId, i) => {
      const id = Number(text(rawId));
      if (!Number.isInteger(id) || id <= 0) return;
      rows.push({
        id,
        code: text(codeVals[i]).toUpperCase(),
        label: text(labelVals[i]),
        min: num(minVals[i]),
        max: num(maxVals[i]),
      });
    });

    const newCode = text(req.body.new_code).toUpperCase();
    if (newCode) {
      rows.push({
        id: null,
        code: newCode,
        label: text(req.body.new_label) || newCode,
        min: num(req.body.new_min_percent),
        max: num(req.body.new_max_percent),
      });
    }

    if (!rows.length) return await renderCodes(res, { error: "Nothing to save." });

    for (const r of rows) {
      const err = rowError(r.code, r.min, r.max);
      if (err) return await renderCodes(res, { error: err });
    }
    const dupes = new Set();
    for (const r of rows) {
      if (dupes.has(r.code)) return await renderCodes(res, { error: `Duplicate code ${r.code}.` });
      dupes.add(r.code);
    }
    const oerr = overlapError(rows);
    if (oerr) return await renderCodes(res, { error: oerr });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows) {
        const dup = await client.query(
          "SELECT id FROM grade_codes WHERE code = $1 AND ($2::int IS NULL OR id <> $2)",
          [r.code, r.id]
        );
        if (dup.rows.length) {
          await client.query("ROLLBACK");
          return await renderCodes(res, { error: `Code ${r.code} is already used by another row.` });
        }
        if (r.id) {
          await client.query(
            "UPDATE grade_codes SET code = $1, label = $2, min_percent = $3, max_percent = $4 WHERE id = $5",
            [r.code, r.label, r.min, r.max, r.id]
          );
        } else {
          const so = await client.query("SELECT COALESCE(MAX(sort_order), 0) + 10 AS s FROM grade_codes");
          await client.query(
            "INSERT INTO grade_codes (code, label, min_percent, max_percent, sort_order) VALUES ($1, $2, $3, $4, $5)",
            [r.code, r.label, r.min, r.max, so.rows[0].s]
          );
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
    res.redirect("/admin/codes?message=" + encodeURIComponent("Grade codes saved."));
  } catch (err) {
    next(err);
  }
});

// ---- users ------------------------------------------------------------------

async function loadUsers() {
  const r = await query(
    `SELECT u.id, u.username, u.display_name, u.email, u.active,
            COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.id IS NOT NULL), '{}') AS roles,
            COALESCE(array_agg(r.id ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '{}') AS role_ids
       FROM app_users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN app_roles  r  ON r.id = ur.role_id
      GROUP BY u.id
      ORDER BY u.username`
  );
  return r.rows;
}

async function loadRoles() {
  const r = await query("SELECT id, name, description, visible_modules FROM app_roles ORDER BY name");
  return r.rows;
}

router.get("/users", async (req, res, next) => {
  try {
    const [users, roles] = await Promise.all([loadUsers(), loadRoles()]);
    res.render("admin/users", {
      pageTitle: "Users",
      activeTab: "admin",
      users,
      roles,
      message: text(req.query.message) || null,
      error: text(req.query.error) || null,
    });
  } catch (err) {
    next(err);
  }
});

async function renderUsers(res, extra = {}) {
  const [users, roles] = await Promise.all([loadUsers(), loadRoles()]);
  res.status(extra.status ?? 200).render("admin/users", {
    pageTitle: "Users",
    activeTab: "admin",
    users,
    roles,
    message: null,
    error: null,
    ...extra,
  });
}

// Assign roles to a user (replace the set).
router.post("/users/roles", async (req, res, next) => {
  const userId = Number(text(req.body.user_id));
  if (!Number.isInteger(userId) || userId <= 0) {
    return await renderUsers(res, { status: 400, error: "Invalid user." });
  }
  const raw = req.body.role_id;
  const roleIds = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
    .map((x) => Number(text(x)))
    .filter((n) => Number.isInteger(n) && n > 0);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT id, username FROM app_users WHERE id = $1", [userId]);
    if (!u.rows.length) {
      await client.query("ROLLBACK");
      return await renderUsers(res, { status: 400, error: "User not found." });
    }
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
    for (const rid of roleIds) {
      await client.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING",
        [userId, rid]
      );
    }
    await client.query("COMMIT");
    res.redirect(
      "/admin/users?message=" +
        encodeURIComponent(`Roles updated for ${u.rows[0].username} (${roleIds.length} assigned).`)
    );
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    next(err);
  } finally {
    client.release();
  }
});

router.post("/users/toggle", async (req, res, next) => {
  const userId = Number(text(req.body.user_id));
  if (!Number.isInteger(userId) || userId <= 0) {
    return await renderUsers(res, { status: 400, error: "Invalid user." });
  }
  try {
    const r = await query(
      "UPDATE app_users SET active = NOT active WHERE id = $1 RETURNING username, active",
      [userId]
    );
    if (!r.rows.length) return await renderUsers(res, { status: 400, error: "User not found." });
    const { username, active } = r.rows[0];
    res.redirect(
      "/admin/users?message=" +
        encodeURIComponent(`${username} is now ${active ? "active" : "inactive"}.`)
    );
  } catch (err) {
    next(err);
  }
});

router.post("/users", async (req, res, next) => {
  const username = text(req.body.username).toLowerCase();
  const display_name = text(req.body.display_name);
  const email = text(req.body.email);
  if (!username) return await renderUsers(res, { status: 400, error: "Username is required." });
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
    return await renderUsers(res, {
      status: 400,
      error: "Username must be 2-32 characters (letters, digits, . _ -).",
    });
  }
  if (!display_name) return await renderUsers(res, { status: 400, error: "Display name is required." });
  try {
    const dup = await query("SELECT id FROM app_users WHERE username = $1", [username]);
    if (dup.rows.length) {
      return await renderUsers(res, { status: 400, error: `Username "${username}" already exists.` });
    }
    await query(
      "INSERT INTO app_users (username, display_name, email, active) VALUES ($1, $2, $3, TRUE)",
      [username, display_name, email || null]
    );
    res.redirect("/admin/users?message=" + encodeURIComponent(`User "${username}" added.`));
  } catch (err) {
    next(err);
  }
});

// ---- roles ------------------------------------------------------------------

router.get("/roles", async (req, res, next) => {
  try {
    const roles = await loadRoles();
    res.render("admin/roles", {
      pageTitle: "Roles",
      activeTab: "admin",
      roles,
      navModules: NAV_MODULES,
      message: text(req.query.message) || null,
      error: text(req.query.error) || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/roles", async (req, res, next) => {
  const id = Number(text(req.body.role_id));
  const fail = async (msg) => {
    const roles = await loadRoles();
    return res.status(400).render("admin/roles", {
      pageTitle: "Roles",
      activeTab: "admin",
      roles,
      navModules: NAV_MODULES,
      error: msg,
      message: null,
    });
  };
  if (!Number.isInteger(id) || id <= 0) return await fail("Invalid role.");
  const which = req.body.visible_modules;
  // A multi-select only submits keys; if absent the user cleared all -> empty string.
  const visible = parseModules(which);
  const allowed = new Set(NAV_MODULES.map((m) => m[0]));
  const bad = visible.split(",").filter(Boolean).filter((k) => !allowed.has(k));
  if (bad.length) return await fail(`Unknown module key(s): ${bad.join(", ")}.`);
  try {
    const r = await query(
      "UPDATE app_roles SET visible_modules = $1 WHERE id = $2 RETURNING name",
      [visible, id]
    );
    if (!r.rows.length) return await fail("Role not found.");
    res.redirect("/admin/roles?message=" + encodeURIComponent(`Visibility saved for ${r.rows[0].name}.`));
  } catch (err) {
    next(err);
  }
});

export default router;
