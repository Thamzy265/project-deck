# Database tab: facts and differences from the plan

Batch 4 of [the M3 design](../design/m3-drift-inspector.md) (`feat/database-tab`): the dashboard's Database tab ([UI spec](../ui/m3-database-tab.md)) and the daemon routes it needs. Checked on 17 Oct 2026 against @codemirror/view 6.43.13, @codemirror/lang-sql 6.10.0, style-mod 4.1.4 and Chromium from Playwright 1.64.

## Facts checked

- **CodeMirror's styles and the CSP.** The design note expected CodeMirror to work under `default-src 'self'` because it uses constructable style sheets. It does so only in a shadow root: style-mod puts its rules in a `<style>` element when the editor's root is the document (which has a `head`), and the CSP blocks that element. Without its styles `.cm-content` loses `white-space: break-spaces`, so Chromium types no-break spaces (U+00A0) and SQLite reads `DELETE FROM orders` as one token. The SQL editor therefore mounts in an open shadow root (`EditorView({ root })`), where style-mod uses a constructed sheet. A Playwright test checks that no CSP violation happens.
- **Shadow root consequences.** Ids don't cross the shadow boundary, so the editor is named with `aria-label="SQL"` (the same text as its visible label). Key events from inside report the host as their target, so the `r` / `R` shortcuts now read `composedPath()[0]` to tell that focus is in a text field.
- **Same-origin GETs carry no `Origin` header** in Chromium. `GET /api/db/queries` takes the dashboard cookie alone (the API middleware still refuses a foreign Origin); `PUT` still needs the exact Origin, like the edit routes.

## Differences from the plan, the design note and the UI spec

1. **Saved queries live in `.flutterdeck/queries.json`** (design note, Data), not in browser storage: `GET` and `PUT /api/db/queries`, dashboard cookie only, written through a fresh file and a rename so a link planted by a cloned repo is never followed.
2. **The choose-device picker** (`POST /api/db/device`, dashboard only): the `choose-device` answer now lists the devices (adb serials, or simulator names and UDIDs). A pick that is no longer listed is ignored, and the user is asked again. Its copy ("Device", "Use this device") is not in the UI spec.
3. **Refusals carry the gate's code** as `detail` on `{error, code}`, so the dashboard can say "it deletes rows", "it adds a database" and so on. For Claude (token callers), a hidden-column refusal of a statement that names a view adds that the view is refused whole (QA G1).
4. **Fake mode runs real SQL.** `FakeLiveDatabase` (`@project-deck/db-sqlite/testing`) keeps a SQLite database in memory and reads it through the snapshot engine. The fake app has `customers`, `orders` (with a foreign key) and an `audit_log` written by a trigger, so QA can see the trigger refusal (QA G2).
5. **Query exports** are the query's own result, at most 1,000 rows: `POST /api/db/query` takes at most 1,000 rows from the dashboard, below the design's 5,000 export cap. Table exports page through the current filter and sort, 1,000 rows per call, up to 100,000 rows or 50 MB.
6. **Editing needs a primary key.** Rows of tables without one (matched by row id) and rows whose key is a blob can't be edited; Edit and Delete row are disabled (Edit says why in its tooltip).
7. **The table page query** is `LIMIT ? OFFSET ?` in the chosen sort with the key as tie-break, not keyset paging: sorting by any column then works the same way.
