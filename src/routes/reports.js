import express from "express";
import { query } from "../db.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Shared helpers: validation, query-string normalization, CSV
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
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

/** First day of the term that contains `iso`, else 90 days back. */
function defaultFrom() {
  return addDays(todayIso(), -90);
}

function posInt(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Only keep a value if it is in the allowed set (drops junk params). */
function oneOf(raw, allowed) {
  const v = typeof raw === "string" ? raw : "";
  return allowed.includes(v) ? v : "";
}

/** Comma-separated list -> subset of allowed tokens, order preserved/deduped. */
function multiOf(raw, allowed) {
  const parts = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) if (allowed.includes(p) && !out.includes(p)) out.push(p);
  return out;
}

function fmtDate(v) {
  if (!v) return "";
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function gradeLabel(g) {
  if (g === null || g === undefined) return "";
  return g === 0 ? "K" : String(g);
}

/** Deterministic query string (sorted keys) from a params object. */
function toQueryString(obj) {
  const parts = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const cellOf = (c, r) =>
    typeof c.get === "function" ? c.get(r) : typeof c.value === "function" ? c.value(r) : "";
  const header = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(cellOf(c, r))).join(","));
  return [header, ...body].join("\r\n") + "\r\n";
}

/** CSV filename: <report_key>-<YYYY-MM-DD>.csv */
function csvFilename(reportKey) {
  return `${reportKey}-${todayIso()}.csv`;
}

// If the caller asked for CSV, stream it and return true; otherwise return false
// so the caller renders the normal HTML grid.
function csvOrSheet(res, wantsCsv, reportKey, columns, rows) {
  if (!wantsCsv) return false;
  // Build the payload BEFORE touching headers so a bad column can never write
  // an attachment header and then fall through to a 500.
  const body = toCsv(columns, rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${csvFilename(reportKey)}"`
  );
  res.send(body);
  return true;
}

// ---------------------------------------------------------------------------
// Report catalogue + reference data
// ---------------------------------------------------------------------------

const REPORTS = [
  {
    key: "roster",
    name: "Class Roster",
    path: "/reports/roster",
    description: "Students by school, grade, and status with contact phone.",
  },
  {
    key: "attendance",
    name: "Attendance Summary",
    path: "/reports/attendance",
    description: "Per-student present/absent/tardy counts and attendance rate.",
  },
  {
    key: "transcript",
    name: "Transcript Batch",
    path: "/reports/transcript",
    description: "Posted final grades for every student in a grade level.",
  },
  {
    key: "contacts",
    name: "Student Contact List",
    path: "/reports/contacts",
    description: "One row per guardian contact for a school and grade.",
  },
];

const REPORT_BY_KEY = Object.fromEntries(REPORTS.map((r) => [r.key, r]));
const REPORT_BY_PATH = Object.fromEntries(REPORTS.map((r) => [r.path, r]));

const STATUSES = ["Active", "Inactive", "Transferred", "Graduated"];

async function loadSchools() {
  const r = await query("SELECT id, name, code FROM schools ORDER BY id");
  return r.rows;
}

async function loadTerms() {
  const r = await query(
    "SELECT id, name, starts_on, ends_on, is_current FROM terms ORDER BY id"
  );
  return r.rows;
}

function gradeOptions() {
  // K plus the grades actually present in the data (fallback 0..12).
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
}

/** Log one run; never let logging failure break the report. */
async function logRun(reportKey, params, rowCount) {
  try {
    await query(
      `INSERT INTO report_runs (report_key, params, row_count, ran_by)
       VALUES ($1, $2::jsonb, $3, $4)`,
      [reportKey, JSON.stringify(params), rowCount, "Demo User"]
    );
  } catch {
    /* run logging is best-effort */
  }
}

/** Friendly render helper for a landed (query-parse) error; never 500s. */
function renderReport(res, { report, params, columns, rows, extra = {} }) {  return res.render("reports/report", {
    pageTitle: report.name,
    activeTab: "reports",
    report,
    reports: REPORTS,
    invalidMessage: null,
    params,
    columns,
    rows,
    rowCount: rows.length,
    queryString: toQueryString(params),
    printMode: false,
    note: null,
    ...extra,
  });
}

/**
 * Render the report page with an "Invalid parameters" box and no results.
 * Used when the caller supplied values that could not be validated.
 */
function renderInvalid(res, report, params, invalid, data) {
  return res.status(200).render("reports/report", {
    pageTitle: report.name,
    activeTab: "reports",
    report,
    reports: REPORTS,
    invalidMessage: "Invalid parameters",
    invalidDetails: invalid,
    params,
    columns: [],
    rows: [],
    rowCount: 0,
    queryString: toQueryString(params),
    printMode: false,
    note: null,
    filtersSummary: ["(not run)"],
    ...data,
  });
}

// ---------------------------------------------------------------------------
// GET /reports — index
// ---------------------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const runs = await query(
      `SELECT report_key, params, row_count, ran_on, ran_by
         FROM report_runs
        ORDER BY ran_on DESC, id DESC
        LIMIT 15`
    );
    const saved = await query(
      `SELECT id, name, report_key, params, created_by, created_on
         FROM saved_reports
        ORDER BY name`
    );
    res.render("reports/index", {
      pageTitle: "Reports",
      activeTab: "reports",
      reports: REPORTS,
      recentRuns: runs.rows.map((r) => ({
        ...r,
        report_name: REPORT_BY_KEY[r.report_key]?.name ?? r.report_key,
        query: toQueryString(r.params || {}),
        ran_on_display: r.ran_on instanceof Date
          ? r.ran_on.toISOString().replace("T", " ").slice(0, 16)
          : String(r.ran_on).slice(0, 16),
      })),
      savedReports: saved.rows.map((s) => ({
        ...s,
        report_name: REPORT_BY_KEY[s.report_key]?.name ?? s.report_key,
        href: `${REPORT_BY_KEY[s.report_key]?.path ?? "/reports"}?${toQueryString(
          s.params || {}
        )}`,
      })),
      savedNotice:
        req.query.saved === "1"
          ? `Saved "${String(req.query.name ?? "").slice(0, 60)}".`
          : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /reports/save — store the current query string under a name
// ---------------------------------------------------------------------------

router.post("/save", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim().slice(0, 80);
    const refererPath = String(req.body.report_path ?? "").trim();
    const report = REPORT_BY_PATH[refererPath] ?? null;

    // Re-parse the submitted query string so only known params are stored.
    const incoming = new URLSearchParams(String(req.body.query ?? ""));
    const params = report ? parseParams(report.key, incoming).params : {};

    if (!report) {
      return res.status(200).render("reports/save-error", {
        pageTitle: "Save Report",
        activeTab: "reports",
        message: "Unknown report; nothing was saved.",
      });
    }
    if (!name) {
      return res.status(200).render("reports/save-error", {
        pageTitle: "Save Report",
        activeTab: "reports",
        message: "A report name is required; nothing was saved.",
      });
    }

    await query(
      `INSERT INTO saved_reports (name, report_key, params, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (name)
       DO UPDATE SET report_key = EXCLUDED.report_key,
                     params = EXCLUDED.params,
                     created_by = EXCLUDED.created_by,
                     created_on = CURRENT_DATE`,
      [name, report.key, JSON.stringify(params), "Demo User"]
    );

    res.redirect(`/reports?saved=1&name=${encodeURIComponent(name)}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Parameter parsing (per report)
// ---------------------------------------------------------------------------

/**
 * Parse + validate query params for one report.
 * Returns { params, invalid } where `invalid` lists human-readable messages for
 * values that were SUPPLIED but rejected (so the page can show an "Invalid
 * parameters" box instead of silently ignoring junk). Absent params are fine.
 */
function parseParams(key, q) {
  const raw = (k) => {
    if (typeof q.get === "function") return q.get(k);
    return q[k];
  };
  const present = (k) => {
    const v = raw(k);
    return v !== undefined && v !== null && String(v) !== "";
  };

  const invalid = [];
  const nInt = (k, label) => {
    if (!present(k)) return "";
    const n = posInt(raw(k));
    if (n === null) invalid.push(`${label} is not a valid id`);
    return n ?? "";
  };
  const pick = (k, allowed, label) => {
    if (!present(k)) return "";
    const v = oneOf(raw(k), allowed);
    if (v === "") invalid.push(`${label} "${String(raw(k)).slice(0, 20)}" is not recognized`);
    return v;
  };

  if (key === "roster") {
    return {
      params: {
        school: nInt("school", "School"),
        grade: pick("grade", gradeOptions().map(String), "Grade level"),
        status: pick("status", STATUSES, "Status"),
        cols: multiOf(raw("cols"), ["phone", "dob", "gender"]).join(","),
      },
      invalid,
    };
  }
  if (key === "attendance") {
    let from = defaultFrom();
    let to = todayIso();
    if (present("from")) {
      if (isDate(raw("from"))) from = raw("from");
      else invalid.push(`From date "${String(raw("from")).slice(0, 20)}" must be YYYY-MM-DD`);
    }
    if (present("to")) {
      if (isDate(raw("to"))) to = raw("to");
      else invalid.push(`To date "${String(raw("to")).slice(0, 20)}" must be YYYY-MM-DD`);
    }
    if (to < from) to = from;
    return {
      params: {
        from,
        to,
        school: nInt("school", "School"),
        grade: pick("grade", gradeOptions().map(String), "Grade level"),
        cols: multiOf(raw("cols"), ["breakdown"]).join(","),
      },
      invalid,
    };
  }
  if (key === "transcript") {
    return {
      params: {
        grade: pick("grade", gradeOptions().map(String), "Grade level"),
        term: nInt("term", "Term"),
        cols: multiOf(raw("cols"), ["percent", "points"]).join(","),
      },
      invalid,
    };
  }
  if (key === "contacts") {
    return {
      params: {
        school: nInt("school", "School"),
        grade: pick("grade", gradeOptions().map(String), "Grade level"),
        cols: multiOf(raw("cols"), ["email", "primary"]).join(","),
      },
      invalid,
    };
  }
  return { params: {}, invalid: ["Unknown report"] };
}

// ---------------------------------------------------------------------------
// Reference data for the parameter panels
// ---------------------------------------------------------------------------

async function panelData() {
  const [schools, terms] = await Promise.all([loadSchools(), loadTerms()]);
  return { schools, terms, grades: gradeOptions(), statuses: STATUSES };
}

// ---------------------------------------------------------------------------
// GET /reports/roster
// ---------------------------------------------------------------------------

router.get("/roster", async (req, res, next) => {
  try {
    const { params, invalid } = parseParams("roster", req.query);
    const wantCsv = req.query.format === "csv";
    const details = panelData();
    if (invalid.length) {
      return renderInvalid(res, REPORT_BY_KEY.roster, params, invalid, await details);
    }

    const cols = params.cols.split(",").filter(Boolean);
    const showPhone = cols.includes("phone");
    const showDob = cols.includes("dob");
    const showGender = cols.includes("gender");

    const where = [];
    const values = [];
    if (params.school !== "") {
      values.push(params.school);
      where.push(`st.school_id = $${values.length}`);
    }
    if (params.grade !== "") {
      values.push(Number(params.grade));
      where.push(`st.grade_level = $${values.length}`);
    }
    if (params.status !== "") {
      values.push(params.status);
      where.push(`st.status = $${values.length}`);
    }

    const r = await query(
      `SELECT st.id, st.state_id, st.last_name, st.first_name, st.middle_name,
              st.grade_level, st.gender, st.dob, st.status,
              sc.name AS school_name, sc.code AS school_code,
              pc.name AS contact_name, pc.relationship AS contact_relationship,
              pc.phone AS contact_phone
         FROM students st
         LEFT JOIN schools sc ON sc.id = st.school_id
         LEFT JOIN LATERAL (
              SELECT name, relationship, phone
                FROM student_contacts c
               WHERE c.student_id = st.id
               ORDER BY c.is_primary DESC, c.id
               LIMIT 1
         ) pc ON TRUE
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY st.last_name, st.first_name, st.id`,
      values
    );

    const rows = r.rows.map((row) => ({
      ...row,
      grade_label: gradeLabel(row.grade_level),
      dob_display: fmtDate(row.dob),
    }));

    const columns = [
      { key: "state_id", label: "State ID", get: (x) => x.state_id },
      { key: "name", label: "Name", get: (x) => `${x.last_name}, ${x.first_name}` },
      { key: "grade", label: "Grade", get: (x) => x.grade_label, num: true },
    ];
    if (showGender) columns.push({ key: "gender", label: "Gender", get: (x) => x.gender });
    if (showDob) columns.push({ key: "dob", label: "Birth date", get: (x) => x.dob_display });
    columns.push({ key: "school", label: "School", get: (x) => x.school_name });
    columns.push({ key: "status", label: "Status", get: (x) => x.status });
    if (showPhone) {
      columns.push({ key: "phone", label: "Primary contact", get: (x) => x.contact_phone });
    }

    await logRun("roster", params, rows.length);
    if (csvOrSheet(res, wantCsv, "roster", columns, rows)) return;

    const data = await details;
    return renderReport(res, {
      report: REPORT_BY_KEY.roster,
      params,
      columns,
      rows,
      extra: {
        ...data,
        showPhone,
        showDob,
        showGender,
        printMode: req.query.print === "1",
        filtersSummary: [
          params.school ? `School #${params.school}` : "All schools",
          params.grade ? `Grade ${gradeLabel(Number(params.grade))}` : "All grades",
          params.status || "All statuses",
        ],
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /reports/attendance
// ---------------------------------------------------------------------------

router.get("/attendance", async (req, res, next) => {
  try {
    const { params, invalid } = parseParams("attendance", req.query);
    const wantCsv = req.query.format === "csv";
    const details = panelData();
    if (invalid.length) {
      return renderInvalid(res, REPORT_BY_KEY.attendance, params, invalid, await details);
    }

    const breakdown = params.cols.split(",").includes("breakdown");

    const where = [];
    const values = [];
    // Aggregate attendance per student over the date range, then LEFT JOIN so
    // students with no rows show zeros.
    values.push(params.from);
    const fromIdx = values.length;
    values.push(params.to);
    const toIdx = values.length;

    if (params.school !== "") {
      values.push(params.school);
      where.push(`st.school_id = $${values.length}`);
    }
    if (params.grade !== "") {
      values.push(Number(params.grade));
      where.push(`st.grade_level = $${values.length}`);
    }

    const r = await query(
      `SELECT st.id, st.state_id, st.last_name, st.first_name, st.grade_level,
              st.status, sc.name AS school_name, sc.code AS school_code,
              COALESCE(a.days_present, 0)::int AS days_present,
              COALESCE(a.days_absent, 0)::int  AS days_absent,
              COALESCE(a.days_tardy, 0)::int   AS days_tardy,
              COALESCE(a.days_excused, 0)::int AS days_excused,
              COALESCE(a.total_marks, 0)::int  AS total_marks,
              COALESCE(a.codes, '')            AS code_breakdown
         FROM students st
         LEFT JOIN schools sc ON sc.id = st.school_id
         LEFT JOIN LATERAL (
              SELECT
                 count(*) FILTER (WHERE ac.code = 'P')::int AS days_present,
                 count(*) FILTER (WHERE ac.counts_absent AND NOT ac.excused)::int AS days_absent,
                 count(*) FILTER (WHERE ac.code = 'T')::int AS days_tardy,
                 count(*) FILTER (WHERE ac.excused)::int AS days_excused,
                 count(*)::int AS total_marks,
                 string_agg(DISTINCT ac.code || ':' || ac.label, '; ') AS codes
                FROM attendance_daily ad
                JOIN attendance_codes ac ON ac.code = ad.code
               WHERE ad.student_id = st.id
                 AND ad.on_date BETWEEN $${fromIdx} AND $${toIdx}
         ) a ON TRUE
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY st.last_name, st.first_name, st.id`,
      values
    );

    const rows = r.rows.map((row) => {
      const denominated = row.days_present + row.days_absent + row.days_tardy + row.days_excused;
      const rate = denominated > 0
        ? Math.round(((row.days_present + row.days_excused) / denominated) * 1000) / 10
        : 0;
      return { ...row, grade_label: gradeLabel(row.grade_level), rate };
    });

    const columns = [
      { key: "name", label: "Student", get: (x) => `${x.last_name}, ${x.first_name}` },
      { key: "state_id", label: "State ID", get: (x) => x.state_id },
      { key: "grade", label: "Grade", get: (x) => x.grade_label, num: true },
      { key: "school", label: "School", get: (x) => x.school_code },
      { key: "present", label: "Present", get: (x) => x.days_present, num: true },
      { key: "absent", label: "Absent", get: (x) => x.days_absent, num: true },
      { key: "tardy", label: "Tardy", get: (x) => x.days_tardy, num: true },
      { key: "excused", label: "Excused", get: (x) => x.days_excused, num: true },
      { key: "rate", label: "Rate %", get: (x) => x.rate.toFixed(1), num: true },
    ];
    if (breakdown) {
      columns.push({ key: "breakdown", label: "Code breakdown", get: (x) => x.code_breakdown });
    }

    await logRun("attendance", params, rows.length);
    if (csvOrSheet(res, wantCsv, "attendance", columns, rows)) return;

    const data = await details;
    return renderReport(res, {
      report: REPORT_BY_KEY.attendance,
      params,
      columns,
      rows,
      extra: {
        ...data,
        breakdown,
        printMode: req.query.print === "1",
        filtersSummary: [
          `${params.from} – ${params.to}`,
          params.school ? `School #${params.school}` : "All schools",
          params.grade ? `Grade ${gradeLabel(Number(params.grade))}` : "All grades",
        ],
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /reports/transcript
// ---------------------------------------------------------------------------

router.get("/transcript", async (req, res, next) => {
  try {
    const { params, invalid } = parseParams("transcript", req.query);
    const wantCsv = req.query.format === "csv";
    const details = panelData();
    if (invalid.length) {
      return renderInvalid(res, REPORT_BY_KEY.transcript, params, invalid, await details);
    }

    const cols = params.cols.split(",").filter(Boolean);
    const showPercent = cols.includes("percent");
    const showPoints = cols.includes("points");

    const where = [];
    const values = [];
    if (params.grade !== "") {
      values.push(Number(params.grade));
      where.push(`st.grade_level = $${values.length}`);
    }
    if (params.term !== "") {
      values.push(params.term);
      where.push(`fg.term_id = $${values.length}`);
    }

    // LEFT JOIN: students with no posted grades still appear, flagged.
    const r = await query(
      `SELECT st.id AS student_id, st.state_id, st.last_name, st.first_name,
              st.grade_level, sc.code AS school_code,
              s.section_code, s.course_name, t.name AS term_name,
              fg.letter, fg.percent, fg.points, fg.posted_on
         FROM students st
         LEFT JOIN schools sc ON sc.id = st.school_id
         LEFT JOIN final_grades fg ON fg.student_id = st.id
         LEFT JOIN sections s ON s.id = fg.section_id
         LEFT JOIN terms t ON t.id = fg.term_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY st.last_name, st.first_name, st.id,
                 s.course_name NULLS LAST, s.section_code NULLS LAST`,
      values
    );

    // Group into one record per student; a null section_code = no posted grades.
    const byStudent = new Map();
    for (const row of r.rows) {
      const key = row.student_id;
      if (!byStudent.has(key)) {
        byStudent.set(key, {
          student_id: row.student_id,
          state_id: row.state_id,
          name: `${row.last_name}, ${row.first_name}`,
          grade_label: gradeLabel(row.grade_level),
          school_code: row.school_code,
          grades: [],
        });
      }
      if (row.section_code) {
        byStudent.get(key).grades.push({
          course_name: row.course_name,
          section_code: row.section_code,
          term_name: row.term_name,
          letter: row.letter,
          percent: row.percent === null ? "" : Number(row.percent),
          points: row.points === null ? "" : Number(row.points),
        });
      }
    }

    // Flatten to one row per student (grade list rendered in the view).
    const rows = [...byStudent.values()].map((s) => ({
      ...s,
      grade_courses: s.grades.length
        ? s.grades.map((g) => `${g.course_name} (${g.section_code})`).join("; ")
        : "No posted grades",
      grade_letters: s.grades.length
        ? s.grades.map((g) => g.letter || "").join(", ")
        : "—",
      grade_count: s.grades.length,
      has_grades: s.grades.length > 0,
    }));

    const columns = [
      { key: "name", label: "Student", get: (x) => x.name },
      { key: "state_id", label: "State ID", get: (x) => x.state_id },
      { key: "grade", label: "Grade", get: (x) => x.grade_label, num: true },
      { key: "school", label: "School", get: (x) => x.school_code },
      { key: "courses", label: "Posted grades", get: (x) => x.grade_courses },
      { key: "letters", label: "Letter(s)", get: (x) => x.grade_letters },
      { key: "count", label: "Grade count", get: (x) => x.grade_count, num: true },
    ];

    await logRun("transcript", params, rows.length);
    if (csvOrSheet(res, wantCsv, "transcript", columns, rows)) return;

    const data = await details;
    return renderReport(res, {
      report: REPORT_BY_KEY.transcript,
      params,
      columns,
      rows,
      extra: {
        ...data,
        showPercent,
        showPoints,
        printMode: req.query.print === "1",
        filtersSummary: [
          params.grade ? `Grade ${gradeLabel(Number(params.grade))}` : "All grades",
          params.term
            ? `Term #${params.term}`
            : "All terms",
        ],
        note: rows.every((x) => !x.has_grades)
          ? "final_grades is empty or has no rows for these parameters — every student shows \"no posted grades\"."
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /reports/contacts
// ---------------------------------------------------------------------------

router.get("/contacts", async (req, res, next) => {
  try {
    const { params, invalid } = parseParams("contacts", req.query);
    const wantCsv = req.query.format === "csv";
    const details = panelData();
    if (invalid.length) {
      return renderInvalid(res, REPORT_BY_KEY.contacts, params, invalid, await details);
    }

    const cols = params.cols.split(",").filter(Boolean);
    const showEmail = cols.includes("email");
    const showPrimary = cols.includes("primary");

    const where = [];
    const values = [];
    if (params.school !== "") {
      values.push(params.school);
      where.push(`st.school_id = $${values.length}`);
    }
    if (params.grade !== "") {
      values.push(Number(params.grade));
      where.push(`st.grade_level = $${values.length}`);
    }

    // LEFT JOIN -> one row per contact, or one "no contacts" row per student.
    const r = await query(
      `SELECT st.id AS student_id, st.state_id, st.last_name, st.first_name,
              st.grade_level, sc.code AS school_code, sc.name AS school_name,
              c.name AS contact_name, c.relationship, c.phone, c.email, c.is_primary
         FROM students st
         LEFT JOIN schools sc ON sc.id = st.school_id
         LEFT JOIN student_contacts c ON c.student_id = st.id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY st.last_name, st.first_name, st.id,
                 c.is_primary DESC NULLS LAST, c.id NULLS LAST`,
      values
    );

    const rows = r.rows.map((row) => ({
      ...row,
      grade_label: gradeLabel(row.grade_level),
      has_contact: row.contact_name !== null,
      contact_name: row.contact_name ?? "No contacts on file",
      relationship: row.relationship ?? "",
      phone: row.phone ?? "",
      email: row.email ?? "",
      is_primary: row.is_primary === true,
    }));

    const columns = [
      { key: "name", label: "Student", get: (x) => `${x.last_name}, ${x.first_name}` },
      { key: "state_id", label: "State ID", get: (x) => x.state_id },
      { key: "grade", label: "Grade", get: (x) => x.grade_label, num: true },
      { key: "school", label: "School", get: (x) => x.school_code },
      { key: "contact", label: "Contact", get: (x) => x.contact_name },
      { key: "rel", label: "Relationship", get: (x) => x.relationship },
      { key: "phone", label: "Phone", get: (x) => x.phone },
    ];
    if (showEmail) columns.push({ key: "email", label: "Email", get: (x) => x.email });
    if (showPrimary) {
      columns.push({ key: "primary", label: "Primary", get: (x) => (x.is_primary ? "Yes" : "") });
    }

    await logRun("contacts", params, rows.length);
    if (csvOrSheet(res, wantCsv, "contacts", columns, rows)) return;

    const data = await details;
    return renderReport(res, {
      report: REPORT_BY_KEY.contacts,
      params,
      columns,
      rows,
      extra: {
        ...data,
        showEmail,
        showPrimary,
        printMode: req.query.print === "1",
        filtersSummary: [
          params.school ? `School #${params.school}` : "All schools",
          params.grade ? `Grade ${gradeLabel(Number(params.grade))}` : "All grades",
        ],
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
