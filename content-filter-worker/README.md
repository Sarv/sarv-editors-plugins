# Content Filter Worker

A **system**, **invisible** (`isVisual: false`) plugin that enforces the organization's
content policy on the open document whether anyone opens a panel or not.

It has no interface. The editor loads it in a hidden iframe alongside every document, and
from then on it:

1. keeps the rule list up to date from the Sarv Drive content-policy endpoint;
2. scans the whole document on a timer — everywhere the editor's own search engine looks, not
   only the body: tables, every section's headers and footers, footnotes and endnotes, the text
   inside shapes and text boxes, and a presentation's speaker notes (see [`API.md`](../content-filter/API.md),
   "What the scan reads");
3. **highlights** every occurrence of every disallowed word, using the editor's own search
   highlight — no change is made to the document, nothing is written to the file and
   co-authors see nothing;
4. **holds the save and the download shut**, with a message naming the words, until they
   are gone — and the message only promises a highlight when the editor could paint one (a word
   inside a spreadsheet's text box cannot be marked, because that engine searches cells, not
   runs, so it is named and blocked without being marked);
5. **broadcasts** what it found, so the [Content Filter](../content-filter) panel can list
   it without scanning the document a second time.

## Why this is a separate plugin from the panel

A plugin variation is either resident and invisible or click-to-open, never both. The
editor runs system plugins at variation 0 with no data (`CPluginsManager.runAllSystem`),
refuses to run a plugin that is already running, and fires `asc_onPluginShow` for any
*visual* variation — so autostarting the panel would pop it open on every document. The
panel's variation 0 is visual, so the resident half needs its own guid.

The two are served side by side from the same origin, which is what lets them share
`content-filter/scripts/policy-core.js` (the rules API, the cache and the scan) and talk
over a `BroadcastChannel`.

## Protocol

All messages carry `channel: "sarv-content-filter"` and `documentKey` — which document the
message is about. A `BroadcastChannel` reaches every tab of the same origin, so without the
key a panel watching a text document would list the words found in the presentation open
beside it; a message about another document is ignored by both halves.

The key is `core.documentKey()`, resolved the same way on both sides: the key the editor
opened the document under when the plugin frame can see the editor's window, otherwise an id
minted inside the editor on its own `Api` object — which both halves reach through
`callCommand` and which lives exactly as long as the open document does.

Worker → panel:

| `type` | payload |
|---|---|
| `scan` | `{ documentKey, editorType, violations, words, blocked, at }` — after every scan |

Panel → worker:

| `type` | meaning |
|---|---|
| `requestScan` | scan now (the panel saw a selection change) |
| `requestState` | resend the last `scan` (a panel just opened mid-session) |
| `rulesChanged` | refetch the rules (the panel's Refresh was pressed) |

Where the browser has no `BroadcastChannel`, or no worker is installed, nothing arrives
and the panel falls back to scanning for itself.

## Editor requirements

Highlighting and blocking use two plugin methods this build of the document server adds,
both **reserved for system plugins** (the editor checks the calling plugin's guid):

| Method | Effect |
|---|---|
| `SetContentPolicyBlock(reason)` | `asc_Save` and `downloadAs` refuse while a reason is set; the reason is shown to the user verbatim. Passing an empty reason lifts it. Autosave is refused silently. |
| `HighlightTerms(words, {matchCase, wholeWords})` | Paints every occurrence of every word with the search highlight. Returns the match count, or `-1` in PDF while the page text is still being extracted. |
| `ClearHighlightTerms()` | Removes the highlight. |

On an editor without them the worker still scans and still broadcasts; it just cannot hold
the save.

## Scope of the block

Client-side blocking is there to tell the user what is wrong while they can still fix it.
It is **not** the security boundary — in a co-authored document changes reach the other
clients before any save happens, and the worker only runs in the browsers that loaded it.
The airtight gate is the drive's own save callback (`callbackUrl`), which must refuse a
version that still contains a disallowed word.

Closing cannot truly be prevented either. A `beforeunload` handler raises the browser's
generic "Leave site?" prompt at best, and from a hidden iframe that never received a click
Chrome ignores it outright.

## Configuration

Everything is shared with the panel, so there is nothing to set up here:

- deployment endpoint and tokens — constants at the top of
  `../content-filter/scripts/policy-core.js`;
- `cacheTtlHours` and `scanIntervalMs` — the panel's Settings window, read back out of
  `localStorage` on every scan cycle, so a change takes effect without a reload
  (`scanIntervalMs: 0` turns the timer off and leaves only `requestScan`).
