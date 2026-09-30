// fees.js — Fees module: catalog, bulk assignment, payments, waivers, balances.
// Auto-mounted at /fees. Owned by the fees slice.
//
// Data model (db/migrations/21-fees.sql):
//   fee_catalog(id, name, amount numeric(10,2), description,
//               applies_to 'all'|'school'|'grade', active, created_at)
//   student_fees(id, student_id, fee_id, term_id, amount numeric(10,2),
//               assigned_on, waived, unique(student_id, fee_id, term_id))
//   fee_payments(id, student_fee_id, amount numeric(10,2), method,
//               paid_on, received_by, note)
//
// Money rule: all balances are computed in SQL as amount - coalesce(paid,0)
// with numeric(10,2); JS never sums floats for display-critical values. A
// waived assignment always counts as zero outstanding.
import { pool, query } from "../db.js";
import express from "express";

const router = express.Router();

const METHODS = ["Cash", "Check", "Card", "Online"];
const APPLIES_TO = ["all", "school", "grade"];

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function look(rows) { return rows && rows.length ? rows[0] : null; }
function fmtDate(v) {
  if (!v) return "";
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
void fmtDate; // reserved: date formatting helper kept for symmetry with sibling slices
function gradeLabel(g) {
  if (g === null || g === undefined || g === "") return "";
  return Number(g) === 0 ? "K" : String(g);
}
// Money display: always two decimals with a leading $. Values arrive as strings
// from pg (numeric) so we parse once, format, and never accumulate in floats.
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}
// Validate a money string. Returns { value } (a 2dp string) or { error }.
function parseMoney(raw, label) {
  const s = String(raw === undefined || raw === null ? "" : raw).trim().replace(/^\$/, "");
  if (s === "") return { error: `${label} is required.` };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return { error: `${label} must be a positive number with at most 2 decimals (got "${raw}").` };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return { error: `${label} must be greater than zero.` };
  return { value: n.toFixed(2) };
}
// Optional money (blank allowed) — used for nothing critical yet, kept for symmetry.
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

async function loadTermsSchools() {
  const [terms, schools] = await Promise.all([
    query(`SELECT id, name, is_current FROM terms ORDER BY id`),
    query(`SELECT id, name, code FROM schools ORDER BY id`),
  ]);
  return { terms: terms.rows, schools: schools.rows };
}

// ---------------------------------------------------------------------------
// GET /fees — dashboard: totals strip, per-fee assignment and collection
// rollups, links into the other screens.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const ctx = { pageTitle: "Fees", activeTab: "admin" };
  try {
    const totals = look(
      (
        await query(`
          SELECT
            (SELECT count(*)::int FROM student_fees) AS fees_assigned,
            COALESCE((SELECT sum(amount) FROM student_fees), 0) AS billed,
            COALESCE((
              SELECT sum(p.amount)
                FROM fee_payments p
                JOIN student_fees sf ON sf.id = p.student_fee_id
            ), 0) AS collected,
            COALESCE((
              SELECT sum(GREATEST(sf.amount - COALESCE(paid.paid, 0), 0))
                FROM student_fees sf
                LEFT JOIN (
                  SELECT student_fee_id, sum(amount) AS paid
                    FROM fee_payments GROUP BY student_fee_id
                ) paid ON paid.student_fee_id = sf.id
               WHERE sf.waived = FALSE
            ), 0) AS outstanding,
            COALESCE((SELECT count(*)::int FROM student_fees WHERE waived), 0) AS waived_count
        `)
      ).rows
    );

    const feeRows = (
      await query(`
        SELECT fc.id, fc.name, fc.amount, fc.applies_to, fc.active, fc.description,
               COALESCE(a.assigned, 0)::int AS assigned,
               COALESCE(a.billed, 0)       AS billed,
               COALESCE(a.paid, 0)         AS collected,
               COALESCE(a.outstanding, 0)  AS outstanding
          FROM fee_catalog fc
          LEFT JOIN (
            SELECT sf.fee_id,
                   count(*) AS assigned,
                   sum(sf.amount) AS billed,
                   COALESCE(sum(paid.paid), 0) AS paid,
                   sum(CASE WHEN sf.waived THEN 0
                            ELSE GREATEST(sf.amount - COALESCE(paid.paid, 0), 0) END) AS outstanding
              FROM student_fees sf
              LEFT JOIN (
                SELECT student_fee_id, sum(amount) AS paid
                  FROM fee_payments GROUP BY student_fee_id
              ) paid ON paid.student_fee_id = sf.id
             GROUP BY sf.fee_id
          ) a ON a.fee_id = fc.id
         ORDER BY fc.active DESC, fc.name
      `)
    ).rows;

    res.render("fees/index", {
      ...ctx,
      totals: {
        feesAssigned: totals ? totals.fees_assigned : 0,
        billed: totals ? totals.billed : "0",
        collected: totals ? totals.collected : "0",
        outstanding: totals ? totals.outstanding : "0",
        waivedCount: totals ? totals.waived_count : 0,
      },
      feeRows,
      money,
    });
  } catch (err) {
    res.render("fees/index", {
      ...ctx,
      totals: { feesAssigned: 0, billed: "0", collected: "0", outstanding: "0", waivedCount: 0 },
      feeRows: [], money,
      error: `Could not load the fees dashboard: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /fees/catalog — catalog table + add/edit form
// ---------------------------------------------------------------------------
router.get("/catalog", async (req, res) => {
  const ctx = { pageTitle: "Fee Catalog", activeTab: "admin" };
  try {
    const editId = toInt(req.query.edit);
    const rows = (
      await query(`
        SELECT fc.*,
               (SELECT count(*)::int FROM student_fees sf WHERE sf.fee_id = fc.id) AS assigned
          FROM fee_catalog fc
         ORDER BY fc.active DESC, fc.name
      `)
    ).rows;
    let editing = null;
    if (editId) editing = rows.find((r) => r.id === editId) || null;
    res.render("fees/catalog", {
      ...ctx, fees: rows, editing, money,
      appliesTo: APPLIES_TO,
      saved: String(req.query.saved || "") === "1",
      savedMsg: req.query.msg ? String(req.query.msg) : "",
    });
  } catch (err) {
    res.render("fees/catalog", {
      ...ctx, fees: [], editing: null, money, appliesTo: APPLIES_TO, error: `Could not load the catalog: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /fees/catalog — add or update a fee. Bad input re-renders (200) with an
// error box; it is never a 500.
// ---------------------------------------------------------------------------
router.post("/catalog", async (req, res) => {
  const ctx = { pageTitle: "Fee Catalog", activeTab: "admin" };
  const id = toInt(req.body.id);
  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const appliesToRaw = String(req.body.applies_to || "all").trim();
  const active = String(req.body.active || "") === "1" || String(req.body.active || "") === "on";

  async function renderForm(error) {
    try {
      const rows = (
        await query(`
          SELECT fc.*,
                 (SELECT count(*)::int FROM student_fees sf WHERE sf.fee_id = fc.id) AS assigned
            FROM fee_catalog fc
           ORDER BY fc.active DESC, fc.name
        `)
      ).rows;
      const editing = id ? rows.find((r) => r.id === id) || null : null;
      return res.status(error ? 400 : 200).render("fees/catalog", {
        ...ctx, fees: rows, editing, money, appliesTo: APPLIES_TO,
        error,
        // echo back what the user typed so the form is not lost
        form: { id, name, amount: String(req.body.amount || ""), description, applies_to: appliesToRaw, active },
      });
    } catch (err) {
      return res.render("fees/catalog", {
        ...ctx, fees: [], editing: null, money, appliesTo: APPLIES_TO,
        error: error || `Could not reload the catalog: ${err.message}`,
        form: { id, name, amount: String(req.body.amount || ""), description, applies_to: appliesToRaw, active },
      });
    }
  }

  if (!name) return renderForm("Fee name is required.");
  const amount = parseMoney(req.body.amount, "Amount");
  if (amount.error) return renderForm(amount.error);
  if (!APPLIES_TO.includes(appliesToRaw)) {
    return renderForm(`Applies-to must be one of: ${APPLIES_TO.join(", ")}.`);
  }

  try {
    if (id) {
      const r = await query(
        `UPDATE fee_catalog
            SET name = $1, amount = $2, description = $3, applies_to = $4, active = $5
          WHERE id = $6`,
        [name, amount.value, description || null, appliesToRaw, active, id]
      );
      if (r.rowCount === 0) return renderForm(`No fee with id ${id} exists.`);
      return res.redirect("/fees/catalog?saved=1&msg=" + encodeURIComponent(`Updated "${name}".`));
    }
    await query(
      `INSERT INTO fee_catalog (name, amount, description, applies_to, active)
       VALUES ($1, $2, $3, $4, $5)`,
      [name, amount.value, description || null, appliesToRaw, active]
    );
    return res.redirect("/fees/catalog?saved=1&msg=" + encodeURIComponent(`Added "${name}".`));
  } catch (err) {
    return renderForm(`Could not save the fee: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// GET /fees/assign — bulk assignment form
// ---------------------------------------------------------------------------
router.get("/assign", async (req, res) => {
  const ctx = { pageTitle: "Assign Fees", activeTab: "admin" };
  try {
    const [{ terms, schools }, fees] = await Promise.all([
      loadTermsSchools(),
      query(`SELECT id, name, amount, applies_to FROM fee_catalog WHERE active ORDER BY name`),
    ]);
    const current = terms.find((t) => t.is_current);
    const grades = (
      await query(`SELECT DISTINCT grade_level FROM students ORDER BY grade_level`)
    ).rows.map((r) => r.grade_level);

    // Terms stored on the query string so the preview/apply results can be shown
    // as a redirect-summary on the same page.
    res.render("fees/assign", {
      ...ctx,
      terms, schools, fees: fees.rows, grades, money,
      selected: {
        term_id: toInt(req.query.term) || (current ? current.id : null),
        school_id: String(req.query.school || ""),
        fee_ids: [],
        grade_level: String(req.query.grade || ""),
      },
      result: null,
    });
  } catch (err) {
    res.render("fees/assign", {
      ...ctx, terms: [], schools: [], fees: [], grades: [], money,
      selected: { term_id: null, school_id: "", fee_ids: [], grade_level: "" },
      error: `Could not load the assignment form: ${err.message}`,
    });
  }
});

// Build the candidate student list (school + optional grade filter).
async function candidateStudents(schoolId, gradeLevel) {
  const params = [];
  const where = [`st.status = 'Active'`];
  if (schoolId) { params.push(schoolId); where.push(`st.school_id = $${params.length}`); }
  if (gradeLevel !== "" && gradeLevel !== null && gradeLevel !== undefined) {
    params.push(gradeLevel === "K" ? 0 : Number(gradeLevel));
    where.push(`st.grade_level = $${params.length}`);
  }
  const sql = `
    SELECT st.id, st.state_id, st.last_name, st.first_name, st.grade_level, st.school_id,
           sc.name AS school_name
      FROM students st
      LEFT JOIN schools sc ON sc.id = st.school_id
     WHERE ${where.join(" AND ")}
     ORDER BY st.last_name, st.first_name, st.id
  `;
  return (await query(sql, params)).rows;
}

// ---------------------------------------------------------------------------
// POST /fees/assign — preview (dry) and apply (one transaction).
// ---------------------------------------------------------------------------
router.post("/assign", async (req, res) => {
  const ctx = { pageTitle: "Assign Fees", activeTab: "admin" };
  const termId = toInt(req.body.term_id);
  const schoolId = toInt(req.body.school_id);
  const gradeRaw = String(req.body.grade_level === undefined ? "" : req.body.grade_level).trim();
  const mode = String(req.body.mode || "preview").toLowerCase();

  // fee_id may arrive as a single value or an array of checkboxes.
  let feeIds = req.body.fee_id;
  if (feeIds === undefined || feeIds === null) feeIds = [];
  if (!Array.isArray(feeIds)) feeIds = [feeIds];
  feeIds = feeIds.map(toInt).filter((n) => n !== null);

  async function renderResult(error, result) {
    try {
      const [{ terms, schools }, fees, grades] = await Promise.all([
        loadTermsSchools(),
        query(`SELECT id, name, amount, applies_to FROM fee_catalog WHERE active ORDER BY name`),
        query(`SELECT DISTINCT grade_level FROM students ORDER BY grade_level`),
      ]);
      return res.status(error ? 400 : 200).render("fees/assign", {
        ...ctx,
        terms, schools, fees: fees.rows, money,
        grades: grades.rows.map((r) => r.grade_level),
        selected: { term_id: termId, school_id: schoolId ? String(schoolId) : "", fee_ids: feeIds, grade_level: gradeRaw },
        error, result,
      });
    } catch (err) {
      return res.render("fees/assign", {
        ...ctx, terms: [], schools: [], fees: [], grades: [], money,
        selected: { term_id: termId, school_id: schoolId ? String(schoolId) : "", fee_ids: feeIds, grade_level: gradeRaw },
        error: error || `Could not reload the form: ${err.message}`,
        result,
      });
    }
  }

  if (!termId) return renderResult("Select a term.");
  if (!feeIds.length) return renderResult("Select at least one active fee.");

  try {
    const [term, feeList, students] = await Promise.all([
      look((await query(`SELECT * FROM terms WHERE id = $1`, [termId])).rows),
      query(
        `SELECT id, name, amount, applies_to FROM fee_catalog
          WHERE id = ANY($1::int[]) AND active ORDER BY name`,
        [feeIds]
      ),
      candidateStudents(schoolId, gradeRaw),
    ]);
    if (!term) return renderResult(`No term with id ${termId}.`);
    if (!feeList.rows.length) return renderResult("None of the selected fees is active/existing.");

    // Which (student, fee) pairs already exist for this term?
    const studentIds = students.map((s) => s.id);
    let existing = new Set();
    if (studentIds.length) {
      const ex = await query(
        `SELECT student_id, fee_id FROM student_fees
          WHERE term_id = $1 AND fee_id = ANY($2::int[]) AND student_id = ANY($3::int[])`,
        [termId, feeList.rows.map((f) => f.id), studentIds]
      );
      for (const r of ex.rows) existing.add(`${r.student_id}:${r.fee_id}`);
    }

    // Pending = every (student, fee) pair not already assigned.
    const pending = [];
    for (const st of students) {
      for (const f of feeList.rows) {
        if (!existing.has(`${st.id}:${f.id}`)) {
          pending.push({ student: st, fee: f });
        }
      }
    }

    // Per-fee summary for both preview and result.
    const perFee = feeList.rows.map((f) => {
      const would = students.length;
      const skipped = students.filter((st) => existing.has(`${st.id}:${f.id}`)).length;
      return { fee: f, eligible: would, skipped, toAssign: would - skipped };
    });

    if (mode !== "apply") {
      const totalAmount = pending.reduce((s, p) => s + Number(p.fee.amount), 0);
      return renderResult(null, {
        mode: "preview",
        term, feeList: feeList.rows, students, pending, perFee,
        studentCount: students.length,
        toAssign: pending.length,
        skipped: students.length * feeList.rows.length - pending.length,
        totalAmount: totalAmount.toFixed(2),
        // Show a bounded slice of the would-be rows in the preview grid.
        previewRows: pending.slice(0, 300),
      });
    }

    // ---- APPLY: one transaction, inserts skipping duplicate pairs ----
    const client = await pool.connect();
    let assigned = 0;
    let skipped = 0;
    try {
      await client.query("BEGIN");
      for (const p of pending) {
        const r = await client.query(
          `INSERT INTO student_fees (student_id, fee_id, term_id, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (student_id, fee_id, term_id) DO NOTHING`,
          [p.student.id, p.fee.id, termId, p.fee.amount]
        );
        if (r.rowCount === 1) assigned++;
        else skipped++;
      }
      // Anything already present and re-selected counts as skipped too.
      skipped += students.length * feeList.rows.length - pending.length;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return renderResult(null, {
      mode: "apply",
      term, feeList: feeList.rows, perFee,
      studentCount: students.length,
      assigned, skipped,
    });
  } catch (err) {
    return renderResult(`Assignment failed, nothing was written: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// GET /fees/student?student=<id> — one student's assignments, contacts, and
// the payment / waiver forms.
// ---------------------------------------------------------------------------
router.get("/student", async (req, res) => {
  const ctx = { pageTitle: "Student Fees", activeTab: "admin" };
  try {
    const id = toInt(req.query.student);
    if (!id) {
      return res.render("fees/student", {
        ...ctx, noStudent: true, money, methods: METHODS,
        message: "No student selected. Provide ?student=<id> (see Balances for a list).",
      });
    }
    const student = look(
      (
        await query(
          `SELECT st.id, st.state_id, st.last_name, st.first_name, st.grade_level,
                  st.status, st.school_id, sc.name AS school_name
             FROM students st LEFT JOIN schools sc ON sc.id = st.school_id
            WHERE st.id = $1`,
          [id]
        )
      ).rows
    );
    if (!student) {
      return res.status(404).render("fees/student", {
        ...ctx, noStudent: true, money, methods: METHODS, error: `No student with id ${id}.`,
      });
    }

    const [contacts, feeRows] = await Promise.all([
      query(
        `SELECT name, relationship, phone, email, is_primary
           FROM student_contacts WHERE student_id = $1
          ORDER BY is_primary DESC, name`,
        [id]
      ),
      query(
        `SELECT sf.id, sf.amount, sf.assigned_on, sf.waived, sf.term_id,
                fc.name AS fee_name, fc.id AS fee_id,
                t.name AS term_name,
                COALESCE(paid.paid, 0) AS paid,
                CASE WHEN sf.waived THEN 0
                     ELSE GREATEST(sf.amount - COALESCE(paid.paid, 0), 0) END AS balance
           FROM student_fees sf
           JOIN fee_catalog fc ON fc.id = sf.fee_id
           LEFT JOIN terms t ON t.id = sf.term_id
           LEFT JOIN (
             SELECT student_fee_id, sum(amount) AS paid
               FROM fee_payments GROUP BY student_fee_id
           ) paid ON paid.student_fee_id = sf.id
          WHERE sf.student_id = $1
          ORDER BY t.name NULLS FIRST, fc.name`,
        [id]
      ),
    ]);

    const totals = look(
      (
        await query(
          `SELECT
             COALESCE(sum(sf.amount), 0) AS billed,
             COALESCE(sum(COALESCE(paid.paid, 0)), 0) AS paid,
             COALESCE(sum(CASE WHEN sf.waived THEN 0
                               ELSE GREATEST(sf.amount - COALESCE(paid.paid, 0), 0) END), 0) AS outstanding
             FROM student_fees sf
             LEFT JOIN (
               SELECT student_fee_id, sum(amount) AS paid
                 FROM fee_payments GROUP BY student_fee_id
             ) paid ON paid.student_fee_id = sf.id
            WHERE sf.student_id = $1`,
          [id]
        )
      ).rows
    );

    res.render("fees/student", {
      ...ctx, student,
      contacts: contacts.rows,
      feeRows: feeRows.rows,
      totals: {
        billed: totals ? totals.billed : "0",
        paid: totals ? totals.paid : "0",
        outstanding: totals ? totals.outstanding : "0",
      },
      money, methods: METHODS,
      saved: String(req.query.saved || "") === "1",
      savedMsg: req.query.msg ? String(req.query.msg) : "",
    });
  } catch (err) {
    res.render("fees/student", {
      ...ctx, noStudent: true, money, methods: METHODS,
      error: `Could not load the student's fees: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /fees/payment — record a payment against one assignment. Rejects any
// amount over the remaining balance, quoting the balance in the error.
// ---------------------------------------------------------------------------
router.post("/payment", async (req, res) => {
  const studentId = toInt(req.body.student_id);
  const studentFeeId = toInt(req.body.student_fee_id);
  const back = (params) =>
    res.redirect(`/fees/student?student=${studentId || ""}&${params}`);

  if (!studentId || !studentFeeId) {
    return res.redirect(`/fees/student?student=${studentId || ""}&error=${encodeURIComponent("Missing student or fee assignment.")}`);
  }

  const amount = parseMoney(req.body.amount, "Payment amount");
  if (amount.error) return back(`error=${encodeURIComponent(amount.error)}`);

  const method = String(req.body.method || "").trim();
  if (!METHODS.includes(method)) {
    return back(`error=${encodeURIComponent(`Method must be one of: ${METHODS.join(", ")}.`)}`);
  }
  const paidOn = String(req.body.paid_on || "").trim() || todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    return back(`error=${encodeURIComponent(`Payment date must be YYYY-MM-DD (got "${req.body.paid_on}").`)}`);
  }
  const receivedBy = String(req.body.received_by || "").trim();
  const note = String(req.body.note || "").trim();

  try {
    // Load the assignment, verify it belongs to the student, and compute the
    // remaining balance in SQL (numeric), honouring waivers.
    const row = look(
      (
        await query(
          `SELECT sf.id, sf.student_id, sf.waived, sf.amount,
                  COALESCE(paid.paid, 0) AS paid,
                  CASE WHEN sf.waived THEN 0
                       ELSE GREATEST(sf.amount - COALESCE(paid.paid, 0), 0) END AS balance,
                  fc.name AS fee_name
             FROM student_fees sf
             JOIN fee_catalog fc ON fc.id = sf.fee_id
             LEFT JOIN (
               SELECT student_fee_id, sum(amount) AS paid
                 FROM fee_payments GROUP BY student_fee_id
             ) paid ON paid.student_fee_id = sf.id
            WHERE sf.id = $1`,
          [studentFeeId]
        )
      ).rows
    );
    if (!row || row.student_id !== studentId) {
      return back(`error=${encodeURIComponent("That fee assignment does not belong to this student.")}`);
    }
    if (row.waived) {
      return back(`error=${encodeURIComponent(`${row.fee_name} is waived; no payment is due.`)}`);
    }

    const balance = Number(row.balance);
    if (Number(amount.value) > balance + 1e-9) {
      return back(
        `error=${encodeURIComponent(
          `Payment of ${money(amount.value)} exceeds the remaining balance of ${money(balance)} on ${row.fee_name}. ` +
          `Enter at most ${money(balance)}.`
        )}`
      );
    }
    if (balance <= 0) {
      return back(`error=${encodeURIComponent(`${row.fee_name} is already paid in full (balance ${money(balance)}).`)}`);
    }

    await query(
      `INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [studentFeeId, amount.value, method, paidOn, receivedBy || null, note || null]
    );
    return back(`saved=1&msg=${encodeURIComponent(`Recorded ${money(amount.value)} ${method} toward ${row.fee_name}.`)}`);
  } catch (err) {
    return back(`error=${encodeURIComponent(`Could not record the payment: ${err.message}`)}`);
  }
});

// ---------------------------------------------------------------------------
// POST /fees/waive — mark one assignment waived (idempotent).
// ---------------------------------------------------------------------------
router.post("/waive", async (req, res) => {
  const studentId = toInt(req.body.student_id);
  const studentFeeId = toInt(req.body.student_fee_id);
  const back = (params) => res.redirect(`/fees/student?student=${studentId || ""}&${params}`);
  if (!studentId || !studentFeeId) {
    return back(`error=${encodeURIComponent("Missing student or fee assignment.")}`);
  }
  try {
    const r = await query(
      `UPDATE student_fees sf
          SET waived = TRUE
        WHERE sf.id = $1 AND sf.student_id = $2
        RETURNING (SELECT name FROM fee_catalog fc WHERE fc.id = sf.fee_id) AS fee_name`,
      [studentFeeId, studentId]
    );
    if (r.rowCount === 0) {
      return back(`error=${encodeURIComponent("That fee assignment does not belong to this student.")}`);
    }
    return back(`saved=1&msg=${encodeURIComponent(`Waived ${r.rows[0].fee_name}.`)}`);
  } catch (err) {
    return back(`error=${encodeURIComponent(`Could not waive the fee: ${err.message}`)}`);
  }
});

// ---------------------------------------------------------------------------
// GET /fees/balances — school-wide report; &format=csv exports the same rows.
// Filters: school, grade, only (only students with an outstanding balance).
// ---------------------------------------------------------------------------
router.get("/balances", async (req, res) => {
  const ctx = { pageTitle: "Fee Balances", activeTab: "admin" };
  const schoolId = toInt(req.query.school);
  const gradeRaw = String(req.query.grade === undefined ? "" : req.query.grade).trim();
  const only = String(req.query.only || "") === "1" || String(req.query.only || "") === "on";
  const format = String(req.query.format || "").toLowerCase();

  // One query builds every column; balances are computed in SQL, never in JS.
  const params = [];
  const where = [`st.status = 'Active'`];
  if (schoolId) { params.push(schoolId); where.push(`st.school_id = $${params.length}`); }
  if (gradeRaw !== "") {
    params.push(gradeRaw === "K" ? 0 : Number(gradeRaw));
    where.push(`st.grade_level = $${params.length}`);
  }

  const rowsSql = `
    SELECT st.id, st.state_id, st.last_name, st.first_name, st.grade_level,
           sc.name AS school_name,
           COALESCE(sf.billed, 0)      AS billed,
           COALESCE(sf.paid, 0)        AS paid,
           COALESCE(sf.waived_amount, 0) AS waived_amount,
           COALESCE(sf.outstanding, 0) AS outstanding
      FROM students st
      LEFT JOIN schools sc ON sc.id = st.school_id
      LEFT JOIN (
        SELECT sfs.student_id,
               sum(sfs.amount) AS billed,
               COALESCE(sum(paid.paid), 0) AS paid,
               sum(CASE WHEN sfs.waived THEN sfs.amount ELSE 0 END) AS waived_amount,
               sum(CASE WHEN sfs.waived THEN 0
                        ELSE GREATEST(sfs.amount - COALESCE(paid.paid, 0), 0) END) AS outstanding
          FROM student_fees sfs
          LEFT JOIN (
            SELECT student_fee_id, sum(amount) AS paid
              FROM fee_payments GROUP BY student_fee_id
          ) paid ON paid.student_fee_id = sfs.id
         GROUP BY sfs.student_id
      ) sf ON sf.student_id = st.id
     WHERE ${where.join(" AND ")}
     ${only ? "AND COALESCE(sf.outstanding, 0) > 0" : ""}
     ORDER BY st.last_name, st.first_name, st.id
  `;

  try {
    const [{ schools }, grades, balanceResult] = await Promise.all([
      loadTermsSchools(),
      query(`SELECT DISTINCT grade_level FROM students ORDER BY grade_level`),
      query(rowsSql, params),
    ]);
    const rows = balanceResult.rows;

    // Totals row across the filtered result set (sum in SQL of the same values).
    const totals = rows.reduce(
      (acc, r) => {
        acc.billed += Number(r.billed);
        acc.paid += Number(r.paid);
        acc.waived += Number(r.waived_amount);
        acc.outstanding += Number(r.outstanding);
        return acc;
      },
      { billed: 0, paid: 0, waived: 0, outstanding: 0 }
    );

    const filters = {
      school: schoolId || "",
      grade: gradeRaw,
      only,
      schoolName: (schools.find((s) => s.id === schoolId) || {}).name || "All schools",
      gradeName: gradeRaw === "" ? "All grades" : gradeLabel(gradeRaw),
    };

    if (format === "csv") {
      const lines = [];
      lines.push(["School", csvCell(filters.schoolName)].join(","));
      lines.push(["Grade", csvCell(filters.gradeName)].join(","));
      lines.push(["Only with balance", only ? "yes" : "no"].join(","));
      lines.push(["Generated", todayIso()].join(","));
      lines.push("");
      lines.push("Student ID,State ID,Last name,First name,Grade,School,Billed,Paid,Waived,Outstanding");
      for (const r of rows) {
        lines.push(
          [
            r.id,
            csvCell(r.state_id),
            csvCell(r.last_name),
            csvCell(r.first_name),
            csvCell(gradeLabel(r.grade_level)),
            csvCell(r.school_name || ""),
            Number(r.billed).toFixed(2),
            Number(r.paid).toFixed(2),
            Number(r.waived_amount).toFixed(2),
            Number(r.outstanding).toFixed(2),
          ].join(",")
        );
      }
      lines.push(
        [
          "", "", csvCell("TOTAL"), "", "", "", "",
          totals.billed.toFixed(2),
          totals.paid.toFixed(2),
          totals.waived.toFixed(2),
          totals.outstanding.toFixed(2),
        ].join(",")
      );
      const body = lines.join("\r\n") + "\r\n";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="fee-balances-${todayIso()}.csv"`
      );
      return res.send(body);
    }

    res.render("fees/balances", {
      ...ctx, rows, totals, filters, schools, gradeLabels: grades.rows.map((g) => g.grade_level),
      money, gradeLabel,
      studentCount: rows.length,
    });
  } catch (err) {
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.send("error," + csvCell(err.message) + "\r\n");
    }
    res.render("fees/balances", {
      ...ctx, rows: [], totals: { billed: 0, paid: 0, waived: 0, outstanding: 0 },
      filters: { school: schoolId || "", grade: gradeRaw, only, schoolName: "Unknown", gradeName: "Unknown" },
      schools: [], gradeLabels: [], money, gradeLabel, studentCount: 0,
      error: `Could not build the balances report: ${err.message}`,
    });
  }
});

export default router;
