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

## Deploy-time configuration (`scripts/script.js`)

```javascript
var API_ENDPOINT       = 'https://dev-console.sarv.com/drive-api/v1/external/get-content-policy';
var API_SESSION_TOKEN  = '<session-token>';
var API_BEARER_TOKEN   = '<bearer-token>';
var API_ACTIVE_ACCOUNT = '0';
var API_ORG_ID         = '';   // leave empty to infer from Session-Token
```

All values are set once before publishing. End users never see or change them.

---

## User-configurable settings

End users can adjust only these operational preferences via the Settings panel:

| Setting | Default | Description |
|---|---|---|
| **Auto-Remove Delay** | `0` s | Seconds before violations are auto-removed. `0` = disabled. |
| **Scan Interval** | `3000` ms | Milliseconds between background scans. |
| **Cache Duration** | `24` h | Hours before a full re-sync is triggered. |
