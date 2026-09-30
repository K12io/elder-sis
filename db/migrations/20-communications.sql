-- 20-communications.sql — Communications slice (S3).
-- Announcements + delivery log with deterministic demo seed.
-- Idempotent: tables use IF NOT EXISTS; seed inserts only when absent.

CREATE TABLE IF NOT EXISTS announcements (
    id              SERIAL PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    audience_type   TEXT NOT NULL CHECK (audience_type IN ('all','school','grade','staff')),
    audience_value  TEXT,
    channel         TEXT NOT NULL CHECK (channel IN ('Email','Print','Both')),
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS announcement_recipients (
    id                  SERIAL PRIMARY KEY,
    announcement_id     INTEGER NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
    student_id          INTEGER REFERENCES students (id),
    user_id             INTEGER REFERENCES app_users (id),
    delivered_at        TIMESTAMPTZ,
    read_at             TIMESTAMPTZ,
    UNIQUE (announcement_id, student_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcements (status);
CREATE INDEX IF NOT EXISTS idx_announcements_audience ON announcements (audience_type, audience_value);
CREATE INDEX IF NOT EXISTS idx_announcement_recipients_ann ON announcement_recipients (announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_recipients_student ON announcement_recipients (student_id);
CREATE INDEX IF NOT EXISTS idx_announcement_recipients_user ON announcement_recipients (user_id);

-- ---- Deterministic seed: 3 demo announcements with recipients --------------
-- Announcement 1: District-wide published announcement.
-- Announcement 2: School-targeted draft (Valley View High School = school_id 1).
-- Announcement 3: Grade-targeted published announcement (Grade 9 = grade_level 9).

-- Insert announcements only if table is empty.
WITH ins AS (
    INSERT INTO announcements (title, body, audience_type, audience_value, channel, status, created_by, published_at)
    SELECT 'Welcome Back — 2026–27 School Year',
           'Dear families and staff,\n\nWelcome to the 2026–27 school year at Valley View Unified. We are excited to have our students back on campus. Please review the attached calendar for key dates, including parent conferences, testing windows, and holidays.\n\nHighlights:\n• First day: September 1, 2026\n• Fall break: November 23–27\n• Winter break: December 22 – January 2\n• Spring break: April 5–9\n\nTransportation routes have been updated; check the portal for your bus stop times. Nutrition Services reminds you that free breakfast is available to all students.\n\nIf you have questions, contact your school office or reply to this message.\n\n— Valley View Unified Administration',
           'all', NULL, 'Both', 'published', 'District Office', NOW() - INTERVAL '10 days'
    WHERE NOT EXISTS (SELECT 1 FROM announcements)
    RETURNING id
),
ins2 AS (
    INSERT INTO announcements (title, body, audience_type, audience_value, channel, status, created_by, published_at)
    SELECT 'VVHS Senior Portrait Schedule — DRAFT',
           'Attention Valley View High School seniors and families:\n\nThe preliminary senior portrait schedule is ready for review. Sessions will run October 14–18 in the VVHS library. Please confirm your appointment time by September 30.\n\nNote: This is a DRAFT schedule. Final times will be published after photographer confirmation.\n\nContact the VVHS front office with conflicts.',
           'school', '1', 'Email', 'draft', 'VVHS Office', NULL
    WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title = 'VVHS Senior Portrait Schedule — DRAFT')
    RETURNING id
),
ins3 AS (
    INSERT INTO announcements (title, body, audience_type, audience_value, channel, status, created_by, published_at)
    SELECT 'Grade 9 Orientation — Important Reminders',
           'Grade 9 students and families:\n\nOrientation is Thursday, August 29, 8:00 AM – 12:00 PM at Valley View High School. Arrive at the main gym by 7:45 AM.\n\nBring:\n• Completed emergency card (mailed home)\n• Immunization records (if not yet submitted)\n• Comfortable shoes for campus tour\n\nSchedule:\n8:00  Welcome & admin overview\n8:30  Building tours (student leaders)\n9:30  Locker assignments & combinations\n10:00 Tech setup: Chromebooks & portal login\n11:00 Q&A with counselors\n11:30 Lunch (provided)\n12:00 Dismissal\n\nParents are welcome for the 8:00 AM welcome session only. Students should be picked up promptly at noon.\n\nSee you there!\n— VVHS 9th Grade Team',
           'grade', '9', 'Both', 'published', 'VVHS Counseling', NOW() - INTERVAL '5 days'
    WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title = 'Grade 9 Orientation — Important Reminders')
    RETURNING id
)
-- Materialize recipients for the seeded announcements.
-- Announcement 1 (all): all active students.
INSERT INTO announcement_recipients (announcement_id, student_id)
SELECT a.id, s.id
FROM announcements a
JOIN students s ON s.status = 'Active'
WHERE a.title = 'Welcome Back — 2026–27 School Year'
  AND NOT EXISTS (
    SELECT 1 FROM announcement_recipients ar
    WHERE ar.announcement_id = a.id AND ar.student_id = s.id
  );

-- Announcement 2 (school=1): active students at school_id 1 (Valley View High School).
INSERT INTO announcement_recipients (announcement_id, student_id)
SELECT a.id, s.id
FROM announcements a
JOIN students s ON s.status = 'Active' AND s.school_id = 1
WHERE a.title = 'VVHS Senior Portrait Schedule — DRAFT'
  AND NOT EXISTS (
    SELECT 1 FROM announcement_recipients ar
    WHERE ar.announcement_id = a.id AND ar.student_id = s.id
  );

-- Announcement 3 (grade=9): active students with grade_level 9.
INSERT INTO announcement_recipients (announcement_id, student_id)
SELECT a.id, s.id
FROM announcements a
JOIN students s ON s.status = 'Active' AND s.grade_level = 9
WHERE a.title = 'Grade 9 Orientation — Important Reminders'
  AND NOT EXISTS (
    SELECT 1 FROM announcement_recipients ar
    WHERE ar.announcement_id = a.id AND ar.student_id = s.id
  );

-- Also seed staff recipients for any 'staff' audience announcements (none in demo, but shows pattern).
-- INSERT INTO announcement_recipients (announcement_id, user_id)
-- SELECT a.id, u.id
-- FROM announcements a
-- JOIN app_users u ON u.active = TRUE
-- WHERE a.audience_type = 'staff'
--   AND NOT EXISTS (
--     SELECT 1 FROM announcement_recipients ar
--     WHERE ar.announcement_id = a.id AND ar.user_id = u.id
--   );