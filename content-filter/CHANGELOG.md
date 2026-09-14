# Changelog — Content Filter Plugin

---

## v1.5.0

### Bug fixes
- **A banned word hidden in a table, a header, a footer, a footnote or a text box was reported by nobody** — the shared core read only the document body's top-level paragraphs, so the panel, like the worker, listed nothing for a word anywhere else. It now reads everything the editor's own search engine covers: the body with its tables (nested ones included), the headers and footers of every section, every footnote and endnote, the text inside every shape and text box, and a presentation's speaker notes. A word found in any of those is listed with its snippet and removed by **Remove** like any other, because the editor's search-and-replace reaches all of them.
- **Two neighbouring spreadsheet cells could invent a phrase that was in neither** — cell values were joined with a space, so `top` beside `secret` read as `top secret`. Every region is now joined with a newline, which no phrase can match across.
- **The panel listed words that were in a different document** — the worker broadcasts what it finds on a `BroadcastChannel`, which carries to every tab of the same origin, and the panel believed every result that arrived. With a presentation open beside a text document, the document's panel showed the presentation's words, counted them in its badge and offered to remove them, and the count flickered between the two documents' as each worker reported in. Every message is now stamped with the document it is about — the key the editor opened the document under, or an id minted inside the editor when the plugin frame cannot see it — and a result about another document is ignored.
- **The removal history was shared by every document of a kind** — it was scoped by a title read through `GetDocumentInfo`, which is not an editor method, so every text document filed its history under the same `word:default`. It is scoped by the document key above instead.

### Improvements
- **One row per word, not one per occurrence** — a word used four times filled the list with four identical rows, each with its own **Remove** button that took out all four anyway. Each word now has one row, with the number of times it appears beside it (`EBITDA (2)`), and the badge, the warning bar and the summary count words, the summary naming the occurrence total alongside.
- **A spreadsheet's text boxes are listed as report-only** — their text is now scanned, but the spreadsheet's search engine walks cells rather than runs and can neither mark nor replace a word inside a shape, so such a word is listed the way a pdf's is: named, no snippet, no **Remove** button, and skipped by **Remove all** and the auto-remove countdown. The save is still held while it is there.
- **One collector instead of three** — the three per-editor readers in the core were one function each with their own copy of "read a document content"; they are now one collector that dispatches on the editor type through `Asc.scope`, so the helpers that read a content, a shape or a table exist once.
- **Reading the document no longer recalculates it** — the read asked the editor to recalculate afterwards, which discarded the worker's highlight and cost a layout pass on a large document every few seconds.

---

## v1.4.0

### Improvements
- **The toolbar button is a plain button again** — the plugin declared three visual variations (the panel, a Settings window and an About window), and the plugin bar renders anything with more than one as a *split* button: two halves in one frame, each taking the hover on its own, with the icon packed against its label instead of spaced like a plain button's. Beside ten plain plugin buttons it read as a defect — the icon looked stuck to the caption, and hovering lit up half a button. The plugin now declares one variation, so its button is a single button with one hover region and the same icon spacing as every other plugin's.
- **Settings and About moved into the panel** — reached from the gear and the (i) in the panel's status bar, beside Refresh, as views alongside the four tabs. Settings writes through the shared core's config writer and the panel restarts its scan loop as soon as you press **Save**, so a new scan interval takes effect at once instead of at the next reload; **Clear Cache** now also updates the status bar, which reads the same cache it just dropped. `index_setting.html` and `index_about.html` are gone, and `scripts/settings.js` is a view module the panel drives rather than a page with a plugin lifecycle of its own.

### Notes
- Nothing about the scanning, the rules API or the save block changed in this release.

---

## v1.3.0

### New features
- **The policy is enforced whether the panel is open or not** — a companion system plugin, **Content Filter Worker**, now runs with every document. It scans on the same interval, highlights every disallowed word in the document itself, and holds the save and the download shut with a message naming the words until they are gone. Nothing is written to the file to do it: the highlight uses the editor's search highlight, so no change is made, nothing is saved and co-authors see nothing.
- **PDF documents are covered too** — the pdf editor hands a plugin neither its page text nor a way to change it, so a disallowed word there is found through the editor's own search instead: it is highlighted and the save is held shut exactly as elsewhere. The panel lists such a word as report-only — named and highlighted, with no snippet and no **Remove** button, because the fix belongs in the source file — and **Remove all** and the auto-remove countdown skip it rather than reporting a removal that did not happen.
- **The panel shows the worker's scan** — when a worker is broadcasting, the panel displays what the worker found instead of scanning the document a second time, and asks the worker to rescan on a selection change. With no worker installed nothing arrives and the panel scans for itself exactly as before, so it still works on its own.

### Bug fixes
- **Presentations scanned as if they were empty** — the slide collector walked `ApiSlide.GetObjectsCount()`/`GetObject()`, neither of which exists, so every scan of a .pptx read 0 characters and reported nothing. It now reads `slide.GetAllDrawings()`, which covers shapes, images, charts, tables (cell by cell) and groups (recursively). Only the slides are read — the presentation's own `GetAllShapes()` would drag in every layout and master, whose placeholder boilerplate is not the user's text and cannot be removed by them.

### Improvements
- **The endpoint and the tokens can be passed from the editor config** — `editorConfig.plugins.options.all.contentPolicy` now sets the policy service's URL, session and bearer tokens, active account and organization for both the panel and the worker, so pointing a deployment at its own service, or rotating a token, no longer means editing and republishing the plugin. Anything left unset keeps the built-in value, a guid-specific block can override the shared one, and `setPluginsOptions` mid-session makes the worker refetch the rule list instead of waiting for its cache to expire. See `API.md`, “Configuring the endpoint”.
- **The endpoint, the cache and the scan moved into a shared core** (`scripts/policy-core.js`) — the panel and the worker load the same file, so the rules API, the deployment tokens, the storage keys, the incremental-sync logic, the document collectors and the scan itself exist in one place and cannot drift apart. Roughly 200 lines of the panel script are now that shared file.
- **Sync is one code path instead of three** — `doFullSync`, `doIncrementalSync` and the cache freshness check collapsed into the core's `syncRules`, which decides for itself whether to ask for everything or only for what changed. Refresh now also tells the worker to refetch.
- **The scan's own timeout replaced the panel's safety timer** — reading the document answers empty rather than hanging, so the 10-second flag-reset that used to guard `callCommand` is no longer needed.

### Notes
- Blocking the save needs the editor-side methods this build of the document server provides (`SetContentPolicyBlock`, `HighlightTerms`), and they are reserved for system plugins. On an editor without them the worker still scans and still reports, but cannot hold the save.
- The drive's half of the enforcement is now specified in `API.md` (“Server-side enforcement”), with a reference implementation in the `scripts` sibling repo (`contentPolicyGuard.js`, wired into `server-local.js`): convert the finished version to text through the document server, match the policy words as case-insensitive substrings, and answer the save callback with a non-zero `error` — storing nothing — when any are present.
- The block is there to tell the user what is wrong while they can still fix it; it is not the security boundary. In a co-authored document changes reach other clients before any save, so the drive's own save callback is what finally refuses a version that still contains a disallowed word.

---

## v1.2.1

### Bug fixes
- **Panel is legible in the dark theme** — the editor only recolours a fixed list of selectors inside a plugin frame (`body`, `.form-control`, `.btn-text-default`, links, scrollbars), so everything this plugin styles itself kept its hardcoded light values: white violation/rule/history cards, light-grey category chips, and a tab badge that all but vanished. Every neutral colour now comes from the editor's own theme tokens, republished as CSS custom properties by the shared `v1/plugin-theme.js`.
- **Status colours have a dark variant** — the red, green, amber and blue tints behind the warning bar, result summary, countdown banner, Remove buttons and history source badges were washed out to unreadable on a dark panel (the badge measured 1.3:1). Each is now a `--cf-*` pair redefined under `data-theme-type="dark"`; every text-on-background pair in the panel clears 4.5:1 in both themes.
- **Native controls follow the theme** — checkboxes, radios and scrollbars are painted by the browser and ignore CSS tokens entirely, so they stayed light on a dark panel. `color-scheme` is now set from the theme type.
- **Amber warning text darkened in the light theme** — `#E65100` on its light amber tint was only 3.46:1, so it moved to `#C24400` (4.65:1). This is the one visible change to the light theme; it is near-imperceptible in practice.

### Improvements
- **Theme handling moved out of the plugin** — the per-file `onThemeChanged` overrides in `scripts/script.js`, `scripts/settings.js` and `index_about.html` (which repainted a few card backgrounds inline) are gone. The shared helper owns the callback and still chains `onThemeChangedBase`, so the editor's own recolouring keeps working.

---

## v1.2.0

### Bug fixes
- **Cell/Slide scan now covers the full document** — scanning in spreadsheets and presentations no longer requires selecting cells or pressing Ctrl+A first. The full document scan iterates all sheets and all slide shapes via the editor API, exactly like the Word scan does.
- **Remove/Remove All now works in spreadsheets and presentations** — uses `executeMethod("SearchAndReplace")` for cell and slide editors; `callCommand` + `Api.GetDocument().SearchAndReplace` continues to be used for Word/PDF.
- **Auto-remove countdown no longer resets on every cursor move** — `initOnSelectionChanged` fires on every cursor movement, which was calling `stopCountdown()` on each scan update and restarting the timer from the full delay. The countdown now only resets when violations are cleared to zero; it continues uninterrupted through subsequent scans.

### Improvements
- **Removal history scoped per document and editor type** — history is no longer a single global list shared across all files and editor types. Each entry carries a `docId` (`<editorType>:<filename>`), resolved on plugin open via `GetDocumentInfo`. The Removed tab shows only the current file's history; clearing history removes only the current file's entries.
- **History cap changed to 50 per document** (was 500 total) — prevents any single document from polluting localStorage. A hard total cap of 500 entries across all documents is enforced as a safety limit.
- **Scan interval fallback applies to all editor types** — previously the periodic re-scan interval was only active in Word. It now runs in spreadsheet and presentation editors too.

---

## v1.1.0

### New features
- **Tab-based UI** — panel now shows four tabs: Violations, Disallowed, Allowed, and Removed history.
- **Removed history tab** — every word removed (auto or manual) is logged with word, category, timestamp, and source (`auto` / `manual`). History persists in localStorage and can be cleared from the tab.
- **Fully automatic scanning** — no manual scan button required. Scanning is event-driven via `initOnSelectionChanged` on every cursor/selection change, with a 3-second interval fallback for Word to catch edits where the cursor doesn't move.
- **Persistent violation warning bar** — a red banner is shown at the top of the panel whenever violations exist, with a "Remove All" button.
- **Violation badge on tab** — the Violations tab shows a red count badge when disallowed content is found.
- **Search/filter** — Disallowed and Allowed tabs include a live search input to filter rules by text or category.
- **`beforeunload` warning** — browser close or reload is interrupted with a warning message if the document contains unresolved violations.
- **Incremental sync** — plugin stores the highest `updatedAt` date seen across all fetched records. On every subsequent load, only records newer than that date are fetched (`?since=…`), then merged into the existing cache.
- **Scan indicator** — a pulsing dot is shown on the Violations tab while a document scan is in progress.

### Breaking changes
- **API params are now fixed** — `size=2000`, `skip=…`, `since=…` (incremental), `userId=…` (from editor session). These are no longer configurable in Settings.
- **No API key** — the plugin no longer sends an `Authorization` header. API security is enforced by IP allowlisting on the server side.
- **Field names are fixed** — the plugin always reads `text`, `type`, `category`, `updatedAt` from API responses. Field mapping settings have been removed.
- **Settings simplified** — only 4 settings remain: API URL, Auto-Remove Delay, Scan Interval, Cache Duration.

---

## v1.0.0

- Initial release.
- Paginated API fetch: re-fetches until response size < page size (default 2000).
- localStorage cache with configurable TTL (default 24 hours).
- Configurable field mapping for any API response structure.
- Scan Selection and Scan Document (full text via document API in Word).
- Allowed content whitelist overrides disallowed rules.
- Light/dark theme support.
