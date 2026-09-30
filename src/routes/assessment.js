// assessment.js — Assessment module: state/benchmark test scores.
// Auto-mounted at /assessment. Owned by the assessment slice.
//
// Data model (db/migrations/22-assessment.sql):
//   assessments(id, name, subject, grade_levels, administered_on, max_score,
//               proficiency_cut, test_window, active)
//   assessment_scores(id, assessment_id, student_id, scale_score, performance_level)
//
// Performance banding — MUST mirror the CASE in 22-assessment.sql exactly:
//   s < cut * 0.70              -> 'Below Basic'
//   cut * 0.70 <= s < cut       -> 'Basic'
//   cut <= s < cut * 1.20       -> 'Proficient'
//   s >= cut * 1.20             -> 'Advanced'
import { pool, query } from "../db.js";
import express from "express";

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const LEVELS = ["Below Basic", "Basic", "Proficient", "Advanced"];

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function look(rows) { return rows && rows.length ? rows[0] : null; }
function fmtDate(v) {
  if (!v) return "";
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
function gradeLabel(g) {
  if (g === null || g === undefined) return "";
  return Number(g) === 0 ? "K" : String(g);
}
// 'K-5' / '6-8' / '3-8' / '9-12' -> [lo, hi] with K === 0. Returns null if the
// string cannot be parsed (a bad row is skipped, not fatal).
function gradeRange(text) {
  const m = String(text || "").trim().match(/^(K|\d{1,2})\s*-\s*(K|\d{1,2})$/i);
  if (!m) return null;
  const parse = (t) => (String(t).toUpperCase() === "K" ? 0 : Number(t));
  const lo = parse(m[1]);
  const hi = parse(m[2]);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return null;
  return [lo, hi];
}
// Server-side banding. Returns null when the score is not a usable number.
function levelFor(score, cut) {
  const s = Number(score);
  const c = Number(cut);
  if (!Number.isFinite(s) || !Number.isFinite(c)) return null;
  if (s < c * 0.70) return "Below Basic";
  if (s < c) return "Basic";
  if (s < c * 1.20) return "Proficient";
  return "Advanced";
}
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

// Students whose grade level falls in an assessment's grade_levels range,
// ordered by last name (the score-entry roster).
function rosterSql(range) {
  return `
    SELECT st.id, st.state_id, st.last_name, st.first_name, st.grade_level, st.school_id
      FROM students st
     WHERE st.grade_level BETWEEN $1 AND $2
     ORDER BY st.last_name, st.first_name, st.id
  `;
}

async function loadAssessment(id) {
  return look((await query(`SELECT * FROM assessments WHERE id = $1`, [id])).rows);
}

// ---------------------------------------------------------------------------
// GET /assessment — dashboard: all assessments with rolled-up stats, filters
// by subject and test window, and a district totals meta strip.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const ctx = { pageTitle: "Assessment", activeTab: "" };
  const subject = String(req.query.subject || "").trim();
  const window = String(req.query.window || "").trim();
  try {
    const params = [];
    const where = [];
    if (subject) { params.push(subject); where.push(`a.subject = $${params.length}`); }
    if (window) { params.push(window); where.push(`a.test_window = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = (
      await query(
        `
      SELECT a.id, a.name, a.subject, a.grade_levels, a.administered_on,
             a.max_score, a.proficiency_cut, a.test_window, a.active,
             COALESCE(s.scores_entered, 0)::int       AS scores_entered,
             s.avg_score,
             COALESCE(s.proficient, 0)::int           AS proficient,
             (SELECT count(*)::int FROM students st
               WHERE st.grade_level BETWEEN
                 (CASE WHEN split_part(a.grade_levels,'-',1)='K' THEN 0 ELSE split_part(a.grade_levels,'-',1)::int END)
                 AND
                 (CASE WHEN split_part(a.grade_levels,'-',2)='K' THEN 0 ELSE split_part(a.grade_levels,'-',2)::int END)
             ) AS eligible
        FROM assessments a
        LEFT JOIN (
            SELECT assessment_id,
                   count(*) AS scores_entered,
                   ROUND(avg(scale_score), 2) AS avg_score,
                   count(*) FILTER (WHERE performance_level IN ('Proficient','Advanced')) AS proficient
              FROM assessment_scores
             GROUP BY assessment_id
        ) s ON s.assessment_id = a.id
        ${whereSql}
       ORDER BY a.administered_on DESC, a.name
      `,
        params
      )
    ).rows;

    for (const r of rows) {
      r.avg_score = r.avg_score === null ? null : Number(r.avg_score);
      r.pct_proficient = r.scores_entered > 0 ? round1((r.proficient / r.scores_entered) * 100) : null;
      r.pct_entered = r.eligible > 0 ? round1((r.scores_entered / r.eligible) * 100) : null;
    }

    const [subjects, windows] = await Promise.all([
      query(`SELECT DISTINCT subject FROM assessments ORDER BY subject`),
      query(`SELECT DISTINCT test_window FROM assessments WHERE test_window IS NOT NULL ORDER BY test_window`),
    ]);

    // District-wide totals for the meta strip (respecting current filters).
    const totals = look(
      (
        await query(
          `
      SELECT COALESCE(count(*), 0)::int AS n_assessments,
             COALESCE(sum(scores_entered), 0)::int AS n_scored,
             COALESCE(sum(proficient), 0)::int AS n_proficient
        FROM (
          SELECT a.id,
                 (SELECT count(*) FROM assessment_scores sc WHERE sc.assessment_id = a.id) AS scores_entered,
                 (SELECT count(*) FROM assessment_scores sc
                   WHERE sc.assessment_id = a.id AND sc.performance_level IN ('Proficient','Advanced')) AS proficient
            FROM assessments a
            ${whereSql}
        ) q
      `,
          params
        )
      ).rows
    );
    const districtPct = totals && totals.n_scored > 0 ? round1((totals.n_proficient / totals.n_scored) * 100) : null;

    res.render("assessment/index", {
      ...ctx, assessments: rows,
      subjectFilter: subject, windowFilter: window,
      subjects: subjects.rows.map((r) => r.subject),
      windows: windows.rows.map((r) => r.test_window),
      totals: {
        assessments: totals ? totals.n_assessments : 0,
        scored: totals ? totals.n_scored : 0,
        proficient: totals ? totals.n_proficient : 0,
        pctProficient: districtPct,
      },
    });
  } catch (err) {
    res.render("assessment/index", {
      ...ctx, assessments: [], subjects: [], windows: [],
      subjectFilter: subject, windowFilter: window,
      totals: { assessments: 0, scored: 0, proficient: 0, pctProficient: null },
      error: `Could not load assessments: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /assessment/scores?assessment=<id> — score-entry grid for one assessment
// ---------------------------------------------------------------------------
router.get("/scores", async (req, res) => {
  const ctx = { pageTitle: "Score Entry", activeTab: "" };
  try {
    const id = toInt(req.query.assessment);
    if (!id) {
      return res.render("assessment/scores", {
        ...ctx, noAssessment: true,
        message: "No assessment selected. Choose one from the Assessment dashboard.",
      });
    }
    const a = await loadAssessment(id);
    if (!a) {
      return res.status(404).render("assessment/scores", {
        ...ctx, noAssessment: true, error: `No assessment with id ${id}.`,
      });
    }
    const range = gradeRange(a.grade_levels);
    if (!range) {
      return res.status(400).render("assessment/scores", {
        ...ctx, assessment: a, noAssessment: true,
        error: `Assessment "${a.name}" has an unparseable grade range ("${a.grade_levels}").`,
      });
    }

    const [roster, savedRes] = await Promise.all([
      query(rosterSql(), range),
      query(`SELECT student_id, scale_score, performance_level FROM assessment_scores WHERE assessment_id = $1`, [id]),
    ]);
    const scoreMap = new Map();
    for (const s of savedRes.rows) scoreMap.set(s.student_id, s);
    const maxScore = Number(a.max_score);
    const cut = Number(a.proficiency_cut);

    const students = roster.rows.map((st) => {
      const row = scoreMap.get(st.id);
      const scale = row && row.scale_score !== null ? Number(row.scale_score) : null;
      const implied = scale === null ? levelFor(maxScore * 0.5, cut) : levelFor(scale, cut);
      return {
        ...st,
        scale_score: scale,
        performance_level: scale === null ? "" : implied,
        suggested_level: implied,
        entered: scale !== null,
      };
    });
    const enteredCount = students.filter((s) => s.entered).length;

    res.render("assessment/scores", {
      ...ctx, assessment: a, students, levels: LEVELS,
      enteredCount, missingCount: students.length - enteredCount,
      savedFlag: req.query.saved === "1",
      savedCount: toInt(req.query.saved_count),
      missingAfter: Number.isInteger(Number(req.query.missing)) ? Number(req.query.missing) : null,
    });
  } catch (err) {
    res.status(400).render("assessment/scores", {
      ...ctx, noAssessment: true,
      error: `Could not load the score grid: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /assessment/scores — upsert the whole grid in ONE transaction.
// performance_level is always recomputed from the assessment's cut score;
// any client-sent level is ignored.
// ---------------------------------------------------------------------------
router.post("/scores", async (req, res) => {
  const id = toInt(req.body.assessment_id);
  if (!id) return res.redirect("/assessment");
  try {
    const a = await loadAssessment(id);
    if (!a) return res.redirect("/assessment");
    const range = gradeRange(a.grade_levels);
    if (!range) return res.redirect(`/assessment/scores?assessment=${id}`);
    const cut = Number(a.proficiency_cut);
    const maxScore = Number(a.max_score);

    const roster = (await query(rosterSql(), range)).rows;
    const client = await pool.connect();
    let saved = 0;
    try {
      await client.query("BEGIN");
      for (const st of roster) {
        const raw = req.body[`score_${st.id}`];
        const rawStr = raw === undefined || raw === null ? "" : String(raw).trim();
        if (rawStr === "") continue; // blank = leave untouched / not entered
        const n = Number(rawStr);
        if (!Number.isFinite(n)) {
          throw new Error(`Row for student ${st.id} ("${rawStr}") is not a number.`);
        }
        if (n < 0 || n > maxScore) {
          throw new Error(
            `Score ${n} for student ${st.id} is outside 0..${maxScore} (assessment max).`
          );
        }
        const level = levelFor(n, cut); // server-side recompute; client level ignored
        await client.query(
          `
          INSERT INTO assessment_scores (assessment_id, student_id, scale_score, performance_level)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (assessment_id, student_id)
          DO UPDATE SET scale_score = EXCLUDED.scale_score,
                        performance_level = EXCLUDED.performance_level
          `,
          [id, st.id, round2(n).toFixed(2), level]
        );
        saved++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const missing = look(
      (
        await query(
          `
      SELECT (SELECT count(*) FROM students st WHERE st.grade_level BETWEEN $1 AND $2) -
             (SELECT count(*) FROM assessment_scores WHERE assessment_id = $3) AS missing
      `,
          [range[0], range[1], id]
        )
      ).rows
    );
    return res.redirect(
      `/assessment/scores?assessment=${id}&saved=1&saved_count=${saved}&missing=${missing ? missing.missing : 0}`
    );
  } catch (err) {
    return res.status(400).render("assessment/scores", {
      pageTitle: "Score Entry", activeTab: "", noAssessment: true,
      error: `Save failed, nothing was written: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /assessment/student?student=<id> — one student's assessment history with
// a progress note versus their previous score in the same subject.
// ---------------------------------------------------------------------------
router.get("/student", async (req, res) => {
  const ctx = { pageTitle: "Student Assessment History", activeTab: "" };
  try {
    const id = toInt(req.query.student);
    if (!id) {
      return res.render("assessment/student", {
        ...ctx, noStudent: true,
        message: "No student selected. Provide ?student=<id>.",
      });
    }
    const st = look(
      (
        await query(
          `
      SELECT st.id, st.state_id, st.last_name, st.first_name, st.middle_name,
             st.grade_level, st.status, st.school_id, sch.name AS school_name
        FROM students st LEFT JOIN schools sch ON sch.id = st.school_id
       WHERE st.id = $1
      `,
          [id]
        )
      ).rows
    );
    if (!st) {
      return res.status(404).render("assessment/student", {
        ...ctx, noStudent: true, error: `No student with id ${id}.`,
      });
    }

    const rows = (
      await query(
        `
      SELECT sc.id, sc.scale_score, sc.performance_level,
             a.id AS assessment_id, a.name, a.subject, a.administered_on,
             a.max_score, a.proficiency_cut, a.grade_levels, a.test_window
        FROM assessment_scores sc
        JOIN assessments a ON a.id = sc.assessment_id
       WHERE sc.student_id = $1
       ORDER BY a.administered_on, a.id
      `,
        [id]
      )
    ).rows;

    // Progress note: change versus the previous score in the same subject.
    const prevBySubject = new Map();
    for (const r of rows) {
      const cur = r.scale_score === null ? null : Number(r.scale_score);
      const prev = prevBySubject.get(r.subject);
      if (prev === undefined || prev === null || cur === null) {
        r.delta = null;
      } else {
        r.delta = round2(cur - prev);
      }
      r.pct = Number(r.max_score) > 0 && cur !== null ? round1((cur / Number(r.max_score)) * 100) : null;
      if (cur !== null) prevBySubject.set(r.subject, cur);
    }

    // Overall progress note per subject (first vs latest) for a compact summary.
    const subjectSummary = [];
    const bySubject = new Map();
    for (const r of rows) {
      if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
      bySubject.get(r.subject).push(r);
    }
    for (const [subj, list] of bySubject) {
      const scored = list.filter((r) => r.scale_score !== null);
      const first = scored[0] || null;
      const last = scored[scored.length - 1] || null;
      subjectSummary.push({
        subject: subj,
        count: list.length,
        first,
        last,
        change: first && last && first !== last ? round2(Number(last.scale_score) - Number(first.scale_score)) : null,
      });
    }

    res.render("assessment/student", {
      ...ctx, student: st, rows, subjectSummary, LEVELS,
    });
  } catch (err) {
    res.render("assessment/student", {
      ...ctx, noStudent: true, error: `Could not load assessment history: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /assessment/summary?assessment=<id>[&format=csv] — group summary:
// counts/percent per level overall, per school, and per grade when multi-grade.
// ---------------------------------------------------------------------------
router.get("/summary", async (req, res) => {
  const ctx = { pageTitle: "Assessment Summary", activeTab: "" };
  try {
    const id = toInt(req.query.assessment);
    if (!id) {
      return res.render("assessment/summary", {
        ...ctx, noAssessment: true,
        message: "No assessment selected. Choose one from the Assessment dashboard.",
      });
    }
    const a = await loadAssessment(id);
    if (!a) {
      return res.status(404).render("assessment/summary", {
        ...ctx, noAssessment: true, error: `No assessment with id ${id}.`,
      });
    }
    const range = gradeRange(a.grade_levels);
    const cut = Number(a.proficiency_cut);

    const rows = (
      await query(
        `
      SELECT sc.scale_score, sc.performance_level,
             st.id AS student_id, st.grade_level, st.school_id,
             sch.name AS school_name
        FROM assessment_scores sc
        JOIN students st ON st.id = sc.student_id
        LEFT JOIN schools sch ON sch.id = st.school_id
       WHERE sc.assessment_id = $1
      `,
        [id]
      )
    ).rows;
    const eligible = range
      ? look((await query(`SELECT count(*)::int AS n FROM students WHERE grade_level BETWEEN $1 AND $2`, range)).rows).n
      : 0;

    const assessed = rows.length;
    const profCount = rows.filter((r) => r.performance_level === "Proficient" || r.performance_level === "Advanced").length;
    const avg = assessed ? round2(rows.reduce((s, r) => s + (r.scale_score === null ? 0 : Number(r.scale_score)), 0) / assessed) : null;

    const levelStats = LEVELS.map((lvl) => {
      const n = rows.filter((r) => r.performance_level === lvl).length;
      return { level: lvl, count: n, pct: assessed ? round1((n / assessed) * 100) : 0 };
    });

    // Per-school breakdown.
    const schoolMap = new Map();
    for (const r of rows) {
      const key = r.school_id;
      if (!schoolMap.has(key)) schoolMap.set(key, { school: r.school_name || "(no school)", scores: [] });
      schoolMap.get(key).scores.push(r);
    }
    const schools = [...schoolMap.values()]
      .map((b) => {
        const n = b.scores.length;
        const p = b.scores.filter((r) => r.performance_level === "Proficient" || r.performance_level === "Advanced").length;
        const sm = b.scores.reduce((s, r) => s + (r.scale_score === null ? 0 : Number(r.scale_score)), 0);
        return {
          school: b.school, assessed: n,
          avg: n ? round2(sm / n) : null,
          proficient: p,
          pct_proficient: n ? round1((p / n) * 100) : null,
        };
      })
      .sort((x, y) => (x.school < y.school ? -1 : x.school > y.school ? 1 : 0));

    // Per-grade breakdown.
    const gradeMap = new Map();
    for (const r of rows) {
      if (!gradeMap.has(r.grade_level)) gradeMap.set(r.grade_level, []);
      gradeMap.get(r.grade_level).push(r);
    }
    const grades = [...gradeMap.entries()]
      .map(([grade, list]) => {
        const n = list.length;
        const p = list.filter((r) => r.performance_level === "Proficient" || r.performance_level === "Advanced").length;
        const sm = list.reduce((s, r) => s + (r.scale_score === null ? 0 : Number(r.scale_score)), 0);
        return {
          grade_level: grade, grade_label: gradeLabel(grade), assessed: n,
          avg: n ? round2(sm / n) : null,
          proficient: p,
          pct_proficient: n ? round1((p / n) * 100) : null,
        };
      })
      .sort((x, y) => Number(x.grade_level) - Number(y.grade_level));

    // CSV export of the current summary.
    if (String(req.query.format || "").toLowerCase() === "csv") {
      const lines = [];
      lines.push(["Assessment", csvCell(a.name)].join(","));
      lines.push(["Subject", csvCell(a.subject)].join(","));
      lines.push(["Grade range", csvCell(a.grade_levels)].join(","));
      lines.push(["Administered", csvCell(fmtDate(a.administered_on))].join(","));
      lines.push(["Test window", csvCell(a.test_window || "")].join(","));
      lines.push(["Max score", csvCell(a.max_score)].join(","));
      lines.push(["Proficiency cut", csvCell(a.proficiency_cut)].join(","));
      lines.push("");
      lines.push("Performance level,Count,Percent");
      for (const l of levelStats) lines.push([csvCell(l.level), l.count, l.pct].join(","));
      lines.push([csvCell("Assessed"), assessed, ""].join(","));
      lines.push([csvCell("Eligible"), eligible, ""].join(","));
      lines.push([csvCell("Average scale score"), avg === null ? "" : avg, ""].join(","));
      lines.push("");
      lines.push("School,Students assessed,Avg scale,% proficient");
      for (const s of schools) {
        lines.push([csvCell(s.school), s.assessed, s.avg === null ? "" : s.avg, s.pct_proficient === null ? "" : s.pct_proficient].join(","));
      }
      lines.push("");
      lines.push("Grade,Students assessed,Avg scale,% proficient");
      for (const g of grades) {
        lines.push([csvCell(g.grade_label), g.assessed, g.avg === null ? "" : g.avg, g.pct_proficient === null ? "" : g.pct_proficient].join(","));
      }
      const body = lines.join("\r\n") + "\r\n";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="assessment-${id}-summary-${todayIso()}.csv"`);
      return res.send(body);
    }

    res.render("assessment/summary", {
      ...ctx, assessment: a, levelStats, schools, grades,
      assessed, eligible, missing: Math.max(eligible - assessed, 0),
      avg, profCount, pctProficient: assessed ? round1((profCount / assessed) * 100) : null,
      multiGrade: grades.length > 1,
    });
  } catch (err) {
    res.render("assessment/summary", {
      ...ctx, noAssessment: true,
      error: `Could not build the summary: ${err.message}`,
    });
  }
});

export default router;
