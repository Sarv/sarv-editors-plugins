# Changelog — Content Filter Worker

---

## v1.1.0

### Bug fixes
- **A banned word hidden in a table, a header, a footer, a footnote or a text box saved unchallenged** — the scan read only the document body's top-level paragraphs, so a word anywhere else was neither highlighted nor blocked, while the editor's own search found it perfectly well. The scan now reads everything the search engine covers: the body with its tables (nested ones included), the headers and footers of every section, every footnote and endnote, the text inside every shape and text box, and a presentation's speaker notes. On a 2.5 MB document that costs 80 ms instead of 53 ms, against 546 ms for a full search of every policy term — so the document is still read the cheap way on every scan.
- **Two neighbouring spreadsheet cells could invent a phrase that was in neither** — cell values were joined with a space, so `top` beside `secret` read as `top secret` and held the save on a document that never contained it. Every region is now joined with a newline, which no phrase can match across.
- **Its scan was broadcast to every document open in the browser** — the channel the result goes out on reaches every tab of the same origin, and nothing in the message said which document it was about, so the Content Filter panel of a text document listed and counted the words found in the presentation open beside it. Every broadcast now carries the document's key, and a request from another document's panel is left to that document's worker.
- **The message promised a highlight that was not always there** — it now says "the words are highlighted" only when the editor actually marked something. A word inside a spreadsheet's text box is named and blocked but cannot be marked (that engine searches cells, not runs), and sending the user to look for a marking that does not exist made the word harder to find, not easier.

### Improvements
- **Reading the document no longer recalculates it** — the scan asked the editor to recalculate after every read, which threw away the very highlight it had just painted and cost a layout pass on a large document every few seconds. The read is now declared for what it is: it changes nothing.

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
