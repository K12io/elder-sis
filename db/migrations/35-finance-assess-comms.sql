-- 35-finance-assess-comms.sql — Scale-up seed for the legacy side of the
-- data-migration demo: district-wide fees + realistic payments, two more
-- assessments with full score coverage, and a term's worth of announcements.
--
-- Idempotent and deterministic: every insert is guarded with NOT EXISTS /
-- ON CONFLICT and every value is derived from existing ids (students.id,
-- schools.id, fee_catalog.id). Re-running on every boot adds nothing and
-- changes nothing.
--
-- Reads (never writes): students, schools, terms, fee_catalog, app_users.
-- Owns (adds rows to, never edits pre-existing rows):
--   student_fees, fee_payments, assessments, assessment_scores,
--   announcements, announcement_recipients.
--
-- Pre-existing baseline this file assumes (from 21-fees.sql / 22-assessment.sql
-- / 20-communications.sql): student_fees covers only the FIRST school (lowest
-- schools.id); 4 assessments; 3 announcements.
--
-- DEMO "TODAY" = 2026-09-30. Current term = '2026-27 Fall' (2026-09-01..2026-12-18).

-- ============================================================================
-- 1. FEES DISTRICT-WIDE
-- ----------------------------------------------------------------------------
-- 21-fees.sql assigns two fees (Technology + Activity) to every student of the
-- FIRST school for the current term. We extend the identical pattern to the
-- OTHER schools so the whole district is billed. unique(student_id, fee_id,
-- term_id) + the NOT EXISTS guard make this a no-op on the next boot.
-- VOLUME KNOB: the school filter below. Today it yields 200 students × 2 fees
-- = 400 new assignments (baseline 200 -> ~600 total).
-- ============================================================================
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
JOIN fee_catalog fc ON fc.name IN ('Technology Fee', 'Activity Fee') AND fc.active
WHERE sc.id <> (SELECT id FROM schools ORDER BY id LIMIT 1)
  AND NOT EXISTS (
      SELECT 1 FROM student_fees sf
       WHERE sf.student_id = st.id AND sf.fee_id = fc.id AND sf.term_id = t.id
  );

-- ============================================================================
-- 2. PAYMENTS WITH REALISTIC STATUSES
-- ----------------------------------------------------------------------------
-- ~200 payments across all schools. Target sets are pinned to deterministic
-- predicates on students.id (never "whatever is currently unpaid"), so each
-- boot selects the SAME rows; the NOT EXISTS guard then makes re-runs no-ops.
--
-- KINDS (all against existing/just-created assignments; predicates are disjoint):
--   FULL    (90): Activity id%5=0  + Technology id%10=6
--   PARTIAL (90): Activity id%5=1  + Technology id%10=8   (≈ half the fee)
--   SMALL   (15): Activity id%20=12                       (flat $10 one-off)
--   ZERO    (10): Technology id%20=7 on the OTHER schools (waived fee, $0)
--
-- paid_on spreads 2026-09-01 .. 2026-09-30 (inside the term, up to demo today).
-- method and received_by vary deterministically off students.id.
-- Existing school-1 partials (id%10=1 Tech, id%10=3 Activity) are disjoint from
-- every predicate below, so nothing is double-charged.
-- ============================================================================

-- ---- Waive ~10 fees on the newly-created (non-first-school) assignments ------
-- Restricted to schools other than the first, i.e. ONLY rows this file just
-- inserted in section 1. No pre-existing row is ever touched. Deterministic
-- predicate (id % 20 = 7) means re-running writes the same value.
UPDATE student_fees sf
   SET waived = TRUE
  FROM students st, fee_catalog fc, terms t
 WHERE sf.student_id = st.id
   AND sf.fee_id = fc.id
   AND sf.term_id = t.id
   AND t.is_current
   AND fc.name = 'Technology Fee'
   AND st.school_id <> (SELECT id FROM schools ORDER BY id LIMIT 1)
   AND st.id % 20 = 7;

-- ---- FULL payments -----------------------------------------------------------
INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
SELECT sf.id,
       sf.amount,
       CASE st.id % 4 WHEN 0 THEN 'Cash' WHEN 1 THEN 'Check'
                      WHEN 2 THEN 'Card' ELSE 'Online' END,
       DATE '2026-09-01' + ((st.id * 7) % 30),
       CASE st.id % 5 WHEN 0 THEN 'Dana Whitfield' WHEN 1 THEN 'Patricia Osei'
                      WHEN 2 THEN 'Marcus Lea' WHEN 3 THEN 'Lena Ortiz'
                      ELSE 'Sam Whitaker' END,
       'Full payment — Activity Fee'
FROM student_fees sf
JOIN fee_catalog fc ON fc.id = sf.fee_id
JOIN students   st ON st.id = sf.student_id
JOIN terms      t  ON t.id  = sf.term_id AND t.is_current
WHERE fc.name = 'Activity Fee'
  AND st.id % 5 = 0
  AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.student_fee_id = sf.id);

INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
SELECT sf.id,
       sf.amount,
       CASE st.id % 4 WHEN 0 THEN 'Online' WHEN 1 THEN 'Card'
                      WHEN 2 THEN 'Check' ELSE 'Cash' END,
       DATE '2026-09-01' + ((st.id * 11) % 30),
       CASE st.id % 5 WHEN 0 THEN 'Lena Ortiz' WHEN 1 THEN 'Sam Whitaker'
                      WHEN 2 THEN 'Dana Whitfield' WHEN 3 THEN 'Patricia Osei'
                      ELSE 'Marcus Lea' END,
       'Full payment — Technology Fee'
FROM student_fees sf
JOIN fee_catalog fc ON fc.id = sf.fee_id
JOIN students   st ON st.id = sf.student_id
JOIN terms      t  ON t.id  = sf.term_id AND t.is_current
WHERE fc.name = 'Technology Fee'
  AND st.id % 10 = 6
  AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.student_fee_id = sf.id);

-- ---- PARTIAL payments (≈ half the fee) ---------------------------------------
INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
SELECT sf.id,
       ROUND(sf.amount / 2.0, 2),
       CASE st.id % 4 WHEN 0 THEN 'Check' WHEN 1 THEN 'Cash'
                      WHEN 2 THEN 'Online' ELSE 'Card' END,
       DATE '2026-09-01' + ((st.id * 13) % 30),
       CASE st.id % 5 WHEN 0 THEN 'Marcus Lea' WHEN 1 THEN 'Lena Ortiz'
                      WHEN 2 THEN 'Sam Whitaker' WHEN 3 THEN 'Dana Whitfield'
                      ELSE 'Patricia Osei' END,
       'Partial payment — balance due on Activity Fee'
FROM student_fees sf
JOIN fee_catalog fc ON fc.id = sf.fee_id
JOIN students   st ON st.id = sf.student_id
JOIN terms      t  ON t.id  = sf.term_id AND t.is_current
WHERE fc.name = 'Activity Fee'
  AND st.id % 5 = 1
  AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.student_fee_id = sf.id);

INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
SELECT sf.id,
       ROUND(sf.amount / 2.0, 2),
       CASE st.id % 4 WHEN 0 THEN 'Card' WHEN 1 THEN 'Online'
                      WHEN 2 THEN 'Cash' ELSE 'Check' END,
       DATE '2026-09-01' + ((st.id * 17) % 30),
       CASE st.id % 5 WHEN 0 THEN 'Patricia Osei' WHEN 1 THEN 'Dana Whitfield'
                      WHEN 2 THEN 'Lena Ortiz' WHEN 3 THEN 'Sam Whitaker'
                      ELSE 'Marcus Lea' END,
       'Partial payment — balance due on Technology Fee'
FROM student_fees sf
JOIN fee_catalog fc ON fc.id = sf.fee_id
JOIN students   st ON st.id = sf.student_id
JOIN terms      t  ON t.id  = sf.term_id AND t.is_current
WHERE fc.name = 'Technology Fee'
  AND st.id % 10 = 8
  AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.student_fee_id = sf.id);

-- ---- SMALL one-off payments (flat $10, never overpays) -----------------------
INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
SELECT sf.id,
       10.00,
       CASE st.id % 4 WHEN 0 THEN 'Cash' WHEN 1 THEN 'Online'
                      WHEN 2 THEN 'Check' ELSE 'Card' END,
       DATE '2026-09-01' + ((st.id * 19) % 30),
       CASE st.id % 5 WHEN 0 THEN 'Sam Whitaker' WHEN 1 THEN 'Marcus Lea'
                      WHEN 2 THEN 'Patricia Osei' WHEN 3 THEN 'Lena Ortiz'
                      ELSE 'Dana Whitfield' END,
       'One-off partial payment toward Activity Fee'
FROM student_fees sf
JOIN fee_catalog fc ON fc.id = sf.fee_id
JOIN students   st ON st.id = sf.student_id
JOIN terms      t  ON t.id  = sf.term_id AND t.is_current
WHERE fc.name = 'Activity Fee'
  AND st.id % 20 = 12
  AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.student_fee_id = sf.id);

-- ---- ZERO payments recording a waived fee ------------------------------------
INSERT INTO fee_payments (student_fee_id, amount, method, paid_on, received_by, note)
SELECT sf.id,
       0.00,
       'Waiver',
       DATE '2026-09-01' + ((st.id * 23) % 30),
       CASE st.id % 5 WHEN 0 THEN 'Patricia Osei' WHEN 1 THEN 'Marcus Lea'
                      WHEN 2 THEN 'Dana Whitfield' WHEN 3 THEN 'Sam Whitaker'
                      ELSE 'Lena Ortiz' END,
       'Fee waived — no charge'
FROM student_fees sf
JOIN fee_catalog fc ON fc.id = sf.fee_id
JOIN students   st ON st.id = sf.student_id
JOIN terms      t  ON t.id  = sf.term_id AND t.is_current
WHERE fc.name = 'Technology Fee'
  AND sf.waived = TRUE
  AND st.id % 20 = 7
  AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.student_fee_id = sf.id);

-- ============================================================================
-- 3. TWO MORE ASSESSMENTS + FULL SCORE COVERAGE
-- ----------------------------------------------------------------------------
-- Fills the grade bands with a second administration each, inside the current
-- term. Guarded on the documented unique(name, administered_on).
-- ============================================================================
INSERT INTO assessments (name, subject, grade_levels, administered_on, max_score, proficiency_cut, test_window, active)
SELECT v.name, v.subject, v.grade_levels, v.administered_on::date, v.max_score, v.proficiency_cut, v.test_window, TRUE
FROM (VALUES
    ('Winter Reading Benchmark', 'Reading', 'K-5',  '2026-09-29', 100.00, 70.00, 'Fall 2026'),
    ('Math Standards Check',     'Math',    '9-12', '2026-09-30', 120.00, 84.00, 'Fall 2026')
) AS v(name, subject, grade_levels, administered_on, max_score, proficiency_cut, test_window)
WHERE NOT EXISTS (
    SELECT 1 FROM assessments a WHERE a.name = v.name AND a.administered_on = v.administered_on::date
);

-- ---- Deterministic score seed (mirrors 22-assessment.sql EXACTLY) ------------
-- PERFORMANCE BANDING (documented; mirrored exactly in src/routes/assessment.js):
--   Let s = scale score, cut = assessments.proficiency_cut.
--     s < cut * 0.70              -> 'Below Basic'
--     cut * 0.70 <= s < cut       -> 'Basic'
--     cut <= s < cut * 1.20       -> 'Proficient'
--     s >= cut * 1.20             -> 'Advanced'
--
-- SCORE MATH (deterministic, reproducible from students.id alone):
--   raw    = (id * 37) % 41          -> 0..40
--   pct    = 46 + raw * 1.2          -> 46.0 .. 94.0  (a believable spread around cut)
--   score  = ROUND(max_score * pct / 100, 2), clamped to [0, max_score]
-- Seeded for every student whose grade_level falls inside the assessment's
-- grade_levels range. Restricted to the two new administrations above.
WITH bands AS (
    SELECT
        a.id AS assessment_id,
        a.max_score,
        a.proficiency_cut,
        LEAST(
            a.max_score,
            GREATEST(0,
                ROUND(a.max_score * (46 + ((st.id * 37) % 41) * 1.2) / 100.0, 2)
            )
        ) AS scale_score,
        st.id AS student_id
    FROM assessments a
    JOIN students st
      ON st.grade_level BETWEEN
           (CASE WHEN split_part(a.grade_levels, '-', 1) = 'K'
                 THEN 0 ELSE split_part(a.grade_levels, '-', 1)::int END)
           AND
           (CASE WHEN split_part(a.grade_levels, '-', 2) = 'K'
                 THEN 0 ELSE split_part(a.grade_levels, '-', 2)::int END)
    WHERE (a.name, a.administered_on) IN (
        ('Winter Reading Benchmark', DATE '2026-09-29'),
        ('Math Standards Check',     DATE '2026-09-30')
    )
)
INSERT INTO assessment_scores (assessment_id, student_id, scale_score, performance_level)
SELECT
    b.assessment_id,
    b.student_id,
    b.scale_score,
    CASE
        WHEN b.scale_score <  b.proficiency_cut * 0.70 THEN 'Below Basic'
        WHEN b.scale_score <  b.proficiency_cut        THEN 'Basic'
        WHEN b.scale_score <  b.proficiency_cut * 1.20 THEN 'Proficient'
        ELSE 'Advanced'
    END
FROM bands b
WHERE (SELECT count(*) FROM students) > 0
ON CONFLICT (assessment_id, student_id) DO NOTHING;

-- ============================================================================
-- 4. COMMUNICATIONS — a term's worth of announcements (3 -> 15) + recipients
-- ----------------------------------------------------------------------------
-- 12 new announcements: 3 district-wide, 3 per-school, 4 per-grade, 2
-- staff-only. Mixed channels and draft/published status. created_at /
-- published_at inside the current term (Sep 2026). Guarded by title, so
-- re-running never duplicates.
-- VOLUME KNOB: the VALUES list below.
-- ============================================================================
INSERT INTO announcements (title, body, audience_type, audience_value, channel, status, created_by, created_at, published_at)
SELECT v.title, v.body, v.audience_type, v.audience_value, v.channel, v.status,
       v.created_by, v.created_at::timestamptz,
       CASE WHEN v.status = 'published'
            THEN v.created_at::timestamptz + INTERVAL '1 day'
            ELSE NULL END
FROM (VALUES
    ('Fall 2026 Progress Reports Available Sept 30',
     E'Families,\n\nFirst-quarter progress reports for the 2026-27 fall term will be available in the parent portal on September 30. Please review your student''s grades, attendance, and teacher comments.\n\nParent-teacher conferences are scheduled for October 8-9. Sign-up links will open next week.\n\n— Valley View Unified Administration',
     'all', NULL, 'Both', 'published', 'District Office', '2026-09-10 08:15:00'),
    ('Free & Reduced Meal Application — New Online Form',
     E'Dear families,\n\nNutrition Services has launched a new online application for free and reduced-price meals. A single application covers every student in your household.\n\nApply before October 15 to avoid a lapse in benefits. Paper forms remain available at every school office.\n\n— Nutrition Services',
     'all', NULL, 'Email', 'published', 'Nutrition Services', '2026-09-12 09:00:00'),
    ('Immunization Records Due by October 31',
     E'This is a reminder that required immunization records must be on file by October 31, 2026. Students without current records may be excluded from school per state code.\n\nUpload records through the portal or bring a copy to your school nurse.\n\n— District Health Services',
     'all', NULL, 'Both', 'published', 'District Health Services', '2026-09-15 07:45:00'),
    ('VVHS Homecoming Week — Revised Bell Schedule',
     E'Valley View High School students and families:\n\nHomecoming week runs October 13-18. Please note the revised bell schedule: Friday dismissal moves to 1:15 PM to allow for the parade and pep rally.\n\nSpirit days are posted on the main office door and the school website.\n\n— VVHS Administration',
     'school', '1', 'Email', 'published', 'VVHS Office', '2026-09-16 10:20:00'),
    ('VVM Fall Fundraiser Kickoff',
     E'Valley View Middle School families:\n\nThe fall fundraiser kicks off September 22 and runs through October 6. Orders and payment are due to homeroom teachers by October 6.\n\nProceeds support field trips and classroom supplies. Thank you for your support!\n\n— VVM PTO',
     'school', '2', 'Both', 'published', 'VVM Office', '2026-09-18 11:05:00'),
    ('VVE Picture Day — September 25',
     E'Valley View Elementary families:\n\nPicture day is Thursday, September 25. Order forms went home this week; online orders close the evening of September 24.\n\nPlease send students in school-appropriate attire. Retake day is October 23.\n\n— VVE Front Office',
     'school', '3', 'Print', 'published', 'VVE Office', '2026-09-19 08:30:00'),
    ('Grade 9 Fall Testing Window — Reading & Math Benchmarks',
     E'Grade 9 students and families:\n\nFall benchmark testing for grade 9 runs September 22-30. Students will take the Reading and Math benchmarks during their English and Algebra periods.\n\nPlease ensure students arrive on time and well rested. Make-up testing is October 2.\n\n— VVHS Assessment Team',
     'grade', '9', 'Email', 'published', 'VVHS Assessment Team', '2026-09-08 13:00:00'),
    ('Grade 5 Outdoor Education Permission Slips',
     E'Grade 5 families:\n\nThe annual Outdoor Education trip is October 20-21. Signed permission slips and the activity fee are due to your child''s teacher by October 10.\n\nAn updated packing list is attached. Please label all belongings.\n\n— VVE Grade 5 Team',
     'grade', '5', 'Both', 'published', 'VVE Grade 5 Team', '2026-09-21 09:40:00'),
    ('Grade 6 Locker Assignments — DRAFT',
     E'Grade 6 families:\n\nPreliminary locker assignments are being finalized and will be posted the week of October 5. Please review the draft list at the main office and report conflicts by October 2.\n\nThis notice is a DRAFT pending facilities confirmation.\n\n— VVM Office',
     'grade', '6', 'Email', 'draft', 'VVM Office', '2026-09-21 09:40:00'),
    ('Grade 12 Senior Fee & Cap-and-Gown Deadline',
     E'Grade 12 students and families:\n\nThe senior fee and cap-and-gown order deadline is October 31. Payments can be made online or at the VVHS bookkeeping office.\n\nGraduation date: June 5, 2027. More details to follow.\n\n— VVHS Counseling',
     'grade', '12', 'Both', 'published', 'VVHS Counseling', '2026-09-22 14:10:00'),
    ('Staff: Fall Professional Development Day — Oct 14',
     E'All staff,\n\nDistrict professional development day is Wednesday, October 14. Sessions run 8:00 AM - 3:30 PM at VVM. Registration opens next Monday in the staff portal.\n\nPlease register for two sessions. Lunch is provided.\n\n— Office of Teaching & Learning',
     'staff', NULL, 'Email', 'published', 'Office of Teaching & Learning', '2026-09-14 12:00:00'),
    ('Staff: Fire Drill Schedule — DRAFT',
     E'All staff,\n\nDraft fire drill schedule for the fall term is below. Confirm your assigned marshal post with your building administrator.\n\n• Oct 6 - VVH, 9:30 AM\n• Oct 7 - VVM, 10:00 AM\n• Oct 8 - VVE, 1:00 PM\n\nThis schedule is a DRAFT pending facilities sign-off.\n\n— Safety & Security',
     'staff', NULL, 'Both', 'draft', 'Safety & Security', '2026-09-23 15:20:00')
) AS v(title, body, audience_type, audience_value, channel, status, created_by, created_at)
WHERE NOT EXISTS (SELECT 1 FROM announcements a WHERE a.title = v.title);

-- ---- Materialise recipients (same pattern as 20-communications.sql) ----------
-- Restricted to the 12 titles above, so pre-existing recipients are untouched.

-- district-wide -> all active students
INSERT INTO announcement_recipients (announcement_id, student_id)
SELECT a.id, s.id
FROM announcements a
JOIN students s ON s.status = 'Active'
WHERE a.audience_type = 'all'
  AND a.title IN (
      'Fall 2026 Progress Reports Available Sept 30',
      'Free & Reduced Meal Application — New Online Form',
      'Immunization Records Due by October 31')
  AND NOT EXISTS (
      SELECT 1 FROM announcement_recipients ar
       WHERE ar.announcement_id = a.id AND ar.student_id = s.id);

-- per-school -> active students at that school
INSERT INTO announcement_recipients (announcement_id, student_id)
SELECT a.id, s.id
FROM announcements a
JOIN students s ON s.status = 'Active' AND s.school_id = a.audience_value::int
WHERE a.audience_type = 'school'
  AND a.title IN (
      'VVHS Homecoming Week — Revised Bell Schedule',
      'VVM Fall Fundraiser Kickoff',
      'VVE Picture Day — September 25')
  AND NOT EXISTS (
      SELECT 1 FROM announcement_recipients ar
       WHERE ar.announcement_id = a.id AND ar.student_id = s.id);

-- per-grade -> active students in that grade
INSERT INTO announcement_recipients (announcement_id, student_id)
SELECT a.id, s.id
FROM announcements a
JOIN students s ON s.status = 'Active' AND s.grade_level = a.audience_value::int
WHERE a.audience_type = 'grade'
  AND a.title IN (
      'Grade 9 Fall Testing Window — Reading & Math Benchmarks',
      'Grade 5 Outdoor Education Permission Slips',
      'Grade 6 Locker Assignments — DRAFT',
      'Grade 12 Senior Fee & Cap-and-Gown Deadline')
  AND NOT EXISTS (
      SELECT 1 FROM announcement_recipients ar
       WHERE ar.announcement_id = a.id AND ar.student_id = s.id);

-- staff-only -> active app_users
INSERT INTO announcement_recipients (announcement_id, user_id)
SELECT a.id, u.id
FROM announcements a
JOIN app_users u ON u.active
WHERE a.audience_type = 'staff'
  AND a.title IN (
      'Staff: Fall Professional Development Day — Oct 14',
      'Staff: Fire Drill Schedule — DRAFT')
  AND NOT EXISTS (
      SELECT 1 FROM announcement_recipients ar
       WHERE ar.announcement_id = a.id AND ar.user_id = u.id);

-- ---- Delivery / read log for the new (published) announcements ---------------
-- ~70% of recipients delivered (recipient row id % 10 < 7) and ~40% of those
-- read ((recipient row id * 3) % 10 < 4 — a hash picked to be uncorrelated
-- with the delivery modulus, so it is ~40% of the delivered set, not of all
-- recipients). Drafts are never delivered. Scoped by title to the 12 new
-- announcements, so pre-existing recipient rows are never touched. Both UPDATEs
-- fully define the timestamps via CASE, so they are self-healing and idempotent
-- regardless of what a previous boot left behind.
UPDATE announcement_recipients ar
   SET delivered_at = CASE
         WHEN ar.id % 10 < 7
         THEN a.published_at + ((ar.id % 7) || ' hours')::interval
         ELSE NULL END
  FROM announcements a
 WHERE a.id = ar.announcement_id
   AND a.status = 'published'
   AND a.title IN (
       'Fall 2026 Progress Reports Available Sept 30',
       'Free & Reduced Meal Application — New Online Form',
       'Immunization Records Due by October 31',
       'VVHS Homecoming Week — Revised Bell Schedule',
       'VVM Fall Fundraiser Kickoff',
       'VVE Picture Day — September 25',
       'Grade 9 Fall Testing Window — Reading & Math Benchmarks',
       'Grade 5 Outdoor Education Permission Slips',
       'Grade 12 Senior Fee & Cap-and-Gown Deadline',
       'Staff: Fall Professional Development Day — Oct 14');

UPDATE announcement_recipients ar
   SET read_at = CASE
         WHEN ar.delivered_at IS NOT NULL AND (ar.id * 3) % 10 < 4
         THEN ar.delivered_at + INTERVAL '2 hours'
         ELSE NULL END
  FROM announcements a
 WHERE a.id = ar.announcement_id
   AND a.title IN (
       'Fall 2026 Progress Reports Available Sept 30',
       'Free & Reduced Meal Application — New Online Form',
       'Immunization Records Due by October 31',
       'VVHS Homecoming Week — Revised Bell Schedule',
       'VVM Fall Fundraiser Kickoff',
       'VVE Picture Day — September 25',
       'Grade 9 Fall Testing Window — Reading & Math Benchmarks',
       'Grade 5 Outdoor Education Permission Slips',
       'Grade 12 Senior Fee & Cap-and-Gown Deadline',
       'Staff: Fall Professional Development Day — Oct 14');
