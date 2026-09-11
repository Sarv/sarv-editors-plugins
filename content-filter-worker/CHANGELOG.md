# Changelog — Content Filter Worker

---

## v1.0.0

### New features
- **First release.** A system plugin: the editor starts it with every document and never shows it. It keeps the organization's content rules up to date, scans the whole document on a timer, and whenever a disallowed word is present it highlights every occurrence, holds the save and the download shut with a message naming the words, and broadcasts what it found so the **Content Filter** panel can list it without scanning again.
- **The highlight makes no change to the document** — it is the editor's own search highlight, painted over the matches. Nothing is written, nothing is saved and co-authors see nothing.
- **Reads a pdf through the editor's search** — the pdf editor exposes annotations, widgets and a selection to a plugin, but never the page text, so a scan there collects nothing. When the collected text is empty the worker asks the editor which of the policy words the document holds (`HighlightTerms` answers `matched`), which highlights them in the same call — so a pdf is blocked and highlighted like every other format, without the worker ever reading the file.
- **Takes its endpoint from the editor config** — the policy service's URL and tokens come from `editorConfig.plugins.options.all.contentPolicy` when the integrator passes them, falling back to the shared core's built-in constants otherwise. A change to those options mid-session (`setPluginsOptions`) makes the worker refetch the rule list rather than wait for its cache to expire.
- **Shares its scan with the panel** — the rules API, the cache and the scan all come from `content-filter/scripts/policy-core.js`, the same file the panel loads, so the two halves cannot disagree about what the rules are or what the document contains.

### Notes
- Requires a document server that provides the system-plugin methods `SetContentPolicyBlock` and `HighlightTerms`. Without them the worker still scans and still broadcasts, but cannot hold the save.
- Client-side blocking exists to tell the user what is wrong while they can still fix it. It is not the security boundary: in a co-authored document changes reach other clients before any save, so the drive's own save callback is what finally refuses a version.
- No interface, and it is hidden from the plugin manager — system plugins are not listed there. The **Content Filter** panel is where a reviewer sees what was found.

---
