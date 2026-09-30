import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { pool, query, applyDb } from "./db.js";
import studentsRouter from "./routes/students.js";
import schedulingRouter from "./routes/scheduling.js";
import attendanceRouter from "./routes/attendance.js";
import gradingRouter from "./routes/grading.js";
import gradesRouter from "./routes/grades.js";
import reportsRouter from "./routes/reports.js";
import adminRouter from "./routes/admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.urlencoded({ extended: false }));

app.get("/", async (req, res) => {
  const [students, sections, teachers, term] = await Promise.all([
    query("SELECT count(*)::int AS n FROM students"),
    query("SELECT count(*)::int AS n FROM sections"),
    query("SELECT count(*)::int AS n FROM teachers"),
    query("SELECT name FROM terms WHERE is_current LIMIT 1"),
  ]);
  res.render("home", {
    stats: {
      students: students.rows[0].n,
      sections: sections.rows[0].n,
      teachers: teachers.rows[0].n,
    },
    termName: term.rows.length ? `Year 2026\u201327 \u00b7 ${term.rows[0].name}` : undefined,
  });
});

app.get("/healthz", async (req, res) => {
  try {
    await query("SELECT 1");
    res.status(200).json({ ok: true, db: "up" });
  } catch {
    res.status(500).json({ ok: false, db: "down" });
  }
});

app.use("/students", studentsRouter);
app.use("/scheduling", schedulingRouter);
app.use("/attendance", attendanceRouter);
app.use("/grading", gradingRouter);
app.use("/grades", gradesRouter);
app.use("/reports", reportsRouter);
app.use("/admin", adminRouter);

const port = Number(process.env.PORT) || 3000;

await applyDb();

app.listen(port, () => {
  console.log(`fake-sis listening on http://localhost:${port}`);
});

export default app;