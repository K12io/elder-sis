import express from "express";
import { query, pool } from "../db.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const CODES = [
  { value: "M", label: "M — Member (regular enrollment)" },
  { value: "T", label: "T — Temporary / transfer" },
  { value: "N", label: "N — Non-member / part-time" },
];
const GENDERS = ["M", "F"];
const RELATIONSHIPS = [
  "Mother", "Father", "Guardian", "Grandparent",
  "Stepparent", "Foster Parent", "Other",
];

// Grade level is stored as INTEGER elsewhere in the schema (K = 0).
function gradeToInt(value) {
  if (value === "" || value == null) return null;
  const s = String(value).trim().toUpperCase();
  if (s === "K" || s === "0") return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 12 ? n : null;
}

function gradeToLabel(intVal) {
  if (intVal === null || intVal === undefined) return "";
  return Number(intVal) === 0 ? "K" : String(intVal);
}

function trimOrNull(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

// pg returns DATE columns as JS Date objects at local midnight; render them in
// the classic YYYY-MM-DD form regardless of driver configuration.
function fmtDate(v) {
  if (v == null) return "";
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// Pull the raw registration body into a normalized shape used by both the
// validation step and the form re-render.
function readForm(body) {
  return {
    last_name: trimOrNull(body.last_name),
    first_name: trimOrNull(body.first_name),
    middle_name: trimOrNull(body.middle_name),
    dob: trimOrNull(body.dob),
    gender: trimOrNull(body.gender),
    grade_level: trimOrNull(body.grade_level),
    school_id: trimOrNull(body.school_id),
    entry_date: trimOrNull(body.entry_date),
    term_id: trimOrNull(body.term_id),
    code: trimOrNull(body.code),
    guardian_name: trimOrNull(body.guardian_name),
    guardian_relationship: trimOrNull(body.guardian_relationship),
    guardian_phone: trimOrNull(body.guardian_phone),
    guardian_email: trimOrNull(body.guardian_email),
  };
}

// Returns an array of human-readable validation messages (empty = valid).
function validate(form) {
  const errors = [];
  if (!form.last_name) errors.push("Last name is required.");
  if (!form.first_name) errors.push("First name is required.");
  if (!form.dob) errors.push("Birth date is required.");
  else if (!isDate(form.dob)) errors.push("Birth date must be a valid YYYY-MM-DD date.");
  if (form.gender && !GENDERS.includes(form.gender)) errors.push("Gender must be M or F.");
  if (form.grade_level === null || form.grade_level === "") {
    errors.push("Grade level is required.");
  } else if (gradeToInt(form.grade_level) === null) {
    errors.push("Grade level must be K or a number from 1 to 12.");
  }
  if (!form.school_id || !/^\d+$/.test(form.school_id)) {
    errors.push("School is required.");
  }
  if (!form.entry_date) errors.push("Entry date is required.");
  else if (!isDate(form.entry_date)) errors.push("Entry date must be a valid YYYY-MM-DD date.");
  if (!form.term_id || !/^\d+$/.test(form.term_id)) {
    errors.push("Term is required.");
  }
  if (!form.code) errors.push("Enrollment code is required.");
  else if (!CODES.some((c) => c.value === form.code)) {
    errors.push("Enrollment code must be M, T, or N.");
  }
  return errors;
}

// Lookup tables for the form. Current term is preselected; district-level
// terms (school_id NULL) plus any matching the chosen school are offered.
async function formLookups() {
  const [schools, terms] = await Promise.all([
    query("SELECT id, name, code FROM schools ORDER BY id"),
    query(
      `SELECT id, name, is_current
         FROM terms
        WHERE school_id IS NULL
        ORDER BY is_current DESC, id`
    ),
  ]);
  const current = terms.rows.find((t) => t.is_current);
  return { schools: schools.rows, terms: terms.rows, currentTermId: current ? current.id : null };
}

async function renderNewForm(res, { form, errors = [], duplicates = [], values = null, status = 200, notice = null }) {
  const lookups = await formLookups();
  res.status(status).render("enrollment/new", {
    pageTitle: "Register a New Student",
    activeTab: "students",
    schools: lookups.schools,
    terms: lookups.terms,
    currentTermId: lookups.currentTermId,
    grades: GRADES,
    codes: CODES,
    genders: GENDERS,
    relationships: RELATIONSHIPS,
    form: form ?? {},
    errors,
    duplicates,
    // On "enroll anyway" the browser re-posts the same values; keep them.
    values,
    notice,
  });
}

// ---------------------------------------------------------------------------
// GET /enrollment — landing page
// ---------------------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const [recent, currentTerm, totals] = await Promise.all([
      query(
        `SELECT e.id,
                e.entry_date,
                e.exit_date,
                e.code,
                s.id          AS student_id,
                s.state_id,
                s.first_name,
                s.last_name,
                sch.name      AS school_name,
                t.name        AS term_name,
                t.is_current  AS term_current
           FROM enrollments e
           JOIN students s  ON s.id = e.student_id
           LEFT JOIN schools sch ON sch.id = e.school_id
           LEFT JOIN terms  t   ON t.id = e.term_id
          ORDER BY e.entry_date DESC NULLS LAST, e.id DESC
          LIMIT 25`
      ),
      query("SELECT id, name FROM terms WHERE is_current LIMIT 1"),
      query("SELECT count(*)::int AS n FROM enrollments WHERE exit_date IS NULL"),
    ]);
    res.render("enrollment/index", {
      pageTitle: "Enrollment",
      activeTab: "students",
      recent: recent.rows.map((r) => ({
        ...r,
        entry_date: fmtDate(r.entry_date),
        exit_date: fmtDate(r.exit_date),
      })),
      currentTerm: currentTerm.rows[0] ?? null,
      activeCount: totals.rows[0].n,
      notice: typeof req.query.notice === "string" ? req.query.notice : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /enrollment/new — registration form
// ---------------------------------------------------------------------------

router.get("/new", async (req, res, next) => {
  try {
    const lookups = await formLookups();
    await renderNewForm(res, {
      form: {
        entry_date: new Date().toISOString().slice(0, 10),
        code: "M",
        term_id: lookups.currentTermId ? String(lookups.currentTermId) : "",
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /enrollment/new — duplicate check + insert
// ---------------------------------------------------------------------------

router.post("/new", async (req, res, next) => {
  const form = readForm(req.body);
  const confirmed = req.body.confirm === "1";

  try {
    const errors = validate(form);
    if (errors.length) {
      return renderNewForm(res, { form, errors, status: 400, values: form });
    }

    // Duplicate check: last name (case-insensitive) + birth date.
    if (!confirmed) {
      const dupes = await query(
        `SELECT s.id, s.state_id, s.first_name, s.middle_name, s.last_name,
                s.grade_level, s.dob, s.status,
                sch.name AS school_name
           FROM students s
           LEFT JOIN schools sch ON sch.id = s.school_id
          WHERE lower(s.last_name) = lower($1)
            AND s.dob = $2::date
          ORDER BY s.id`,
        [form.last_name, form.dob]
      );
      if (dupes.rows.length) {
        return renderNewForm(res, {
          form,
          duplicates: dupes.rows,
          status: 409,
          values: form,
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const gradeInt = gradeToInt(form.grade_level);
      const schoolId = Number(form.school_id);
      const termId = Number(form.term_id);

      // Generate a unique state ID in the existing "VA" + 6-digit style.
      const maxRow = await client.query(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(state_id, '\\D', '', 'g'), '')::bigint), 100000) AS max
           FROM students
          WHERE state_id LIKE 'VA%'`
      );
      let nextNum = Number(maxRow.rows[0].max) + 1;
      let stateId = `VA${String(nextNum).padStart(6, "0")}`;
      for (let attempt = 0; attempt < 50; attempt++) {
        const clash = await client.query("SELECT 1 FROM students WHERE state_id = $1", [stateId]);
        if (!clash.rows.length) break;
        nextNum += 1;
        stateId = `VA${String(nextNum).padStart(6, "0")}`;
      }

      const student = await client.query(
        `INSERT INTO students
           (state_id, last_name, first_name, middle_name, grade_level,
            gender, dob, school_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,'Active')
         RETURNING id, state_id`,
        [
          stateId, form.last_name, form.first_name, form.middle_name,
          gradeInt, form.gender, form.dob, schoolId,
        ]
      );
      const studentId = student.rows[0].id;

      // Enrollment row: current term (the term chosen on the form).
      await client.query(
        `INSERT INTO enrollments
           (student_id, school_id, term_id, entry_date, exit_date, grade_level, code)
         VALUES ($1,$2,$3,$4::date,NULL,$5,$6)`,
        [studentId, schoolId, termId, form.entry_date, gradeInt, form.code]
      );

      // Audit event.
      const noteParts = [
        `Guardian: ${form.guardian_name ?? "(not provided)"}`,
        form.guardian_relationship ? `Relationship: ${form.guardian_relationship}` : null,
        form.guardian_phone ? `Phone: ${form.guardian_phone}` : null,
        form.guardian_email ? `Email: ${form.guardian_email}` : null,
      ].filter(Boolean);
      await client.query(
        `INSERT INTO enrollment_events (student_id, action, occurred_at, note)
         VALUES ($1, 'enrolled', now(), $2)`,
        [studentId, noteParts.join(" | ")]
      );

      await client.query("COMMIT");
      return res.redirect(303, `/enrollment/confirm?student=${studentId}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    // A unique violation on state_id is the only realistic race; surface a
    // clean error box instead of crashing.
    if (err && err.code === "23505") {
      return renderNewForm(res, {
        form,
        errors: ["Could not generate a unique state ID. Please submit again."],
        status: 409,
        values: form,
      });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /enrollment/confirm?student=<id> — confirmation page
// ---------------------------------------------------------------------------

router.get("/confirm", async (req, res, next) => {
  try {
    const studentId = Number(req.query.student);
    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).render("enrollment/confirm", {
        pageTitle: "Enrollment Confirmation",
        activeTab: "students",
        student: null,
        enrollment: null,
        error: "No student was specified for confirmation.",
      });
    }
    const result = await query(
      `SELECT s.id, s.state_id, s.first_name, s.middle_name, s.last_name,
              s.grade_level, s.gender, s.dob, s.status,
              sch.name AS school_name,
              e.id AS enrollment_id, e.entry_date, e.exit_date, e.code,
              t.name AS term_name
         FROM students s
         LEFT JOIN schools sch ON sch.id = s.school_id
         LEFT JOIN enrollments e ON e.student_id = s.id
         LEFT JOIN terms t ON t.id = e.term_id
        WHERE s.id = $1
        ORDER BY e.entry_date DESC NULLS LAST, e.id DESC`,
      [studentId]
    );
    if (!result.rows.length) {
      return res.status(404).render("enrollment/confirm", {
        pageTitle: "Enrollment Confirmation",
        activeTab: "students",
        student: null,
        enrollment: null,
        error: `No student found with id ${studentId}.`,
      });
    }
    const enrollment = result.rows.find((r) => r.enrollment_id) ?? null;
    const student = {
      ...result.rows[0],
      dob: fmtDate(result.rows[0].dob),
    };
    res.render("enrollment/confirm", {
      pageTitle: "Enrollment Confirmation",
      activeTab: "students",
      student,
      enrollment: enrollment
        ? { ...enrollment, entry_date: fmtDate(enrollment.entry_date), exit_date: fmtDate(enrollment.exit_date) }
        : null,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// The home page links to /enrollment/register — alias it to the form.
router.get("/register", (req, res) => res.redirect(302, "/enrollment/new"));

// ---------------------------------------------------------------------------
// POST /enrollment/:studentId/withdraw
// ---------------------------------------------------------------------------

router.post("/:studentId/withdraw", async (req, res, next) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    return res.status(400).send("Invalid student id");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const student = await client.query(
      "SELECT id, state_id, first_name, last_name FROM students WHERE id = $1",
      [studentId]
    );
    if (!student.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).send("Student not found");
    }

    const open = await client.query(
      `UPDATE enrollments
          SET exit_date = CURRENT_DATE
        WHERE student_id = $1
          AND exit_date IS NULL
        RETURNING id`,
      [studentId]
    );

    await client.query(
      "UPDATE students SET status = 'Withdrawn' WHERE id = $1",
      [studentId]
    );

    const s = student.rows[0];
    await client.query(
      `INSERT INTO enrollment_events (student_id, action, occurred_at, note)
       VALUES ($1, 'withdrawn', now(), $2)`,
      [
        studentId,
        `Withdrew ${open.rows.length} open enrollment row(s) effective ` +
          new Date().toISOString().slice(0, 10),
      ]
    );

    await client.query("COMMIT");
    res.redirect(303, "/enrollment?notice=Student+withdrawn");
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

export default router;
