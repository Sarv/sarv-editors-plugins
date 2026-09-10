# Change Log

## v1.1.0

### Content export
- **`content` is now self-contained - no stylesheet travels with it** — **BREAKING**: the `result` message no longer carries `css` or `scope`. Everything the page context needs is inline in the markup: the page box is one wrapper element with the real width, margins, background and default font on its `style` attribute, and the per-element defaults that used to be descendant selectors are written into each `p`, `h1`-`h6`, `ul`, `ol`, `li`, `table`, `td`, `th`, `blockquote`, `pre`, `img`, `b`, `i` and `a` *ahead* of whatever the copy pipeline already put there, so the document's own values still win. A blank paragraph gets a literal zero-width space instead of a `::after` rule, and the float clearfix is a trailing `<div style="clear:both">`. A host that was doing `<style>${css}</style><div class="${scope}">${content}</div>` becomes `innerHTML = content`. Two fields for one payload was the single most confusing thing about the protocol; inline styles also beat the host's stylesheet on specificity, which a scoped stylesheet of our own could not promise. Measured cost on a 306 KB export: +1.3 KB.
- **`frame` now means "wrap the content in the document's page"** — same setting, same default, same opt-out; `frame: false` still gives the bare fragment, which renders at whatever width the host element has.

### Integration
- **The Integration tab documents every payload field** — a new "What each field holds" table covering `channel`, `requestId`, `ok`, `format`, `content`, `meta`, `message`, `editor` and `settings`: what each one carries, that `content` is the whole document in one message rather than chunks, that `format` follows the Settings tab unless the call overrode it, and that `meta` is informational and not needed to render. Step 5 and its snippet shrink to the one `innerHTML` the new reply needs.

## v1.0.2

### Documentation
- **The Integration tab says when the first `extract` is safe to send** — the plugin starts after the document does, so a host that hangs its first request on `onDocumentReady` finds no plugin to send it to. Step 4 now states the gate outright: wait for `ready`, then enable the button or flush a queued request from that branch. The `ready` row of the message table carries the beacon's cadence and its 60-try limit, which is the reason the gate exists. Same note added to the README's protocol section so the repo doc and the in-editor tab agree.

## v1.0.1

### Bug fixes
- **Copy buttons are visible in the dark theme** — the Integration tab's Copy pills were a translucent white chip carrying inherited text, which on a dark panel meant light text on a light pill and nothing readable. The pill is now an opaque `--background-normal` chip with `--text-normal`, which contrasts against the snippet block in both themes.
- **The whole settings window follows the editor theme** — the editor recolours only a fixed selector list inside a plugin frame, so the tabs, section titles, step numbers, snippet blocks, lead text and the message table kept their hardcoded light colours. They now read the editor's theme tokens, republished as CSS custom properties by the shared `v1/plugin-theme.js`, with the previous light values as fallbacks. Every text-on-background pair in the window clears 4.5:1 in both themes.
- **Native controls follow the theme** — the format radios were drawn light on a dark panel because the browser paints them and ignores CSS tokens; `color-scheme` is now set from the theme type.

## v1.0.0

- Initial release.

### Content export
- **Two output formats** — HTML (`GetFileHTML`, formatting preserved) or Markdown, chosen by the end user in the plugin's settings window and remembered per user.
- **Scoped page stylesheet** — HTML comes back with a `css` string scoped to `.sarv-doc-page`, rebuilt from the real document (`GetFinalSection()` page width and margins, `GetDefaultTextPr()` font family and size). The host wraps the fragment in that class and it renders at the document's true page width instead of inheriting the host page's CSS. Turn it off with the `frame` setting to get the bare fragment.
- **Blank lines survive** — an empty `<p>` gets a zero-width `::after`, otherwise every blank line in the document disappears because an empty paragraph has no line box.
- **List markers stay on their item** — every `<li>` wraps its text in a `<p>`; with `list-style-position: inside` that pushes the text to the next line and orphans the marker. The stylesheet hangs the marker outside, which is what the document does anyway.
- **Table width is restored** — the copy pipeline writes each `<td>` its grid width but never writes the `<table>` its own, so an AutoFit-to-window table (`tblW` pct 5000) shrink-wrapped to a fraction of its real width. The width is read back from the model over `GetAllTables()` and put on the element; if the tag count and the model count disagree nothing is touched.
- **Floating images wrap again** — the serializer emits the same bare `<img>` for an inline picture and an anchored one, so every floating image landed in normal flow and pushed its text underneath. Anchors are read back over `GetAllDrawingObjects()` and turned into floats: square/tight/through become a left or right float with Word's own `distL`/`distR`/`distT`/`distB` as margins and the anchor gap as the outer margin; top-and-bottom becomes `display:block; clear:both`; behind/in-front-of-text stays in flow. The page scope carries a clearfix.
- **Base64 images** — optional `base64img`, so the exported HTML carries its pictures instead of pointing at editor URLs the host cannot fetch.
- **Markdown options** — `htmlheadings`, `demoteheadings` and `renderhtmltags` control how headings and inline markup come across.

### Integration
- **postMessage protocol** — the plugin beacons `ready` to `window.top` until the host acks, then answers `extract`, `getSettings`, `setSettings` and `openSettings` with `result`, `error` or `settings` on the `sarv-content-export` channel. No connector, no polling on the host side.
- **Integration tab in the settings window** — a six-step copy-paste guide: the `editorConfig.plugins` block (filled in at runtime with this deployment's real config URL and the plugin's guid), the `<div id="output">`, the listener, the request and the injection, plus a table of every message in both directions. Each snippet has a Copy button.
- **Per-client loading** — the plugin loads from `editorConfig.plugins.pluginsData` + `autostart`, so one build serves clients who need it and clients who do not from the same code; the decision lives in the integrator's `/getConfig`.

### Packaging
- **System plugin, not visual** — `isSystem: true`, `isVisual: false`, so it starts automatically, stays out of the plugin list, and cannot be switched off from the Background plugins panel. Only the integrator can disable it, via `editorConfig.plugins.disable`.
- **Word only** — `EditorsSupport: ["word"]`; `GetFileHTML` and the document API this relies on have no spreadsheet or presentation equivalent.
- **Not user-removable** — needed a fix in the editor itself: the Plugin Manager computed the Remove button from a list only the desktop build populated, so in the browser every system plugin got one. See `UPSTREAM_GUIDE.md` section 8a-8 in `sarv-editors`.
