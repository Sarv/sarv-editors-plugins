# Content Filter Plugin — API Reference

Developer documentation for building the backend API that powers this plugin.

---

## Overview

The plugin fetches two types of rules from your API:

| Type | Meaning | Example |
|---|---|---|
| `disallowed` | Word/phrase that **must not** appear in a document. Flagged as a violation. | `"confidential"`, `"Q2 revenue figures"`, `"Competitor X"` |
| `allowed` | Explicit **whitelist** that overrides a disallowed rule. Useful when a word is normally blocked but is acceptable in a specific known phrase. | `"COVID-19 vaccine"` (overrides a block on `"COVID"`) |

A rule is simply a **word or phrase** (case-insensitive match). Single words, multi-word phrases, brand names, legal terms, or any string.

---

## Security

API calls are made directly from the browser (no server proxy). Access is restricted at the network level:

- **IP allowlisting** — your server should only accept requests from your known office/VPN IP ranges. Block all other sources.
- **No API key is sent by the plugin.** Authentication is purely network-layer.

---

## Endpoint

```
GET {API_URL}?size=2000&skip={SKIP}[&since={ISO_DATE}][&userId={USER_ID}]
```

All query parameter names and values are **fixed** — they are not user-configurable:

| Parameter | Value | Description |
|---|---|---|
| `size` | `2000` (fixed) | Records per page. Plugin re-fetches while `records.length == 2000`. |
| `skip` | `0`, `2000`, `4000`, … | Zero-based record offset for pagination. Incremented by 2000 per page. |
| `since` | ISO-8601 date | *(Incremental sync only)* Fetch only records updated after this date. Omitted on full sync. |
| `userId` | String | The ID of the user who opened the editor (`window.Asc.plugin.info.userId`). Omitted if unavailable. |

**Example requests:**

```bash
# Full fetch, page 1
GET /api/content-rules?size=2000&skip=0&userId=alice@example.com

# Full fetch, page 2 (only if page 1 returned exactly 2000 records)
GET /api/content-rules?size=2000&skip=2000&userId=alice@example.com

# Incremental — only records updated after last sync
GET /api/content-rules?size=2000&skip=0&since=2024-11-15T08:30:00.000Z&userId=alice@example.com
```

---

## Response Format

### Standard response (with wrapper object)

```json
{
  "data": [
    { "id": 1, "text": "confidential", "type": "disallowed", "category": "compliance",  "updatedAt": "2024-11-10T09:00:00.000Z" },
    { "id": 2, "text": "Q2 revenue",   "type": "disallowed", "category": "financial",   "updatedAt": "2024-11-10T09:00:00.000Z" },
    { "id": 3, "text": "top secret",   "type": "disallowed", "category": "security",    "updatedAt": "2024-11-11T14:30:00.000Z" },
    { "id": 4, "text": "do not share", "type": "disallowed", "category": "compliance",  "updatedAt": "2024-11-12T07:00:00.000Z" },
    { "id": 5, "text": "approved vendor", "type": "allowed", "category": "procurement", "updatedAt": "2024-11-12T07:00:00.000Z" }
  ],
  "total": 5
}
```

### Flat array response (also supported)

```json
[
  { "text": "confidential", "type": "disallowed", "category": "compliance" },
  { "text": "approved vendor", "type": "allowed", "category": "procurement" }
]
```

### Field descriptions

| Field | Required | Description |
|---|---|---|
| `text` | **Yes** | The word or phrase to match in the document. Case-insensitive. Can be a single word (`"password"`) or a multi-word phrase (`"for internal use only"`). |
| `type` | **Yes** | `"disallowed"` → flagged as a violation. `"allowed"` → whitelisted (overrides disallowed). Any value other than `"allowed"` is treated as `"disallowed"`. |
| `category` | No | Label shown on each violation card (e.g. `"compliance"`, `"security"`, `"legal"`). Helps users understand why something is flagged. |
| `updatedAt` | Recommended | ISO-8601 timestamp of when this record was last modified. Required for incremental sync. |

> **Field names are fixed** — the plugin always reads `text`, `type`, `category`, and `updatedAt`. The records array wrapper key defaults to `data` (flat arrays are also accepted).

---

## Pagination

The plugin fetches pages until the response contains **fewer records than the page size** (2000):

```
Page 1: skip=0,    received=2000 → fetch page 2
Page 2: skip=2000, received=2000 → fetch page 3
Page 3: skip=4000, received=847  → DONE (847 < 2000)

Total records fetched = 4847
```

This happens in the background — the UI is not blocked.

---

## Incremental Sync

When `updatedAt` is present on records:

1. **First load or expired cache**: full sync (all pages, no `since` param).
2. **On every subsequent page load**: plugin uses cached rules instantly, then calls:
   ```
   GET /api/content-rules?size=2000&skip=0&since=<lastRecordDate>&userId=<id>
   ```
   where `lastRecordDate` is the maximum `updatedAt` value seen in all previously fetched records.
3. New/updated records are **merged** into the existing cache. Records are matched by their `text` field — if the same word comes back with a different `type`, it is updated.
4. The new `lastRecordDate` high-water mark is saved for the next reload.

**Result**: on reload, violation results appear immediately from cache. The background call only fetches the delta.

---

## Incremental sync response example

```json
{
  "data": [
    { "id": 6, "text": "internal memo", "type": "disallowed", "category": "compliance", "updatedAt": "2024-12-01T11:00:00.000Z" },
    { "id": 7, "text": "trade secret",  "type": "disallowed", "category": "legal",       "updatedAt": "2024-12-01T11:05:00.000Z" }
  ],
  "total": 2
}
```

Since `total < page_size (2000)`, the plugin stops. These 2 records are merged into the cached 4847.

---

## Mock Data (30 records)

Copy this for local development or testing:

```json
[
  { "id": 1,  "text": "confidential",         "type": "disallowed", "category": "compliance",  "updatedAt": "2024-11-01T08:00:00.000Z" },
  { "id": 2,  "text": "top secret",           "type": "disallowed", "category": "security",    "updatedAt": "2024-11-01T08:00:00.000Z" },
  { "id": 3,  "text": "for internal use only","type": "disallowed", "category": "compliance",  "updatedAt": "2024-11-01T08:00:00.000Z" },
  { "id": 4,  "text": "do not distribute",    "type": "disallowed", "category": "compliance",  "updatedAt": "2024-11-01T08:00:00.000Z" },
  { "id": 5,  "text": "Q2 revenue",           "type": "disallowed", "category": "financial",   "updatedAt": "2024-11-02T09:00:00.000Z" },
  { "id": 6,  "text": "EBITDA",               "type": "disallowed", "category": "financial",   "updatedAt": "2024-11-02T09:00:00.000Z" },
  { "id": 7,  "text": "profit forecast",      "type": "disallowed", "category": "financial",   "updatedAt": "2024-11-02T09:00:00.000Z" },
  { "id": 8,  "text": "password",             "type": "disallowed", "category": "security",    "updatedAt": "2024-11-03T10:00:00.000Z" },
  { "id": 9,  "text": "secret key",           "type": "disallowed", "category": "security",    "updatedAt": "2024-11-03T10:00:00.000Z" },
  { "id": 10, "text": "access token",         "type": "disallowed", "category": "security",    "updatedAt": "2024-11-03T10:00:00.000Z" },
  { "id": 11, "text": "guaranteed returns",   "type": "disallowed", "category": "legal",       "updatedAt": "2024-11-04T11:00:00.000Z" },
  { "id": 12, "text": "no risk",              "type": "disallowed", "category": "legal",       "updatedAt": "2024-11-04T11:00:00.000Z" },
  { "id": 13, "text": "risk-free investment", "type": "disallowed", "category": "legal",       "updatedAt": "2024-11-04T11:00:00.000Z" },
  { "id": 14, "text": "Competitor Corp",      "type": "disallowed", "category": "brand",       "updatedAt": "2024-11-05T12:00:00.000Z" },
  { "id": 15, "text": "Rival Inc",            "type": "disallowed", "category": "brand",       "updatedAt": "2024-11-05T12:00:00.000Z" },
  { "id": 16, "text": "proprietary",          "type": "disallowed", "category": "compliance",  "updatedAt": "2024-11-06T08:00:00.000Z" },
  { "id": 17, "text": "trade secret",         "type": "disallowed", "category": "legal",       "updatedAt": "2024-11-06T08:00:00.000Z" },
  { "id": 18, "text": "salary details",       "type": "disallowed", "category": "hr",          "updatedAt": "2024-11-07T09:00:00.000Z" },
  { "id": 19, "text": "performance review",   "type": "disallowed", "category": "hr",          "updatedAt": "2024-11-07T09:00:00.000Z" },
  { "id": 20, "text": "internal only",        "type": "disallowed", "category": "compliance",  "updatedAt": "2024-11-08T10:00:00.000Z" },
  { "id": 21, "text": "draft",                "type": "disallowed", "category": "publishing",  "updatedAt": "2024-11-09T07:00:00.000Z" },
  { "id": 22, "text": "not for publication",  "type": "disallowed", "category": "publishing",  "updatedAt": "2024-11-09T07:00:00.000Z" },
  { "id": 23, "text": "under embargo",        "type": "disallowed", "category": "publishing",  "updatedAt": "2024-11-09T07:00:00.000Z" },
  { "id": 24, "text": "merger",               "type": "disallowed", "category": "m&a",         "updatedAt": "2024-11-10T08:00:00.000Z" },
  { "id": 25, "text": "acquisition target",   "type": "disallowed", "category": "m&a",         "updatedAt": "2024-11-10T08:00:00.000Z" },
  { "id": 26, "text": "COVID-19 vaccine",     "type": "allowed",    "category": "approved",    "updatedAt": "2024-11-11T09:00:00.000Z" },
  { "id": 27, "text": "annual report",        "type": "allowed",    "category": "approved",    "updatedAt": "2024-11-11T09:00:00.000Z" },
  { "id": 28, "text": "public disclosure",    "type": "allowed",    "category": "approved",    "updatedAt": "2024-11-11T09:00:00.000Z" },
  { "id": 29, "text": "approved vendor list", "type": "allowed",    "category": "procurement", "updatedAt": "2024-11-12T10:00:00.000Z" },
  { "id": 30, "text": "press release draft",  "type": "allowed",    "category": "publishing",  "updatedAt": "2024-11-12T10:00:00.000Z" }
]
```

---

## Example: Express.js Mock Server

No authentication middleware needed — access control is handled entirely by IP allowlisting at the network/firewall level.

```javascript
const express = require('express');
const app = express();

const rules = [
  { id: 1,  text: "confidential",          type: "disallowed", category: "compliance",  updatedAt: "2024-11-01T08:00:00.000Z" },
  { id: 2,  text: "top secret",            type: "disallowed", category: "security",    updatedAt: "2024-11-01T08:00:00.000Z" },
  { id: 3,  text: "for internal use only", type: "disallowed", category: "compliance",  updatedAt: "2024-11-01T08:00:00.000Z" },
  { id: 4,  text: "Q2 revenue",            type: "disallowed", category: "financial",   updatedAt: "2024-11-02T09:00:00.000Z" },
  { id: 5,  text: "password",              type: "disallowed", category: "security",    updatedAt: "2024-11-03T10:00:00.000Z" },
  { id: 6,  text: "guaranteed returns",    type: "disallowed", category: "legal",       updatedAt: "2024-11-04T11:00:00.000Z" },
  { id: 7,  text: "Competitor Corp",       type: "disallowed", category: "brand",       updatedAt: "2024-11-05T12:00:00.000Z" },
  { id: 8,  text: "annual report",         type: "allowed",    category: "approved",    updatedAt: "2024-11-11T09:00:00.000Z" },
  { id: 9,  text: "press release draft",   type: "allowed",    category: "publishing",  updatedAt: "2024-11-12T10:00:00.000Z" },
  // ... add more records
];

app.get('/api/content-rules', (req, res) => {
  // CORS headers (required for browser fetch)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const size   = parseInt(req.query.size)  || 2000;
  const skip   = parseInt(req.query.skip)  || 0;
  const since  = req.query.since ? new Date(req.query.since) : null;
  const userId = req.query.userId || null; // for user-specific rules if needed

  // Filter by date for incremental sync
  let filtered = since
    ? rules.filter(r => new Date(r.updatedAt) > since)
    : rules;

  // Paginate
  const page = filtered.slice(skip, skip + size);

  res.json({ data: page, total: filtered.length });
});

app.options('/api/content-rules', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.sendStatus(200);
});

app.listen(3000, () => console.log('Mock server running on http://localhost:3000'));
```

---

## Example curl Commands

```bash
# Full fetch
curl "http://localhost:3000/api/content-rules?size=2000&skip=0&userId=alice@example.com"

# Incremental fetch (records updated after a date)
curl "http://localhost:3000/api/content-rules?size=2000&skip=0&since=2024-11-10T00:00:00.000Z&userId=alice@example.com"
```

---

## Plugin Configuration Reference

### Deploy-time constant (set in `scripts/script.js`)

| Constant | Description |
|---|---|
| `API_URL` | Your content-rules endpoint. Set this once before publishing the plugin. End users never see or change this value. |

### User-configurable settings (Settings modal)

End users can only adjust these 3 operational preferences:

| Setting | Default | Description |
|---|---|---|
| **Auto-Remove Delay** | `0` | Seconds before violations are auto-removed. `0` = disabled. |
| **Scan Interval** | `3000` | Milliseconds between background scans in Word. |
| **Cache Duration** | `24` | Hours before a full re-sync is triggered. |

Everything else (API URL, page size, param names, field names, API key) is fixed in the plugin code and not exposed to users.
