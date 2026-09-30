# WAVE IN FLIGHT — do not act on these slices

## Active workers (wave 5b)

- `D2` grading data for all 42 sections — flash-fleet. db/migrations/31-grading-data.sql
- `D3` attendance history (6 weeks x all sections) — flash-fleet. db/migrations/32-attendance-data.sql

## Rules while this list is non-empty
- Do NOT verify, grade, or write verdicts for the slices listed — their migrations are mid-write.
- Do NOT dispatch replacements. Do NOT write their files yourself.
- You MAY verify slices NOT listed, or record a no-op tick. That is a complete tick.

## Clear this file when the wave has finished
