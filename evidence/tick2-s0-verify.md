# S0 verification evidence — tick 2 (2026-09-30)

## What was verified
Full boot of `npm start` (Node v26.8.1, Express 4.21, pg 8.13) against Postgres 16
(`fake_sis` on appsicle-postgres-1), fresh schema, deterministic seed, then route checks.

## Transcript (abridged)
```
$ psql fake_sis -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"   # clean slate
$ npm start
fake-sis listening on http://localhost:3000
$ curl -s -o home.html -w "%{http_code} %{size_download}" http://localhost:3000/
200 4111
$ curl -s http://localhost:3000/healthz
{"ok":true,"db":"up"}
$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/css/app.css
200
```
Restart (2nd boot, non-empty DB) -> 200 again; seed did NOT duplicate (students stayed
300). applyDb() is idempotent.

## Seed state (psql counts, final)
students 300 (140 VVE / 60 VVM / 100 VVH), sections 42, teachers 12, enrollments 300.
Home page renders live counts: `300 / 42 / 12` in the Enrollment Snapshot table.

## Issues found + fixed this tick
1. app.js passed `counts` local but home.ejs reads `stats` (page would always show the
   no-data fallback). Fixed: / route now passes stats{students,sections,teachers}+termName.
2. No courses/teachers in schema/seed (S0 criteria wanted ~30 courses). Fixed: teachers +
   sections tables added to db/schema.sql; 12 teachers / 42 sections seeded in src/db.js.
3. Seed had 200 students, criteria says ~300. Fixed: SCHOOL_PLAN -> 140/60/100.

## Notes / deviations from original S0 file-list
- db/seed.sql never existed: seed lives in src/db.js (deterministic JS, parameterized
  multi-row INSERTs). Keep this until a seed.sql is actually needed; update file lists.
- Design-system CSS was derived from catalog metadata + classic-SIS conventions, not yet
  pixel-checked against the ~12 WebP captures. That fidelity pass is folded into S1.
- Nav links (/students etc.) 404 until S1+ wires routes — by design.

## Repro
`npm start` (needs Docker appsicle-postgres-1 + .env DATABASE_URL), then
`curl localhost:3000/ | grep 'class="num"'` -> three live counts.
