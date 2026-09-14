# Fireberry → WOW Ads Integration

Embedded ad-review widget inside Fireberry customer records.
Fires the WOW ads pipeline on demand, displays the 10 generated ads,
captures approve/reject decisions, and writes results back to the
customer record.

## Architecture

```
┌─────────────────────────┐
│  Fireberry record (1)   │  status field flips to "ready"
└────────────┬────────────┘
             │ Automation: HTTP webhook
             ▼
┌──────────────────────────────────────────────────────────────┐
│  POST /api/fireberry-ads/generate         (iconiq-server)    │
│    → fireberry-ads.service.js                                │
│        1. read customer fields from Fireberry (object 1)     │
│        2. map → WOW brief                                    │
│        3. POST http://localhost:3001/api/fireberry-ads/      │
│             from-brief  (wow-beta child process)             │
│        4. persist { recordId, sessionId } in Mongo           │
└──────────────────────────────────────────────────────────────┘
             │
             ▼ async (60–90s)
┌──────────────────────────────────────────────────────────────┐
│  WOW pipeline (wow-beta/backend)                             │
│    Gemini text + nano prompts + image generation             │
│    → data/uploads/ads/{sessionId}/ad_1..10.png               │
└──────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────┐
│  iframe on the customer record                               │
│    GET  /api/fireberry-ads/session/:recordId   (poll every 3s)│
│    POST /api/fireberry-ads/decision            (per click)   │
└──────────────────────────────────────────────────────────────┘
```

## Files added/modified

| File | Type | Purpose |
|------|------|---------|
| `wow-beta/backend/src/routes/fireberryAdsRoutes.ts` | NEW | `POST /api/fireberry-ads/from-brief` — direct ads-only entry, bypasses HTML site generation |
| `wow-beta/backend/src/index.ts` | MOD | Mount the new route |
| `services/fireberry-ads.service.js` | NEW | Orchestrator: read Fireberry → map → drive WOW → persist mapping |
| `routes/fireberry-ads.routes.js` | NEW | Three HTTP endpoints (generate / session / decision) |
| `routes/api.js` | MOD | Mount `/api/fireberry-ads` |
| `public/fireberry-ads-review.html` | NEW | Embedded widget |
| `server.js` | MOD | `GET /fireberry-ads-review` serves the HTML |

## Mongo collection

`fireberry_ad_sessions`

```js
{
  fireberryRecordId:   "a8c82355-285e-4afb-b7f3-57e1aa031ca7",
  fireberryObjectType: 1,
  sessionId:           "10750b77-4911-4b1f-8dbd-02081a742017",
  briefId:             "...",
  status:              "generating" | "ready" | "reviewed",
  decisions:           { "1": "approved", "2": "rejected", ... },
  createdAt:           ISODate,
  updatedAt:           ISODate,
}
```

No migration step needed — the collection is created on first upsert.

## Setup steps

### 1. Verify field mapping (one-time, manual)

Open `services/fireberry-ads.service.js` and look at `FIREBERRY_FIELD_MAP`.
The default values are placeholders based on the existing
`fireberry-customers.service.js`. To confirm the real field names for
each brief input:

1. Open a Fireberry customer record in the browser
2. F12 → Network → reload the page
3. Find the request to `/api/record/1/{id}` (or `/api/query`)
4. Inspect the response — each `pcfsystemfield<N>` corresponds to a label
   shown on the form. Update `FIREBERRY_FIELD_MAP` accordingly.

The widget will still work with incomplete mapping; brief fields with
unknown source will simply be empty.

### 2. Add new Fireberry fields for tracking (recommended)

On the customer object (type 1), add these custom fields:

| Field type | Suggested label | Purpose |
|------------|-----------------|---------|
| Text | `סטטוס יצירת מודעות` | Drives the automation trigger |
| Text (long) | `החלטות מודעות` | Stores JSON: `{"1":"approved",...}` |
| Text | `Session ID` | Optional — for debugging |

After Fireberry creates the new fields, copy their `pcfsystemfield<N>`
names into `FIREBERRY_FIELD_MAP` (the keys named `adsSessionId`,
`adsStatus`, `adsDecisions`). Until you do, write-back to Fireberry is a
no-op — local Mongo storage still works.

### 3. Configure the Fireberry Automation

In Fireberry: Settings → Automations → New Automation

```
Trigger:    On record update of object type 1 (Customer)
Condition:  status_field == "ready to generate ads"
Action:     HTTP Request
  Method:   POST
  URL:      https://iconiq-b19bf9d01fab.herokuapp.com/api/fireberry-ads/generate
  Headers:  Content-Type: application/json
  Body:     { "recordId": "{{accountid}}" }
```

### 4. Embed the iframe

On the customer record form, add an HTML field with this body:

```html
<iframe
  src="https://iconiq-b19bf9d01fab.herokuapp.com/fireberry-ads-review?recordId={{accountid}}"
  style="width:100%;min-width:900px;height:850px;border:none;display:block;border-radius:12px;">
</iframe>
```

If Fireberry's rich-text editor strips `<iframe>` — use the source-code
(`</>`) button or a dedicated Web Resource field type.

## Testing locally

```bash
# 1. start the server (also spawns wow-beta as a child process)
cd C:\Users\Goals\OneDrive\Documents\GitHub\iconiq-server-new
npm start

# 2. simulate the Fireberry webhook
curl -X POST http://localhost:3900/api/fireberry-ads/generate \
  -H "Content-Type: application/json" \
  -d '{"recordId":"a8c82355-285e-4afb-b7f3-57e1aa031ca7"}'
# → { "ok": true, "sessionId": "...", "status": "generating" }

# 3. open the widget
start http://localhost:3900/fireberry-ads-review?recordId=a8c82355-285e-4afb-b7f3-57e1aa031ca7
```

## Deployment

The integration uses iconiq-server-new's existing Heroku deployment.
After merging:

```bash
git add wow-beta/backend/src/routes/fireberryAdsRoutes.ts \
        wow-beta/backend/src/index.ts \
        services/fireberry-ads.service.js \
        routes/fireberry-ads.routes.js \
        routes/api.js \
        public/fireberry-ads-review.html \
        server.js \
        docs/FIREBERRY_ADS_INTEGRATION.md
git commit -m "feat: fireberry ↔ wow ads pipeline integration"
git push heroku main   # or via your usual deploy flow
```

No new env vars required — uses existing `FIREBERRY_TOKEN` and the
already-spawned wow-beta child process.

## Operational notes

- **Idempotent generate** — calling `/generate` twice with the same
  recordId returns the existing session if it's still generating or
  already ready. Fresh generation requires deleting the Mongo doc first.
- **Cost** — each call burns Gemini text + image quota for ~10 ads.
  ~$0.05–0.10 per generation at current Google AI pricing.
- **Image hosting** — images live on the Heroku dyno's local disk
  (`wow-beta/backend/data/uploads/ads/...`). They survive process restart
  via Heroku's ephemeral disk but are wiped on dyno cycling (~daily).
  For permanent storage, the widget should upload approved images to
  Backblaze B2 (already configured) — TODO for a later iteration.
- **Decision write-back** — fails silently if `FIREBERRY_FIELD_MAP.adsDecisions`
  still points to a placeholder field name. Mongo is the source of truth.
