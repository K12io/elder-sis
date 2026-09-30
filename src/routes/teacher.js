import express from "express";
import { pool, query } from "../db.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Teacher Workspace
//
// A teacher-facing hub over the existing tables (teachers, sections,
// section_roster, students, schools, terms, grade_* and attendance_*).
// Read-only except POST /teacher/attendance, which upserts attendance_daily
// with the same columns and conflict target as the Attendance module's grid.
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

function toId(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Simple letter bands (spec): A 90+, B 80+, C 70+, D 60+, F below.
const LETTER_BANDS = [
  { letter: "A", min: 90 },
  { letter: "B", min: 80 },
  { letter: "C", min: 70 },
  { letter: "D", min: 60 },
  { letter: "F", min: -Infinity },
];

function letterFor(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  return (LETTER_BANDS.find((b) => pct >= b.min) || LETTER_BANDS.at(-1)).letter;
}

async function loadTeachers() {
  const r = await query(
    `SELECT t.id, t.code, t.name, t.dept, t.school_id,
            sc.name AS school_name, sc.code AS school_code
       FROM teachers t
       LEFT JOIN schools sc ON sc.id = t.school_id
      ORDER BY t.name, t.id`
  );
  return r.rows;
}

async function loadCurrentTerm() {
  const r = await query(
    "SELECT id, name, starts_on, ends_on FROM terms WHERE is_current ORDER BY id LIMIT 1"
  );
  return r.rows[0] || null;
}

async function loadTeacher(teacherId) {
  if (!Number.isInteger(teacherId)) return null;
  const r = await query(
    `SELECT t.id, t.code, t.name, t.dept, t.school_id,
            sc.name AS school_name, sc.code AS school_code
       FROM teachers t
       LEFT JOIN schools sc ON sc.id = t.school_id
      WHERE t.id = $1`,
    [teacherId]
  );
  return r.rows[0] || null;
}

async function loadSection(sectionId) {
  if (!Number.isInteger(sectionId)) return null;
  const r = await query(
    `SELECT s.id, s.section_code, s.course_name, s.period, s.room, s.capacity,
            s.school_id, s.teacher_id, s.term_id,
            sc.name AS school_name, sc.code AS school_code,
            t.name AS teacher_name,
            tm.name AS term_name
       FROM sections s
       JOIN schools sc ON sc.id = s.school_id
       JOIN teachers t ON t.id = s.teacher_id
       LEFT JOIN terms tm ON tm.id = s.term_id
      WHERE s.id = $1`,
    [sectionId]
  );
  return r.rows[0] || null;
}

/** Section roster from section_roster, ordered by last name. */
async function loadRoster(sectionId) {
  const r = await query(
    `SELECT st.id, st.state_id, st.last_name, st.first_name, st.middle_name,
            st.grade_level, st.status
       FROM section_roster sr
       JOIN students st ON st.id = sr.student_id
      WHERE sr.section_id = $1
      ORDER BY st.last_name, st.first_name, st.id`,
    [sectionId]
  );
  return r.rows;
}

async function loadCodes() {
  const r = await query(
    "SELECT code, label, counts_absent, excused FROM attendance_codes ORDER BY sort_order, code"
  );
  return r.rows;
}

/**
 * Current standing per roster student for one section.
 *
 * Weighted percentage follows the same semantics as the grading module: per
 * category, earned/possible across that category's assignments ("X" exempt is
 * skipped; "M"/missing counts 0 earned), then a weighted mean over categories
 * that actually have possible points, renormalizing the weights used. Only
 * categories whose weight is present count. Returns a Map keyed by student id.
 */
async function loadStandings(sectionId) {
  const r = await query(
    `WITH asg AS (
       SELECT a.id, a.category_id, a.points AS possible,
              COALESCE(c.weight, 0) AS weight,
              c.name AS category_name
         FROM grade_assignments a
         LEFT JOIN grade_categories c ON c.id = a.category_id
        WHERE a.section_id = $1
     ),
     per_cat AS (
       SELECT gs.student_id,
              asg.category_id,
              asg.weight,
              sum(CASE WHEN gs.code = 'X' THEN 0 ELSE asg.possible END) AS possible,
              sum(CASE WHEN gs.code = 'X' THEN 0 ELSE COALESCE(gs.points, 0) END) AS earned,
              count(*)::int AS n
         FROM asg
         JOIN grade_scores gs ON gs.assignment_id = asg.id
        GROUP BY gs.student_id, asg.category_id, asg.weight
     ),
     scored AS (
       SELECT student_id,
              category_id,
              weight,
              n,
              CASE WHEN possible > 0 THEN (earned / possible) * 100 ELSE NULL END AS pct
         FROM per_cat
     ),
     weighted AS (
       SELECT student_id,
              sum(pct * weight) AS wsum,
              sum(weight)       AS wbasis,
              sum(n)::int       AS raw_scores
         FROM scored
        WHERE pct IS NOT NULL
        GROUP BY student_id
     )
     SELECT student_id,
            CASE WHEN wbasis > 0 THEN wsum / wbasis ELSE NULL END AS weighted_pct,
            COALESCE(raw_scores, 0) AS raw_scores
       FROM weighted`,
    [sectionId]
  );

  const map = new Map();
  for (const row of r.rows) {
    const pct = row.weighted_pct == null ? null : Number(row.weighted_pct);
    map.set(row.student_id, {
      pct,
      letter: letterFor(pct),
      scoresEntered: Number(row.raw_scores) || 0,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// GET /teacher — pick a teacher; their current-term sections + today strip
// ---------------------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const teachers = await loadTeachers();
    const selectedId = toId(req.query.teacher);
    const teacher =
      teachers.find((t) => t.id === selectedId) || teachers[0] || null;
    const term = await loadCurrentTerm();
    const date = isDate(req.query.date) ? req.query.date : todayIso();

    let sections = [];
    let totalStudents = 0;
    let todayMarks = 0;

    if (teacher) {
      const r = await query(
        `SELECT s.id, s.section_code, s.course_name, s.period, s.room,
                s.capacity, s.school_id, s.term_id,
                sc.name AS school_name, sc.code AS school_code,
                (SELECT count(*)::int FROM section_roster sr WHERE sr.section_id = s.id) AS roster_count
           FROM sections s
           JOIN schools sc ON sc.id = s.school_id
          WHERE s.teacher_id = $1
            AND ($2::int IS NULL OR s.term_id = $2)
          ORDER BY s.period NULLS LAST, s.course_name, s.section_code`,
        [teacher.id, term ? term.id : null]
      );
      sections = r.rows;
      totalStudents = sections.reduce((n, s) => n + s.roster_count, 0);

      if (sections.length > 0) {
        const ids = sections.map((s) => s.id);
        const m = await query(
          `SELECT count(*)::int AS n
             FROM attendance_daily
            WHERE section_id = ANY($1::int[]) AND on_date = $2`,
          [ids, date]
        );
        todayMarks = m.rows[0].n;
      }
    }

    const codes = await loadCodes();

    res.render("teacher/index", {
      pageTitle: "Teacher Workspace",
      activeTab: "",
      teachers,
      teacher,
      term,
      date,
      sections,
      totalStudents,
      todayMarks,
      codes,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /teacher/section?teacher=&section= — roster + current standing
// ---------------------------------------------------------------------------

router.get("/section", async (req, res, next) => {
  try {
    const teacherId = toId(req.query.teacher);
    const sectionId = toId(req.query.section);
    const teacher = await loadTeacher(teacherId);
    const section = await loadSection(sectionId);

    // Friendly, never-500 states for a bad/missing id or a teacher mismatch.
    const notFound = !section || !teacher || section.teacher_id !== teacher.id;

    let roster = [];
    let standings = new Map();
    if (!notFound) {
      roster = await loadRoster(section.id);
      standings = await loadStandings(section.id);
    }

    res.render("teacher/section", {
      pageTitle: section && !notFound ? `Section :: ${section.course_name}` : "Section",
      activeTab: "",
      teacher,
      section: notFound ? null : section,
      requestedSectionId: sectionId,
      requestedTeacherId: teacherId,
      roster,
      standings,
      notFound,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /teacher/attendance?teacher=&section=&date= — one section/date quick entry
// ---------------------------------------------------------------------------

router.get("/attendance", async (req, res, next) => {
  try {
    const teacherId = toId(req.query.teacher);
    const sectionId = toId(req.query.section);
    const date = isDate(req.query.date) ? req.query.date : todayIso();

    const teacher = await loadTeacher(teacherId);
    const section = await loadSection(sectionId);
    const notFound = !section || !teacher || section.teacher_id !== teacher.id;

    let roster = [];
    const existing = {};
    let saved = null;
    if (!notFound) {
      roster = await loadRoster(section.id);
      const marks = await query(
        `SELECT student_id, code
           FROM attendance_daily
          WHERE section_id = $1 AND on_date = $2`,
        [section.id, date]
      );
      for (const m of marks.rows) existing[m.student_id] = m.code;

      if (req.query.saved === "1") {
        saved = Number.parseInt(req.query.n ?? "0", 10) || 0;
      }
    }

    const codes = await loadCodes();

    res.render("teacher/attendance", {
      pageTitle: "Teacher Attendance",
      activeTab: "",
      teacher,
      section: notFound ? null : section,
      requestedSectionId: sectionId,
      requestedTeacherId: teacherId,
      date,
      roster,
      existing,
      codes,
      saved,
      notFound,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /teacher/attendance — upsert one date for one section, one transaction
//
// Body shape: section, date, teacher, and code_<studentId> per roster row
// (matches teacher/attendance.ejs). Same columns and ON CONFLICT target as the
// Attendance module's grid save.
// ---------------------------------------------------------------------------

router.post("/attendance", async (req, res, next) => {
  const client = await pool.connect();
  let sectionId = null;
  let date = null;
  try {
    sectionId = toId(req.body.section);
    date = isDate(req.body.date) ? req.body.date : todayIso();

    const section = await loadSection(sectionId);
    if (!section) {
      // Friendly redirect rather than a 500 for a bad id.
      return res.redirect("/teacher?notice=" + encodeURIComponent("Unknown section."));
    }

    const validCodes = new Set((await loadCodes()).map((c) => c.code));

    // Only accept codes for students actually on this section's roster.
    const rosterRows = await query(
      "SELECT student_id FROM section_roster WHERE section_id = $1",
      [sectionId]
    );
    const rosterIds = new Set(rosterRows.rows.map((r) => r.student_id));

    const entries = [];
    for (const [key, rawValue] of Object.entries(req.body)) {
      if (!key.startsWith("code_")) continue;
      const studentId = Number.parseInt(key.slice(5), 10);
      if (!Number.isInteger(studentId) || studentId <= 0) continue;
      if (!rosterIds.has(studentId)) continue;
      const code = String(rawValue ?? "").trim().toUpperCase();
      if (code === "" || !validCodes.has(code)) continue;
      entries.push({ studentId, code });
    }

    await client.query("BEGIN");
    if (entries.length > 0) {
      const values = [];
      const params = [];
      entries.forEach((e, i) => {
        const b = i * 4;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
        params.push(e.studentId, sectionId, date, e.code);
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

    const studentsSaved = new Set(entries.map((e) => e.studentId)).size;
    return res.redirect(
      `/teacher/attendance?teacher=${section.teacher_id}&section=${sectionId}` +
        `&date=${encodeURIComponent(date)}&saved=1&n=${studentsSaved}`
    );
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

export default router;
