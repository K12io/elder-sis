import express from "express";
import { pool, query } from "../db.js";

const router = express.Router();

// ---- helpers ----------------------------------------------------------------

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function num(v) {
  const s = text(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const AUDIENCE_TYPES = ["all", "school", "grade", "staff"];
const CHANNELS = ["Email", "Print", "Both"];
const STATUSES = ["draft", "published"];

async function loadSchools() {
  const r = await query("SELECT id, name, code FROM schools ORDER BY id");
  return r.rows;
}

async function loadGrades() {
  const grades = [
    { value: "K", label: "Kindergarten" },
    { value: "1", label: "Grade 1" },
    { value: "2", label: "Grade 2" },
    { value: "3", label: "Grade 3" },
    { value: "4", label: "Grade 4" },
    { value: "5", label: "Grade 5" },
    { value: "6", label: "Grade 6" },
    { value: "7", label: "Grade 7" },
    { value: "8", label: "Grade 8" },
    { value: "9", label: "Grade 9" },
    { value: "10", label: "Grade 10" },
    { value: "11", label: "Grade 11" },
    { value: "12", label: "Grade 12" },
  ];
  return grades;
}

async function loadUsers() {
  const r = await query("SELECT id, display_name, username FROM app_users WHERE active = TRUE ORDER BY display_name");
  return r.rows;
}

function formatDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 19).replace("T", " ");
}

function formatDateOnly(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 10);
}

function audienceLabel(audienceType, audienceValue) {
  if (audienceType === "all") return "All District";
  if (audienceType === "school") return `School: ${audienceValue || "(unknown)"}`;
  if (audienceType === "grade") return `Grade: ${audienceValue || "(unknown)"}`;
  if (audienceType === "staff") return `Staff: ${audienceValue || "(all staff)"}`;
  return audienceType;
}

// ---- index: inbox-style list ------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const statusFilter = text(req.query.status);
    const audienceFilter = text(req.query.audience_type);

    const where = [];
    const params = [];
    if (statusFilter && STATUSES.includes(statusFilter)) {
      params.push(statusFilter);
      where.push(`a.status = $${params.length}`);
    }
    if (audienceFilter && AUDIENCE_TYPES.includes(audienceFilter)) {
      params.push(audienceFilter);
      where.push(`a.audience_type = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Counts for metabar
    const [draftCount, pubCount, recipCount, rowsR] = await Promise.all([
      query("SELECT count(*)::int AS n FROM announcements WHERE status = 'draft'"),
      query("SELECT count(*)::int AS n FROM announcements WHERE status = 'published'"),
      query("SELECT count(*)::int AS n FROM announcement_recipients"),
      query(
        `SELECT a.id, a.title, a.audience_type, a.audience_value, a.channel, a.status,
                a.created_by, a.created_at, a.published_at,
                COUNT(ar.id)::int AS recipient_count
           FROM announcements a
           LEFT JOIN announcement_recipients ar ON ar.announcement_id = a.id
           ${whereSql}
           GROUP BY a.id
           ORDER BY a.created_at DESC`,
        params
      ),
    ]);

    res.render("communications/index", {
      pageTitle: "Communications",
      activeTab: "communications",
      rows: rowsR.rows,
      filters: { status: statusFilter, audience_type: audienceFilter },
      metabar: {
        drafts: draftCount.rows[0].n,
        published: pubCount.rows[0].n,
        totalRecipients: recipCount.rows[0].n,
      },
      statuses: STATUSES,
      audienceTypes: AUDIENCE_TYPES,
      audienceLabel,
      formatDate,
    });
  } catch (err) {
    next(err);
  }
});

// ---- new: compose form ------------------------------------------------------

router.get("/new", async (req, res, next) => {
  try {
    const [schools, grades, users] = await Promise.all([loadSchools(), loadGrades(), loadUsers()]);
    res.render("communications/new", {
      pageTitle: "New Announcement",
      activeTab: "communications",
      schools,
      grades,
      users,
      audienceTypes: AUDIENCE_TYPES,
      channels: CHANNELS,
      statuses: STATUSES,
      form: { title: "", body: "", audience_type: "all", audience_value: "", channel: "Email", status: "draft" },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const title = text(req.body.title);
    const body = text(req.body.body);
    const audienceType = text(req.body.audience_type);
    const audienceValue = text(req.body.audience_value);
    const channel = text(req.body.channel);
    const status = text(req.body.status);

    const [schools, grades, users] = await Promise.all([loadSchools(), loadGrades(), loadUsers()]);

    // Validate
    const errors = [];
    if (!title) errors.push("Title is required.");
    if (!body) errors.push("Body is required.");
    if (!AUDIENCE_TYPES.includes(audienceType)) errors.push("Invalid audience type.");
    if (!CHANNELS.includes(channel)) errors.push("Invalid channel.");
    if (!STATUSES.includes(status)) errors.push("Invalid status.");
    if (audienceType === "school" && !audienceValue) errors.push("School is required for school audience.");
    if (audienceType === "grade" && !audienceValue) errors.push("Grade is required for grade audience.");
    if (audienceType === "staff" && !audienceValue) errors.push("Staff audience value is required (e.g., a group name).");

    if (errors.length) {
      return res.status(400).render("communications/new", {
        pageTitle: "New Announcement",
        activeTab: "communications",
        schools,
        grades,
        users,
        audienceTypes: AUDIENCE_TYPES,
        channels: CHANNELS,
        statuses: STATUSES,
        form: { title, body, audience_type: audienceType, audience_value: audienceValue, channel, status },
        error: errors.join(" "),
      });
    }

    const createdBy = "Demo User"; // TODO: from session

    // Insert announcement + materialize recipients in one transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const annR = await client.query(
        `INSERT INTO announcements (title, body, audience_type, audience_value, channel, status, created_by, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [title, body, audienceType, audienceValue || null, channel, status, createdBy, status === "published" ? new Date() : null]
      );
      const announcementId = annR.rows[0].id;

      let recipientCount = 0;
      if (audienceType === "all") {
        const r = await client.query(
          `INSERT INTO announcement_recipients (announcement_id, student_id)
           SELECT $1, s.id FROM students s WHERE s.status = 'Active'`,
          [announcementId]
        );
        recipientCount = r.rowCount ?? 0;
      } else if (audienceType === "school") {
        const schoolId = Number(audienceValue);
        const r = await client.query(
          `INSERT INTO announcement_recipients (announcement_id, student_id)
           SELECT $1, s.id FROM students s WHERE s.status = 'Active' AND s.school_id = $2`,
          [announcementId, schoolId]
        );
        recipientCount = r.rowCount ?? 0;
      } else if (audienceType === "grade") {
        const gradeLevel = audienceValue === "K" ? 0 : Number(audienceValue);
        const r = await client.query(
          `INSERT INTO announcement_recipients (announcement_id, student_id)
           SELECT $1, s.id FROM students s WHERE s.status = 'Active' AND s.grade_level = $2`,
          [announcementId, gradeLevel]
        );
        recipientCount = r.rowCount ?? 0;
      } else if (audienceType === "staff") {
        const r = await client.query(
          `INSERT INTO announcement_recipients (announcement_id, user_id)
           SELECT $1, u.id FROM app_users u WHERE u.active = TRUE`,
          [announcementId]
        );
        recipientCount = r.rowCount ?? 0;
      }

      await client.query("COMMIT");
      res.redirect(`/communications/show?id=${announcementId}&notice=${encodeURIComponent(`${recipientCount} recipients queued`)}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ---- show: one announcement -------------------------------------------------

router.get("/show", async (req, res, next) => {
  try {
    const id = Number(req.query.id);
    if (!Number.isInteger(id) || id <= 0) return res.redirect("/communications");

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [annR, recipR, countR] = await Promise.all([
      query("SELECT * FROM announcements WHERE id = $1", [id]),
      query(
        `SELECT ar.id, ar.student_id, ar.user_id, ar.delivered_at, ar.read_at,
                s.last_name, s.first_name, s.state_id, s.grade_level, s.school_id,
                u.display_name, u.username,
                sch.name AS school_name
           FROM announcement_recipients ar
           LEFT JOIN students s ON s.id = ar.student_id
           LEFT JOIN schools sch ON sch.id = s.school_id
           LEFT JOIN app_users u ON u.id = ar.user_id
          WHERE ar.announcement_id = $1
          ORDER BY COALESCE(s.last_name, u.display_name), COALESCE(s.first_name, u.username)
          LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
      query("SELECT count(*)::int AS n FROM announcement_recipients WHERE announcement_id = $1", [id]),
    ]);

    if (annR.rows.length === 0) {
      return res.status(404).render("communications/404", {
        pageTitle: "Announcement Not Found",
        activeTab: "communications",
        announcementId: id,
      });
    }

    const announcement = annR.rows[0];
    const totalRecipients = countR.rows[0].n;
    const notice = text(req.query.notice);
    const message = text(req.query.message);
    const error = text(req.query.error);

    res.render("communications/show", {
      pageTitle: `Announcement: ${announcement.title}`,
      activeTab: "communications",
      announcement,
      recipients: recipR.rows,
      totalRecipients,
      page,
      limit,
      totalPages: Math.ceil(totalRecipients / limit),
      audienceLabel,
      formatDate,
      formatDateOnly,
      notice,
      message,
      error,
    });
  } catch (err) {
    next(err);
  }
});

// ---- publish: POST /communications/publish ----------------------------------

router.post("/publish", async (req, res, next) => {
  try {
    const id = Number(text(req.body.id));
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect("/communications?error=" + encodeURIComponent("Invalid announcement ID."));
    }

    const r = await query(
      `UPDATE announcements
          SET status = 'published', published_at = NOW()
        WHERE id = $1 AND status = 'draft'
        RETURNING id`,
      [id]
    );

    if (r.rowCount === 0) {
      return res.redirect(`/communications/show?id=${id}&error=` + encodeURIComponent("Announcement not found or already published."));
    }
    res.redirect(`/communications/show?id=${id}&message=` + encodeURIComponent("Announcement published."));
  } catch (err) {
    next(err);
  }
});

// ---- deliver: POST /communications/deliver ----------------------------------

router.post("/deliver", async (req, res, next) => {
  try {
    const id = Number(text(req.body.id));
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect("/communications?error=" + encodeURIComponent("Invalid announcement ID."));
    }

    const r = await query(
      `UPDATE announcement_recipients
          SET delivered_at = NOW()
        WHERE announcement_id = $1 AND delivered_at IS NULL`,
      [id]
    );

    const changed = r.rowCount ?? 0;
    res.redirect(`/communications/show?id=${id}&message=` + encodeURIComponent(`${changed} recipient(s) marked as delivered.`));
  } catch (err) {
    next(err);
  }
});

// ---- log: delivery log ------------------------------------------------------

router.get("/log", async (req, res, next) => {
  try {
    const format = text(req.query.format);
    const announcementId = num(req.query.announcement_id);
    const studentId = num(req.query.student_id);
    const deliveredFilter = text(req.query.delivered); // 'yes', 'no', ''
    const readFilter = text(req.query.read); // 'yes', 'no', ''
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = format === "csv" ? 10000 : 50;
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    if (announcementId) {
      params.push(announcementId);
      where.push(`ar.announcement_id = $${params.length}`);
    }
    if (studentId) {
      params.push(studentId);
      where.push(`ar.student_id = $${params.length}`);
    }
    if (deliveredFilter === "yes") where.push("ar.delivered_at IS NOT NULL");
    if (deliveredFilter === "no") where.push("ar.delivered_at IS NULL");
    if (readFilter === "yes") where.push("ar.read_at IS NOT NULL");
    if (readFilter === "no") where.push("ar.read_at IS NULL");

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countSql = `
      SELECT count(*)::int AS n
      FROM announcement_recipients ar
      JOIN announcements a ON a.id = ar.announcement_id
      LEFT JOIN students s ON s.id = ar.student_id
      ${whereSql}
    `;

    const rowsSql = `
      SELECT ar.id, ar.announcement_id, ar.student_id, ar.user_id,
             ar.delivered_at, ar.read_at,
             a.title AS announcement_title, a.audience_type, a.audience_value, a.channel, a.status,
             s.state_id, s.last_name, s.first_name, s.grade_level, sch.name AS school_name,
             u.display_name, u.username
      FROM announcement_recipients ar
      JOIN announcements a ON a.id = ar.announcement_id
      LEFT JOIN students s ON s.id = ar.student_id
      LEFT JOIN schools sch ON sch.id = s.school_id
      LEFT JOIN app_users u ON u.id = ar.user_id
      ${whereSql}
      ORDER BY ar.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countParams = [...params];
    const rowsParams = [...params, limit, offset];

    const [countR, rowsR, announcementsR] = await Promise.all([
      query(countSql, countParams),
      query(rowsSql, rowsParams),
      query("SELECT id, title FROM announcements ORDER BY created_at DESC"),
    ]);

    const total = countR.rows[0].n;
    const totalPages = Math.ceil(total / limit);

    // Counts per announcement for the metabar
    const perAnnR = await query(
      `SELECT a.id, a.title,
              COUNT(ar.id)::int AS total,
              COUNT(ar.delivered_at)::int AS delivered,
              COUNT(ar.read_at)::int AS read
         FROM announcements a
         LEFT JOIN announcement_recipients ar ON ar.announcement_id = a.id
        GROUP BY a.id
        ORDER BY a.created_at DESC`
    );

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="delivery_log.csv"');
      let csv = "Announcement ID,Announcement Title,Audience Type,Audience Value,Channel,Status,Recipient Type,Recipient ID,Recipient Name,Delivered At,Read At\n";
      for (const row of rowsR.rows) {
        const recipientType = row.student_id ? "Student" : "User";
        const recipientId = row.student_id ?? row.user_id ?? "";
        const recipientName = row.student_id
          ? `${row.last_name}, ${row.first_name} (${row.state_id})`
          : row.display_name ?? row.username ?? "";
        csv += [
          row.announcement_id,
          `"${row.announcement_title.replace(/"/g, '""')}"`,
          row.audience_type,
          row.audience_value || "",
          row.channel,
          row.status,
          recipientType,
          recipientId,
          `"${recipientName.replace(/"/g, '""')}"`,
          row.delivered_at ? new Date(row.delivered_at).toISOString().slice(0, 19).replace("T", " ") : "",
          row.read_at ? new Date(row.read_at).toISOString().slice(0, 19).replace("T", " ") : "",
        ].join(",") + "\n";
      }
      return res.send(csv);
    }

    res.render("communications/log", {
      pageTitle: "Delivery Log",
      activeTab: "communications",
      rows: rowsR.rows,
      filters: {
        announcement_id: announcementId || "",
        student_id: studentId || "",
        delivered: deliveredFilter,
        read: readFilter,
      },
      announcements: announcementsR.rows,
      page,
      limit,
      total,
      totalPages,
      perAnn: perAnnR.rows,
      formatDate,
      audienceLabel,
    });
  } catch (err) {
    next(err);
  }
});

export default router;