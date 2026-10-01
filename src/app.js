import path from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { pool, query, applyDb } from "./db.js";
import { attachUser, requireAuth, requireRole } from "./middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.urlencoded({ extended: false }));

// Session/user resolution for every request (sets req.user + res.locals.currentUser).
app.use(attachUser);

app.get("/", async (req, res) => {
  // The app opens on the sign-in page for anonymous visitors; signed-in users
  // land on the Start Page.
  if (!req.user) return res.redirect("/auth/login?next=%2F");
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

// Default-deny: every module requires a signed-in user unless listed in
// PUBLIC_MODULES. Open surfaces are only the landing page, /healthz (k8s probes),
// static CSS and the auth flow itself. Role gates layer on top via GATED.
const PUBLIC_MODULES = new Set(["auth"]);
const GATED = {
  admin: [requireRole("Administrator")],
  fees: [requireRole("Administrator", "Registrar")],
  discipline: [requireRole("Administrator", "Counselor", "Teacher", "Registrar")],
};
{
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js")).sort();
  for (const file of files) {
    const name = file.replace(/\.js$/, "");
    const mod = await import(path.join(ROUTES_DIR, file));
    const router = mod.default;
    if (!router) continue;
    const middleware = PUBLIC_MODULES.has(name) ? [] : [requireAuth, ...(GATED[name] ?? [])];
    app.use(`/${name}`, ...middleware, router);
    for (const alias of ROUTE_ALIASES[name] ?? []) app.use(alias, ...middleware, router);
  }
}

const port = Number(process.env.PORT) || 3000;

await applyDb();

app.listen(port, () => {
  console.log(`Elder (elder-sis) listening on http://localhost:${port}`);
});

export default app;