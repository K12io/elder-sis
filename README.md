# elder-sis

**Elder** — a dense, old-fashioned school Student Information System (SIS), built to sit
alongside a newer SIS as the **legacy source system** in data-migration demos: extract from
here, map, load there, adapt ad hoc.

Express + EJS + PostgreSQL, plain JavaScript on Node 26, server-rendered — no client-side
JavaScript, by design: a legacy system that behaves and looks like one.

- **Live:** https://elder.k12.io (Hetzner K8s — see `reference/deploy-recon.md`)
- **Run locally:** `npm install && npm start` → http://localhost:3000 (needs PostgreSQL 16 +
  `DATABASE_URL` in `.env`)
- **Data:** ~42,000 rows of synthetic district data (300 students, 936 rostered sections-sits,
  15,215 grade scores, 20,204 attendance rows) with deliberate migration edge cases
- **Demo walkthrough:** `BUILD-REPORT.md` §4

Demo password for every account: `demo1234` (`admin`, `registrar`, `teacher`, …).
All data is synthetic — no real student records.