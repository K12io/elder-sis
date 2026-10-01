import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (s) => (await p.query(s)).rows;
const show = async (label, sql) => console.log(label + "\n" + JSON.stringify(await q(sql)));

await show("=== TOTALS ===",
  "select (select count(*)::int from discipline_incidents) discipline_incidents, (select count(*)::int from health_encounters) health_encounters, (select count(*)::int from health_flags) health_flags");

await show("=== incidents per school ===",
  "select sc.code school, sc.name, count(*)::int incidents from discipline_incidents d join students s on s.id=d.student_id join schools sc on sc.id=s.school_id group by sc.code,sc.name order by sc.code");

await show("=== incidents per grade band ===",
  "select case when s.grade_level between 0 and 5 then 'Elementary K-5' when s.grade_level between 6 and 8 then 'Middle 6-8' else 'High 9-12' end grade_band, count(*)::int incidents, count(distinct d.student_id)::int students from discipline_incidents d join students s on s.id=d.student_id group by 1 order by 1");

await show("=== incidents per code ===",
  "select d.code, c.label, c.severity, count(*)::int n from discipline_incidents d join discipline_codes c on c.code=d.code group by d.code,c.label,c.severity order by c.severity desc, d.code");

await show("=== date ranges (term 2026-09-01..2026-12-18, demo today 2026-09-30) ===",
  "select (select min(incident_date) from discipline_incidents) disc_min, (select max(incident_date) from discipline_incidents) disc_max, (select min(encounter_date) from health_encounters) enc_min, (select max(encounter_date) from health_encounters) enc_max, (select min(recorded_on) from health_flags) flag_min, (select max(recorded_on) from health_flags) flag_max");

await show("=== parent_notified false / follow-up ===",
  "select count(*)::int total, count(*) filter (where not parent_notified)::int not_notified, round(100.0*count(*) filter (where not parent_notified)/count(*),1) pct_not_notified, count(*) filter (where follow_up_date is not null)::int follow_ups, round(100.0*count(*) filter (where follow_up_date is not null)/count(*),1) pct_follow_up from discipline_incidents");

await show("=== clustering (distinct students with incidents) ===",
  "select count(distinct student_id)::int distinct_students, (select count(*)::int from students) total_students, (select max(n) from (select count(*) n from discipline_incidents group by student_id) x) max_incidents_per_student, (select min(n) from (select count(*) n from discipline_incidents group by student_id) x) min_incidents_per_student from discipline_incidents");

await show("=== encounters by type ===",
  "select encounter_type, count(*)::int n from health_encounters group by encounter_type order by encounter_type");

await show("=== flags by type ===",
  "select flag, count(*)::int n from health_flags group by flag order by flag");

await show("=== discipline/health student overlap ===",
  "select count(*)::int students_with_both from (select distinct student_id from discipline_incidents intersect select distinct student_id from health_encounters) x");

await show("=== guards (nothing outside window, no null staff) ===",
  "select (select count(*)::int from discipline_incidents where incident_date < DATE '2026-09-01' or incident_date > DATE '2026-09-30') disc_out, (select count(*)::int from health_encounters where encounter_date < DATE '2026-09-01' or encounter_date > DATE '2026-09-30') enc_out, (select count(*)::int from discipline_incidents where follow_up_date > DATE '2026-12-18') future_fu, (select count(*)::int from discipline_incidents where reported_by is null) null_rep, (select count(*)::int from health_encounters where seen_by is null) null_seen, (select count(*)::int from discipline_codes) codes, (select count(*)::int from students) students");

await p.end();
