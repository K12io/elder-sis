import express from "express";
import { query } from "../db.js";

const router = express.Router();

const PERIODS = [1, 2, 3, 4, 5, 6, 7];

// ---- small validation helpers (never throw on bad input) --------------------

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function int(v) {
  const s = text(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Render view, never 500: fallback error screen instead.
async function safe(res, view, locals) {
  try {
    res.render(view, locals);
  } catch (e) {
    console.error(e);
    errorShell(res, "Scheduling", "The scheduling screen could not be loaded. Please try again.");
  }
}

function errorShell(res, title, message) {
  res.status(200).send(
    "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" + title +
    "</title><link rel='stylesheet' href='/css/app.css'></head><body><div id='shell'>" +
    "<div style='padding:14px'><h2 style='font-size:14px'>" + title + " — Error</h2>" +
    "<p style='font-size:11px'>" + message + "</p>" +
    "<p style='font-size:11px'><a href='/scheduling'>Back to Scheduling</a></p></div>" +
    "</div></body></html>"
  );
}

// Wrap a handler with a catch-all so a bad request never crashes the app.
function h(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      console.error(e);
      errorShell(res, "Scheduling", "An unexpected error occurred: " + String(e.message || e));
    });
  };
}

// ---- shared queries ----------------------------------------------------------

async function schools() {
  const r = await query("SELECT id, name, code FROM schools ORDER BY id");
  return r.rows;
}

// Sections of one school for the student assign picker (grouped by period).
async function schoolSections(schoolId) {
  const r = await query(
    `SELECT s.id, s.section_code, s.course_name, s.period, s.room, s.capacity,
            t.name AS teacher_name,
            (SELECT count(*)::int FROM section_roster sr WHERE sr.section_id = s.id) AS enrolled
       FROM sections s
       LEFT JOIN teachers t ON t.id = s.teacher_id
      WHERE s.school_id = $1
      ORDER BY s.period NULLS LAST, s.course_name, s.section_code`,
    [schoolId]
  );
  return r.rows;
}

// Conflict test: does the student already have any section in this period?
async function hasSectionInPeriod(studentId, period) {
  const r = await query(
    `SELECT 1
       FROM section_roster sr
       JOIN sections s ON s.id = sr.section_id
      WHERE sr.student_id = $1 AND s.period = $2
      LIMIT 1`,
    [studentId, period]
  );
  return r.rowCount > 0;
}

// Conflicts for the master grid: rows of period + key (teacher/room) count>=2.
async function schoolClashes(schoolId) {
  const [byTeacher, byRoom] = await Promise.all([
    query(
      `SELECT s.period, s.teacher_id, count(*)::int AS n
         FROM sections s
        WHERE s.school_id = $1
        GROUP BY s.period, s.teacher_id
       HAVING count(*) > 1`,
      [schoolId]
    ),
    query(
      `SELECT s.period, s.room, count(*)::int AS n
         FROM sections s
        WHERE s.school_id = $1 AND s.room IS NOT NULL AND s.room <> ''
        GROUP BY s.period, s.room
       HAVING count(*) > 1`,
      [schoolId]
    ),
  ]);
  const teacherClash = new Set(byTeacher.rows.map((r) => r.period + ":" + r.teacher_id));
  const roomClash = new Set(byRoom.rows.map((r) => r.period + ":" + r.room));
  return { teacherClash, roomClash };
}

// ---- routes ------------------------------------------------------------------

// GET /scheduling — landing: sections table + filters + module links.
router.get("/", h(async (req, res) => {
  const schoolId = int(req.query.school);
  const period = int(req.query.period);
  const r = await query(
    `SELECT s.id, s.section_code, s.course_name, s.period, s.room, s.capacity,
            t.name AS teacher_name, sc.name AS school_name, sc.id AS school_id,
            (SELECT count(*)::int FROM section_roster sr WHERE sr.section_id = s.id) AS enrolled
       FROM sections s
       LEFT JOIN teachers t ON t.id = s.teacher_id
       JOIN schools sc ON sc.id = s.school_id
      WHERE ($1::int IS NULL OR s.school_id = $1)
        AND ($2::int IS NULL OR s.period = $2)
      ORDER BY sc.id, s.period NULLS LAST, s.course_name, s.section_code`,
    [schoolId, period]
  );
  safe(res, "scheduling/index", {
    pageTitle: "Scheduling",
    activeTab: "schedule",
    sections: r.rows,
    schools: await schools(),
    schoolId,
    period,
    periods: PERIODS,
  });
}));

// GET /scheduling/catalog — course catalog with add/edit forms.
router.get("/catalog", h(async (req, res) => {
  const editId = int(req.query.edit);
  const list = await query(
    `SELECT c.*,
            (SELECT count(*)::int FROM sections s WHERE s.course_name = c.course_name) AS section_count
       FROM courses c
      ORDER BY c.course_name`
  );
  let editing = null;
  if (editId != null) {
    const er = await query("SELECT * FROM courses WHERE id = $1", [editId]);
    editing = er.rows[0] || null;
  }
  safe(res, "scheduling/catalog", {
    pageTitle: "Course Catalog",
    activeTab: "schedule",
    courses: list.rows,
    editing,
  });
}));

// POST /scheduling/catalog — create or update a course.
router.post("/catalog", h(async (req, res) => {
  const name = text(req.body.course_name);
  const department = text(req.body.department);
  const creditsRaw = text(req.body.credits);
  const credits = creditsRaw && Number.isFinite(Number(creditsRaw)) ? Number(creditsRaw) : null;
  const gradeLevels = text(req.body.grade_levels);
  const description = text(req.body.description);
  const id = int(req.body.id);
  let msg = "";
  let err = "";
  if (!name) {
    err = "Course name is required.";
  } else if (credits != null && (credits < 0 || credits > 10)) {
    err = "Credits must be between 0 and 10.";
  } else if (id != null) {
    const dup = await query("SELECT 1 FROM courses WHERE course_name = $1 AND id <> $2", [name, id]);
    if (dup.rowCount > 0) {
      err = "A course with that name already exists.";
    } else {
      await query(
        `UPDATE courses SET course_name = $1, department = $2, credits = $3,
                           grade_levels = $4, description = $5 WHERE id = $6`,
        [name, department || null, credits, gradeLevels || null, description || null, id]
      );
      msg = "Course updated: " + name + ".";
    }
  } else {
    const dup = await query("SELECT 1 FROM courses WHERE course_name = $1", [name]);
    if (dup.rowCount > 0) {
      err = "A course with that name already exists.";
    } else {
      await query(
        `INSERT INTO courses (course_name, department, credits, grade_levels, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [name, department || null, credits, gradeLevels || null, description || null]
      );
      msg = "Course added: " + name + ".";
    }
  }
  const qs = new URLSearchParams();
  if (msg) qs.set("msg", msg);
  if (err) qs.set("err", err);
  res.redirect("/scheduling/catalog" + (qs.toString() ? "?" + qs.toString() : ""));
}));

// GET /scheduling/master — master schedule grid with clash highlights.
router.get("/master", h(async (req, res) => {
  const schoolId = int(req.query.school);
  const list = await schools();
  const effective = schoolId != null ? schoolId : (list.length ? list[0].id : null);
  const [secs, clashes] = await Promise.all([
    query(
      `SELECT s.id, s.section_code, s.course_name, s.period, s.room, s.teacher_id,
              t.name AS teacher_name
         FROM sections s
         LEFT JOIN teachers t ON t.id = s.teacher_id
        WHERE s.school_id = $1
        ORDER BY s.course_name, s.section_code`,
      [effective]
    ),
    schoolClashes(effective),
  ]);
  const teachers = await query(
    `SELECT t.id, t.name, t.code FROM teachers t
      WHERE t.school_id = $1
      ORDER BY t.name`,
    [effective]
  );
  safe(res, "scheduling/master", {
    pageTitle: "Master Schedule",
    activeTab: "schedule",
    schools: list,
    schoolId: effective,
    periods: PERIODS,
    teachers: teachers.rows,
    sections: secs.rows,
    teacherClash: clashes.teacherClash,
    roomClash: clashes.roomClash,
  });
}));

// GET /scheduling/student?student=<id> — one student's schedule.
router.get("/student", h(async (req, res) => {
  const id = int(req.query.student);
  if (id == null) {
    return errorShell(res, "Scheduling", "No student id given.");
  }
  const st = await query(
    `SELECT st.*, sc.name AS school_name
       FROM students st LEFT JOIN schools sc ON sc.id = st.school_id
      WHERE st.id = $1`,
    [id]
  );
  if (!st.rows.length) {
    return errorShell(res, "Scheduling", "Student not found.");
  }
  const student = st.rows[0];
  const roster = await query(
    `SELECT sr.id AS roster_id, sr.assigned_on,
            s.id AS section_id, s.section_code, s.course_name, s.period, s.room, s.capacity,
            t.name AS teacher_name
       FROM section_roster sr
       JOIN sections s ON s.id = sr.section_id
       LEFT JOIN teachers t ON t.id = s.teacher_id
      WHERE sr.student_id = $1
      ORDER BY s.period NULLS LAST, s.course_name`,
    [id]
  );
  const creditsRow = await query(
    `SELECT COALESCE(SUM(c.credits), 0) AS total
       FROM section_roster sr
       JOIN sections s ON s.id = sr.section_id
       JOIN courses c ON c.course_name = s.course_name
      WHERE sr.student_id = $1`,
    [id]
  );
  const picker = student.school_id ? await schoolSections(student.school_id) : [];
  safe(res, "scheduling/student", {
    pageTitle: "Student Schedule",
    activeTab: "schedule",
    student,
    schedule: roster.rows,
    totalCredits: creditsRow.rows[0].total,
    sections: picker,
    periods: PERIODS,
    msg: text(req.query.msg),
    err: text(req.query.err),
  });
}));

// POST /scheduling/assign — put a student in a section (period-conflict guard).
router.post("/assign", h(async (req, res) => {
  const studentId = int(req.body.student_id);
  const sectionId = int(req.body.section_id);
  if (studentId == null || sectionId == null) {
    return errorShell(res, "Scheduling", "Both a student and a section are required.");
  }
  const sec = await query(
    `SELECT s.*, (SELECT count(*)::int FROM section_roster sr WHERE sr.section_id = s.id) AS enrolled
       FROM sections s WHERE s.id = $1`,
    [sectionId]
  );
  if (!sec.rows.length) {
    return errorShell(res, "Scheduling", "Section not found.");
  }
  const section = sec.rows[0];
  const back = "/scheduling/student?student=" + studentId;
  if (section.period != null && (await hasSectionInPeriod(studentId, section.period))) {
    const clash = await query(
      `SELECT s.course_name
         FROM section_roster sr JOIN sections s ON s.id = sr.section_id
        WHERE sr.student_id = $1 AND s.period = $2 LIMIT 1`,
      [studentId, section.period]
    );
    return res.redirect(
      back +
        "&err=" +
        encodeURIComponent(
          "CONFLICT: student already has " + clash.rows[0].course_name +
            " in period " + section.period + "; cannot add " + section.course_name + "."
        )
    );
  }
  try {
    await query(
      "INSERT INTO section_roster (section_id, student_id) VALUES ($1, $2)",
      [sectionId, studentId]
    );
  } catch (e) {
    return res.redirect(back + "&err=" + encodeURIComponent("Assignment failed: " + e.message));
  }
  res.redirect(back + "&msg=" + encodeURIComponent(
    "Assigned " + section.course_name + " (" + section.section_code + ") to student."));
}));

// POST /scheduling/unassign — remove a student from a section roster.
router.post("/unassign", h(async (req, res) => {
  const rosterId = int(req.body.roster_id);
  if (rosterId == null) {
    return errorShell(res, "Scheduling", "A roster row is required.");
  }
  const back = "/scheduling/section?section=" + req.body.section_id;
  const r = await query(
    "DELETE FROM section_roster WHERE id = $1 RETURNING section_id",
    [rosterId]
  );
  if (r.rowCount > 0 && r.rows[0].section_id) {
    res.redirect("/scheduling/section?section=" + r.rows[0].section_id +
      "&msg=" + encodeURIComponent("Student removed from roster."));
  } else {
    res.redirect(back + "&err=" + encodeURIComponent("Roster row not found."));
  }
}));

// GET /scheduling/section?section=<id> — one section with roster + bulk helper.
router.get("/section", h(async (req, res) => {
  const id = int(req.query.section);
  if (id == null) {
    return errorShell(res, "Scheduling", "No section id given.");
  }
  const sr = await query(
    `SELECT s.*, t.name AS teacher_name, sc.name AS school_name, sc.id AS school_id,
            tm.name AS term_name
       FROM sections s
       LEFT JOIN teachers t ON t.id = s.teacher_id
       JOIN schools sc ON sc.id = s.school_id
       LEFT JOIN terms tm ON tm.id = s.term_id
      WHERE s.id = $1`,
    [id]
  );
  if (!sr.rows.length) {
    return errorShell(res, "Scheduling", "Section not found.");
  }
  const section = sr.rows[0];
  const roster = await query(
    `SELECT sr.id, sr.assigned_on, st.id AS student_id, st.first_name, st.last_name,
            st.grade_level, st.state_id
       FROM section_roster sr
       JOIN students st ON st.id = sr.student_id
      WHERE sr.section_id = $1
      ORDER BY st.last_name, st.first_name`,
    [id]
  );
  safe(res, "scheduling/section", {
    pageTitle: "Section Roster",
    activeTab: "schedule",
    section,
    roster: roster.rows,
    msg: text(req.query.msg),
    err: text(req.query.err),
  });
}));

// POST /scheduling/bulk — assign a grade level of students to one section.
router.post("/bulk", h(async (req, res) => {
  const sectionId = int(req.body.section_id);
  const grade = int(req.body.grade_level);
  if (sectionId == null || grade == null) {
    return errorShell(res, "Scheduling", "Section and grade level are required.");
  }
  const sec = await query(
    `SELECT s.*, (SELECT count(*)::int FROM section_roster sr WHERE sr.section_id = s.id) AS enrolled
       FROM sections s WHERE s.id = $1`,
    [sectionId]
  );
  if (!sec.rows.length) {
    return errorShell(res, "Scheduling", "Section not found.");
  }
  const section = sec.rows[0];
  const cands = await query(
    `SELECT st.id
       FROM students st
      WHERE st.school_id = $1 AND st.grade_level = $2 AND st.status = 'Active'
        AND NOT EXISTS (
          SELECT 1 FROM section_roster sr
          JOIN sections s2 ON s2.id = sr.section_id
         WHERE sr.student_id = st.id AND s2.period = $3
        )`,
    [section.school_id, grade, section.period]
  );
  let added = 0;
  let skipped = 0;
  let remaining = Math.max(
    (section.capacity || 0) - section.enrolled, 0
  );
  for (const row of cands.rows) {
    if (section.period != null && (await hasSectionInPeriod(row.id, section.period))) {
      skipped++;
      continue;
    }
    if (section.capacity != null && remaining <= 0) {
      skipped++;
      continue;
    }
    try {
      await query("INSERT INTO section_roster (section_id, student_id) VALUES ($1, $2)", [sectionId, row.id]);
      added++;
      if (section.capacity != null) remaining--;
    } catch {
      skipped++;
    }
  }
  res.redirect(
    "/scheduling/section?section=" + sectionId +
    "&msg=" + encodeURIComponent(
      "Bulk assign grade " + grade + ": " + added + " added, " + skipped + " skipped (conflict or capacity)."
    )
  );
}));

// POST /scheduling/auto — fill section_roster for a school + term.
router.post("/auto", h(async (req, res) => {
  const schoolId = int(req.body.school_id);
  let termId = int(req.body.term_id);
  if (schoolId == null) {
    return errorShell(res, "Scheduling", "A school is required for auto-assign.");
  }
  if (termId == null) {
    const cur = await query("SELECT id FROM terms WHERE is_current LIMIT 1");
    termId = cur.rows.length ? cur.rows[0].id : null;
  }
  const termIdRef = termId;
  const secs = await query(
    `SELECT s.id, s.period, s.capacity,
            (SELECT count(*)::int FROM section_roster sr WHERE sr.section_id = s.id) AS enrolled
       FROM sections s
      WHERE s.school_id = $1 AND ($2::int IS NULL OR s.term_id = $2 OR s.term_id IS NULL)
      ORDER BY s.period NULLS LAST, s.id`,
    [schoolId, termIdRef]
  );
  // Group sections by period; track live enrollment.
  const byPeriod = new Map();
  for (const s of secs.rows) {
    const p = s.period == null ? 0 : s.period;
    if (!byPeriod.has(p)) byPeriod.set(p, []);
    byPeriod.get(p).push(s);
  }
  const stus = await query(
    "SELECT id FROM students WHERE school_id = $1 AND status = 'Active' ORDER BY id",
    [schoolId]
  );
  let assigned = 0, skipConflict = 0, skipCapacity = 0;
  for (const stu of stus.rows) {
    for (const p of byPeriod.keys()) {
      if (await hasSectionInPeriod(stu.id, p)) {
        skipConflict++;
        continue;
      }
      const options = byPeriod.get(p).filter((s) => s.capacity == null || s.enrolled < s.capacity);
      if (!options.length) {
        skipCapacity++;
        continue;
      }
      const pick = options[(stu.id + p) % options.length]; // deterministic spread
      try {
        await query("INSERT INTO section_roster (section_id, student_id) VALUES ($1, $2)", [pick.id, stu.id]);
        pick.enrolled++;
        assigned++;
      } catch {
        skipConflict++;
      }
    }
  }
  res.redirect(
    "/scheduling?auto=1&school=" + schoolId +
    "&msg=" + encodeURIComponent(
      "Auto-assign complete: " + assigned + " assigned, " + skipConflict +
        " skipped by conflict, " + skipCapacity + " skipped by capacity."
    )
  );
}));

export default router;
