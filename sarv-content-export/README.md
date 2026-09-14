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

The plugin starts *after* the document does, so `onDocumentReady` is too early to send
anything — gate the first `extract` on `ready` having arrived, not on the editor's own
ready event.

## Protocol

All messages carry `channel: "sarv-content-export"`.

Plugin → host:

| `type` | payload |
|---|---|
| `ready` | `{ editor, settings }` — repeated every 1s until acked (60 tries max) |
| `settings` | `{ settings }` — after the user saves in the settings window |
| `result` | `{ requestId, ok, format, escape, content, meta }` — `content` is the whole answer, one message, every style inline |
| `error` | `{ requestId, message }` |

Host → plugin:

| `type` | payload |
|---|---|
| `ack` | stops the beacon |
| `extract` | `{ requestId, format?, markup?, escape?, options? }` — each one overrides the saved setting for this call only |
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
    document.getElementById("output").innerHTML = msg.content;   // self-contained
  }
});

// later
plugin.postMessage({ channel: CHANNEL, type: "extract", requestId: 1 }, "*");
```

A full working host is `../../scripts/editor/html-submit-poc.html`
(`http://localhost:4000/editor/html-submit-poc.html`).

## Markup and escaping

`markup` decides how much of the copy pipeline's output survives; `escape` decides what
shape the string arrives in. They are independent, and both can be overridden per call.

### `markup: "clean"` (default)

`GetFileHTML` is the clipboard producer, so what it returns is Word's own paste payload:
every tag carries the editor's bookkeeping, bold and italic arrive as presentational
`<b>`/`<i>`, and each paragraph repeats the zeroed margins and borders that exist only to
defeat a host stylesheet.

```html
<p style="margin:0;padding:0;font:inherit;color:inherit;text-align:center;margin-top:0pt;
   margin-bottom:0pt;border:none;mso-border-left-alt:none;mso-border-between:none">
  <span style="font-family:'Noto Sans';font-size:14pt;color:#000000;
     mso-style-textfill-fill-color:#000000"><b style="font-weight:bold;">Hi</b></span></p>
```

The clean pass keeps what the document actually says — font, size, colour, alignment,
real paragraph spacing, table geometry and image placement — and drops the rest:

```html
<p style="text-align: center;"><span style="font-family: &quot;Noto Sans&quot;;
   font-size: 14pt; color: rgb(0, 0, 0);"><strong>Hi</strong></span></p>
```

It runs over a parsed document rather than regular expressions, which is what makes it
safe: unwrapping an element that lost its last attribute needs its matching close tag,
the browser's CSS parser discards every `mso-*` declaration for free (they are not real
properties, so they never reach the `CSSStyleDeclaration`), and it expands the shorthands
so one flat allow-list can decide the whole style attribute. On a real document the markup
went from ~12.5 KB to ~3.1 KB; base64 images dominate the total either way.

`markup: "full"` is the escape hatch — the clipboard payload byte for byte, bookkeeping
included, for anything downstream that needs the original.

### Everything emitted is CSS 2.1

Exported content ends up in mail clients, PDF engines and CMS sanitisers that are years
behind a browser, and a declaration they cannot parse is not degraded — the stricter ones
drop the whole style attribute with it. So the clean pass gates both halves:

- **Properties** — a CSS 2.1 allow-list, per element. `text-decoration-line` and
  `border-image-*` (which is what Chrome expands `border: none` into alongside the real
  longhands) are named out.
- **Values** — the values are not ours, they come back out of the browser's CSSOM, which
  re-serialises into syntax CSS 2.1 never had. `rgba()` is flattened to `rgb()` while it is
  opaque and dropped while it is not; `text-decoration: underline solid rgb(0,0,0)` loses
  its CSS3 components; `hsl()`, `calc()`, `var()`, `rem`/`vw`/`vh` units, vendor prefixes
  and CSS3 `display` values are dropped.
- **Shorthands** — the CSSOM only hands back longhands, so a bordered cell arrives as
  twelve declarations saying one thing. Families are folded back into the CSS 2.1
  shorthand when all four sides are present and agree, and left expanded when they are not.

The page box (`frame: true`) is CSS 2.1 too: there is no `box-sizing`, so `width` is the
content width — the page less its two side margins — and the padding is added outside it.

### `escape`

| value | `content` holds |
|---|---|
| `"none"` (default) | the markup as a plain string — what you want if you are about to render it |
| `"json"` | the markup already serialised as a JSON string literal, surrounding quotes included: `"<p style=\"text-align: center;\">Hi</p>"`. Drop it straight into a payload or a text column. |
| `"entities"` | the markup made inert — `&lt;p&gt;` — so it shows as visible source in a `<pre>`, a `<textarea>` or an attribute |

`"json"` is for a host that carries the content rather than renders it. If your own code
will `JSON.stringify` the message, leave this at `"none"` or it is escaped twice. The
`result` message echoes `escape` back, so a host always knows whether it is holding markup
or a payload.

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

So the plugin puts the page context back into the markup itself, and hands over one
self-contained string. There is no stylesheet to place and no class to apply — `content`
is the whole answer.

- **The page box** is one wrapper element carrying inline `width`, `padding`, `background`,
  `font-family` and `font-size` read off the real document:
  `GetFinalSection().GetPageWidth()/GetPageMargin*()` and
  `GetDefaultTextPr().GetFontFamily()/GetFontSize()`.
- **Host defaults are neutralised per element**, not by a descendant selector: every `p`,
  `h1`-`h6`, `ul`, `ol`, `li`, `table`, `blockquote` and `pre` gets `margin:0;padding:0;
  font:inherit;color:inherit` written *ahead* of whatever the copy pipeline already put in
  its `style` attribute, so the document's own values win and the host's cannot reach in.
  A declaration the tag already makes is skipped rather than duplicated.
- **A blank paragraph gets a literal zero-width space** instead of a `::after` rule, because
  a paragraph that is empty in the document comes over as an empty `<p>` with no line box —
  so without it every blank line in the document silently disappears.

Inline styles also beat the host's stylesheet on specificity, which a scoped stylesheet of
our own could not promise.

Three things the serializer gets wrong that the plugin repairs before handing the HTML over:

**Lists.** Every `<li>` wraps its text in a `<p>`, and a `<p>` is a block — so with
`list-style-position: inside` the marker has to take a line box of its own and the text
drops to the next line, leaving every bullet and number orphaned above its item. Every
`<li>` is given `list-style-position: outside` instead, which is also what the document does.
The
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
- The page box ends with a `<div style="clear:both">`, or a picture taller than the text it
  wraps would hang out of the bottom of it.

Measured on a document whose picture spans 0.229–0.770 of the text column, the export puts
it at 0.228–0.771 with the paragraphs back beside it.

What still cannot survive: a numbered list loses its number *format* beyond the CSS
`list-style-type` — a Word `a)` renders as `a.`, because `list-style-type` has no way to
express a suffix.

Set `frame: false` in the settings to get the bare fragment with no page box — it then
renders at whatever width the host element has.

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
injecting `content` — plus a field-by-field reference for every message payload, with a copy
button on every snippet. The
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
| `markup` | `"clean"` | `"clean"` for lean semantic CSS 2.1 HTML, `"full"` for the raw clipboard payload |
| `escape` | `"none"` | `"none"`, `"json"` (a JSON string literal) or `"entities"` (`&lt;p&gt;`) |
| `frame` | `false` | wrap the HTML in the document's own page box |
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

Not any more - but stock 9.4 let them, and the fix lives in the editor, not here.

Nothing in the *editor's* own UI ever offered it:

- It is not in the plugin list (`controller/Plugins.js:892`, `!isSystem`), so there is
  nothing to remove there.
- It is not in **Background plugins** either - `controller/Plugins.js:961` gates that list
  on `pluginVisible`, which a system plugin is not. Even for plugins that do appear there,
  the switcher is built `value: !!model.isSystem, disabled: !!model.isSystem`
  (`:318-319`): on and greyed out.

The **Plugin Manager** was the hole. `pluginMethod_GetInstalledPlugins`
(`sdkjs/common/apiBase_plugins.js`) computes `canRemoved` from a `protectedPlugins` array
that upstream only fills in the **desktop** build, so in a browser it is always empty and
every card - system plugins included - got a **Remove** button, in both the *Available
plugins* and *Marketplace* tabs. Pressing it ran `RemovePlugin` -> `unregister` and wrote
the guid into `asc_plugins_removed` in the editor origin's `localStorage`, which
`checkInstalledPlugins` re-applies on every load. Verified: the button vanished and the
plugin stayed gone across a reload.

Patched in `sdkjs/common/apiBase_plugins.js` (see `UPSTREAM_GUIDE.md` 8a-8), for **every**
system plugin rather than this guid:

1. `canRemoved` is false when `isSystem()` - no Remove button.
2. `RemovePlugin` refuses a system guid outright, since any plugin can call the method.
3. `checkInstalledPlugins` drops a system guid from `asc_plugins_removed` instead of
   honouring it, so a browser that already removed one recovers by itself.
4. `GetInstalledPlugins` also reports `isSystem`, and the store renders a **SYSTEM** tag in
   the button's place - on the card in both tabs and in the detail view - so the card says
   why there is nothing to press instead of just leaving a gap.

Ordinary plugins are untouched and stay removable. The only off switch left is the
integrator's: `editorConfig.plugins.disable` (an array of guids that
`controller/Plugins.js:123-126` forwards to `api.setPluginsDisabled`, after which
`sdkjs/common/plugins.js:965` makes `run()` a no-op), or simply not sending the `plugins`
block for that client.

What the user *does* see is the **Content Export** button in the Plugins tab, always.

## Local development

Served by the repo's dev server on `http://localhost:30300`; nodemon restarts on change.
The plugin is listed in `plugins-index.json` and is gated by `"enabled": true` in its own
`config.json`.
