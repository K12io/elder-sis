import express from "express";
import { query } from "../db.js";

const router = express.Router();

const GRADES = [
  { value: "K", label: "Kindergarten" },
  { value: "1", label: "Grade 1" },
  { value: "2", label: "Grade 2" },
  { value: "3", label: "Grade 3" },
  { value: "4", label: "Grade 4" },
  { value: "5", label: "Grade 5" },
  { value: "6", label: "Grade 6" },
  { value: "7", label: "Grade 7" },
  { value: "8", label: "Grade 8" },
  { value: "9", label: "Grade 9" },
  { value: "10", label: "Grade 10" },
  { value: "11", label: "Grade 11" },
  { value: "12", label: "Grade 12" },
];

const STATUSES = ["Active", "Inactive", "Transferred", "Graduated", "Withdrawn"];

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function gradeToInt(v) {
  if (v === "K") return 0;
  if (/^\d{1,2}$/.test(v)) return Number(v);
  return null;
}

function intToGrade(n) {
  if (n === null || n === undefined) return "";
  return n === 0 ? "K" : String(n);
}

// Roster search: shared by GET / and GET /search.
async function roster(req, res, extraLocals) {
  const last = str(req.query.last);
  const first = str(req.query.first);
  const stateId = str(req.query.state_id ?? req.query.stateId);
  const gradeRaw = str(req.query.grade);
  const status = str(req.query.status);

  const where = [];
  const params = [];

  if (last) {
    params.push(`%${last}%`);
    where.push(`s.last_name ILIKE $${params.length}`);
  }
  if (first) {
    params.push(`%${first}%`);
    where.push(`s.first_name ILIKE $${params.length}`);
  }
  if (stateId) {
    params.push(`%${stateId}%`);
    where.push(`s.state_id ILIKE $${params.length}`);
  }
  const grade = gradeToInt(gradeRaw);
  if (grade !== null) {
    params.push(grade);
    where.push(`s.grade_level = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`s.status = $${params.length}`);
  }
  // Quick-search catch-all: a single term matches first OR last name OR state ID.
  const q = str(req.query.q);
  if (q && !last && !first && !stateId) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(s.last_name ILIKE ${p} OR s.first_name ILIKE ${p} OR s.state_id ILIKE ${p})`);
  }

  const hasCriteria = where.length > 0;
  const whereSql = hasCriteria ? `WHERE ${where.join(" AND ")}` : "";

  // Count all matches, but cap the rendered grid at 50 rows.
  const countSql = `SELECT count(*)::int AS n FROM students s ${whereSql}`;
  const rowsSql = `
    SELECT s.id, s.state_id, s.last_name, s.first_name, s.grade_level,
           s.gender, s.dob, s.status, sch.name AS school_name
    FROM students s
    LEFT JOIN schools sch ON sch.id = s.school_id
    ${whereSql}
    ORDER BY s.last_name, s.first_name, s.id
    LIMIT 50`;
  const [countR, rowsR] = await Promise.all([
    query(countSql, params),
    query(rowsSql, params),
  ]);

  res.render("students/index", {
    pageTitle: "Student Records",
    activeTab: "students",
    criteria: { last: last || q, first, stateId, grade: gradeRaw, status },
    hasCriteria,
    total: countR.rows[0].n,
    rows: rowsR.rows,
    grades: GRADES,
    statuses: STATUSES,
    intToGrade,
    ...extraLocals,
  });
}

router.get("/", (req, res) => roster(req, res, {}));

// Quick Search (header) resolves here. Accept q as a catch-all name/ID lookup.
router.get("/search", (req, res) => roster(req, res, {}));

router.get("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return next();

  const [studentR, contactsR, enrollR, alertsR] = await Promise.all([
    query(
      `SELECT s.*, sch.name AS school_name, sch.code AS school_code
       FROM students s LEFT JOIN schools sch ON sch.id = s.school_id
       WHERE s.id = $1`,
      [id]
    ),
    query(
      `SELECT name, relationship, phone, email, is_primary
       FROM student_contacts WHERE student_id = $1
       ORDER BY is_primary DESC, name`,
      [id]
    ),
    query(
      `SELECT e.grade_level, e.entry_date, e.exit_date, e.code,
              t.name AS term_name, t.starts_on, t.ends_on,
              sch.name AS school_name
       FROM enrollments e
       LEFT JOIN terms t ON t.id = e.term_id
       LEFT JOIN schools sch ON sch.id = e.school_id
       WHERE e.student_id = $1
       ORDER BY t.starts_on NULLS LAST, e.id`,
      [id]
    ),
    query(
      `SELECT alert_date, alert_type, message
       FROM student_alerts WHERE student_id = $1
       ORDER BY alert_date DESC NULLS LAST, id`,
      [id]
    ),
  ]);

  if (studentR.rows.length === 0) {
    return res.status(404).render("students/404", {
      pageTitle: "Student Not Found",
      activeTab: "students",
      studentId: id,
    });
  }

  res.render("students/show", {
    pageTitle: `Student ${studentR.rows[0].state_id}`,
    activeTab: "students",
    student: studentR.rows[0],
    contacts: contactsR.rows,
    enrollments: enrollR.rows,
    alerts: alertsR.rows,
    grades: GRADES,
    statuses: STATUSES,
    intToGrade,
    saved: req.query.saved === "1",
  });
});

router.post("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return next();

  const firstName = str(req.body.first_name);
  const middleName = str(req.body.middle_name) || null;
  const lastName = str(req.body.last_name);
  const gradeRaw = str(req.body.grade_level);
  const grade = gradeRaw === "" ? null : gradeToInt(gradeRaw);
  const gender = str(req.body.gender) || null;
  const dob = str(req.body.dob) || null;
  const status = str(req.body.status) || "Active";

  if (!firstName || !lastName) {
    return res.status(400).render("students/show", {
      pageTitle: "Student Record",
      activeTab: "students",
      student: { id, first_name: firstName, last_name: lastName },
      contacts: [],
      enrollments: [],
      alerts: [],
      grades: GRADES,
      statuses: STATUSES,
      intToGrade,
      saved: false,
      error: "First and last name are required.",
    });
  }

  const r = await query(
    `UPDATE students
        SET first_name = $1, middle_name = $2, last_name = $3,
            grade_level = $4, gender = $5, dob = $6, status = $7
      WHERE id = $8`,
    [firstName, middleName, lastName, grade, gender, dob, status, id]
  );
  if (r.rowCount === 0) {
    return res.status(404).render("students/404", {
      pageTitle: "Student Not Found",
      activeTab: "students",
      studentId: id,
    });
  }
  res.redirect(`/students/${id}?saved=1`);
});

export default router;
