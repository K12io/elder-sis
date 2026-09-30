import express from "express";
import { pool, query } from "../db.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation / shared helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Reject impossible dates like 2026-02-31 (Date rolls them over).
  return d.toISOString().slice(0, 10) === s;
}

function todayIso() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dowOf(iso) {
  // 0 = Sunday ... 6 = Saturday
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** Monday..Friday ISO dates for the week containing `iso`. */
function weekOf(iso) {
  const shift = (dowOf(iso) + 6) % 7; // days since Monday
  const monday = addDays(iso, -shift);
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

const WEEKDAY_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri"];

async function loadCodes() {
  const r = await query(
    "SELECT code, label, counts_absent, excused FROM attendance_codes ORDER BY sort_order, code"
  );
  return r.rows;
}

/** Friendly landed-error render helper; never throws out of a route. */
function fail(res, status, message) {
  return res.status(status).render("attendance/error", {
    pageTitle: "Attendance",
    activeTab: "attend",
    message,
    status,
  });
}

/** All 42 sections grouped by school, for the landing dropdown. */
async function loadSectionsGrouped() {
  const r = await query(
    `SELECT s.id, s.section_code, s.course_name, s.period, s.room,
            sc.id AS school_id, sc.name AS school_name, sc.code AS school_code,
            t.name AS teacher_name
       FROM sections s
       JOIN schools sc ON sc.id = s.school_id
       JOIN teachers t ON t.id = s.teacher_id
      ORDER BY sc.id, t.name, s.period NULLS LAST, s.course_name`
  );
  const groups = [];
  let current = null;
  for (const row of r.rows) {
    if (!current || current.id !== row.school_id) {
      current = { id: row.school_id, name: row.school_name, code: row.school_code, sections: [] };
      groups.push(current);
    }
    current.sections.push(row);
  }
  return groups;
}

async function loadSection(sectionId) {
  if (!Number.isInteger(sectionId)) return null;
  const r = await query(
    `SELECT s.id, s.section_code, s.course_name, s.period, s.room, s.school_id,
            sc.name AS school_name, sc.code AS school_code, t.name AS teacher_name
       FROM sections s
       JOIN schools sc ON sc.id = s.school_id
       JOIN teachers t ON t.id = s.teacher_id
      WHERE s.id = $1`,
    [sectionId]
  );
  return r.rows[0] || null;
}

/**
 * "Which students belong to a section?"
 * Section membership is owned by the Scheduling module via `section_roster`.
 * The grid rosters exactly those students, ordered by last name. Sections with
 * no roster rows yet render an empty grid plus a pointer to Scheduling.
 */
async function loadRoster(section) {
  const r = await query(
    `SELECT st.id, st.state_id, st.last_name, st.first_name, st.grade_level
       FROM section_roster sr
       JOIN students st ON st.id = sr.student_id
      WHERE sr.section_id = $1
      ORDER BY st.last_name, st.first_name, st.id`,
    [section.id]
  );
  return r.rows;
}

function parseSectionId(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// GET /attendance — landing
// ---------------------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const date = isDate(req.query.date) ? req.query.date : todayIso();
    const groups = await loadSectionsGrouped();
    const selected = parseSectionId(req.query.section);
    const codes = await loadCodes();
    res.render("attendance/index", {
      pageTitle: "Attendance",
      activeTab: "attend",
      date,
      groups,
      totalSections: groups.reduce((n, g) => n + g.sections.length, 0),
      selected,
      codes,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /attendance/grid?section=&date=
// ---------------------------------------------------------------------------

router.get("/grid", async (req, res, next) => {
  try {
    const sectionId = parseSectionId(req.query.section);
    if (sectionId === null) return fail(res, 400, "Unknown or missing section id.");

    const date = isDate(req.query.date) ? req.query.date : todayIso();
    const section = await loadSection(sectionId);
    if (!section) return fail(res, 404, `No section found with id ${sectionId}.`);

    const roster = await loadRoster(section);
    const week = weekOf(date);
    const codes = await loadCodes();

    // Existing marks for the whole week, keyed studentId|date.
    const marks = await query(
      `SELECT student_id, on_date, code
         FROM attendance_daily
        WHERE section_id = $1 AND on_date BETWEEN $2 AND $3`,
      [sectionId, week[0], week[4]]
    );
    const existing = {};
    for (const m of marks.rows) {
      const iso = m.on_date instanceof Date
        ? m.on_date.toISOString().slice(0, 10)
        : String(m.on_date).slice(0, 10);
      existing[`${m.student_id}|${iso}`] = m.code;
    }

    res.render("attendance/grid", {
      pageTitle: "Attendance Grid",
      activeTab: "attend",
      section,
      date,
      week,
      weekdayLabels: WEEKDAY_LABEL,
      roster,
      codes,
      existing,
      saved: req.query.saved === "1" ? Number.parseInt(req.query.n ?? "0", 10) || 0 : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /attendance/grid — save a whole week for one section, one transaction
// ---------------------------------------------------------------------------

router.post("/grid", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sectionId = parseSectionId(req.body.section);
    if (sectionId === null) return fail(res, 400, "Unknown or missing section id.");

    const date = isDate(req.body.date) ? req.body.date : todayIso();
    const section = await loadSection(sectionId);
    if (!section) return fail(res, 404, `No section found with id ${sectionId}.`);

    const validCodes = new Set((await loadCodes()).map((c) => c.code));
    const week = weekOf(date);
    const weekSet = new Set(week);

    // Body shape: code_<studentId>_<YYYY-MM-DD>. Anything else is ignored.
    const entries = [];
    for (const [key, rawValue] of Object.entries(req.body)) {
      if (!key.startsWith("code_")) continue;
      const rest = key.slice(5);
      const sep = rest.lastIndexOf("_");
      if (sep < 1) continue;
      const studentId = Number.parseInt(rest.slice(0, sep), 10);
      const onDate = rest.slice(sep + 1);
      if (!Number.isInteger(studentId) || studentId <= 0) continue;
      if (!weekSet.has(onDate)) continue;

      const code = String(rawValue ?? "").trim().toUpperCase();
      if (code === "") continue;              // skip blank cells
      if (!validCodes.has(code)) continue;    // ignore junk codes
      entries.push({ studentId, onDate, code });
    }

    await client.query("BEGIN");
    if (entries.length > 0) {
      // One multi-row upsert keeps the whole week transactional.
      const values = [];
      const params = [];
      entries.forEach((e, i) => {
        const b = i * 4;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
        params.push(e.studentId, sectionId, e.onDate, e.code);
      });
      await client.query(
        `INSERT INTO attendance_daily (student_id, section_id, on_date, code)
         VALUES ${values.join(",\n")}
         ON CONFLICT (student_id, section_id, on_date)
         DO UPDATE SET code = EXCLUDED.code, updated_at = now()`,
        params
      );
    }
    await client.query("COMMIT");

    // "N students" — distinct students with at least one mark posted.
    const studentsSaved = new Set(entries.map((e) => e.studentId)).size;
    res.redirect(
      `/attendance/grid?section=${sectionId}&date=${encodeURIComponent(date)}` +
        `&saved=1&n=${studentsSaved}`
    );
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /attendance/office — filters over attendance_daily
// ---------------------------------------------------------------------------

router.get("/office", async (req, res, next) => {
  try {
    const schoolId = Number.isInteger(Number.parseInt(req.query.school ?? "", 10))
      ? Number.parseInt(req.query.school, 10)
      : null;
    const code = typeof req.query.code === "string" && req.query.code.trim()
      ? req.query.code.trim().toUpperCase()
      : null;
    const lastName = typeof req.query.last === "string" ? req.query.last.trim() : "";

    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    const single = req.query.date;
    let from = isDate(fromRaw) ? fromRaw : null;
    let to = isDate(toRaw) ? toRaw : null;
    if (isDate(single)) {
      from = single;
      to = single;
    }

    const where = [];
    const params = [];
    if (from) { params.push(from); where.push(`ad.on_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`ad.on_date <= $${params.length}`); }
    if (schoolId !== null) { params.push(schoolId); where.push(`st.school_id = $${params.length}`); }
    if (code) { params.push(code); where.push(`ad.code = $${params.length}`); }
    if (lastName) { params.push(`${lastName}%`); where.push(`st.last_name ILIKE $${params.length}`); }

    const rows = await query(
      `SELECT ad.id, ad.on_date, ad.code, ad.updated_at,
              st.id AS student_id, st.last_name, st.first_name, st.state_id,
              st.grade_level, sc.code AS school_code,
              s.section_code, s.course_name, s.period
         FROM attendance_daily ad
         JOIN students st ON st.id = ad.student_id
         JOIN sections s  ON s.id  = ad.section_id
         LEFT JOIN schools sc ON sc.id = st.school_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY st.last_name, st.first_name, ad.on_date, s.period
        LIMIT 500`,
      params
    );

    const totals = await query(
      `SELECT ad.code, count(*)::int AS n
         FROM attendance_daily ad
         JOIN students st ON st.id = ad.student_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        GROUP BY ad.code ORDER BY ad.code`,
      params
    );

    const schools = await query("SELECT id, name, code FROM schools ORDER BY id");
    const codes = await loadCodes();
    const students = await query(
      "SELECT id, last_name, first_name, grade_level FROM students WHERE status = 'Active' ORDER BY last_name, first_name LIMIT 300"
    );
    const sections = await query(
      `SELECT s.id, s.section_code, s.course_name, s.period, sc.code AS school_code
         FROM sections s JOIN schools sc ON sc.id = s.school_id
        ORDER BY sc.id, s.period NULLS LAST, s.course_name`
    );

    res.render("attendance/office", {
      pageTitle: "Attendance Office",
      activeTab: "attend",
      filters: {
        from: fromRaw ?? "",
        to: toRaw ?? "",
        date: isDate(single) ? single : "",
        school: schoolId,
        code,
        last: lastName,
      },
      rows: rows.rows,
      totals: totals.rows,
      schools: schools.rows,
      codes,
      students: students.rows,
      sections: sections.rows,
      corrected: req.query.corrected === "1" ? Number.parseInt(req.query.n ?? "0", 10) || 0 : null,
      massCount: req.query.mass !== undefined ? Number.parseInt(req.query.mass, 10) || 0 : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /attendance/office/correct — flip one row's code, bump updated_at
// ---------------------------------------------------------------------------

router.post("/office/correct", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.body.id ?? "", 10);
    const code = String(req.body.code ?? "").trim().toUpperCase();
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, "Missing attendance row id.");

    const validCodes = new Set((await loadCodes()).map((c) => c.code));
    if (!validCodes.has(code)) return fail(res, 400, `Unknown attendance code "${code}".`);

    const r = await query(
      "UPDATE attendance_daily SET code = $1, updated_at = now() WHERE id = $2",
      [code, id]
    );
    res.redirect(`/attendance/office?corrected=1&n=${r.rowCount}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /attendance/office/mass — apply one code to many students, one txn
// ---------------------------------------------------------------------------

router.post("/office/mass", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const date = isDate(req.body.date) ? req.body.date : null;
    if (!date) return fail(res, 400, "Mass entry needs a valid date (YYYY-MM-DD).");

    const sectionId = parseSectionId(req.body.section);
    if (sectionId === null) return fail(res, 400, "Mass entry needs a section.");

    const code = String(req.body.code ?? "").trim().toUpperCase();
    const validCodes = new Set((await loadCodes()).map((c) => c.code));
    if (!validCodes.has(code)) return fail(res, 400, `Unknown attendance code "${code}".`);

    const section = await loadSection(sectionId);
    if (!section) return fail(res, 404, `No section found with id ${sectionId}.`);

    // student_ids[] from either a checkbox list or a textarea (ids, one per line / comma).
    let ids = [];
    if (Array.isArray(req.body.student_ids)) ids = req.body.student_ids;
    else if (typeof req.body.student_ids === "string" && req.body.student_ids.trim()) {
      ids = req.body.student_ids.split(/[\s,]+/);
    } else if (typeof req.body.students_text === "string") {
      ids = req.body.students_text.split(/[\s,]+/);
    }
    ids = ids.map((v) => Number.parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0);
    ids = [...new Set(ids)];
    if (ids.length === 0) return fail(res, 400, "Mass entry needs at least one student id.");

    // Constrain to students that actually exist and are in this section's school.
    const valid = await query(
      "SELECT id FROM students WHERE id = ANY($1::int[]) AND school_id = $2",
      [ids, section.school_id]
    );
    const validIds = valid.rows.map((r) => r.id);

    let applied = 0;
    await client.query("BEGIN");
    if (validIds.length > 0) {
      const r = await client.query(
        `INSERT INTO attendance_daily (student_id, section_id, on_date, code)
         SELECT unnest($1::int[]), $2, $3, $4
         ON CONFLICT (student_id, section_id, on_date)
         DO UPDATE SET code = EXCLUDED.code, updated_at = now()`,
        [validIds, sectionId, date, code]
      );
      applied = r.rowCount;
    }
    await client.query("COMMIT");

    res.redirect(`/attendance/office?mass=${applied}&date=${encodeURIComponent(date)}`);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /attendance/letters — "classic attendance letters"
// ---------------------------------------------------------------------------

router.get("/letters", async (req, res, next) => {
  try {
    const defaultFrom = addDays(todayIso(), -30);
    const from = isDate(req.query.from) ? req.query.from : defaultFrom;
    let to = isDate(req.query.to) ? req.query.to : todayIso();
    if (to < from) to = from;

    let threshold = Number.parseInt(req.query.threshold ?? "3", 10);
    if (!Number.isInteger(threshold) || threshold < 0) threshold = 3;

    const schoolId = Number.isInteger(Number.parseInt(req.query.school ?? "", 10))
      ? Number.parseInt(req.query.school, 10)
      : null;

    const params = [from, to];
    let schoolClause = "";
    if (schoolId !== null) {
      params.push(schoolId);
      schoolClause = `AND st.school_id = $${params.length}`;
    }

    // Count unexcused absences (counts_absent AND NOT excused) and tardies per student.
    const r = await query(
      `SELECT st.id, st.last_name, st.first_name, st.state_id, st.grade_level,
              sc.name AS school_name, sc.code AS school_code,
              count(*) FILTER (WHERE ac.counts_absent AND NOT ac.excused)::int AS absences,
              count(*) FILTER (WHERE ac.code = 'T')::int AS tardies,
              count(*) FILTER (WHERE ac.excused)::int AS excused
         FROM attendance_daily ad
         JOIN students st ON st.id = ad.student_id
         JOIN attendance_codes ac ON ac.code = ad.code
         LEFT JOIN schools sc ON sc.id = st.school_id
        WHERE ad.on_date BETWEEN $1 AND $2 ${schoolClause}
        GROUP BY st.id, st.last_name, st.first_name, st.state_id, st.grade_level,
                 sc.name, sc.code
       HAVING (count(*) FILTER (WHERE ac.counts_absent AND NOT ac.excused) + count(*) FILTER (WHERE ac.code = 'T')) >= $${params.length + 1}
        ORDER BY absences DESC, tardies DESC, st.last_name, st.first_name`,
      [...params, threshold]
    );

    const schools = await query("SELECT id, name, code FROM schools ORDER BY id");
    const codes = await loadCodes();

    res.render("attendance/letters", {
      pageTitle: "Attendance Letters",
      activeTab: "attend",
      from,
      to,
      threshold,
      schoolId,
      schools: schools.rows,
      codes,
      rows: r.rows,
      generatedAt: new Date().toISOString().replace("T", " ").slice(0, 16),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
