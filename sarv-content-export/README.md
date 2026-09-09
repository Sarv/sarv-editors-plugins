# Sarv Content Export

A **system**, **invisible** (`isVisual: false`) plugin that hands the open document's
content to the *host page* — the integrator's own page that embeds the editor — as
**HTML** or **Markdown**.

It has no panel. The editor loads it in the background, it announces itself to the host
page, and from then on the host asks for content whenever it wants (a Submit button, a
Preview button, an autosave hook — whatever the host does).

## Why postMessage and not the documented connector

The documented integrator↔plugin channel (`docEditor.createConnector()` /
`onExternalPluginMessage`) is gated on the `advancedApi` license flag, which this build
defaults to `false` (`src/server/Common/sources/license.js`), and inbound messages are
dropped in `src/sdkjs/common/editorscommon.js`. `createConnector` is not present in this
build's `api.js` at all.

The plugin iframe is created with no `sandbox` attribute and appended to the editor's own
`document.body` (`src/sdkjs/common/plugins.js`), so from inside the plugin `window.top` is
the host page. That is the channel used here — no license flag, no fork patch.

Because the host cannot address the plugin first (it has no handle on the hidden iframe),
the plugin **beacons** `ready` upward once a second until the host acks, then the host
replies through the latched `event.source`.

## Protocol

All messages carry `channel: "sarv-content-export"`.

Plugin → host:

| `type` | payload |
|---|---|
| `ready` | `{ editor, settings }` — repeated every 1s until acked (60 tries max) |
| `settings` | `{ settings }` — after the user saves in the settings window |
| `result` | `{ requestId, format, content, css, scope, meta }` |
| `error` | `{ requestId, message }` |

Host → plugin:

| `type` | payload |
|---|---|
| `ack` | stops the beacon |
| `extract` | `{ requestId, format?, options? }` — `format` overrides the saved setting for this call only |
| `getSettings` / `setSettings` | read / write the saved settings |
| `openSettings` | opens the settings window inside the editor |

Minimal host side:

```js
const CHANNEL = "sarv-content-export";
let plugin = null;

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.channel !== CHANNEL) return;
  if (msg.type === "ready") {
    plugin = event.source;
    plugin.postMessage({ channel: CHANNEL, type: "ack" }, "*");
  }
  if (msg.type === "result") {
    document.getElementById("output").innerHTML =
      `<style>${msg.css}</style><div class="${msg.scope}">${msg.content}</div>`;
  }
});

// later
plugin.postMessage({ channel: CHANNEL, type: "extract", requestId: 1 }, "*");
```

A full working host is `../../scripts/editor/html-submit-poc.html`
(`http://localhost:4000/editor/html-submit-poc.html`).

## Where the content comes from

- **HTML** — `GetFileHTML`, which runs the document through the *clipboard* pipeline
  (`Api.ContentToHTML` → `asc_CheckCopy(text_data, 2)`). That is the highest-fidelity
  source available: inline `font-family` / `font-size` / `color`, `<b>` / `<i>`,
  `text-align`, tables and base64 images all survive. Falls back to
  `ConvertDocument("html", …)` if it comes back empty.

  Two things are repaired on the way out:

  - **Font sizes.** `ContentToHTML` installs a `CDocumentReaderMode` before copying, and
    reader mode deliberately *damps* every size towards the reading default instead of
    reporting it — `em = (1 + pt/12) / 2` (`wordcopypaste.js`, `CorrectFontSize`). So 10pt
    arrives as `0.91em` and a 20pt heading as `1.33em`: the document's size contrast is
    halved. The plugin inverts it (`pt = 12 * (2·em − 1)`, snapped to 0.5pt) and emits real
    points. This alone is most of the "formatting is not preserved" complaint.
  - **The `docData` class.** The first element carries the editor's binary clipboard
    round-trip payload in `class="docData;DOCY;…"` — several KB of base64 that means
    nothing outside the editor. It is stripped.
- **Markdown** — `ConvertDocument("markdown", …)` (`CMarkdownConverter`).

### Formatting fidelity

`GetFileHTML` returns a *fragment*, not a page. The character formatting is inline and
survives, but the **page context** does not — page width, margins and the document's
default font are lost, and the host page's own CSS bleeds into the fragment. That is why
the stock HTML plugin's output "loses formatting".

So alongside the content the plugin ships a scoped stylesheet (`css`, applying to
`scope` = `.sarv-doc-page`) built from the real document:
`GetFinalSection().GetPageWidth()/GetPageMargin*()` and
`GetDefaultTextPr().GetFontFamily()/GetFontSize()`. It sets the true page width and
margins, the default font, a white page ground, and neutralises the host's `p`/`h1`-`h6`/
`ul`/`ol`/`table` defaults. It also gives a blank `<p>` a zero-width `::after`, because a
paragraph that is empty in the document comes over as an empty `<p>` with no line box —
so without it every blank line in the document silently disappears. Wrap the content in
`<div class="sarv-doc-page">` and it looks like the page.

Three things the serializer gets wrong that the plugin repairs before handing the HTML over:

**Lists.** Every `<li>` wraps its text in a `<p>`, and a `<p>` is a block — so with
`list-style-position: inside` the marker has to take a line box of its own and the text
drops to the next line, leaving every bullet and number orphaned above its item. The
stylesheet hangs the marker outside instead, which is also what the document does. The
indent itself arrives as an inline `padding-left` on the `<ul>`/`<ol>`, so it is left alone.

**Table width.** The copy pipeline writes every `<td>` its grid width but never writes the
`<table>` its own width (`wordcopypaste.js`, `CopyTable`/`CopyCell`), so a table the
document sizes as a percentage of the text column — which is what Word's default "AutoFit
to window" produces, `tblW` pct 5000 — arrives as a bare `<table>` and the browser
shrink-wraps it to the sum of its grid, often a third of its real width. The width is still
in the model, so the plugin reads it back with a `callCommand` over `GetAllTables()` and
puts it on the element. `GetAllTables` walks the document in the same order the tags appear
(each table, then its nested tables, depth first), so index *i* matches the *i*-th
`<table>`; if the two counts disagree nothing is changed.

**Image wrapping.** `CopyParaItem`'s `para_Drawing` branch emits nothing but
`<img style="max-width:100%" width height src>` — identical for a picture sitting in the
text and for one anchored beside it. Every floating image therefore lands in normal flow
and pushes the text that used to sit next to it underneath, which is the single most
visible difference between the export and the page. The anchor is in the model, so the
plugin reads it back over the same `callCommand` (`GetAllDrawingObjects()` → each
`ParaDrawing`'s `wrappingType`, `PositionH`, `Distance` and computed `X`) and turns it into
a float:

- *Square / tight / through* become a `float`. Word wraps on **both** sides, which no float
  can do, so the side that matters is the one the text actually lands on: lines fill from
  the left, so text takes the left gap whenever that gap is wide enough to hold a word, and
  the picture reads as a right float. Only a picture against the left margin, with no usable
  room beside it, becomes a left float.
- The **outer** margin is set to the gap the anchor left against that edge of the text
  column, so the picture keeps its place in the column instead of snapping to the margin.
  The inner margin, and top/bottom, come from Word's own `distL`/`distR`/`distT`/`distB`.
- *Top and bottom* becomes `display:block; clear:both`. *Behind / in front of text* has no
  wrapping to express, so it is left in flow.
- The page scope gets a `::after` clearfix, or a picture taller than the text it wraps
  would hang out of the bottom of the page box.

Measured on a document whose picture spans 0.229–0.770 of the text column, the export puts
it at 0.228–0.771 with the paragraphs back beside it.

What still cannot survive: a numbered list loses its number *format* beyond the CSS
`list-style-type` — a Word `a)` renders as `a.`, because `list-style-type` has no way to
express a suffix.

Set `frame: false` in the settings to get the bare fragment with no stylesheet.

## Settings

Two ways in, both opening the same `Asc.PluginWindow` (`settings.html`):

- **Inside the editor** — a **Content Export** button in the editor's own **Plugins** tab.
  An `isVisual:false` plugin has no panel and so no entry in the plugin list, so the button
  is registered at init with `AddToolbarMenuItem` using tab id `plugins`, which lands it in
  the existing Plugins tab rather than creating one of its own. Clicks come back as the
  `onToolbarMenuClick` event, which the variation has to declare in `config.json`'s
  `"events"` or the editor never delivers it.
- **From the host page** — post `{type: "openSettings"}` on the channel.

The window is editor-drawn: it carries the standard plugin-window header and a **Save /
Cancel** footer, exactly like any other plugin window. Because the footer belongs to the
editor, Save arrives at the *worker* as `Asc.plugin.button(0, windowId)`, not in the
settings frame - the worker answers by asking the window for its values
(`command("collectSettings")`), and the window replies with `sendToPlugin("onSettingsSaved", …)`.

Closing that window needs care. The editor does not close a plugin modal itself: the X
arrives at `Asc.plugin.button` as id `-1` plus the id of the window it came from, and the
plugin is expected to close it. The stock handler (`executeCommand("close")`) closes the
whole **plugin**, and every plugin close runs `LayoutManager.clearCustomControls(guid)` —
which removes the Plugins-tab button — and would also tear down the host postMessage
channel this background worker exists for. So the handler here closes only the window it
was given and never closes the plugin.

The window has two tabs. **Settings** holds the values below; **Integration** is a static
step-by-step guide for whoever embeds the editor - the `editorConfig.plugins` block, the
target `<div>`, latching `event.source` from the `ready` beacon, asking for `extract`, and
injecting `content` / `css` / `scope` - with a copy button on every snippet. The
`editorConfig.plugins` snippet is filled in at runtime rather than written out: `config.json`
sits beside `settings.html`, so `new URL("config.json", location.href)` is this deployment's
real plugin URL, and the guid comes from `Asc.plugin.guid`. Dev, staging and production each
show their own, and the block is a straight paste with nothing to substitute. The tab holds
no state, so Save behaves the same whichever tab is showing.

Copy uses a hidden textarea and `execCommand`, not `navigator.clipboard`: the editor builds
the plugin iframe without `allow="clipboard-write"`, so the async clipboard API is present
but permission-denied there. If even `execCommand` is refused the snippet is selected
instead and the button says so.

Stored in the plugin origin's `localStorage` under `sarv-content-export.settings`.

| key | default | meaning |
|---|---|---|
| `format` | `"html"` | `"html"` or `"markdown"` |
| `frame` | `true` | ship the page-geometry stylesheet with the HTML |
| `base64img` | `true` | embed images as data URIs |
| `htmlHeadings` | `false` | Markdown: emit `<h1>` tags instead of `#` |
| `demoteHeadings` | `false` | Markdown: shift every heading down one level |
| `renderHTMLTags` | `false` | keep raw HTML found in the document |

## Word only

`EditorsSupport` is `["word"]`, so `PluginsManager.checkEditorSupport` (`sdkjs/common/plugins.js`)
refuses to run it in the spreadsheet, presentation or PDF editors. The extraction path it
uses (`GetFileHTML` -> `Api.ContentToHTML`) is a word-processor API anyway.

## Why it isn't an entry in the plugin list

It cannot be one. Two independent one-liners in the editor rule it out:

- `common/main/lib/controller/Plugins.js:892` - `visible = … && !isSystem`. A system plugin
  is never listed.
- `sdkjs/common/plugins.js` `run()` - one guid can have exactly one running instance with
  one current variation, and for a system or background plugin `run()` on an
  already-running plugin returns `false`. So a second, visual variation could never be
  opened from a list entry while the worker is resident.

And the worker has to be resident: `show()` sends `asc_onPluginShow` for any variation
whose `get_Visual()` is true, so a visual variation would pop its window open the moment
autostart fires. A plugin is therefore either a resident invisible worker or a
click-to-open panel - not both. This one is the former, and the injected Plugins-tab
button plus an `Asc.PluginWindow` is the supported way to give it a UI.

## Loading it

The editor only loads it when the integrator's config says so:

```js
editorConfig.plugins = {
  pluginsData: ["http://localhost:30300/sarv-content-export/config.json"],
  autostart:   ["asc.{7B2C9E14-5D63-4A81-9F0E-2C6A8D3B4F52}"],
}
```

`autostart` runs **variation 0**, which is why this plugin has exactly one variation.

In the local harness that decision lives in `scripts/server-local.js` (`CONTENT_EXPORT`):
per-client, keyed on `?clientId=`, with `?contentExport=0|1` to force it either way for a
single load. One codebase, two clients, one config endpoint: the client that should have
the export gets the `plugins` block, the other gets a config with no mention of it and an
editor that never fetches the plugin at all.

### Can the end user turn it off?

No, and that is deliberate for a system plugin:

- It is not in the plugin list (`controller/Plugins.js:892`, `!isSystem`), so there is
  nothing to remove there.
- It is not in **Background plugins** either - `controller/Plugins.js:961` gates that list
  on `pluginVisible`, which a system plugin is not. Even for plugins that do appear there,
  the switcher is built `value: !!model.isSystem, disabled: !!model.isSystem`
  (`:318-319`): on and greyed out.
- The only off switch is the integrator's. `editorConfig.plugins.disable` is an array of
  guids that `controller/Plugins.js:123-126` forwards to `api.setPluginsDisabled`, and
  `sdkjs/common/plugins.js:965` makes `run()` a no-op for anything in it. Or simply do not
  send the `plugins` block for that client.

What the user *does* see is the **Content Export** button in the Plugins tab, always.

## Local development

Served by the repo's dev server on `http://localhost:30300`; nodemon restarts on change.
The plugin is listed in `plugins-index.json` and is gated by `"enabled": true` in its own
`config.json`.
