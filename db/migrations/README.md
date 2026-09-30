# Slice-owned migrations

Each module slice adds exactly ONE file here, named `<NN>-<slice>.sql` (e.g.
`10-attendance.sql`). Files are applied in filename order, inside the same transaction
as `../schema.sql`, on every boot.

Rules:
- Must be idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`). The runner re-executes them each start.
- Never edit another slice's file, `../schema.sql`, or `../db.js` — that keeps parallel
  slices collision-free.
- Keep table names module-scoped (e.g. `attendance_daily`, `grade_assignments`).
