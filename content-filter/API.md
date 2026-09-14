# Content Filter Plugin — API Reference

---

## Endpoint

```
POST https://dev-console.sarv.com/drive-api/v1/external/get-content-policy
```

---

## Request

### Headers

| Header | Value | Notes |
|---|---|---|
| `Content-Type` | `application/json` | Fixed |
| `Session-Token` | `<token>` | Deploy-time constant in `script.js` |
| `active-account` | `0` | Deploy-time constant in `script.js` |
| `Authorization` | `Bearer <token>` | Deploy-time constant in `script.js` |

### Body

```json
{
    "organization_id": "",
    "since": "2024-11-15T08:30:00.000Z",
    "userId": "alice@example.com"
}
```

| Field | Required | Description |
|---|---|---|
| `organization_id` | No | Leave empty to infer org from Session-Token. Set if multi-tenant. |
| `since` | No | ISO-8601 date. Only present on incremental sync — returns records updated after this date. Omitted on full sync. |
| `userId` | No | ID of the user who opened the editor (`window.Asc.plugin.info.userId`). Passed so the server can apply user-specific policies if needed. |

---

## Response

### Accepted response shapes

The plugin accepts any of the following — no server-side changes needed to match a specific wrapper:

```json
{ "data": [ … ] }
```
```json
{ "policies": [ … ] }
```
```json
{ "rules": [ … ] }
```
```json
[ … ]
```

### Record fields

| Field | Accepted names | Required | Description |
|---|---|---|---|
| Word / phrase | `text`, `word`, `phrase`, `term` | **Yes** | The string to match in the document. Case-insensitive. |
| Type | `type`, `policy_type` | **Yes** | `"disallowed"` → flagged as violation. `"allowed"` → whitelist (overrides disallowed). Anything else treated as `"disallowed"`. |
| Category | `category`, `group` | No | Label shown on each violation card (`"compliance"`, `"legal"`, etc.). |
| Last modified | `updatedAt`, `updated_at`, `modifiedAt` | Recommended | ISO-8601 timestamp. Required for incremental sync to work correctly. |

**Example response:**

```json
{
    "data": [
        { "text": "confidential",    "type": "disallowed", "category": "compliance", "updatedAt": "2024-11-10T09:00:00.000Z" },
        { "text": "top secret",      "type": "disallowed", "category": "security",   "updatedAt": "2024-11-10T09:00:00.000Z" },
        { "text": "annual report",   "type": "allowed",    "category": "approved",   "updatedAt": "2024-11-11T09:00:00.000Z" }
    ]
}
```

---

## Incremental sync

On every panel open:

1. **Cached rules** are served instantly from `localStorage` — no API wait.
2. If cache is still valid (within TTL): a background `POST` is sent with `"since": "<lastRecordDate>"` to fetch only records updated since the last sync.
3. If cache is expired: a full `POST` (no `since`) fetches all records.
4. New/updated records are merged into cache. Records are matched by their normalised `text` value.

This means violation results appear immediately, even on slow networks.

---

## Configuring the endpoint

Both halves of the feature - the `content-filter` panel and the `content-filter-worker` system
plugin - read the rule list through one shared file, `content-filter/scripts/policy-core.js`, so
they are configured together and cannot drift apart.

### From the editor config (preferred)

The integrator passes the endpoint and the tokens in `editorConfig.plugins.options`. The editor
hands that block to every plugin it starts, so a new endpoint or a rotated token needs no change
to the plugin and no republish:

```javascript
new DocsAPI.DocEditor("placeholder", {
    document:   { /* ... */ },
    editorConfig: {
        plugins: {
            pluginsData: [
                "https://plugins.example.com/content-filter-worker/config.json",
                "https://plugins.example.com/content-filter/config.json"
            ],
            // The worker has no button, so it can only ever start from here.
            autostart: ["asc.{C3D8B617-4E92-4B7A-9F51-6A2D0C8E4B73}"],
            options: {
                all: {                          // reaches the worker and the panel alike
                    contentPolicy: {
                        endpoint:      "https://drive.example.com/api/get-content-policy",
                        sessionToken:  "<the signed-in user's session token>",
                        bearerToken:   "<the service token>",
                        activeAccount: "0",
                        orgId:         "acme"   // omit to infer from the session token
                    }
                }
            }
        }
    }
});
```

Notes:

- **Every field is optional.** Anything left out (or set to an empty string) keeps the built-in
  value, so a deployment may pass only the `endpoint`.
- **`all` vs. a guid.** `options.all` is merged into what every plugin receives; `options["asc.{…}"]`
  applies to that plugin alone and, since the editor overlays options **per property**, a
  guid-specific `contentPolicy` replaces the one in `all` whole rather than field by field.
  Configure through `all` unless the panel and the worker really need different services.
- **Rotation works mid-session.** Calling `docEditor.setPluginsOptions(...)` re-sends the block;
  the worker treats that as a reason to re-fetch the rule list rather than waiting for its cache
  to expire (`Asc.plugin.onUpdateOptions`).
- Nothing is read at load time - the settings are resolved on each request via
  `SarvContentPolicy.apiSettings()`.

### Built-in fallbacks (`content-filter/scripts/policy-core.js`)

For a deployment that configures nothing, `API_DEFAULTS` in that file holds the same five fields.
They are the last resort, not the place to configure a tenant:

```javascript
const API_DEFAULTS = {
    endpoint:      "https://dev-console.sarv.com/drive-api/v1/external/get-content-policy",
    sessionToken:  "…",
    bearerToken:   "your_token_here",
    activeAccount: "0",
    orgId:         ""    // leave empty to infer from Session-Token
};
```

End users never see or change any of this - the Settings view exposes only the operational
preferences below.

---

## User-configurable settings

End users can adjust only these operational preferences, in the panel's own Settings view -
the gear in its status bar, beside Refresh. There is no Settings window and no dropdown on the
toolbar button: the plugin declares a single variation so that its button is a plain one, like
every other plugin's.

| Setting | Default | Description |
|---|---|---|
| **Auto-Remove Delay** | `0` s | Seconds before violations are auto-removed. `0` = disabled. |
| **Scan Interval** | `3000` ms | Milliseconds between background scans. |
| **Cache Duration** | `24` h | Hours before a full re-sync is triggered. |

---

## Server-side enforcement (the `callbackUrl` half)

The plugin is not the enforcement boundary. It tells the user what is wrong while they can still
fix it — it highlights the words and holds the save shut — but a client can be an unpatched
build, a plugin can fail to load, and a co-author's change reaches the other clients before any
save. **The drive has to refuse the version itself.**

That happens in the drive's `callbackUrl` handler (the endpoint passed in the editor config),
which the document server posts to whenever a version is finished.

### The check

1. Act on `status` **2** (`MustSave`, session ending) and **6** (`ForceSave`, Ctrl+S or a version
   flush). `status` 1/4 carry no file; 3/7 are save errors.
2. Convert the file at `url` to plain text through the document server, so the check reads what
   the file actually contains rather than trusting the client:

   ```
   POST <docserver>/ConvertService.ashx
   Authorization: Bearer <jwt.sign({ payload }, SECRET)>

   { "async": false, "filetype": "docx", "outputtype": "txt",
     "key": "<new for every conversion>", "title": "policy-check.docx",
     "url": "<the callback's url>", "token": "<the same jwt>" }
   ```

   The answer carries `fileUrl`; GET it for the text. `url` must be reachable **from the document
   server's container**, and `key` must be new every time — the converter caches by key and would
   otherwise hand back the previous document's text.
3. Match the policy words against that text **case-insensitively, as substrings**. Converting a
   pdf to text drops some of the spaces between words (`"Thisparagraphmentions Confidential"`), so
   a whole-word or token check lets a pdf through that the editor itself flags. Over-matching is
   the safe direction here.
4. When any word is present: **store nothing** and answer the callback with a non-zero `error`
   (`{"error": 1}`). The document server then reports the save as failed to every client and keeps
   the changes, so the user still has the document and can take the word out. A blocked version
   leaves no trace in the drive.
5. When the conversion itself fails, refuse as well — a policy that goes quiet whenever the
   converter is down is not a policy.

### Reference implementation

`scripts/contentPolicyGuard.js` in the `scripts` sibling repo (`policyWords`, `wordsPresentIn`,
`documentToText`, `findPolicyViolations`), wired into the local harness drive at
`scripts/server-local.js` → `POST /save-document`. It is off unless `CF_POLICY_WORDS` is set, so
an ordinary save pays no conversion round trip. Probe: `node scripts/editor/probe-policy-guard.js`.

### Editor-side API this relies on

Both halves read the same word list, but the editor half is driven by three plugin methods added
for it in sdkjs — available to **system plugins only** (`content-filter-worker` is one; the
sidebar panel is not):

| Method | What it does |
|---|---|
| `HighlightTerms(terms, { matchCase, wholeWords })` | Highlights every occurrence of every term in one pass, the way the search panel highlights matches — no edit, nothing written to the file, nothing for co-authors. Answers `{ count, matched }`; `matched` names the terms the document actually holds, which is the only way to find them in a pdf. `count` is `-1` while a pdf's text is still being extracted. |
| `ClearHighlightTerms()` | Takes the highlight off. |
| `SetContentPolicyBlock(reason)` | Refuses `asc_Save` and every download while `reason` is set, reporting `reason` verbatim to the user; pass an empty value to lift it. Owned by the calling plugin, so one holder cannot clear another's. |
| `GetContentPolicyBlock()` | The reason in force, or `null`. Readable by **any** plugin, so a panel can explain a block another plugin set. |
| `GetHighlightTermsCount()` | How many matches the highlight is currently painting. The editor drops its search results whenever the document is recalculated, which is every edit, so this is how the worker knows its highlight is gone and has to be painted again. |

## What the scan reads

The worker highlights and holds the save on the words its own read of the document finds, so the
read has to cover everywhere the editor's search engine looks — a region it cannot read is a
region a banned word saves out of. `collectDocumentText(editorType)` in
`scripts/policy-core.js` is that read, and every region it returns is joined with a newline so
no phrase can be matched across the seam between two of them (`top` in one cell and `secret` in
the next must not read as `top secret`).

| Editor | Read | Not read |
|---|---|---|
| Text document (`word`) | The body with its tables, nested tables included; every section's headers and footers of all three types; every footnote and endnote; the text inside every shape and text box, in the body and in the headers and footers | Comments, and a layout's or master's boilerplate — the editor's own search does not look there either |
| Presentation (`slide`) | Every slide's shapes, tables (cell by cell) and groups (recursively), and the speaker-notes page | Layouts and masters, whose placeholder text is not the user's and cannot be removed by them |
| Spreadsheet (`cell`) | Every sheet's used range, cell by cell, and the text inside every shape and text box | — |
| PDF (`pdf`) | Nothing: a plugin reaches neither the page text nor an edit. The engine's own search reads it instead (`detectWithEditorSearch`), which highlights as it counts | — |

Two kinds of match come back from a scan:

- **Located** — with a position and a snippet. The panel shows the surrounding text and can take
  the word out, because the editor's search-and-replace reaches wherever the scan read it.
- **Report-only** — `index: -1` and no snippet. The word is named in the message that holds the
  save, but the panel offers no **Remove** button and the auto-remove countdown skips it. Two
  things produce these: a pdf, whose text a plugin cannot rewrite, and a **spreadsheet's text
  boxes** — the spreadsheet's search engine walks cells rather than runs, so a word inside a
  shape there can be neither highlighted nor replaced. Everything else a scan finds is located.
