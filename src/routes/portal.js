import express from "express";
import { query } from "../db.js";

// ---------------------------------------------------------------------------
// Parent / Student Portal  (read-only)
// ---------------------------------------------------------------------------
// A no-login, parent-facing slice over existing SIS data. Every query here is
// SELECT-only. Mounted automatically at "/portal" by src/app.js.
// ---------------------------------------------------------------------------

const router = express.Router();

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function gradeLabel(g) {
  if (g === null || g === undefined) return "—";
  return g === 0 ? "K" : String(g);
}

// Shared student-record loader used by both the screen and print views.
// Returns { student, term, schedule, finalGrades, standings, attendance, contacts, alerts }
// or { student: null } when the id does not resolve.
async function loadStudent(id) {
  const [studentR, termR] = await Promise.all([
    query(
      `SELECT s.id, s.state_id, s.last_name, s.first_name, s.middle_name,
              s.grade_level, s.gender, s.dob, s.status,
              sch.name AS school_name, sch.code AS school_code
         FROM students s
         LEFT JOIN schools sch ON sch.id = s.school_id
        WHERE s.id = $1`,
      [id]
    ),
    query("SELECT id, name, starts_on, ends_on FROM terms WHERE is_current LIMIT 1"),
  ]);

  const student = studentR.rows[0];
  if (!student) return { student: null };

  const term = termR.rows[0] || null;

  // Current schedule: roster rows joined to current-term sections, by period.
  const scheduleR = term
    ? await query(
        `SELECT sec.id AS section_id, sec.period, sec.course_name, sec.section_code,
                sec.room, t.name AS teacher_name, t.dept AS teacher_dept
           FROM section_roster sr
           JOIN sections sec ON sec.id = sr.section_id
           LEFT JOIN teachers t ON t.id = sec.teacher_id
          WHERE sr.student_id = $1 AND sec.term_id = $2
          ORDER BY sec.period NULLS LAST, sec.course_name`,
        [id, term.id]
      )
    : { rows: [] };

  // Posted final grades for the current term.
  const finalR = term
    ? await query(
        `SELECT fg.percent, fg.letter, fg.points, fg.posted_on,
                sec.course_name, sec.section_code, sec.id AS section_id
           FROM final_grades fg
           JOIN sections sec ON sec.id = fg.section_id
          WHERE fg.student_id = $1 AND fg.term_id = $2
          ORDER BY sec.period NULLS LAST, sec.course_name`,
        [id, term.id]
      )
    : { rows: [] };

  const finalGrades = finalR.rows;
  const postedSectionIds = new Set(
    finalGrades.map((r) => Number(r.section_id))
  );

  // Computed standings from grade_scores (weighted by category) for rostered
  // current-term sections that have NO posted final grade. Sections with no
  // usable scores show "—".
  const standings = [];
  if (term && scheduleR.rows.length) {
    const sectionIds = scheduleR.rows.map((r) => Number(r.section_id));
    const [scoresR, scaleR] = await Promise.all([
      query(
        `SELECT a.section_id, a.points AS possible,
                c.id AS category_id, c.name AS category_name,
                COALESCE(c.weight, 0) AS weight,
                gs.code, gs.points AS earned
           FROM grade_assignments a
           LEFT JOIN grade_categories c ON c.id = a.category_id
           LEFT JOIN grade_scores gs
                  ON gs.assignment_id = a.id AND gs.student_id = $2
          WHERE a.section_id = ANY($1::int[])`,
        [sectionIds, id]
      ),
      query("SELECT letter, min_percent, max_percent FROM grade_scale"),
    ]);

    // Per-section category buckets.
    const bySection = new Map();
    for (const r of scoresR.rows) {
      const sid = Number(r.section_id);
      if (!bySection.has(sid)) bySection.set(sid, new Map());
      const cats = bySection.get(sid);
      const key = r.category_id ?? 0;
      if (!cats.has(key)) {
        cats.set(key, {
          name: r.category_name || "Uncategorized",
          weight: Number(r.weight || 0),
          earned: 0,
          possible: 0,
        });
      }
      const cat = cats.get(key);
      if (r.code === "X") continue; // exempt: no effect on standing
      cat.possible += Number(r.possible || 0);
      cat.earned += Number(r.earned || 0); // missing/null earned counts as 0
    }

    const bands = scaleR.rows
      .map((b) => ({
        letter: b.letter,
        min: Number(b.min_percent),
        max: Number(b.max_percent),
      }))
      .sort((a, b) => b.min - a.min);

    const letterFor = (pct) => {
      if (pct == null || !bands.length) return null;
      const band =
        bands.find((b) => pct >= b.min && pct <= b.max) || bands.at(-1);
      return band ? band.letter : null;
    };

    for (const sec of scheduleR.rows) {
      const sid = Number(sec.section_id);
      if (postedSectionIds.has(sid)) continue; // posted grade wins
      const cats = bySection.get(sid);
      let pct = null;
      if (cats) {
        let weightedSum = 0;
        let weightBasis = 0;
        for (const c of cats.values()) {
          if (c.possible <= 0) continue;
          const cpt = (c.earned / c.possible) * 100;
          weightedSum += cpt * c.weight;
          weightBasis += c.weight;
        }
        if (weightBasis > 0) pct = weightedSum / weightBasis;
        else {
          // No category weights at all: fall back to raw points.
          let earned = 0;
          let possible = 0;
          for (const c of cats.values()) {
            earned += c.earned;
            possible += c.possible;
          }
          if (possible > 0) pct = (earned / possible) * 100;
        }
      }
      standings.push({
        section_id: sid,
        period: sec.period,
        course_name: sec.course_name,
        section_code: sec.section_code,
        percent: pct,
        letter: letterFor(pct),
      });
    }
  }

  // Attendance summary: inclusive dates + per-code counts.
  const attRowsR = await query(
    `SELECT ac.code, ac.label, ac.counts_absent, ac.excused,
            COALESCE(ac.sort_order, 0) AS sort_order,
            count(ad.id)::int AS n
       FROM attendance_codes ac
       LEFT JOIN attendance_daily ad
              ON ad.code = ac.code AND ad.student_id = $1
      GROUP BY ac.code, ac.label, ac.counts_absent, ac.excused, ac.sort_order
      ORDER BY ac.sort_order, ac.code`,
    [id]
  );

  const attendance = attRowsR.rows;
  const totalMarked = attendance.reduce((sum, r) => sum + Number(r.n || 0), 0);
  const absentCount = attendance.reduce(
    (sum, r) => sum + (r.counts_absent ? Number(r.n || 0) : 0),
    0
  );
  const attendanceRate =
    totalMarked > 0
      ? ((totalMarked - absentCount) / totalMarked) * 100
      : null;

  const [contactsR, alertsR] = await Promise.all([
    query(
      `SELECT name, relationship, phone, email, is_primary
         FROM student_contacts
        WHERE student_id = $1
        ORDER BY is_primary DESC, name`,
      [id]
    ),
    query(
      `SELECT alert_date, alert_type, message
         FROM student_alerts
        WHERE student_id = $1
        ORDER BY alert_date DESC NULLS LAST, id`,
      [id]
    ),
  ]);

  return {
    student,
    term,
    schedule: scheduleR.rows,
    finalGrades,
    standings,
    attendance,
    totalMarked,
    absentCount,
    attendanceRate,
    contacts: contactsR.rows,
    alerts: alertsR.rows,
  };
}

// ---- Landing: "Find your student" -----------------------------------------

router.get("/", async (req, res) => {
  const q = str(req.query.q);
  const searching = q.length > 0;

  let rows = [];
  if (searching) {
    rows = (
      await query(
        `SELECT s.id, s.state_id, s.last_name, s.first_name, s.grade_level,
                sch.name AS school_name
           FROM students s
           LEFT JOIN schools sch ON sch.id = s.school_id
          WHERE s.last_name ILIKE $1
             OR s.first_name ILIKE $1
             OR s.state_id ILIKE $1
          ORDER BY s.last_name, s.first_name, s.id
          LIMIT 50`,
        [`%${q}%`]
      )
    ).rows;
  } else {
    // No search: the 20 most recent records.
    rows = (
      await query(
        `SELECT s.id, s.state_id, s.last_name, s.first_name, s.grade_level,
                sch.name AS school_name
           FROM students s
           LEFT JOIN schools sch ON sch.id = s.school_id
          ORDER BY s.id DESC
          LIMIT 20`
      )
    ).rows;
  }

  res.render("portal/index", {
    pageTitle: "Parent & Student Portal",
    activeTab: "portal",
    q,
    searching,
    rows,
    gradeLabel,
  });
});

// ---- Printable sheet (declared before /student is fine; paths differ) ------

router.get("/print", async (req, res) => {
  const id = toId(req.query.student);
  if (!id) {
    return res.status(404).render("portal/print", {
      pageTitle: "Student Not Found",
      activeTab: "portal",
      notFound: true,
      studentId: req.query.student ?? "",
      printedOn: new Date(),
      gradeLabel,
    });
  }
  const data = await loadStudent(id);
  if (!data.student) {
    return res.status(404).render("portal/print", {
      pageTitle: "Student Not Found",
      activeTab: "portal",
      notFound: true,
      studentId: id,
      printedOn: new Date(),
      gradeLabel,
    });
  }
  res.render("portal/print", {
    pageTitle: `Print :: ${data.student.last_name}, ${data.student.first_name}`,
    activeTab: "portal",
    notFound: false,
    printedOn: new Date(),
    gradeLabel,
    ...data,
  });
});

// ---- Student portal page ---------------------------------------------------

router.get("/student", async (req, res) => {
  const id = toId(req.query.student);
  if (!id) {
    return res.status(404).render("portal/student", {
      pageTitle: "Student Not Found",
      activeTab: "portal",
      notFound: true,
      studentId: req.query.student ?? "",
      gradeLabel,
    });
  }
  const data = await loadStudent(id);
  if (!data.student) {
    return res.status(404).render("portal/student", {
      pageTitle: "Student Not Found",
      activeTab: "portal",
      notFound: true,
      studentId: id,
      gradeLabel,
    });
  }
  res.render("portal/student", {
    pageTitle: `Portal :: ${data.student.last_name}, ${data.student.first_name}`,
    activeTab: "portal",
    notFound: false,
    gradeLabel,
    ...data,
  });
});

export default router;
