-- 33-people.sql — "people depth" slice: contacts, alerts, longitudinal enrollment
-- history, and the messy edge cases a real migration has to survive.
--
-- Owner: this slice owns ONLY newly inserted/updated people-shaped data. It never
-- drops rows, never changes students.id or state_id, and re-runs in full on every
-- boot inside the schema transaction.
--
-- IDEMPOTENCY MODEL
--   * Every INSERT is `... SELECT ... WHERE NOT EXISTS (per natural key)`.
--   * Every UPDATE is a plain re-assignment of the same deterministic value, so a
--     second run writes identical bytes and changes no counts.
--   * All selection/derivation is a pure function of students.id (and, for a few
--     lookups, the real terms row). No random(), no now(), no clock dependence:
--     two boots on the same data produce byte-identical rows.
--
-- KNOWN SEQUENCING NOTE (not a bug): src/db.js runs schema.sql + every migration,
-- THEN seeds students only if the table is empty. On a brand-new database this file
-- therefore sees an empty students table and inserts nothing; the depth data lands on
-- the *next* boot. On an already-seeded database (the normal case) it lands on the
-- first boot. Counts below assume the seeded 300-student dataset.
--
-- KNOBS (see README/BUILD note): every volume below is one `% N` modulus or one
-- constant. Change the modulus to change the count; the predicates are all documented
-- inline next to what they produce.

-- ============================================================================
-- 1. STUDENT-LEVEL EDGE CASES that must exist BEFORE contacts are built, so the
--    guardian names/emails we derive match the final student names.
-- ============================================================================

-- 1a. Duplicate-name collision test: 2 pairs of students share an identical
--     last+first name. We RENAME existing rows (state_id and id stay unique and
--     unchanged). Pair A: 92 copies 41's name; Pair B: 94 copies 43's.
--     Guard = only rewrite while the pair still differs, so a second boot is a
--     no-op write of the same values.
UPDATE students t
   SET last_name  = src.last_name,
       first_name = src.first_name
  FROM students src
 WHERE (t.id = 92 AND src.id = 41)
    OR (t.id = 94 AND src.id = 43);

-- 1b. Blank-field migration cases: middle_name NULL for 8 students.
--     ids: 37,74,111,148,185,222,259,296  (id % 37 = 0)
UPDATE students SET middle_name = NULL WHERE id % 37 = 0;

-- 1c. Unknown DOB: NULL dob for 5 students.
--     ids: 59,118,177,236,295  (id % 59 = 0)
UPDATE students SET dob = NULL WHERE id % 59 = 0;

-- ============================================================================
-- 2. CONTACTS FOR EVERYONE
--    Primary guardian for every student that has none. Existing seed contacts
--    (ids 1..12) are left untouched. Secondary contact for every 3rd student.
--    Derived from the student's own name/id so the rows read plausibly.
-- ============================================================================

-- 2a. Primary guardian. Guardian shares the student's last name; first name comes
--     from a fixed pool keyed by id; relationship varies by id % 5.
--     Volume: students without a contact (288 of 300) => 288 rows.
INSERT INTO student_contacts (student_id, name, relationship, phone, email, is_primary)
SELECT s.id,
       s.last_name || ', ' ||
         (ARRAY['Maria','David','Susan','James','Linda','Robert','Patricia',
                'Michael','Jennifer','William','Elizabeth','Richard','Barbara',
                'Joseph','Jessica','Thomas','Sarah','Charles','Karen','Daniel'])[(s.id % 20) + 1],
       (ARRAY['Mother','Father','Guardian','Grandparent','Stepparent'])[(s.id % 5) + 1],
       '(540) 555-' || lpad(((s.id * 37) % 9000 + 1000)::text, 4, '0'),
       lower(s.first_name) || '.' || lower(s.last_name) || s.id || '@example.org',
       TRUE
FROM students s
WHERE NOT EXISTS (
        SELECT 1 FROM student_contacts c WHERE c.student_id = s.id
      );

-- 2b. Secondary contact for every 3rd student that now has exactly one contact.
--     Volume: multiples of 3 among the 288 above => 96 rows.
INSERT INTO student_contacts (student_id, name, relationship, phone, email, is_primary)
SELECT s.id,
       s.last_name || ', ' ||
         (ARRAY['Evelyn','Frank','Gloria','Harold','Irene','Leonard','Marilyn',
                'Norman','Olivia','Paul','Ruth','Stanley','Teresa','Victor',
                'Wanda','Albert','Bonnie','Curtis','Doris','Ernest'])[(s.id % 20) + 1],
       (ARRAY['Grandparent','Stepparent','Aunt','Uncle','Guardian'])[(s.id % 5) + 1],
       '(540) 555-' || lpad(((s.id * 53) % 9000 + 1000)::text, 4, '0'),
       'guardian' || s.id || '@example.org',
       FALSE
FROM students s
WHERE (SELECT count(*) FROM student_contacts c WHERE c.student_id = s.id) = 1
  AND s.id % 3 = 0;

-- 2c. Incomplete-record case: 3 primary contacts with no phone at all.
--     ids: 13, 113, 213. Idempotent (re-nulls the same rows).
UPDATE student_contacts
   SET phone = NULL
 WHERE is_primary
   AND student_id IN (13, 113, 213);

-- ============================================================================
-- 3. ALERTS for a plausible subset
--    ~40 students, 1-2 alerts each, realistic types + specific messages, all
--    dated inside the current term (2026-27 Fall: 2026-09-01 .. 2026-12-18).
-- ============================================================================

-- 3a. First alert for the 40-student subset: id % 7 = 0 AND id <= 280.
--     Type and message rotate deterministically by id.
INSERT INTO student_alerts (student_id, alert_date, alert_type, message)
SELECT s.id,
       ('2026-09-10'::date + (s.id % 25)),
       (ARRAY['Medical','Custody','Academic','Behavior','Transportation'])[(s.id % 5) + 1],
       (ARRAY[
          'Carries emergency medication; health plan on file in the front office.',
          'Restricted pickup; verify guardian photo ID before releasing the student.',
          'Below-grade reading level; assigned to Tier 2 intervention, monitor weekly.',
          'Documented behavior plan; notify counselor before any office referral.',
          'Bus route exception approved; alternate stop only, do not board default route.'
       ])[(s.id % 5) + 1]
FROM students s
WHERE s.id % 7 = 0
  AND s.id <= 280
  AND NOT EXISTS (SELECT 1 FROM student_alerts a WHERE a.student_id = s.id);

-- 3b. Second alert for every other student in the subset (id % 14 = 0) => 20 rows.
--     Different type pool + later date so both land inside the term.
INSERT INTO student_alerts (student_id, alert_date, alert_type, message)
SELECT s.id,
       ('2026-10-01'::date + (s.id % 20)),
       (ARRAY['Academic','Transportation','Medical','Custody','Behavior'])[(s.id % 5) + 1],
       (ARRAY[
          'IEP review scheduled; case manager needs prior-year records before the meeting.',
          'Early dismissal on file every Friday; after-care provider picks up at 13:30.',
          'Allergy alert on file: peanuts and tree nuts; classroom is designated nut-free.',
          'Court order limits contact to the custodial parent; document all requests.',
          'Chronic tardiness flagged; attendance team to contact the household.'
       ])[(s.id % 5) + 1]
FROM students s
WHERE s.id % 14 = 0
  AND s.id <= 280
  AND (SELECT count(*) FROM student_alerts a WHERE a.student_id = s.id) = 1;

-- ============================================================================
-- 4. LONGITUDINAL ENROLLMENT HISTORY
--    Every student gets a 2025-26 Fall and 2025-26 Spring row so prior-year
--    extracts have history. Dates come from the real terms rows; grade is the
--    current grade minus one (floored at 0 for Kindergarten).
--    Volume: 300 students x 2 terms = 600 rows (=> 900 total enrollments).
-- ============================================================================

INSERT INTO enrollments (student_id, school_id, term_id, entry_date, exit_date,
                         grade_level, code)
SELECT s.id,
       s.school_id,
       t.id,
       t.starts_on,
       t.ends_on,
       GREATEST(s.grade_level - 1, 0),
       'M'
FROM students s
CROSS JOIN terms t
WHERE t.name IN ('2025-26 Fall', '2025-26 Spring')
  AND NOT EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.student_id = s.id AND e.term_id = t.id
      );

-- ============================================================================
-- 5. EDGE CASES ON THE CURRENT-TERM ENROLLMENT (migration-realism cases)
-- ============================================================================

-- 5a. WITHDRAWN: 15 students (id % 20 = 0 => 20,40,...,300) get status
--     'Withdrawn' and a real mid-term exit_date on their current-term row.
--     No later enrollment is created for them, so they look like a genuine
--     mid-year withdrawal in a longitudinal extract.
UPDATE students
   SET status = 'Withdrawn'
 WHERE id % 20 = 0;

UPDATE enrollments e
   SET exit_date = (t.starts_on + 49 + (e.student_id % 10))
  FROM terms t
 WHERE e.term_id = t.id
   AND t.is_current
   AND e.student_id % 20 = 0;

-- 5b. MID-YEAR ENTRANTS: 10 students (id % 29 = 0 => 29,58,...,290) entered the
--     current term well after it started (starts_on + 30..60 days).
UPDATE enrollments e
   SET entry_date = (t.starts_on + 30 + (e.student_id % 31))
  FROM terms t
 WHERE e.term_id = t.id
   AND t.is_current
   AND e.student_id % 29 = 0;
