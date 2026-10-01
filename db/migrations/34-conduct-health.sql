-- 34-conduct-health.sql — Conduct + Health detail data (slice-owned).
-- Idempotent: re-executed on every boot inside the schema transaction.
-- Owns: NO tables. Only backfills tables owned by 17-discipline.sql:
--   discipline_incidents, health_encounters, health_flags.
-- Reads (does not write): students, schools, terms, discipline_codes, teachers.
--
-- Everything is deterministic and derived from existing ids, so a second boot inserts
-- nothing (every statement is INSERT ... SELECT ... WHERE NOT EXISTS). There is no
-- randomness and no dependence on now(). A fixed demo "today" of 2026-09-30 bounds
-- all dated rows: dates never exceed the current term end (2026-12-18) and never land
-- in the future relative to the demo date.
--
-- ---- Volume knobs (ids stay stable; tune the arithmetic, not the data) ----------
--   Discipline incidents : students where id%6=0                         (50 students)
--                          count = 2 + 1 when (id/6)%3 > 0, else 2      -> 134 rows
--   Health encounters    : students where id%5=1                         (60 students)
--                          count = 1+(id%2)                           ->  90 rows
--                          overlaps exactly 10 students with the discipline set
--   Additional flags     : id%60 = r for r=0..9, five ids each          ->  50 rows
--                          (existing 17-file seeds 4 types / 26 rows -> 76 total)

-- ---- Discipline incidents --------------------------------------------------
-- Cluster on a realistic "frequent flyer" subset (50 students, id%6=0) rather
-- than one incident per student, so ~134 incidents sit on only 50 of 300 students.
-- Each selected student gets 2 or 3 incidents; the offsets CTE (0,1,2) is filtered
-- to that per-student count. All text columns vary deterministically off
-- (student_id, ordinal) so the log reads like real entries.
WITH sel AS (
    SELECT s.id AS student_id, s.school_id
      FROM students s
     WHERE s.id % 6 = 0
),
ord AS (SELECT 0 AS k UNION ALL SELECT 1 UNION ALL SELECT 2),
slots AS (
    SELECT sel.student_id,
           sel.school_id,
           ord.k
      FROM sel
      JOIN ord ON ord.k < 2 + CASE WHEN (sel.student_id / 6) % 3 > 0 THEN 1 ELSE 0 END
),
picked AS (
    SELECT sl.student_id,
           sl.school_id,
           sl.k,
           -- Deterministic date: day-of-term 0..29 == Sep 1 .. Sep 30 (demo today).
           (DATE '2026-09-01'
            + ((sl.student_id * 7 + sl.k * 13 + (sl.student_id % 5) * 3) % 30)) AS incident_date
      FROM slots sl
),
coded AS (
    SELECT p.*,
           -- Cycle codes 7..; used both for the value and the de-dup predicate.
           (SELECT dc.code FROM discipline_codes dc
             ORDER BY dc.severity DESC, dc.code
             LIMIT 1 OFFSET ((p.student_id * 3 + p.k) % (SELECT count(*)::int FROM discipline_codes))) AS code
      FROM picked p
)
INSERT INTO discipline_incidents (
    student_id, incident_date, code, description, action_taken,
    reported_by, parent_notified, follow_up_date
)
SELECT c.student_id,
       c.incident_date,
       c.code,
       (SELECT dc.label FROM discipline_codes dc WHERE dc.code = c.code)
         || ' reported by classroom staff; ' ||
         (ARRAY[
            'student was redirected and the expectation was re-taught.',
            'incident documented after class; student given time to reset.',
            'recurring pattern noted by the grade-level team.',
            'student declined to discuss the incident at the time.',
            'staff de-escalated the situation before instruction resumed.',
            'guardian contact attempted the same day.'
          ])[1 + ((c.student_id + c.k) % 6)] AS description,
       -- Action escalates with severity and varies with the ordinal.
       (SELECT CASE
                 WHEN dc.severity >= 4 THEN (ARRAY['In-School Suspension','Referral','Parent Contact'])[1 + ((c.student_id + c.k) % 3)]
                 WHEN dc.severity  = 3 THEN (ARRAY['Detention','Parent Contact','Referral'])[1 + ((c.student_id + c.k) % 3)]
                 WHEN dc.severity  = 2 THEN (ARRAY['Warning','Detention','Parent Contact'])[1 + ((c.student_id + c.k) % 3)]
                 ELSE (ARRAY['Warning','Warning','Detention'])[1 + ((c.student_id + c.k) % 3)]
               END
          FROM discipline_codes dc WHERE dc.code = c.code) AS action_taken,
       -- Reporting teacher from the student's own school, picked deterministically.
       (SELECT t.name
          FROM teachers t
         WHERE t.school_id = c.school_id
         ORDER BY t.id
         LIMIT 1 OFFSET ((c.student_id + c.k) %
               (SELECT count(*)::int FROM teachers t2 WHERE t2.school_id = c.school_id))) AS reported_by,
       -- ~20% NOT notified: (student_id + ordinal) divisible by 5.
       ((c.student_id + c.k) % 5 <> 0) AS parent_notified,
       -- Follow-up for roughly a third, kept inside the term window.
       CASE WHEN (c.student_id + c.k * 2) % 3 = 0
            THEN LEAST(c.incident_date + 14, DATE '2026-12-18')
            ELSE NULL END AS follow_up_date
  FROM coded c
 WHERE NOT EXISTS (
        SELECT 1 FROM discipline_incidents di
         WHERE di.student_id = c.student_id
           AND di.code = c.code
           AND di.incident_date = c.incident_date
       );

-- ---- Health encounters -----------------------------------------------------
-- Separate deterministic subset from discipline (id%5=1) so the two populations
-- are not identical; exactly 10 students (multiples of 30) carry both kinds of
-- record. One or two nurse visits each, spread across the term.
WITH sel AS (
    SELECT s.id AS student_id, s.school_id
      FROM students s
     WHERE s.id % 5 = 1
),
ord AS (SELECT 0 AS k UNION ALL SELECT 1),
picked AS (
    SELECT sel.student_id, sel.school_id, ord.k,
           (DATE '2026-09-01'
            + ((sel.student_id * 5 + ord.k * 11 + (sel.student_id % 7)) % 30)) AS encounter_date,
           ((sel.student_id + ord.k * 5) % 6) AS t,
           -- De-dup key includes the type so guard matches the inserted row exactly.
           (ARRAY['Clinic Visit','Medication','Injury','Illness','Screening','Immunization'])[1 + ((sel.student_id + ord.k * 5) % 6)] AS encounter_type
      FROM sel
      JOIN ord ON ord.k < 1 + (sel.student_id % 2)
)
INSERT INTO health_encounters (
    student_id, encounter_date, encounter_type, complaint, treatment, disposition, seen_by
)
SELECT p.student_id,
       p.encounter_date,
       p.encounter_type,
       (ARRAY[
          'Headache and light-headedness reported during class.',
          'Routine dose administered per health plan on file.',
          'Scraped knee after a fall on the playground.',
          'Fever and sore throat; sent from class by the teacher.',
          'Vision screening completed for the grade-level cohort.',
          'Scheduled immunization per state requirement.',
          'Stomach ache after lunch; no fever noted.',
          'Minor cut on the hand during a lab activity.',
          'Persistent cough; observed in the clinic for 20 minutes.',
          'Annual hearing screening.',
          'Allergic reaction suspected after a snack.',
          'Ankle pain after a PE activity.'
        ])[1 + ((p.student_id + p.k * 3) % 12)] AS complaint,
       (ARRAY[
          'Rested 20 minutes with water; rechecked before return to class.',
          'Medication administered as authorized; monitored 15 minutes.',
          'Cleaned and bandaged; ice applied.',
          'Temperature checked and noted; guardian advised by phone.',
          'Screening result recorded in the student health record.',
          'Immunization administered per signed consent form.',
          'Offered crackers and water; symptoms subsided.',
          'Antiseptic applied; student returned to class.',
          'Monitored in the clinic; no further symptoms.',
          'Referral made for a follow-up screening next cycle.',
          'Benadryl given per health plan; guardian notified.',
          'Elevated and iced; student rested until comfortable.'
        ])[1 + ((p.student_id + p.k * 3) % 12)] AS treatment,
       (ARRAY['Returned to class','Returned to class','Returned to class','Sent home',
              'Returned to class','Returned to class','Sent home','Returned to class'])[1 + ((p.student_id + p.k) % 8)] AS disposition,
       (SELECT t.name
          FROM teachers t
         WHERE t.school_id = p.school_id
         ORDER BY t.id DESC
         LIMIT 1 OFFSET ((p.student_id + p.k) %
               (SELECT count(*)::int FROM teachers t2 WHERE t2.school_id = p.school_id))) AS seen_by
  FROM picked p
 WHERE NOT EXISTS (
        SELECT 1 FROM health_encounters he
         WHERE he.student_id = p.student_id
           AND he.encounter_date = p.encounter_date
           AND he.encounter_type = p.encounter_type
       );

-- ---- Additional health flags ----------------------------------------------
-- Ten flag types, five students each (id%60 = r, r = 0..9), recorded during the
-- term. The unique (student_id, flag) guard makes re-runs no-ops; the existing
-- 17-file seeds the four older types (26 rows) and these do not duplicate them.
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'Allergy - Peanut', 'Mild-to-moderate peanut allergy; avoidance plan on file with the cafeteria.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 0
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Allergy - Peanut');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'Allergy - Bee Sting', 'Local reaction to bee stings; topical treatment and monitoring noted.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 1
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Allergy - Bee Sting');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'Diabetes Type 1', 'Insulin-dependent; health plan and emergency glucagon on file with the nurse.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 2
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Diabetes Type 1');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'Seizure Protocol', 'Seizure action plan on file; rescue medication kept in the health office.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 3
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Seizure Protocol');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'Medication On File', 'Prescription medication authorized; stored and administered by the health office.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 4
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Medication On File');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'Vision', 'Failed distance vision screening; referral sent for optometry follow-up.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 5
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Vision');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'Hearing', 'Hearing screening outside the normal range; re-screen scheduled.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 6
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Hearing');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'IEP - Speech', 'Speech-language services per IEP; weekly pull-out sessions scheduled.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 7
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'IEP - Speech');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'IEP - OT', 'Occupational therapy services per IEP; fine-motor goals in progress.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 8
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'IEP - OT');
INSERT INTO health_flags (student_id, flag, note, recorded_on)
SELECT s.id, 'Asthma', 'Rescue inhaler on file with the health office; activity plan updated this term.', (DATE '2026-09-01' + (s.id % 20))::date
  FROM students s WHERE s.id % 60 = 9
   AND NOT EXISTS (SELECT 1 FROM health_flags f WHERE f.student_id = s.id AND f.flag = 'Asthma');
