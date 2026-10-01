# V1 — screen-level fidelity deltas vs the reference captures

Source: `reference/captures-v1/` — 15 captures from the Vera SIS UI research library, one per
screen *type* this SIS now has (Aeries, Aspen, Focus). Reviewed visually 2026-09-30.
Chrome-level fidelity (two-tier navy header, dark-blue panel headers, dense 11px grids, tab
strip, salmon current column, print blocks) was already delivered at S1b — this file covers
**screen layout** patterns still missing.

## What the references do that we do not (the recurring patterns)

| # | Pattern in the captures | Where it appears | Our gap |
|---|---|---|---|
| P1 | **Blue collapsible section bar** with a title on the left, right-aligned white action buttons (Add / Delete), and a collapse caret at the far right | Transcript Definition, Attendance "Filters and Options", "Results" bar | our `.sis-box-title` is static — no caret, no in-bar actions |
| P2 | **Gray accordion rows** with chevrons stacked for setup pages | Transcript Definition (Design Options, Demographics, GPA Options…) | our setup pages (/grading/setup, /admin/*) are flat boxes |
| P3 | **Left rail of blue links** with the current item highlighted (boxed/outlined) | CALPADS Extracts (Enrollment Update, Code Translations…) | our admin/report pages use flat link lists |
| P4 | **Pill/round buttons with icons** for Save/Cancel, and a row of small white icon-buttons as an action bar | Aspen "Save/Cancel", Aeries "Edit / Quick Print / Print Changes / Print" | our buttons are rectangular; no action bar |
| P5 | **Circular status icons inside grids** (green ✓ scheduled, red ✕ conflict) | Classes Schedule period columns | our master schedule uses text/borders only |
| P6 | **Student stepper** — `‹ Name ▾ ›` in a gray bar above student-scoped pages | Classes Schedule | our student pages have no prev/next student |
| P7 | **Grouped multi-band table header** (e.g. "Aeries" spanning, "CALPADS" spanning) with per-row edit-pencil icon buttons | CALPADS Code Translations | our report tables have single header rows |
| P8 | **Filter/checkbox row above the grid**: checkboxes + "Group:" dropdown + a secondary highlighted button; results count with a secondary action ("23 Results" + "Keep Students") | Student Search, Attendance filters | our pages have plain forms, no results-count bar |
| P9 | **Wide red primary button** spanning the search panel | Student Search ("Search"), Attendance ("Search Attendance") | our search buttons are small gray |
| P10 | **Day-column grid**: day headers 0–9 centered, codes centered in cells, a trailing **speech-bubble icon column** for notes, plus a "Fill Periods" dropdown and a "Legend" button in the results bar | Attendance Management | we have day columns and a legend, but no note-icon column and no Fill-Periods control |
| P11 | **Photo/avatar column** at the row start, and a **favorite star** at top-right of the page title | Attendance results, Attendance Management | no avatars (acceptable: we have no photos) — the star is cheap and adds authenticity |
| P12 | **Left sidebar app nav** (icon + label over navy) as an alternative to a top tab strip | Aeries app shell (Pages / Reports / Favorites) | our nav is a top tab strip — keep as is, do **not** restructure to a sidebar; noted for completeness only |

## Per-screen application (our routes → what to change)

1. `/students` (search criteria + results grid) — **P8, P9**: criteria panel gets a checkbox row
   (`Include inactive students`, `Search all schools`, `Fuzzy search`), a "Group:" dropdown
   (stub list: No Group Selected / Homeroom / Grade Level), a wide red **Search** button spanning
   the panel, and a results bar above the grid reading "N record(s)" with a secondary
   highlighted button ("Print roster"). **P3**: a small link rail under the panel
   (Recently viewed · Multi student search · Multi-year search) as plain links to the same page
   with query flags (can be inert anchors marked as such).
2. `/attendance/grid` — **P10**: add a trailing notes icon column per student row (renders an
   inert speech-bubble glyph linking to `/attendance/office?student=<id>`), and a results bar
   with a "Fill periods" dropdown (client-free: a form that pre-fills a code into all visible
   day inputs is *not* allowed without JS — instead render a small note explaining that filling
   is done via `/attendance/office`'s Mass entry) and a **Legend** button toggling a legend
   block. **P1**: wrap the meta strip in a blue collapsible bar.
3. `/attendance/office` — **P1, P6**: filters inside a blue collapsible bar; add the student
   stepper only where a single student is in scope (the mass-entry panel keeps its own form).
4. `/scheduling/master` — **P5, P6**: replace text conflict markers with **circular status
   icons** (green ✓ in-schedule, red ✕ clash) and add the `‹ teacher ▾ ›` stepper bar above the
   grid.
5. `/grading/setup` — **P2, P4**: categories and assignment sections become **accordion rows**;
   Save/Cancel as icon pills.
6. `/grades/transcript` — **P1, P4**: transcript definition-style blue bar with Add/Delete
   actions and a caret; print/actions as an icon button bar; keep the existing print block.
7. `/reports/*` — **P3, P7**: parameter pages get the left link rail (the four reports + saved
   reports) with the current report highlighted, and the summary tables get the grouped header
   band treatment where they compare two systems/sets.
8. `/admin/*` — **P3, P2**: left rail for admin areas (School Year, Codes, Users, Roles) with the
   current area highlighted; long forms as accordions.
9. `/portal/student`, `/grades/gpa` — **P6**: student stepper bar (`‹ name ▾ ›`) linking to the
   previous/next student id in the same school.
10. All list screens — **P8**: a consistent results bar (`N record(s)` + one secondary action)
    directly above each grid.

## Constraints (unchanged from S1b)

- **No client-side JavaScript.** Anything that would need JS (fill-down, accordion toggling,
  caret collapsing) must be implemented as either a plain link/form round-trip, or rendered as
  an inert control with an explanatory line. Prefer the honest inert-control option over faking
  behaviour.
- Server-rendered, dense 11px tables, all data escaped with `<%= %>`.
- Do not restructure the chrome (top tab strip stays). P12 is explicitly out of scope.
- Shared files (`app.css`, `partials/*`, `app.js`) are coordinator-owned: the worker adding the
  CSS utility classes stays inside `public/css/app.css` and the module views it is given.

## Acceptance for V1

At least screens 1, 2, 4 and 10 above (students, attendance grid, master schedule, plus the
results-bar pattern) visibly adopt their reference patterns, with `app.css` carrying reusable
classes for: collapsible blue section bar (`.sis-bar` + `.sis-bar-actions` + `.sis-caret`),
accordion row (`.sis-accordion`), left rail (`.sis-rail`), pill buttons (`.sis-pill`), icon
button bar (`.sis-actionbar`), circular status icons (`.sis-status-ok` / `.sis-status-bad`),
student stepper (`.sis-stepper`), results bar (`.sis-resultsbar`), grouped table header bands
(`.sis-band`), and a red primary button (`.sis-button-primary-danger`). Everything else must
still render and behave exactly as before.
