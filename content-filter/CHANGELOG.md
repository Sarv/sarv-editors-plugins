# Changelog — Content Filter Plugin

---

## v1.1.0

### New features
- **Tab-based UI** — panel now shows four tabs: Violations, Disallowed, Allowed, and Removed history.
- **Removed history tab** — every word removed (auto or manual) is logged with word, category, timestamp, and source (`auto` / `manual`). History persists in localStorage (max 500 entries) and can be cleared from the tab.
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
