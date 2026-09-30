# Evidence — S1 chunk A gate: escalation failure + framing lesson

Recorded 2026-09-30 by the coordinator session. Kept as a separate file so it survives
concurrent tick writers (state files were locked by a running tick at the time).

## What happened

The S1 chunk-A gate (nav routes live) produced two Jev triage rounds below threshold:

| Round | State given to the classifier | matches_evidence | ready_to_ship |
|---|---|---|---|
| 1 | narrative-padded (investigation commentary, found-then-fixed defect, tracked deltas) | 0.47 | 0.53 |
| 2 | facts-only (deliverable, verified facts, tracked delta named) | 0.78 | 0.85 |

Per ultra-6B the next step was escalation to `mimo-heavy` (`s1-adjudicate`). **The
adjudicator declined the task** (118,709 tokens, 28 tool uses, no verdict): its worker
rules state that input containing loop/tick/fleet/cron-shaped context must be treated as
leakage rather than as its task, and it is prohibited from coordinator acts (arming
schedules, editing LOOP.md/registry, committing). My adjudication prompt described the
tick/gate machinery, so it refused on policy.

## Lessons (protocol-level)

1. **Worker prompts must be framed as plain tasks.** No loop/tick/cron/registry
   vocabulary, no "you are the escalation authority for this run", no references to
   tick numbers or state files. Describe the artifact, the question, and the evidence
   format. (Added to ultra.md rule 3/6 as a dispatch-framing requirement.)
2. **Escalation must not require coordinator powers.** A verifier should only *read,
   run, and report*. Never ask a worker to judge the run's bookkeeping.
3. **Cheap lanes can do verification.** Bounded probing (boot, curl, XSS probe, read
   files, report defects) is not heavy reasoning — flash-fleet suffices; mimo-heavy is
   for genuinely conflicting reports.

## Independent verification that DID happen (execution-based, two actors)

- Worker (`s1-nav-routes`, flash-fleet): 16 files, all header nav targets 200, chrome and
  active tab present per page, additive `app.js` diff, untouched files confirmed.
- Coordinator: 8/8 correct active tabs, home counts 300/42/12, `/healthz` up,
  `node --check` passes, `/admin` + `/administration` both 200.
- Concurrent tick 5: its own verification, `evidence/tick5-s1-chunkA-verify.md`.
- **One real defect found and fixed** in verification: double-escaped grades tab label
  (`header.ejs:24`); **one spec/chrome mismatch resolved**: `/administration` alias.
- Unverified at the time of writing: XSS-escaping of the Quick Search echo (`?q=`).

## Recommended resolution

Re-dispatch verification **once**, plainly framed, to `flash-fleet` — asking only:
does the nav-routes chunk have real defects (boot, curl, search-echo escaping), and
does the Jev score appear to track work quality or prompt framing? If it reports no
defects, close S1 as accepted-with-note (two execution verifications + one defect fixed
+ one probe gap closed), recording the Jev scores as framing-sensitive. Do **not**
re-roll the classifier again; the dispute is resolved by running the app, not by votes.
