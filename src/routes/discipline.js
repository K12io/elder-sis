import express from "express";
import { pool, query } from "../db.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const ENCOUNTER_TYPES = [
  "Illness",
  "Injury",
  "Medication",
  "Chronic condition",
  "Screening",
  "Other",
];

const HEALTH_FLAGS = [
  "Asthma",
  "Peanut allergy",
  "Medication on file",
  "Seizure care plan",
  "Diabetes care plan",
  "Vision concern",
  "Hearing concern",
  "Other",
];

const FLAG_OTHER = "Other";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function orNull(v) {
  const s = str(v);
  return s === "" ? null : s;
}

function parseId(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isoDate(v) {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function snippet(v, n = 60) {
  const s = str(v);
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}\u2026`;
}

/** Current district term (falls back to the first term by start date). */
async function currentTerm() {
  const r = await query(
    `SELECT id, name, starts_on, ends_on
       FROM terms
      WHERE is_current
      ORDER BY starts_on DESC
      LIMIT 1`
  );
  if (r.rows.length) return r.rows[0];
  const f = await query(
    "SELECT id, name, starts_on, ends_on FROM terms ORDER BY starts_on DESC LIMIT 1"
  );
  return f.rows[0] || null;
}

async function loadCodes() {
  const r = await query(
    `SELECT code, label, severity, description
       FROM discipline_codes
      ORDER BY sort_order, severity, code`
  );
  return r.rows;
}

async function loadSchools() {
  const r = await query("SELECT id, name, code FROM schools ORDER BY id");
  return r.rows;
}

/** Active students for the picker, capped for the classic select. */
async function loadStudentPicker() {
  const r = await query(
    `SELECT id, last_name, first_name, state_id, grade_level
       FROM students
      WHERE status = 'Active'
      ORDER BY last_name, first_name, id
      LIMIT 300`
  );
  return r.rows;
}

async function studentExists(id) {
  if (id === null) return null;
  const r = await query(
    `SELECT s.id, s.last_name, s.first_name, s.state_id, s.grade_level,
            sch.name AS school_name, sch.code AS school_code
       FROM students s
       LEFT JOIN schools sch ON sch.id = s.school_id
      WHERE s.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

/** Friendly landed-error render helper; never throws out of a route. */
function fail(res, status, message, activeTab = "discipline") {
  return res.status(status).render("discipline/error", {
    pageTitle: "Discipline & Health",
    activeTab,
    message,
    status,
  });
}

// ---------------------------------------------------------------------------
// GET /discipline — combined landing
// ---------------------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const term = await currentTerm();
    const from = term ? isoDate(term.starts_on) : null;
    const to = term ? isoDate(term.ends_on) : null;

    const termFilter = from && to ? "WHERE incident_date BETWEEN $1 AND $2" : "";
    const encFilter = from && to ? "WHERE encounter_date BETWEEN $1 AND $2" : "";
    const termParams = from && to ? [from, to] : [];

    const [inc, flags, enc, byCode, codeCount] = await Promise.all([
      query(`SELECT count(*)::int AS n FROM discipline_incidents ${termFilter}`, termParams),
      query(
        `SELECT count(DISTINCT student_id)::int AS n,
                count(*)::int AS flags_total
           FROM health_flags`
      ),
      query(`SELECT count(*)::int AS n FROM health_encounters ${encFilter}`, termParams),
      query(
        `SELECT dc.code, dc.label, count(*)::int AS n
           FROM discipline_incidents di
           JOIN discipline_codes dc ON dc.code = di.code
           ${from && to ? "WHERE di.incident_date BETWEEN $1 AND $2" : ""}
          GROUP BY dc.code, dc.label
          ORDER BY n DESC, dc.code`,
        termParams
      ),
      query("SELECT count(*)::int AS n FROM discipline_codes"),
    ]);

    res.render("discipline/index", {
      pageTitle: "Discipline & Health",
      activeTab: "discipline",
      term,
      termFrom: from,
      termTo: to,
      incidentCount: inc.rows[0].n,
      flaggedStudents: flags.rows[0].n,
      flagCount: flags.rows[0].flags_total,
      encounterCount: enc.rows[0].n,
      byCode: byCode.rows,
      codeCount: codeCount.rows[0].n,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /discipline/incidents — filter bar + dense table + add form
// ---------------------------------------------------------------------------

router.get("/incidents", async (req, res, next) => {
  try {
    const from = isDate(req.query.from) ? req.query.from : null;
    const to = isDate(req.query.to) ? req.query.to : null;
    const schoolId = parseId(req.query.school);
    const gradeRaw = str(req.query.grade);
    const code = str(req.query.code).toUpperCase();
    const last = str(req.query.last);

    const grade =
      gradeRaw === "K" ? 0 : /^\d{1,2}$/.test(gradeRaw) ? Number(gradeRaw) : null;

    const where = [];
    const params = [];
    if (from) { params.push(from); where.push(`di.incident_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`di.incident_date <= $${params.length}`); }
    if (schoolId !== null) { params.push(schoolId); where.push(`st.school_id = $${params.length}`); }
    if (grade !== null) { params.push(grade); where.push(`st.grade_level = $${params.length}`); }
    if (code) { params.push(code); where.push(`di.code = $${params.length}`); }
    if (last) { params.push(`${last}%`); where.push(`st.last_name ILIKE $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows, count, codes, schools, students] = await Promise.all([
      query(
        `SELECT di.id, di.incident_date, di.code, di.description, di.action_taken,
                di.reported_by, di.parent_notified, di.follow_up_date,
                dc.label AS code_label, dc.severity,
                st.id AS student_id, st.last_name, st.first_name, st.state_id,
                st.grade_level, sc.name AS school_name, sc.code AS school_code
           FROM discipline_incidents di
           JOIN students st ON st.id = di.student_id
           JOIN discipline_codes dc ON dc.code = di.code
           LEFT JOIN schools sc ON sc.id = st.school_id
           ${whereSql}
          ORDER BY di.incident_date DESC, st.last_name, st.first_name, di.id DESC
          LIMIT 500`,
        params
      ),
      query(
        `SELECT count(*)::int AS n
           FROM discipline_incidents di
           JOIN students st ON st.id = di.student_id
           ${whereSql}`,
        params
      ),
      loadCodes(),
      loadSchools(),
      loadStudentPicker(),
    ]);

    res.render("discipline/incidents", {
      pageTitle: "Discipline Incidents",
      activeTab: "discipline",
      filters: { from: req.query.from ?? "", to: req.query.to ?? "", school: schoolId, grade: gradeRaw, code, last },
      rows: rows.rows,
      total: count.rows[0].n,
      codes,
      schools,
      students,
      saved: req.query.saved === "1",
      snippet,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discipline/incidents — add one incident
// ---------------------------------------------------------------------------

router.post("/incidents", async (req, res, next) => {
  try {
    const studentId = parseId(req.body.student_id);
    const incidentDate = str(req.body.incident_date);
    const code = str(req.body.code).toUpperCase();

    if (studentId === null) return fail(res, 400, "A student must be selected before saving an incident.");
    const student = await studentExists(studentId);
    if (!student) return fail(res, 404, `No student found with id ${studentId}.`);

    if (!isDate(incidentDate)) {
      return fail(res, 400, "Incident date is required and must be a real date in YYYY-MM-DD form.");
    }

    const codeR = await query("SELECT code FROM discipline_codes WHERE code = $1", [code]);
    if (codeR.rows.length === 0) return fail(res, 400, `Unknown discipline code "${code}".`);

    const followUp = str(req.body.follow_up_date);
    if (followUp && !isDate(followUp)) {
      return fail(res, 400, "Follow-up date must be a real date in YYYY-MM-DD form (or left blank).");
    }

    await query(
      `INSERT INTO discipline_incidents
         (student_id, incident_date, code, description, action_taken,
          reported_by, parent_notified, follow_up_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        studentId,
        incidentDate,
        code,
        orNull(req.body.description),
        orNull(req.body.action_taken),
        orNull(req.body.reported_by),
        req.body.parent_notified === "on" || req.body.parent_notified === "true",
        followUp || null,
      ]
    );

    res.redirect("/discipline/incidents?saved=1");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /discipline/incidents/student?student=<id>
// ---------------------------------------------------------------------------

router.get("/incidents/student", async (req, res, next) => {
  try {
    const studentId = parseId(req.query.student);
    if (studentId === null) return fail(res, 400, "A student id is required (?student=<id>).");

    const student = await studentExists(studentId);
    if (!student) return fail(res, 404, `No student found with id ${studentId}.`);

    const [incidents, byCode, flags] = await Promise.all([
      query(
        `SELECT di.id, di.incident_date, di.code, di.description, di.action_taken,
                di.reported_by, di.parent_notified, di.follow_up_date,
                dc.label AS code_label, dc.severity
           FROM discipline_incidents di
           JOIN discipline_codes dc ON dc.code = di.code
          WHERE di.student_id = $1
          ORDER BY di.incident_date DESC, di.id DESC`,
        [studentId]
      ),
      query(
        `SELECT dc.code, dc.label, count(*)::int AS n
           FROM discipline_incidents di
           JOIN discipline_codes dc ON dc.code = di.code
          WHERE di.student_id = $1
          GROUP BY dc.code, dc.label
          ORDER BY n DESC, dc.code`,
        [studentId]
      ),
      query(
        `SELECT flag, note, recorded_on
           FROM health_flags
          WHERE student_id = $1
          ORDER BY flag`,
        [studentId]
      ),
    ]);

    res.render("discipline/incident-student", {
      pageTitle: `Discipline History — ${student.last_name}, ${student.first_name}`,
      activeTab: "discipline",
      student,
      incidents: incidents.rows,
      byCode: byCode.rows,
      flags: flags.rows,
      snippet,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /discipline/health — filters, encounter table, flag table, two forms
// ---------------------------------------------------------------------------

router.get("/health", async (req, res, next) => {
  try {
    const from = isDate(req.query.from) ? req.query.from : null;
    const to = isDate(req.query.to) ? req.query.to : null;
    const schoolId = parseId(req.query.school);
    const gradeRaw = str(req.query.grade);
    const type = str(req.query.type);
    const flag = str(req.query.flag);

    const grade =
      gradeRaw === "K" ? 0 : /^\d{1,2}$/.test(gradeRaw) ? Number(gradeRaw) : null;

    // Encounter filters
    const eWhere = [];
    const eParams = [];
    if (from) { eParams.push(from); eWhere.push(`he.encounter_date >= $${eParams.length}`); }
    if (to) { eParams.push(to); eWhere.push(`he.encounter_date <= $${eParams.length}`); }
    if (schoolId !== null) { eParams.push(schoolId); eWhere.push(`st.school_id = $${eParams.length}`); }
    if (grade !== null) { eParams.push(grade); eWhere.push(`st.grade_level = $${eParams.length}`); }
    if (type) { eParams.push(type); eWhere.push(`he.encounter_type = $${eParams.length}`); }
    if (flag) {
      eParams.push(flag);
      eWhere.push(`EXISTS (SELECT 1 FROM health_flags f2 WHERE f2.student_id = st.id AND f2.flag = $${eParams.length})`);
    }

    // Flag filters (date range applies to recorded_on; type filter N/A on this table)
    const fWhere = [];
    const fParams = [];
    if (from) { fParams.push(from); fWhere.push(`f.recorded_on >= $${fParams.length}`); }
    if (to) { fParams.push(to); fWhere.push(`f.recorded_on <= $${fParams.length}`); }
    if (schoolId !== null) { fParams.push(schoolId); fWhere.push(`st.school_id = $${fParams.length}`); }
    if (grade !== null) { fParams.push(grade); fWhere.push(`st.grade_level = $${fParams.length}`); }
    if (flag) { fParams.push(flag); fWhere.push(`f.flag = $${fParams.length}`); }

    const eWhereSql = eWhere.length ? `WHERE ${eWhere.join(" AND ")}` : "";
    const fWhereSql = fWhere.length ? `WHERE ${fWhere.join(" AND ")}` : "";

    const [encounters, flagRows, eCount, schools, students] = await Promise.all([
      query(
        `SELECT he.id, he.encounter_date, he.encounter_type, he.complaint,
                he.treatment, he.disposition, he.seen_by,
                st.id AS student_id, st.last_name, st.first_name, st.state_id,
                st.grade_level, sc.name AS school_name, sc.code AS school_code
           FROM health_encounters he
           JOIN students st ON st.id = he.student_id
           LEFT JOIN schools sc ON sc.id = st.school_id
           ${eWhereSql}
          ORDER BY he.encounter_date DESC, st.last_name, st.first_name, he.id DESC
          LIMIT 500`,
        eParams
      ),
      query(
        `SELECT f.student_id, f.flag, f.note, f.recorded_on,
                st.last_name, st.first_name, st.state_id, st.grade_level,
                sc.code AS school_code
           FROM health_flags f
           JOIN students st ON st.id = f.student_id
           LEFT JOIN schools sc ON sc.id = st.school_id
           ${fWhereSql}
          ORDER BY st.last_name, st.first_name, f.flag
          LIMIT 500`,
        fParams
      ),
      query(
        `SELECT count(*)::int AS n
           FROM health_encounters he
           JOIN students st ON st.id = he.student_id
           ${eWhereSql}`,
        eParams
      ),
      loadSchools(),
      loadStudentPicker(),
    ]);

    res.render("discipline/health", {
      pageTitle: "Health Office",
      activeTab: "discipline",
      filters: {
        from: req.query.from ?? "", to: req.query.to ?? "",
        school: schoolId, grade: gradeRaw, type, flag,
      },
      encounters: encounters.rows,
      flagRows: flagRows.rows,
      encounterTotal: eCount.rows[0].n,
      encounterTypes: ENCOUNTER_TYPES,
      flagChoices: HEALTH_FLAGS,
      flagOther: FLAG_OTHER,
      schools,
      students,
      saved: str(req.query.saved),
      snippet,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discipline/health/encounters — add one nurse encounter
// ---------------------------------------------------------------------------

router.post("/health/encounters", async (req, res, next) => {
  try {
    const studentId = parseId(req.body.student_id);
    const date = str(req.body.encounter_date);
    const type = str(req.body.encounter_type);

    if (studentId === null) return fail(res, 400, "A student must be selected before saving an encounter.");
    const student = await studentExists(studentId);
    if (!student) return fail(res, 404, `No student found with id ${studentId}.`);

    if (!isDate(date)) {
      return fail(res, 400, "Encounter date is required and must be a real date in YYYY-MM-DD form.");
    }
    if (!ENCOUNTER_TYPES.includes(type)) {
      return fail(res, 400, `Unknown encounter type "${type}".`);
    }

    await query(
      `INSERT INTO health_encounters
         (student_id, encounter_date, encounter_type, complaint, treatment, disposition, seen_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        studentId,
        date,
        type,
        orNull(req.body.complaint),
        orNull(req.body.treatment),
        orNull(req.body.disposition),
        orNull(req.body.seen_by),
      ]
    );

    res.redirect("/discipline/health?saved=encounter");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discipline/health/flags — add or update a health flag (upsert)
// ---------------------------------------------------------------------------

router.post("/health/flags", async (req, res, next) => {
  try {
    const studentId = parseId(req.body.student_id);
    let flag = str(req.body.flag);
    if (flag === FLAG_OTHER) flag = str(req.body.flag_other);

    if (studentId === null) return fail(res, 400, "A student must be selected before saving a health flag.");
    const student = await studentExists(studentId);
    if (!student) return fail(res, 404, `No student found with id ${studentId}.`);

    if (!flag) return fail(res, 400, "A health flag value is required (choose one or name an 'Other' flag).");
    if (!HEALTH_FLAGS.includes(flag) && flag !== str(req.body.flag_other)) {
      // Allow only the enumerated set or an explicit Other value.
      return fail(res, 400, `Unknown health flag "${flag}".`);
    }

    await query(
      `INSERT INTO health_flags (student_id, flag, note, recorded_on)
       VALUES ($1, $2, $3, CURRENT_DATE)
       ON CONFLICT (student_id, flag)
       DO UPDATE SET note = EXCLUDED.note, recorded_on = CURRENT_DATE`,
      [studentId, flag, orNull(req.body.note)]
    );

    res.redirect("/discipline/health?saved=flag");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /discipline/health/student?student=<id> — one student's health record
// ---------------------------------------------------------------------------

router.get("/health/student", async (req, res, next) => {
  try {
    const studentId = parseId(req.query.student);
    if (studentId === null) return fail(res, 400, "A student id is required (?student=<id>).");

    const student = await studentExists(studentId);
    if (!student) return fail(res, 404, `No student found with id ${studentId}.`);

    const [flags, encounters, alerts] = await Promise.all([
      query(
        `SELECT flag, note, recorded_on
           FROM health_flags
          WHERE student_id = $1
          ORDER BY flag`,
        [studentId]
      ),
      query(
        `SELECT encounter_date, encounter_type, complaint, treatment, disposition, seen_by
           FROM health_encounters
          WHERE student_id = $1
          ORDER BY encounter_date DESC, id DESC`,
        [studentId]
      ),
      query(
        `SELECT alert_date, alert_type, message
           FROM student_alerts
          WHERE student_id = $1
          ORDER BY alert_date DESC NULLS LAST, id`,
        [studentId]
      ),
    ]);

    res.render("discipline/health-student", {
      pageTitle: `Health Record — ${student.last_name}, ${student.first_name}`,
      activeTab: "discipline",
      student,
      flags: flags.rows,
      encounters: encounters.rows,
      alerts: alerts.rows,
      snippet,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
