# WAVE IN FLIGHT — do not act on these slices

Workers currently running for this run. **While this list is non-empty:**

- Do NOT verify, grade, boot-probe, or write FAIL verdicts for the slices listed below —
  their files are mid-write and any failure you observe is a false negative (this
  happened twice on 2026-09-30 and produced two bogus FAIL verdicts).
- Do NOT dispatch replacements for them (a replacement can clobber a live worker's files).
- Do NOT write their view/route/migration files yourself, even if they look missing.
  Missing files here mean "not yet written", not "broken".
- You MAY verify slices that are NOT listed, or record a no-op tick noting the wave is
  in flight. That is a complete, valid tick.

## Active workers

(none — wave closed 2026-09-30; s4-scheduling worker deemed stuck at 308k tokens with
no writes for >3 min; its artifacts are frozen and verified independently.)


## Clear this file when the wave has finished

When both workers have reported and their files have stopped changing, empty the list
(keep the file, replace the entries with a dated "none") and then run the authoritative
post-wave verification: boot, sweep every route, exercise writes, check SQL rows,
restart to prove migration idempotency, clean probe rows, stop the server.
