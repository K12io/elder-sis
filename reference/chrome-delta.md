# Chrome fidelity delta spec (S1b)

**Source**: 6 captures from the Vera SIS UI reference library, downloaded to
`reference/captures/` (selected from 8,195 assets — scope narrowed to chrome surfaces
only: nav bars, a criteria/results grid, a score-entry grid, and a form-heavy screen).
Reviewed visually 2026-09-30 by the coordinator session.

| File | Vendor / module | What it shows |
|---|---|---|
| 01 | PowerSchool navigation | Dark navy top bar: search field, icon-button cluster, circular user chip; content below in gray bands; column strip `Grade Level / Date of Birth` |
| 02 | Skyward navigation | Deep-purple school bar (school name + dropdown) over a **darker action strip** of small icon+label buttons (Reports, Print Screen, Compress, Dock, New Window); tile launcher below |
| 03 | PowerSchool grading | Score-entry grid: light-blue assignment meta strip; salmon/pink **current-column** header; colored 4px accent bars on standard columns; striped rows; green Save |
| 04 | Aeries student-records | "Search Criteria" **dark-blue header bar, white bold label**; labelled criteria inputs + Search; dense 11px results grid with dark-blue header row, blue underlined ID links, alternating stripes; yellow-outlined secondary button ("Student Not Found") |
| 05 | Focus attendance | Vivid blue bar with logo box + screen title; right cluster of small labelled **selects** (user / school / year / term); tab row (active = gray raised tab, inactive = plain text) |
| 06 | Synergy student-records | Form sections as **blue bars with white text** + collapse grabber on the right; dense labelled selects; classic beveled gray buttons (Activate / Cancel) |

## Observed chrome conventions (what "same UI as the designs" means)

1. **Two-tier header.** A tall-ish branding bar (solid navy `#1b3a5d`–`#27506e` or deep
   purple `#4a3f72`) then either a *darker action strip* of tiny icon+label buttons, or a
   *context row* of small bordered selects (school / year / term / user). Branding text
   is white, 12–13px, semibold; the right side always carries a control cluster.
2. **Panel headers are dark-blue bars with white bold text** (Aeries "Search Criteria",
   Synergy form sections), not light-gray bars.
3. **Tab rows**: active tab is a raised gray/white tab; inactive tabs are plain text
   links. (Focus) — not a fused tab bar with gradient.
4. **Data grids**: 11px, ~2px cell padding, 1px solid borders, header row dark blue on
   white text (Aeries) or light gray on dark text (PSPro), alternating row stripes
   (white / `#eee`), links blue and underlined, numeric columns right-aligned.
5. **Accent/strip devices**: light-blue meta strip above a working grid (PSPro
   `#dbeaf5`); salmon/pink header for the *current* entry column (`#f8d7d5`); 4px colored
   top bars on column headers (blue / orange).
6. **Buttons**: classic beveled gray for primary/secondary (Synergy), plus
   outlined-semantic variants (yellow outline = caution; green = commit/save).
7. **Type**: Arial/Verdana 11px body, 10px uppercase letterspaced for column heads,
   14px page titles. Nothing above 15px except screen titles in the blue bar (~16px).
8. **Density over whitespace**: rows ~22px, forms in 2–4 column label/control grids,
   sections separated by bars rather than padding.

## Deltas to apply to `public/css/app.css` (+ header markup where noted)

| # | Change | Where |
|---|---|---|
| D1 | Header becomes two explicit tiers: solid dark navy branding bar (`#27506e`, white 12px semibold text, 3px darker bottom border) + a second, darker strip (`#1e3d55`) holding the context row (school / year / user) as small bordered selects, and a right-aligned control cluster (search input + 3 icon-buttons + circular user chip with initials) | `app.css`, `partials/header.ejs` |
| D2 | `.sis-box-title` / panel headers switch from light gray to dark blue (`#2b5570`) with white bold 11px text | `app.css` |
| D3 | Tab styling: inactive = plain 11px text on the strip; active = raised light tab (`#f7f8f7`, 1px border, no bottom border) — remove any gradient/fused look | `app.css` |
| D4 | `table.sis-table`: header row dark blue `#2b5570` with white 10px uppercase letterspaced text; 11px body, 2px 6px padding, alternating `#fff` / `#eeeeee`; numeric cells right-aligned (`.num`); links `#14568c` underlined | `app.css` |
| D5 | Add `.sis-metabar` (light blue `#dbeaf5`, 1px border `#9db9cf`, 11px) for assignment/record meta strips; and `.col-current` (salmon `#f8d7d5` header + `#fdf0ef` body) for the active entry column, plus `.col-accent-blue` / `.col-accent-orange` 4px top bars | `app.css` |
| D6 | Buttons: beveled gray base; add `.sis-button-warn` (yellow outline `#e0a800`, background `#fffbe8`) and `.sis-button-go` (green `#3f8f4a` white text) | `app.css` |
| D7 | Page title 14px bold with 1px `#a8b4b8` underline; section separators as 2px `#c2ccce` bars; keep the existing 980px shell and warm-gray body | `app.css` |

## Non-goals / dropped

- Only 6 of 8,195 assets were reviewed (chrome-scope). Per-module fidelity (gradebook
  columns, attendance codes) belongs to those module slices, not S1b.
- Modern-gesture controls in the captures (icon buttons, tile launcher, notification
  badge) are included only where they are *chrome*; the fake SIS stays server-rendered
  with no client-side JS.

## Acceptance for S1b

Boot the app; every page shows the two-tier header with control cluster; grids use the
dark-blue header row + stripes; at least one screen demonstrates `.sis-metabar` and a
`.col-current` column (the grading slice will be the natural home; the CSS must exist and
be documented now). Screenshot or HTML diff as evidence.
