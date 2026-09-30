-- 21-fees.sql — Fees module (fee catalog, per-student assignments, payments).
-- Idempotent: safe to re-run on every boot. Owned by the fees slice.
-- Never touches schema.sql or another slice's migration.
-- Reads (does not write): students, schools, terms.

-- ---- Fee catalog (the district's list of chargeable fees) --------------------
CREATE TABLE IF NOT EXISTS fee_catalog (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    amount      NUMERIC(10,2) NOT NULL,
    description TEXT,
    applies_to  TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'school' | 'grade'
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT chk_fee_catalog_applies_to CHECK (applies_to IN ('all','school','grade'))
);

CREATE INDEX IF NOT EXISTS idx_fee_catalog_active ON fee_catalog (active);

-- Guard: tolerate a pre-existing table created without the applies_to check.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_fee_catalog_applies_to') THEN
        ALTER TABLE fee_catalog
            ADD CONSTRAINT chk_fee_catalog_applies_to
            CHECK (applies_to IN ('all','school','grade'));
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ---- Per-student fee assignments --------------------------------------------
-- unique(student_id, fee_id, term_id) is the de-dup key bulk assignment relies on.
CREATE TABLE IF NOT EXISTS student_fees (
    id           SERIAL PRIMARY KEY,
    student_id   INTEGER NOT NULL REFERENCES students (id),
    fee_id       INTEGER NOT NULL REFERENCES fee_catalog (id),
    term_id      INTEGER,
    amount       NUMERIC(10,2) NOT NULL,
    assigned_on  DATE NOT NULL DEFAULT current_date,
    waived       BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_student_fees_student_fee_term UNIQUE (student_id, fee_id, term_id)
);

CREATE INDEX IF NOT EXISTS idx_student_fees_student ON student_fees (student_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_fee     ON student_fees (fee_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_term    ON student_fees (term_id);

-- Guard: tolerate a pre-existing table created without the unique constraint.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_student_fees_student_fee_term') THEN
        ALTER TABLE student_fees
            ADD CONSTRAINT uq_student_fees_student_fee_term
            UNIQUE (student_id, fee_id, term_id);
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ---- Payments received against an assignment --------------------------------
CREATE TABLE IF NOT EXISTS fee_payments (
    id             SERIAL PRIMARY KEY,
    student_fee_id INTEGER NOT NULL REFERENCES student_fees (id),
    amount         NUMERIC(10,2) NOT NULL,
    method         TEXT,
    paid_on        DATE NOT NULL DEFAULT current_date,
    received_by    TEXT,
    note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_fee_payments_student_fee ON fee_payments (student_fee_id);

-- ============================================================================
-- SEED — guarded so re-running on every boot never duplicates or overwrites.
-- ============================================================================

-- ---- The five catalog fees --------------------------------------------------
INSERT INTO fee_catalog (name, amount, description, applies_to, active)
SELECT v.name, v.amount, v.description, v.applies_to, TRUE
FROM (VALUES
    ('Technology Fee', 25.00::numeric(10,2), 'Annual student technology and device-support charge.', 'all'),
    ('Activity Fee',   40.00::numeric(10,2), 'Student activity card and club participation.',       'school'),
    ('Lab Fee',        15.00::numeric(10,2), 'Consumable laboratory materials, science courses.',    'grade'),
    ('Field Trip Fee', 30.00::numeric(10,2), 'Off-campus instructional field trip transport.',       'grade'),
    ('Parking Fee',    50.00::numeric(10,2), 'Student vehicle parking permit (high school).',        'grade')
) AS v(name, amount, description, applies_to)
WHERE NOT EXISTS (SELECT 1 FROM fee_catalog WHERE name = v.name);

-- ---- Assign two fees (Technology + Activity) to every student of the FIRST
-- ---- school (lowest schools.id) for the CURRENT term -------------------------
INSERT INTO student_fees (student_id, fee_id, term_id, amount, assigned_on, waived)
SELECT st.id,
       fc.id,
       t.id,
       fc.amount,
       current_date,
       FALSE
FROM students st
JOIN schools sc ON sc.id = st.school_id
JOIN terms   t  ON t.is_current
JOIN fee_catalog fc ON fc.name IN ('Technology Fee', 'Activity Fee')
WHERE sc.id = (SELECT id FROM schools ORDER BY id LIMIT 1)
  AND NOT EXISTS (
      SELECT 1 FROM student_fees sf
       WHERE sf.student_id = st.id AND sf.fee_id = fc.id AND sf.term_id = t.id
  );

-- ---- A few partial payments against those seeded assignments ----------------
-- IMPORTANT: the target set must be FIXED, not "whatever is currently unpaid".
-- A LIMIT over unpaid rows would hand back a fresh batch on every boot (each
-- boot pays off the next N), so payments would keep growing. We therefore pin
-- the seed to a deterministic predicate: half of the Technology Fee for the
-- first school's students whose id ends in 1, and a quarter of the Activity Fee
-- for the first school's students whose id ends in 3. The NOT EXISTS guard keeps
-- re-runs from duplicating.
INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
SELECT sf.id,
       ROUND(sf.amount / 2.0, 2),
       'Cash',
       current_date,
       'Office',
       'Seeded partial payment'
FROM student_fees sf
JOIN fee_catalog fc ON fc.id = sf.fee_id
JOIN students st ON st.id = sf.student_id
WHERE fc.name = 'Technology Fee'
  AND st.school_id = (SELECT id FROM schools ORDER BY id LIMIT 1)
  AND st.id % 10 = 1
  AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.student_fee_id = sf.id);

INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
SELECT sf.id,
       ROUND(sf.amount / 4.0, 2),
       'Check',
       current_date,
       'Office',
       'Seeded partial payment'
FROM student_fees sf
JOIN fee_catalog fc ON fc.id = sf.fee_id
JOIN students st ON st.id = sf.student_id
WHERE fc.name = 'Activity Fee'
  AND st.school_id = (SELECT id FROM schools ORDER BY id LIMIT 1)
  AND st.id % 10 = 3
  AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.student_fee_id = sf.id);
