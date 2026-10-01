import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

// Return DATE columns (OID 1082) as raw 'YYYY-MM-DD' strings. Default pg parsing
// yields JS Date objects, which display code turns into 'Mon Nov 19'-style junk
// and which then round-trips into date columns as unparseable garbage.
pg.types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Run with: npm start (uses --env-file=.env) " +
      "or export DATABASE_URL=postgres://user:pass@host:5432/fake_sis"
  );
}

export const pool = new Pool({ connectionString });

export function query(text, params) {
  return pool.query(text, params);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(__dirname, "..", "db");
const MIGRATIONS_DIR = path.join(DB_DIR, "migrations");

/**
 * Slice-owned migrations: db/migrations/*.sql applied in filename order, inside the
 * same transaction as schema.sql. Each slice adds its own file (must be idempotent,
 * e.g. CREATE TABLE IF NOT EXISTS) so parallel slices never edit schema.sql.
 */
function migrationsSql() {
  if (!existsSync(MIGRATIONS_DIR)) return "";
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `-- ==== ${f} ====\n${readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")}`)
    .join("\n");
}

// ---- Deterministic synthetic seed data (no randomness) ----

const FIRST_NAMES = [
  "Ava", "Liam", "Maya", "Noah", "Zoe", "Ethan", "Ivy", "Owen",
  "Nora", "Finn", "Ruby", "Jude", "Elena", "Theo", "Iris", "Milo",
  "Cora", "Ezra", "Lena", "Hugo",
];

const LAST_NAMES = [
  "Alvarez", "Bennett", "Chen", "Diaz", "Evans", "Foster", "Garcia",
  "Hughes", "Ibrahim", "Jensen", "Kowalski", "Lopez", "Mercer", "Nguyen",
  "Okafor", "Petrov", "Quinn", "Reyes", "Sandoval", "Tanaka",
];

const MIDDLE_NAMES = ["Rae", "James", "Lee", "Marie", "Dean", "Ann"];

// School buckets: [schoolIndex, count, gradeRangeStart]. Grades: K=0.
const SCHOOL_PLAN = [
  { school: 2, count: 140, grades: [0, 1, 2, 3, 4, 5] }, // Elementary
  { school: 1, count: 60, grades: [6, 7, 8] },           // Middle
  { school: 0, count: 100, grades: [9, 10, 11, 12] },    // High
];

function pad(n, w) {
  return String(n).padStart(w, "0");
}

function buildStudents() {
  const students = [];
  let i = 0;
  for (const plan of SCHOOL_PLAN) {
    for (let k = 0; k < plan.count; k++, i++) {
      const grade = plan.grades[k % plan.grades.length];
      const birthYear = 2012 - grade; // grade 12 -> 2000, K -> 2012
      const month = (i % 12) + 1;
      const day = (i % 28) + 1;
      students.push({
        state_id: `VA${pad(100000 + i, 6)}`,
        last_name: LAST_NAMES[(i * 7 + Math.floor(i / 20)) % 20],
        first_name: FIRST_NAMES[(i * 3) % 20],
        middle_name: MIDDLE_NAMES[i % MIDDLE_NAMES.length],
        grade_level: grade,
        gender: i % 2 === 0 ? "M" : "F",
        dob: `${birthYear}-${pad(month, 2)}-${pad(day, 2)}`,
        school_index: plan.school,
      });
    }
  }
  return students;
}

async function seed(client) {
  // Schools (index 0,1,2 as referenced by SCHOOL_PLAN).
  const schools = [
    ["Valley View High School", "VVH"],
    ["Valley View Middle School", "VVM"],
    ["Valley View Elementary", "VVE"],
  ];
  const schoolIds = [];
  for (const [name, code] of schools) {
    const r = await client.query(
      "INSERT INTO schools (name, code) VALUES ($1, $2) RETURNING id",
      [name, code]
    );
    schoolIds.push(r.rows[0].id);
  }

  // District-level terms (school_id NULL = all schools).
  const terms = [
    ["2025-26 Fall", "2025-08-18", "2025-12-12", false],
    ["2025-26 Spring", "2026-01-05", "2026-06-05", false],
    ["2026-27 Fall", "2026-09-01", "2026-12-18", true],
    ["2026-27 Spring", "2027-01-04", "2027-06-04", false],
  ];
  const termIds = {};
  for (const [name, start, end, current] of terms) {
    const r = await client.query(
      "INSERT INTO terms (name, school_id, starts_on, ends_on, is_current) VALUES ($1, NULL, $2, $3, $4) RETURNING id",
      [name, start, end, current]
    );
    termIds[name] = r.rows[0].id;
  }
  const currentTermId = termIds["2026-27 Fall"];

  // Students: one multi-row parameterized INSERT (8 params per row).
  const students = buildStudents();
  const values = [];
  const params = [];
  students.forEach((s, idx) => {
    const b = idx * 8;
    values.push(
      `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},` +
        `$${b + 6},$${b + 7},$${b + 8},'Active')`
    );
    params.push(
      s.state_id, s.last_name, s.first_name, s.middle_name,
      s.grade_level, s.gender, s.dob, schoolIds[s.school_index]
    );
  });
  const ins = await client.query(
    `INSERT INTO students
       (state_id, last_name, first_name, middle_name, grade_level,
        gender, dob, school_id, status)
     VALUES ${values.join(",\n")}
     RETURNING id, school_id, grade_level`,
    params
  );

  // Enrollments: one row per student, their school + current term.
  const eValues = [];
  const eParams = [];
  ins.rows.forEach((row, idx) => {
    const b = idx * 4;
    eValues.push(
      `($${b + 1},$${b + 2},$${b + 3},'2026-09-01'::date,NULL,$${b + 4},'M')`
    );
    eParams.push(row.id, row.school_id, currentTermId, row.grade_level);
  });
  await client.query(
    `INSERT INTO enrollments
       (student_id, school_id, term_id, entry_date, exit_date, grade_level, code)
     VALUES ${eValues.join(",\n")}`,
    eParams
  );
}

// Academic staffing: teachers + taught sections (deterministic, ~30 sections).
const TEACHER_PLAN = [
  // [name, dept, school_index]
  ["R. Nader", "Mathematics", 0],
  ["S. Whitfield", "Mathematics", 0],
  ["P. Okonkwo", "Science", 0],
  ["L. Maritime", "Science", 0],
  ["T. Ashford", "English", 0],
  ["M. Delacroix", "English", 0],
  ["J. Harkness", "Social Science", 0],
  ["A. Lindqvist", "World Languages", 0],
  ["C. Bennett-Doyle", "Physical Education", 1],
  ["K. Yamagata", "Mathematics", 1],
  ["D. Osei", "Arts", 2],
  ["E. Pruitt", "Elementary Generalist", 2],
];

const COURSE_PLAN = [
  // [course_name, sections_count, school_index]
  ["Algebra I", 3, 0], ["Geometry", 3, 0], ["Algebra II", 2, 0],
  ["Biology", 3, 0], ["Chemistry", 2, 0], ["Physics", 2, 0],
  ["English 9", 3, 0], ["English 10", 2, 0],
  ["World History", 2, 0], ["U.S. History", 2, 0],
  ["Spanish I", 2, 0], ["Band", 1, 0],
  ["Math 7", 2, 1], ["Life Science", 2, 1], ["English 7", 2, 1],
  ["PE 7/8", 2, 1],
  ["Grade 3 Core", 2, 2], ["Grade 4 Core", 2, 2], ["Grade 5 Core", 2, 2],
  ["Music", 1, 2],
];

async function seedAcademic(client) {
  // Teachers
  const tIds = [];
  let codeNum = 100;
  for (const [name, dept, schoolIdx] of TEACHER_PLAN) {
    const schoolR = await client.query(
      "SELECT id FROM schools ORDER BY id LIMIT 1 OFFSET $1", [schoolIdx]
    );
    const r = await client.query(
      "INSERT INTO teachers (code, name, dept, school_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [`T${codeNum++}`, name, dept, schoolR.rows[0].id]
    );
    tIds.push(r.rows[0].id);
  }
  // One teacher per department pair; map school sections to a teacher at that school.
  const termR = await client.query(
    "SELECT id FROM terms WHERE is_current LIMIT 1"
  );
  const currentTermId = termR.rows[0].id;
  const values = [];
  const params = [];
  let b = 0;
  let seq = 0;
  for (const [course, count, schoolIdx] of COURSE_PLAN) {
    const schoolR = await client.query(
      "SELECT id FROM schools ORDER BY id LIMIT 1 OFFSET $1", [schoolIdx]
    );
    const schoolId = schoolR.rows[0].id;
    const candidates = tIds.filter((_, ti) => TEACHER_PLAN[ti][2] === schoolIdx);
    for (let s = 0; s < count; s++) {
      const teacherId = candidates[s % candidates.length];
      const period = (s % 7) + 1;
      const room = `R${100 + schoolIdx * 30 + seq % 30}`;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
      params.push(
        `${course.replace(/\s+/g, "").toUpperCase().slice(0, 8)}-${String(++seq).padStart(3, "0")}`,
        course, schoolId, teacherId, period, room, currentTermId, 32
      );
      b += 8;
    }
  }
  await client.query(
    `INSERT INTO sections
       (section_code, course_name, school_id, teacher_id, period, room, term_id, capacity)
     VALUES ${values.join(",\n")}`,
    params
  );
}

/**
 * Apply schema.sql, then seed only when the students table is empty.
 * Runs in one transaction so a failed seed leaves nothing half-written.
 */
export async function applyDb() {
  const schemaSql = readFileSync(path.join(DB_DIR, "schema.sql"), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schemaSql);
    await client.query(migrationsSql());
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM students"
    );
    if (rows[0].n === 0) {
      await seed(client);
      await seedAcademic(client);
      // Data-wave migrations (30+) insert rows FROM the base tables (students,
      // sections, ...) via INSERT ... SELECT, so they contribute nothing until the
      // JS seeds above have run. Two further passes land the steady state in one
      // start: file 31's derived gradebook windows depend on the status changes
      // that file 33 (people) applies, so pass 2 grades pre-messiness windows and
      // pass 3 grades the final ones (+2,934 scores, verified). All migrations are
      // idempotent — boot 2 and 3 of a fresh DB are byte-identical (verified).
      await client.query(migrationsSql());
      await client.query(migrationsSql());
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}