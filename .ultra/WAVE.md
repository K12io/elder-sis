# WAVE IN FLIGHT — do not act on these slices

## Active workers (wave 5 — data population)

- `D1` rosters — flash-fleet. db/migrations/30-rosters.sql
- `D4` people — flash-fleet. db/migrations/33-people.sql
- `D5` conduct+health — flash-fleet. db/migrations/34-conduct-health.sql
- `D6` finance/assessment/comms — flash-fleet. db/migrations/35-finance-assess-comms.sql
- `D7` demo users — flash-fleet. db/migrations/36-users.sql

## Rules while this list is non-empty
- Do NOT verify, grade, or write verdicts for the slices listed — their migrations are mid-write.
- Do NOT dispatch replacements. Do NOT write their files yourself.
- You MAY verify slices NOT listed, or record a no-op tick. That is a complete tick.
