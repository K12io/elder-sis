import path from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { pool, query, applyDb } from "./db.js";

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


// ---- Route auto-mount -------------------------------------------------------
// Every module slice owns ONE file in src/routes/. It is mounted automatically at
// "/<basename>", so parallel slices never edit this file. Extra paths are aliases.
const ROUTES_DIR = path.join(__dirname, "routes");
const ROUTE_ALIASES = { admin: ["/administration"] };
{
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js")).sort();
  for (const file of files) {
    const name = file.replace(/\.js$/, "");
    const mod = await import(path.join(ROUTES_DIR, file));
    const router = mod.default;
    if (!router) continue;
    app.use(`/${name}`, router);
    for (const alias of ROUTE_ALIASES[name] ?? []) app.use(alias, router);
  }
}

const port = Number(process.env.PORT) || 3000;

await applyDb();

app.listen(port, () => {
  console.log(`fake-sis listening on http://localhost:${port}`);
});

export default app;