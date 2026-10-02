import express from "express";
import { query, pool } from "../db.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Grading module (gradebook).
//
// Roster note: the base schema has no section<->student join table. Because the
// seed data is synthetic and deterministic, every section derives a stable
// 30-student roster from the students of the section's school, windowed by the
// section id (see rosterFor). No writes to the roster; it is read-only.
// ---------------------------------------------------------------------------

const ROSTER_SIZE = 30;

/** One row per student in a section's derived roster (see note above). */
function rosterFor(sectionId) {
  // Postgres forbids variables in OFFSET, so fetch counts and inline a safe
  // integer (never user input) for the window start.
  return query(
    `SELECT st.id, st.last_name, st.first_name, st.state_id, st.grade_level,
            sec.school_id
       FROM sections sec
       JOIN students st ON st.school_id = sec.school_id
      WHERE sec.id = $1
      ORDER BY st.id`,
    [sectionId]
  ).then((r) => {
    const schoolId = r.rows[0] ? r.rows[0].school_id : null;
    if (schoolId == null) return { rows: [] };
    return query(
      `SELECT count(*)::int AS total FROM students WHERE school_id = $1`,
      [schoolId]
    ).then((c) => {
      const total = c.rows[0].total;
      const span = Math.max(total - ROSTER_SIZE + 1, 1);
      const offset = Math.max((Number(sectionId) * 7) % span, 0);
      return query(
        `SELECT st.id, st.last_name, st.first_name, st.state_id, st.grade_level
           FROM sections sec
           JOIN students st ON st.school_id = sec.school_id
          WHERE sec.id = $1
          ORDER BY st.id
          OFFSET ${offset} LIMIT ${ROSTER_SIZE}`,
        [sectionId]
      );
    });
  });
}

async function getSection(id) {
  if (!id) return null;
  const r = await query(
    `SELECT sec.*, sch.name AS school_name, t.name AS teacher_name, tm.name AS term_name
       FROM sections sec
       JOIN schools sch ON sch.id = sec.school_id
       JOIN teachers t  ON t.id = sec.teacher_id
       LEFT JOIN terms tm ON tm.id = sec.term_id
      WHERE sec.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

function toId(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Landing: all sections with assignment counts, filterable by school.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const schoolId = toId(req.query.school);
  const schools = await query("SELECT id, name, code FROM schools ORDER BY name");
  const sections = await query(
    `SELECT sec.id, sec.section_code, sec.course_name, sec.period, sec.room,
            sec.school_id, sch.name AS school_name, t.name AS teacher_name,
            (SELECT count(*) FROM grade_assignments a WHERE a.section_id = sec.id)::int AS assignment_count
       FROM sections sec
       JOIN schools sch ON sch.id = sec.school_id
       JOIN teachers t  ON t.id = sec.teacher_id
      WHERE ($1::int IS NULL OR sec.school_id = $1)
      ORDER BY sch.name, sec.course_name, sec.section_code`,
    [schoolId]
  );
  res.render("grading/index", {
    pageTitle: "Grading",
    activeTab: "grades",
    schools: schools.rows,
    sections: sections.rows,
    schoolId,
  });
});

// ---------------------------------------------------------------------------
// Assignment + weighting setup for a section.
// ---------------------------------------------------------------------------
router.get("/setup", async (req, res) => {
  const sectionId = toId(req.query.section);
  const section = await getSection(sectionId);
  if (!section) {
    return res.status(400).render("grading/setup", {
      pageTitle: "Grading Setup",
      activeTab: "grades",
      section: null,
      assignments: [],
      categories: [],
      weightTotal: 0,
      notice: req.query.notice || null,
      error: "Select a section (missing or unknown section id).",
    });
  }
  const assignments = await query(
    `SELECT a.id, a.name, a.points, a.due_on, a.published,
            c.name AS category_name, c.id AS category_id
       FROM grade_assignments a
       LEFT JOIN grade_categories c ON c.id = a.category_id
      WHERE a.section_id = $1
      ORDER BY a.due_on NULLS LAST, a.id`,
    [sectionId]
  );
  const categories = await query(
    `SELECT id, name, weight FROM grade_categories WHERE section_id = $1 ORDER BY name`,
    [sectionId]
  );
  const weightTotal = categories.rows.reduce(
    (sum, c) => sum + Number(c.weight || 0),
    0
  );
  res.render("grading/setup", {
    pageTitle: `Setup :: ${section.course_name}`,
    activeTab: "grades",
    section,
    assignments: assignments.rows,
    categories: categories.rows,
    weightTotal,
    notice: req.query.notice || null,
    error: null,
  });
});

router.post("/setup", async (req, res) => {
  const sectionId = toId(req.body.section);
  const section = await getSection(sectionId);
  if (!section) return res.status(400).send("Unknown section");
  const name = String(req.body.name || "").trim();
  const categoryId = toId(req.body.category_id);
  const points = Number.parseFloat(req.body.points);
  const dueOn = String(req.body.due_on || "").trim() || null;
  const published = req.body.published === "on" || req.body.published === "1";
  if (!name) {
    return res.redirect(`/grading/setup?section=${sectionId}&notice=` + encodeURIComponent("Assignment name is required."));
  }
  if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    return res.redirect(`/grading/setup?section=${sectionId}&notice=` + encodeURIComponent("Due date must be a valid YYYY-MM-DD date."));
  }
  await query(
    `INSERT INTO grade_assignments (section_id, category_id, name, points, due_on, published)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sectionId, categoryId, name, Number.isFinite(points) ? points : 100, dueOn, published]
  );
  res.redirect(
    `/grading/setup?section=${sectionId}&notice=` +
      encodeURIComponent(`Added assignment "${name}".`)
  );
});

// Create a category.
router.post("/categories", async (req, res) => {
  const action = String(req.body.action || "save");
  const sectionId = toId(req.body.section);
  const section = await getSection(sectionId);
  if (!section) return res.status(400).send("Unknown section");

  if (action === "add") {
    const name = String(req.body.name || "").trim();
    const weight = Number.parseFloat(req.body.weight);
    if (name) {
      await query(
        `INSERT INTO grade_categories (section_id, name, weight) VALUES ($1, $2, $3)
         ON CONFLICT (section_id, name) DO UPDATE SET weight = EXCLUDED.weight`,
        [sectionId, name, Number.isFinite(weight) ? weight : 0]
      );
    }
    return res.redirect(`/grading/setup?section=${sectionId}`);
  }

  // save: weights arrive as weight_<categoryId> fields.
  const cats = await query(
    "SELECT id FROM grade_categories WHERE section_id = $1",
    [sectionId]
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of cats.rows) {
      const raw = req.body[`weight_${c.id}`];
      if (raw === undefined) continue;
      const w = Number.parseFloat(raw);
      await client.query(
        "UPDATE grade_categories SET weight = $1 WHERE id = $2",
        [Number.isFinite(w) ? w : 0, c.id]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.redirect(
    `/grading/setup?section=${sectionId}&notice=` +
      encodeURIComponent("Category weights saved.")
  );
});

// ---------------------------------------------------------------------------
// Score grid.
// ---------------------------------------------------------------------------
function parseCell(raw) {
  // Returns { code, points } from a raw input string.
  const v = String(raw == null ? "" : raw).trim();
  if (v === "") return { code: "", points: null }; // empty = missing
  if (/^m$/i.test(v)) return { code: "M", points: null };
  if (/^x$/i.test(v)) return { code: "X", points: null };
  const n = Number.parseFloat(v);
  if (Number.isFinite(n)) return { code: null, points: n };
  return { code: "", points: null };
}

async function gridData(sectionId, assignmentId, notice, error) {
  const section = await getSection(sectionId);
  if (!section) return null;
  const assignments = await query(
    `SELECT a.id, a.name, a.points, a.due_on, a.published,
            c.name AS category_name
       FROM grade_assignments a
       LEFT JOIN grade_categories c ON c.id = a.category_id
      WHERE a.section_id = $1
      ORDER BY a.due_on NULLS LAST, a.id`,
    [sectionId]
  );
  let selected = assignments.rows.find((a) => a.id === assignmentId) || null;
  if (!selected && assignments.rows.length) selected = assignments.rows[0];
  const roster = await rosterFor(sectionId);

  let scores = {};
  if (assignments.rows.length) {
    const ids = assignments.rows.map((a) => a.id);
    const s = await query(
      `SELECT assignment_id, student_id, code, points
         FROM grade_scores WHERE assignment_id = ANY($1::int[])`,
      [ids]
    );
    for (const row of s.rows) {
      scores[`${row.assignment_id}:${row.student_id}`] = row;
    }
  }
  return {
    pageTitle: "Score Grid",
    activeTab: "grades",
    section,
    assignments: assignments.rows,
    selected,
    roster: roster.rows,
    scores,
    notice: notice || null,
    error: error || null,
  };
}

router.get("/scores", async (req, res) => {
  const sectionId = toId(req.query.section);
  const assignmentId = toId(req.query.assignment);
  const data = await gridData(sectionId, assignmentId, req.query.notice, req.query.error);
  if (!data) {
    return res.status(400).render("grading/scores", {
      pageTitle: "Score Grid",
      activeTab: "grades",
      section: null,
      assignments: [],
      selected: null,
      roster: [],
      scores: {},
      notice: null,
      error: "Select a section (missing or unknown section id).",
    });
  }
  res.render("grading/scores", data);
});

router.post("/scores", async (req, res) => {
  const sectionId = toId(req.body.section);
  const section = await getSection(sectionId);
  if (!section) return res.status(400).send("Unknown section");

  // Grid cells are named score_<assignmentId>_<studentId>.
  const cells = [];
  for (const [key, raw] of Object.entries(req.body)) {
    const m = /^score_(\d+)_(\d+)$/.exec(key);
    if (!m) continue;
    cells.push({ assignmentId: Number(m[1]), studentId: Number(m[2]), value: parseCell(raw) });
  }

  const client = await pool.connect();
  let changed = 0;
  try {
    await client.query("BEGIN");
    for (const c of cells) {
      const existing = await client.query(
        "SELECT code, points FROM grade_scores WHERE assignment_id = $1 AND student_id = $2",
        [c.assignmentId, c.studentId]
      );
      const cur = existing.rows[0];
      const same =
        cur &&
        String(cur.code ?? "") === String(c.value.code ?? "") &&
        String(cur.points ?? "") === String(c.value.points ?? "");
      if (same) continue;
      // A wholly blank cell with no prior row writes nothing.
      if (!cur && c.value.code === "" && c.value.points == null) continue;
      await client.query(
        `INSERT INTO grade_scores (assignment_id, student_id, code, points)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (assignment_id, student_id)
         DO UPDATE SET code = EXCLUDED.code, points = EXCLUDED.points`,
        [c.assignmentId, c.studentId, c.value.code, c.value.points]
      );
      changed++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const back = toId(req.body.assignment) || (cells[0] && cells[0].assignmentId) || null;
  res.redirect(
    `/grading/scores?section=${sectionId}${back ? `&assignment=${back}` : ""}` +
      `&notice=` + encodeURIComponent(`Saved ${changed} changed score${changed === 1 ? "" : "s"}.`)
  );
});

// Bulk fill: apply one value to all students in a section with no score for an assignment.
router.post("/scores/bulk", async (req, res) => {
  const sectionId = toId(req.body.section);
  const assignmentId = toId(req.body.assignment);
  const section = await getSection(sectionId);
  if (!section || !assignmentId) return res.status(400).send("Unknown section or assignment");

  const value = parseCell(req.body.value);
  const onlyMissing = req.body.scope !== "all";
  const roster = await rosterFor(sectionId);
  const studentIds = roster.rows.map((s) => s.id);

  const existing = await query(
    `SELECT student_id FROM grade_scores WHERE assignment_id = $1 AND student_id = ANY($2::int[])`,
    [assignmentId, studentIds]
  );
  const have = new Set(existing.rows.map((r) => r.student_id));
  const targets = onlyMissing ? studentIds.filter((id) => !have.has(id)) : studentIds;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sid of targets) {
      await client.query(
        `INSERT INTO grade_scores (assignment_id, student_id, code, points)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (assignment_id, student_id)
         DO UPDATE SET code = EXCLUDED.code, points = EXCLUDED.points`,
        [assignmentId, sid, value.code, value.points]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.redirect(
    `/grading/scores?section=${sectionId}&assignment=${assignmentId}` +
      `&notice=` + encodeURIComponent(`Bulk fill changed ${targets.length} row${targets.length === 1 ? "" : "s"}.`)
  );
});

// Publish toggle.
router.post("/publish", async (req, res) => {
  const sectionId = toId(req.body.section);
  const assignmentId = toId(req.body.assignment);
  if (!sectionId || !assignmentId) return res.status(400).send("Missing section/assignment");
  const r = await query(
    `UPDATE grade_assignments SET published = NOT published
      WHERE id = $1 AND section_id = $2 RETURNING published`,
    [assignmentId, sectionId]
  );
  const state = r.rows[0] ? r.rows[0].published : false;
  const back = req.body.back === "setup" ? "setup" : "scores";
  const params = back === "setup"
    ? `section=${sectionId}`
    : `section=${sectionId}&assignment=${assignmentId}`;
  res.redirect(
    `/grading/${back}?${params}&notice=` +
      encodeURIComponent(`Assignment ${state ? "published" : "unpublished"}.`)
  );
});

// ---------------------------------------------------------------------------
// Per-student detail with weighted average + letter band.
// ---------------------------------------------------------------------------
const LETTER_BANDS = [
  { letter: "A", min: 90 },
  { letter: "B", min: 80 },
  { letter: "C", min: 70 },
  { letter: "D", min: 60 },
  { letter: "F", min: -Infinity },
];

function letterFor(pct) {
  if (pct == null) return null;
  return (LETTER_BANDS.find((b) => pct >= b.min) || LETTER_BANDS.at(-1)).letter;
}

router.get("/student", async (req, res) => {
  const sectionId = toId(req.query.section);
  const studentId = toId(req.query.student);
  const section = await getSection(sectionId);
  if (!section || !studentId) return res.status(400).send("Unknown section or student");

  const studentR = await query(
    "SELECT id, state_id, first_name, last_name, grade_level FROM students WHERE id = $1",
    [studentId]
  );
  const student = studentR.rows[0];
  if (!student) return res.status(404).send("Unknown student");

  const rows = await query(
    `SELECT a.id AS assignment_id, a.name, a.points AS possible, a.due_on, a.published,
            c.id AS category_id, c.name AS category_name, COALESCE(c.weight, 0) AS weight,
            s.code, s.points AS earned
       FROM grade_assignments a
       LEFT JOIN grade_categories c ON c.id = a.category_id
       LEFT JOIN grade_scores s ON s.assignment_id = a.id AND s.student_id = $2
      WHERE a.section_id = $1
      ORDER BY a.due_on NULLS LAST, a.id`,
    [sectionId, studentId]
  );

  // Category subtotals. "M"/missing/none count as 0 earned (classic behavior);
  // "X" (exempt) is excluded from both earned and possible for that category.
  const catMap = new Map();
  for (const r of rows.rows) {
    const key = r.category_id || 0;
    if (!catMap.has(key)) {
      catMap.set(key, {
        id: r.category_id,
        name: r.category_name || "Uncategorized",
        weight: Number(r.weight || 0),
        earned: 0,
        possible: 0,
        pct: null,
      });
    }
    const cat = catMap.get(key);
    if (r.code === "X") continue; // exempt: no effect
    cat.possible += Number(r.possible || 0);
    cat.earned += Number(r.earned || 0); // null earned -> 0 (missing)
  }
  const categories = [...catMap.values()].map((c) => {
    c.pct = c.possible > 0 ? (c.earned / c.possible) * 100 : null;
    return c;
  });

  // Weighted percentage: sum over categories with data of (category pct * weight),
  // divided by the sum of weights of those same categories (weights renormalized
  // when they don't total 100, and categories with no possible points ignored).
  let weightedSum = 0;
  let weightBasis = 0;
  for (const c of categories) {
    if (c.pct == null) continue;
    weightedSum += c.pct * c.weight;
    weightBasis += c.weight;
  }
  const weightedPct = weightBasis > 0 ? weightedSum / weightBasis : null;
  const letter = letterFor(weightedPct);

  res.render("grading/student", {
    pageTitle: `Student :: ${student.last_name}, ${student.first_name}`,
    activeTab: "grades",
    section,
    student,
    rows: rows.rows,
    categories,
    weightedPct,
    letter,
  });
});

export default router;
