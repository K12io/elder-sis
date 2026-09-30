// grades.js — Academic Records module: final grades, GPA, transcripts, report
// cards, grade corrections. Auto-mounted at /grades. Owned by the grades slice.
import { pool, query } from "../db.js";
import express from "express";

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function look(rows) {
  if (rows && rows.length) return rows[0];
  return null;
}
// Letter from percent, using the grade_scale table. Falls back to the lowest
// letter in the scale (F).
function letterFor(scaleRows, pct) {
  const p = Number(pct);
  for (const r of scaleRows) {
    if (p >= Number(r.min_percent) && p <= Number(r.max_percent)) return r.letter;
  }
  return scaleRows.length ? scaleRows[scaleRows.length - 1].letter : "F";
}

// ---------------------------------------------------------------------------
// Grade computation (shared by standings page and posting). Semantics:
//   - score with numeric points  -> earned, counts toward category possible
//   - code 'M' (missing)         -> 0 earned, counts toward possible
//   - code 'X' (exempt)          -> excluded from earned AND possible
//   - points NULL with no code   -> unscored: counts in possible, 0 earned
//   - category pct = earned / possible * 100
//   - weighted pct = SUM(cat_pct * cat_weight) / SUM(cat_weight)
// Every student in the roster is listed, whether or not they have any scores.
// Scores on assignments whose category is missing from the section's category
// list (e.g. untagged assignments) are never dropped: they collect into an
// explicit uncategorized bucket, and a student whose only scores are
// uncategorized still receives a percent from the raw earned/possible ratio.
// Posting refuses when SUM(weight) does not equal 100.
// ---------------------------------------------------------------------------
const UNCATEGORIZED = "__uncategorized__";

function computeStandings(categories, roster, scores) {
  const cats = categories.map((c) => ({ id: c.id, name: c.name, weight: Number(c.weight) }));
  const catIds = new Set(cats.map((c) => c.id));
  const byStudent = new Map();

  function studentRec(id, name) {
    let rec = byStudent.get(id);
    if (!rec) {
      rec = {
        studentId: id, name, cats: {}, missing: 0, exempt: 0,
        anyScore: false, hasScores: false,
        uncategorized: { earned: 0, possible: 0, pct: null },
      };
      for (const c of cats) rec.cats[c.id] = { earned: 0, possible: 0 };
      byStudent.set(id, rec);
    }
    return rec;
  }

  // Seed every actively enrolled roster student first so students with no
  // scores at all are still listed (shown as "not scored", never posted).
  for (const r of roster) {
    studentRec(r.id, `${r.last_name}, ${r.first_name}`);
  }

  const mismatchedCategories = new Set();
  for (const s of scores) {
    const rec = studentRec(s.student_id, `${s.last_name}, ${s.first_name}`);
    rec.anyScore = true;
    rec.hasScores = true;
    const known = catIds.has(s.category_id);
    if (!known) {
      mismatchedCategories.add(
        s.category_id === null || s.category_id === undefined ? UNCATEGORIZED : s.category_id
      );
    }
    // A score whose category is not part of the section's category list is
    // routed to the explicit uncategorized bucket rather than discarded.
    const bucket = known ? rec.cats[s.category_id] : rec.uncategorized;
    const code = (s.code || "").toUpperCase();
    if (code === "X") { rec.exempt += 1; continue; }
    bucket.possible += Number(s.assignment_points || 0);
    if (code === "M") { rec.missing += 1; continue; }
    if (s.points !== null && s.points !== undefined) {
      bucket.earned += Number(s.points);
    }
  }

  const totalWeight = cats.reduce((a, c) => a + c.weight, 0);
  const out = [];
  for (const rec of byStudent.values()) {
    let num = 0, den = 0;
    for (const c of cats) {
      const b = rec.cats[c.id];
      const pctCat = b.possible > 0 ? (b.earned / b.possible) * 100 : null;
      rec.cats[c.id] = { earned: b.earned, possible: b.possible, pct: pctCat === null ? null : round1(pctCat) };
      if (pctCat !== null) { num += pctCat * c.weight; den += c.weight; }
    }
    rec.pct = den > 0 ? round1(num / den) : null;
    // Fallback: a student with scores but no weighted-category contribution
    // (only untagged/mismatched work) still gets a percent from raw work done.
    if (rec.pct === null && rec.hasScores) {
      const u = rec.uncategorized;
      rec.uncategorized.pct = u.possible > 0 ? round1((u.earned / u.possible) * 100) : 0;
      rec.pct = rec.uncategorized.pct;
      rec.pctBasis = "uncategorized";
    }
    out.push(rec);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { students: out, totalWeight, categories: cats, mismatchedCategories: [...mismatchedCategories] };
}

// ---------------------------------------------------------------------------
// Section standings loader (used by GET and POST /post)
// ---------------------------------------------------------------------------
// Roster note (mirrors the grading module's read-only derived roster): these
// synthetic sections have no per-section enrollment join, so a section's roster
// is the actively enrolled students of the section's school, windowed
// deterministically by section id. Read-only; the roster is never written.
const ROSTER_SIZE = 30;
async function rosterForSection(sectionId, schoolId) {
  const total = look(
    (await query(`SELECT count(*)::int AS total FROM students WHERE school_id = $1 AND status = 'Active'`, [schoolId])).rows
  );
  const n = total ? total.total : 0;
  if (!n) return [];
  const span = Math.max(n - ROSTER_SIZE + 1, 1);
  const offset = Math.max((Number(sectionId) * 7) % span, 0);
  return (
    await query(
      `SELECT st.id, st.last_name, st.first_name, st.grade_level, st.school_id
         FROM students st
        WHERE st.school_id = $1 AND st.status = 'Active'
        ORDER BY st.id
        OFFSET ${offset} LIMIT ${ROSTER_SIZE}`,
      [schoolId]
    )
  ).rows;
}

async function loadSectionContext(sectionId) {
  const sec = look(
    (
      await query(
        `
      SELECT s.id, s.section_code, s.course_name, s.term_id, s.school_id,
             tm.name AS term_name, sch.name AS school_name, tch.name AS teacher_name
        FROM sections s
        JOIN terms tm ON tm.id = s.term_id
        JOIN schools sch ON sch.id = s.school_id
        LEFT JOIN teachers tch ON tch.id = s.teacher_id
       WHERE s.id = $1
      `,
        [sectionId]
      )
    ).rows
  );
  if (!sec) return { notFound: true };

  const roster = await rosterForSection(sectionId, sec.school_id);

  const [catsRes, scoresRes, postedRes, scaleRes] = await Promise.all([
    query(`SELECT id, name, weight FROM grade_categories WHERE section_id = $1 ORDER BY id`, [sectionId]),
    query(
      `
      SELECT gs.assignment_id, gs.student_id, gs.code, gs.points,
             ga.category_id, ga.points AS assignment_points
        FROM grade_scores gs
        JOIN grade_assignments ga ON ga.id = gs.assignment_id
        JOIN students st ON st.id = gs.student_id
       WHERE ga.section_id = $1 AND gs.student_id IS NOT NULL
      `,
      [sectionId]
    ),
    query(
      `
      SELECT fg.*, st.last_name, st.first_name
        FROM final_grades fg JOIN students st ON st.id = fg.student_id
       WHERE fg.section_id = $1
       ORDER BY st.last_name, st.first_name
      `,
      [sectionId]
    ),
    query(`SELECT letter, min_percent, max_percent, gpa_points FROM grade_scale ORDER BY sort_order`),
  ]);

  const { students, totalWeight, categories, mismatchedCategories } = computeStandings(catsRes.rows, roster, scoresRes.rows);
  const scale = scaleRes.rows;
  for (const st of students) {
    st.letter = st.pct === null ? null : letterFor(scale, st.pct);
    st.gpaPoints = st.letter === null ? null : look(scale.filter((r) => r.letter === st.letter)).gpa_points;
  }
  const scoredCount = students.filter((s) => s.hasScores).length;
  const notScoredCount = students.length - scoredCount;
  // Assignments whose category is NULL or belongs to another section: their
  // scores have no place in the section's weighted categories. Reported so the
  // mismatch is visible rather than silently dropping students.
  const untaggedAssignments = (
    await query(
      `SELECT ga.id, ga.name, ga.category_id
         FROM grade_assignments ga
         LEFT JOIN grade_categories gc ON gc.id = ga.category_id
        WHERE ga.section_id = $1
          AND (ga.category_id IS NULL OR gc.section_id IS DISTINCT FROM $1)
        ORDER BY ga.id`,
      [sectionId]
    )
  ).rows;

  const postedMap = new Map();
  for (const p of postedRes.rows) postedMap.set(p.student_id, p);

  return {
    section: sec,
    categories,
    students,
    scale,
    postedMap,
    rosterSize: students.length,
    scoredCount,
    notScoredCount,
    mismatchedCategories,
    untaggedAssignments,
    weightsTotal: round1(totalWeight),
    weightsOk: Math.abs(totalWeight - 100) < 0.001,
  };
}

// ---------------------------------------------------------------------------
// GPA / transcript row source (read-only). Credits come from the scheduling
// module's courses catalog joined by course_name; when the catalog has no row
// for the course, the course is treated as 1.0 credit (equal-weight fallback).
// ---------------------------------------------------------------------------
const GPA_QUERY = `
  SELECT fg.term_id, tm.starts_on, tm.name AS term_name,
         s.course_name, fg.percent, fg.letter, gs.gpa_points,
         COALESCE(c.credits, 1.0) AS credits,
         (c.id IS NOT NULL) AS has_credits_row
    FROM final_grades fg
    JOIN terms tm ON tm.id = fg.term_id
    JOIN grade_scale gs ON gs.letter = fg.letter
    JOIN sections s ON s.id = fg.section_id
    LEFT JOIN courses c ON c.course_name = s.course_name
   WHERE fg.student_id = $1
`;

function buildGpa(rows) {
  const perTerm = [];
  let num = 0, den = 0, cur = null;
  for (const r of rows) {
    if (!cur || cur.term_id !== r.term_id) {
      cur = { term_id: r.term_id, term_name: r.term_name, courses: [], num: 0, den: 0 };
      perTerm.push(cur);
    }
    const pts = Number(r.gpa_points);
    const cr = Number(r.credits);
    cur.num += pts * cr; cur.den += cr;
    cur.courses.push({ ...r });
    num += pts * cr; den += cr;
  }
  for (const t of perTerm) {
    t.termGpa = t.den > 0 ? t.num / t.den : null;
  }
  perTerm.sort((a, b) => {
    const sa = a.courses.length ? a.courses[0].starts_on : "";
    const sb = b.courses.length ? b.courses[0].starts_on : "";
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  return { perTerm, cumGpa: den > 0 ? num / den : null };
}

async function saveGpaSnapshots(studentId, perTerm, cumGpa) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of perTerm) {
      if (t.termGpa === null) continue;
      await client.query(
        `
        INSERT INTO gpa_snapshots (student_id, term_id, term_gpa, cumulative_gpa, computed_on)
        VALUES ($1, $2, $3, $4, CURRENT_DATE)
        ON CONFLICT (student_id, term_id)
        DO UPDATE SET term_gpa = EXCLUDED.term_gpa,
                      cumulative_gpa = EXCLUDED.cumulative_gpa,
                      computed_on = CURRENT_DATE
        `,
        [
          studentId,
          t.term_id,
          round2(t.termGpa).toFixed(2),
          cumGpa === null ? null : round2(cumGpa).toFixed(2),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function studentPickList() {
  return (
    await query(
      `SELECT id, last_name, first_name, grade_level FROM students
        ORDER BY last_name, first_name LIMIT 500`
    )
  ).rows;
}

// ---------------------------------------------------------------------------
// GET /grades — landing: current-term sections with post status
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const ctx = { pageTitle: "Grades & Transcripts", activeTab: "transcripts" };
  try {
    const [sections, scale, currentTerm] = await Promise.all([
      query(
        `
      SELECT s.id, s.section_code, s.course_name, s.period, s.room,
             sch.name AS school_name, tch.name AS teacher_name,
             (SELECT count(*)::int FROM grade_scores gs
                JOIN grade_assignments ga ON ga.id = gs.assignment_id
               WHERE ga.section_id = s.id) AS score_rows,
             (SELECT count(*)::int FROM (
                  SELECT DISTINCT gs.student_id FROM grade_scores gs
                    JOIN grade_assignments ga ON ga.id = gs.assignment_id
                   WHERE ga.section_id = s.id AND gs.student_id IS NOT NULL
              ) q) AS scored_students,
             (SELECT count(*)::int FROM final_grades fg
               WHERE fg.section_id = s.id) AS posted_count
        FROM sections s
        JOIN terms tm ON tm.id = s.term_id AND tm.is_current
        JOIN schools sch ON sch.id = s.school_id
        LEFT JOIN teachers tch ON tch.id = s.teacher_id
       ORDER BY sch.name, s.course_name, s.section_code
      `
      ),
      query(`SELECT letter, min_percent, max_percent, gpa_points, sort_order
               FROM grade_scale ORDER BY sort_order`),
      query(`SELECT id, name FROM terms WHERE is_current LIMIT 1`),
    ]);
    res.render("grades/index", {
      ...ctx,
      sections: sections.rows,
      scale: scale.rows,
      currentTerm: look(currentTerm.rows),
    });
  } catch (err) {
    res.render("grades/index", {
      ...ctx, sections: [], scale: [], currentTerm: null,
      error: `Could not load grade data: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /grades/post?section=<id>
// ---------------------------------------------------------------------------
router.get("/post", async (req, res) => {
  const ctx = { pageTitle: "Post Final Grades", activeTab: "transcripts" };
  try {
    const sectionId = toInt(req.query.section);
    if (!sectionId) {
      return res.render("grades/post", {
        ...ctx, noSection: true,
        message: "No section selected. Pick a section from the Grades landing page.",
      });
    }
    const data = await loadSectionContext(sectionId);
    res.render("grades/post", {
      ...ctx, ...data,
      postedFlag: req.query.posted === "1",
    });
  } catch (err) {
    res.render("grades/post", { ...ctx, error: `Could not compute standings: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /grades/post — post final grades for every student with a score,
// in ONE transaction. Refuses when category weights do not total 100.
// ---------------------------------------------------------------------------
router.post("/post", async (req, res) => {
  const sectionId = toInt(req.body.section);
  if (!sectionId) return res.redirect("/grades");
  try {
    const data = await loadSectionContext(sectionId);
    if (data.notFound) {
      return res.status(400).render("grades/post", {
        pageTitle: "Post Final Grades", activeTab: "transcripts", notFound: true,
        error: "Section not found.",
      });
    }
    if (!data.weightsOk) {
      return res.status(400).render("grades/post", {
        pageTitle: "Post Final Grades", activeTab: "transcripts", ...data,
        error:
          `Posting refused: the category weights for ${data.section.section_code} total ` +
          `${data.weightsTotal}%, not 100%. Fix the weights in the Grading module, then re-post.`,
      });
    }
    const postedBy = String(req.body.posted_by || "Demo User").slice(0, 60) || "Demo User";
    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      // Repost semantics: clear this section's rows then write fresh ones.
      await client.query(`DELETE FROM final_grades WHERE section_id = $1`, [sectionId]);
      for (const s of data.students) {
        // Students with no scores at all (pct === null) are listed on the page
        // but deliberately NOT posted; they are reported in the N of M summary.
        if (s.pct === null) continue;
        await client.query(
          `
          INSERT INTO final_grades
            (student_id, section_id, term_id, percent, letter, points, posted_on, posted_by)
          VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7)
          `,
          [s.studentId, sectionId, data.section.term_id, round1(s.pct).toFixed(2), s.letter, round2(s.pct), postedBy]
        );
        inserted++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    const fresh = await loadSectionContext(sectionId);
    res.render("grades/post", {
      ...fresh,
      pageTitle: "Post Final Grades",
      activeTab: "transcripts",
      postedFlag: true,
      postedCount: inserted,
      attemptedCount: data.students.length,
    });
  } catch (err) {
    res.status(400).render("grades/post", {
      pageTitle: "Post Final Grades", activeTab: "transcripts", noSection: true,
      error: `Posting failed, nothing was written: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /grades/gpa?student=<id>
// ---------------------------------------------------------------------------
router.get("/gpa", async (req, res) => {
  const ctx = { pageTitle: "GPA Lookup", activeTab: "transcripts" };
  try {
    const studentId = toInt(req.query.student);
    const studentList = await studentPickList();
    if (!studentId) {
      return res.render("grades/gpa", { ...ctx, studentList, noStudent: true });
    }
    const st = look(
      (await query(`SELECT id, last_name, first_name, middle_name, grade_level, status FROM students WHERE id = $1`, [studentId])).rows
    );
    if (!st) {
      return res.render("grades/gpa", { ...ctx, studentList, error: `No student with id ${studentId}.` });
    }
    const rows = (await query(GPA_QUERY, [studentId])).rows;
    const { perTerm, cumGpa } = buildGpa(rows);
    const creditsEnabled = rows.length > 0 && rows.some((r) => r.has_credits_row);
    await saveGpaSnapshots(studentId, perTerm, cumGpa);
    const snaps = (await query(`SELECT term_id, computed_on FROM gpa_snapshots WHERE student_id = $1 ORDER BY computed_on DESC`, [studentId])).rows;
    const scaleRows = (await query(`SELECT letter, min_percent, gpa_points FROM grade_scale ORDER BY sort_order`)).rows;
    res.render("grades/gpa", {
      ...ctx, studentList, student: st, perTerm, cumGpa, creditsEnabled, snapshots: snaps, scaleRows,
    });
  } catch (err) {
    res.render("grades/gpa", { ...ctx, studentList: [], error: `Could not compute GPA: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// GET /grades/transcript?student=<id>[&term=<id>]
// Full transcript of record, or a single-term report card with ?term=<id>.
// ---------------------------------------------------------------------------
router.get("/transcript", async (req, res) => {
  const ctx = { pageTitle: "Transcript", activeTab: "transcripts" };
  try {
    const studentId = toInt(req.query.student);
    const studentList = await studentPickList();
    if (!studentId) {
      return res.render("grades/transcript", { ...ctx, reportCard: false, reportCardTerm: null, reportCardTermId: null, terms: [], studentList, noStudent: true });
    }
    const st = look((await query(`SELECT * FROM students WHERE id = $1`, [studentId])).rows);
    if (!st) {
      return res.render("grades/transcript", { ...ctx, reportCard: false, reportCardTerm: null, reportCardTermId: null, terms: [], studentList, error: `No student with id ${studentId}.` });
    }

    const termFilter = toInt(req.query.term);
    const gpaRows = (
      await query(termFilter ? `${GPA_QUERY} AND fg.term_id = $2` : GPA_QUERY, termFilter ? [studentId, termFilter] : [studentId])
    ).rows;
    const { perTerm, cumGpa } = buildGpa(gpaRows);

    const courseRows = (
      await query(
        `
      SELECT fg.term_id, fg.section_id, fg.percent, fg.letter,
             s.section_code, s.course_name, s.period, s.room,
             tch.name AS teacher_name,
             COALESCE(c.credits, 1.0) AS credits,
             (c.id IS NOT NULL) AS has_credits_row,
             (SELECT count(*)::int FROM attendance_daily ad
               WHERE ad.student_id = fg.student_id AND ad.section_id = fg.section_id AND ad.code = 'A') AS absences,
             (SELECT count(*)::int FROM attendance_daily ad
               WHERE ad.student_id = fg.student_id AND ad.section_id = fg.section_id AND ad.code = 'T') AS tardies
        FROM final_grades fg
        JOIN sections s ON s.id = fg.section_id
        LEFT JOIN teachers tch ON tch.id = s.teacher_id
        LEFT JOIN courses c ON c.course_name = s.course_name
       WHERE fg.student_id = $1 ${termFilter ? "AND fg.term_id = $2" : ""}
       ORDER BY s.course_name
      `,
        termFilter ? [studentId, termFilter] : [studentId]
      )
    ).rows;

    const termNames = new Map();
    for (const t of perTerm) termNames.set(t.term_id, t.term_name);
    const courseNames = new Map();
    for (const r of courseRows) courseNames.set(r.term_id, r.term_name || termNames.get(r.term_id) || "");
    const byTerm = new Map();
    for (const r of courseRows) {
      if (!byTerm.has(r.term_id)) byTerm.set(r.term_id, { term_id: r.term_id, term_name: courseNames.get(r.term_id), courses: [] });
      byTerm.get(r.term_id).courses.push(r);
    }
    const gpaByTerm = new Map(perTerm.map((t) => [t.term_id, t]));
    const termsOut = [...byTerm.values()].map((t) => ({ ...t, termGpa: (gpaByTerm.get(t.term_id) || {}).termGpa ?? null }));

    const corrections = (
      await query(
        `
      SELECT gc.*, s.section_code, s.course_name
        FROM grade_corrections gc JOIN sections s ON s.id = gc.section_id
       WHERE gc.student_id = $1
       ORDER BY gc.corrected_on DESC, gc.id DESC
      `,
        [studentId]
      )
    ).rows;

    const creditsTotal = courseRows.reduce((a, r) => a + Number(r.credits), 0);
    const creditsEnabled = courseRows.some((r) => r.has_credits_row);
    const schoolRow = look((await query(`SELECT name FROM schools WHERE id = $1`, [st.school_id])).rows);
    const correctedFlag = req.query.corrected === "1";

    res.render("grades/transcript", {
      ...ctx, studentList, student: st, schoolRow,
      terms: termsOut, cumGpa, creditsTotal: round1(creditsTotal), creditsEnabled,
      corrections, correctedFlag,
      reportCard: !!termFilter,
      reportCardTermId: termFilter,
      reportCardTerm: termFilter ? (termsOut.find((t) => t.term_id === termFilter) || null) : null,
    });
  } catch (err) {
    res.render("grades/transcript", { ...ctx, studentList: [], reportCard: false, reportCardTerm: null, reportCardTermId: null, terms: [], error: `Could not build transcript: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /grades/correct — change one final grade letter (and optional percent)
// with a required reason. Logs to grade_corrections.
// ---------------------------------------------------------------------------
router.post("/correct", async (req, res) => {
  const studentId = toInt(req.body.student_id);
  const sectionId = toInt(req.body.section_id);
  const backTo = `/grades/transcript?student=${studentId || ""}`;
  if (!studentId || !sectionId) return res.redirect(studentId || sectionId ? backTo : "/grades");

  const reason = String(req.body.reason || "").trim();
  const newLetter = String(req.body.new_letter || "").trim().toUpperCase();
  const scaleRows = (await query(`SELECT letter, min_percent FROM grade_scale ORDER BY sort_order`)).rows;
  const scaleRow = look(scaleRows.filter((r) => r.letter === newLetter));
  const newPercentRaw = String(req.body.new_percent || "").trim();
  let pct = Number(newPercentRaw);
  if (newPercentRaw === "" || Number.isNaN(pct)) pct = scaleRow ? Number(scaleRow.min_percent) : null;

  if (!scaleRow) {
    return res.status(400).render("grades/transcript", {
      pageTitle: "Transcript", activeTab: "transcripts", reportCard: false, reportCardTerm: null, reportCardTermId: null, terms: [], studentList: [],
      error: `Correction refused: "${req.body.new_letter || ""}" is not a valid letter grade on the district scale.`,
    });
  }
  if (reason.length < 3) {
    return res.status(400).render("grades/transcript", {
      pageTitle: "Transcript", activeTab: "transcripts", reportCard: false, reportCardTerm: null, reportCardTermId: null, terms: [], studentList: [],
      error: `Correction refused: a reason of at least 3 characters is required.`,
    });
  }

  const client = await pool.connect();
  try {
    const fg = look(
      (await client.query(`SELECT * FROM final_grades WHERE student_id = $1 AND section_id = $2`, [studentId, sectionId])).rows
    );
    if (!fg) {
      return res.status(400).render("grades/transcript", {
        pageTitle: "Transcript", activeTab: "transcripts", reportCard: false, reportCardTerm: null, reportCardTermId: null, terms: [], studentList: [],
        error: `Correction refused: no posted final grade for student ${studentId} in section ${sectionId}.`,
      });
    }
    const oldPercent = fg.percent === null ? null : round1(Number(fg.percent));
    await client.query("BEGIN");
    await client.query(`UPDATE final_grades SET letter = $1, percent = $2 WHERE id = $3`, [
      newLetter, pct === null ? null : Number(pct).toFixed(2), fg.id,
    ]);
    await client.query(
      `
      INSERT INTO grade_corrections
        (student_id, section_id, old_letter, new_letter, old_percent, new_percent, reason, corrected_on, corrected_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, 'Demo User')
      `,
      [studentId, sectionId, fg.letter, newLetter, oldPercent, pct === null ? null : Number(pct).toFixed(2), reason]
    );
    await client.query("COMMIT");
    client.release();
    return res.redirect(`${backTo}&corrected=1`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    return res.status(400).render("grades/transcript", {
      pageTitle: "Transcript", activeTab: "transcripts", reportCard: false, reportCardTerm: null, reportCardTermId: null, terms: [], studentList: [],
      error: `Correction failed: ${err.message}`,
    });
  }
});

export default router;
