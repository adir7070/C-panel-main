# C-Panel Edit Tracking — Developer Spec

> This spec covers all backend and C-Panel changes required to support:
> 1. Per-item client approval/rejection tracking in MongoDB
> 2. Client edit requests sent through the app → Gemini AI
> 3. C-Panel display of item status and edit history

---

## 1. MongoDB Schema Changes

### Collections affected
- `wow_ads_sessions` → `generatedAds[]`
- `wow_organic_ads_sessions` → `generatedPosts[]`

### New fields to add to each embedded item

```js
{
  // ... existing fields (id, imageUrl, headline, cta, description, etc.) ...

  // NEW: client tracking
  clientStatus:     "pending",   // "pending" | "approved" | "rejected"
  clientApprovedAt: null,        // ISODate or null
  clientRejectedAt: null,        // ISODate or null
  editCount:        0,           // number — increments on each edit request
  editRequests:     [],          // array — see structure below
}
```

### `editRequests[]` item structure

```js
{
  requestedAt:   ISODate,        // timestamp of request
  instructions: {
    title?:    String,           // כותרת instructions
    subtitle?: String,           // תת כותרת instructions
    cta?:      String,           // הנעה לפעולה instructions
    image?:    String,           // תמונה instructions
  },
  geminiResult?: String,         // raw Gemini text response (JSON string)
  newImageUrl?:  String,         // new image URL if Imagen generated one
}
```

### Migration note
Existing documents don't have these fields — use `$setOnInsert` or let them default to undefined (treat missing as "pending"/"0").

---

## 2. Endpoints to Create / Modify

### A. Update existing `approve` endpoint

**Route:** `POST /api/client/project-detail/:projectId/approve`
**Body:** `{ phone, kind, itemId }`

Add to the item update:

```js
$set: {
  [`generatedAds.$.clientStatus`]:     "approved",
  [`generatedAds.$.clientApprovedAt`]: new Date(),
  [`generatedAds.$.clientRejectedAt`]: null,
}
```

Use positional operator `$` on the array element matching `itemId`.

---

### B. Update existing `reject` endpoint

**Route:** `POST /api/client/project-detail/:projectId/reject`
**Body:** `{ phone, kind, itemId }`

Add to the item update:

```js
$set: {
  [`generatedAds.$.clientStatus`]:     "rejected",
  [`generatedAds.$.clientRejectedAt`]: new Date(),
  [`generatedAds.$.clientApprovedAt`]: null,
}
```

---

### C. New endpoint — Edit Request

**Route:** `POST /api/client/project-detail/:projectId/items/:itemId/edit-request`

**Body:**
```json
{
  "phone":    "0501234567",
  "kind":     "ads_social",
  "imageUrl": "https://...",
  "instructions": {
    "title":    "שנה את הכותרת ל...",
    "subtitle": "תת כותרת חדשה...",
    "cta":      "לחץ כאן",
    "image":    "להחליף את המנורה למנורה מודרנית"
  }
}
```

**Logic:**

1. Resolve the session collection by `kind`:

```js
const COLLECTION_MAP = {
  ads_sponsored: "wow_ads_sessions",
  ads_social:    "wow_organic_ads_sessions",
  carousels:     "wow_ads_sessions",
  logo:          "wow_ads_sessions",
};
```

2. Build Gemini prompt:

```
שנה לי את המודעה הזאת לפי ההנחיות הבאות:
${instructions.title    ? `- כותרת: ${instructions.title}`                : ""}
${instructions.subtitle ? `- תת כותרת: ${instructions.subtitle}`          : ""}
${instructions.cta      ? `- הנעה לפעולה: ${instructions.cta}`            : ""}
${instructions.image    ? `- שינוי תמונה: ${instructions.image}`          : ""}

החזר JSON בלבד (ללא markdown):
{
  "headline": "...",
  "subtitle": "...",
  "cta": "...",
  "imageNote": "..."
}
```

3. Call Gemini Vision API:
   - Model: `gemini-2.0-flash` (or `gemini-1.5-pro-vision`)
   - Pass `imageUrl` as an inline image part (fetch the URL and send as base64, or use URI reference)
   - Parse JSON from response

4. If `instructions.image` is non-empty → call **Imagen 3** to generate a new image:
   - Prompt: `"${imageNote from Gemini}. High quality advertising photo, professional lighting."`
   - Save image to GCS/S3 and get `newImageUrl`

5. Update MongoDB item:

```js
db.collection(collectionName).updateOne(
  { phone, "generatedAds.id": itemId },
  {
    $inc: { "generatedAds.$.editCount": 1 },
    $push: {
      "generatedAds.$.editRequests": {
        requestedAt:   new Date(),
        instructions,
        geminiResult:  JSON.stringify(geminiJson),
        newImageUrl:   newImageUrl ?? null,
      }
    }
  }
);
```

6. Return response:

```json
{
  "success":  true,
  "text":     "{\"headline\": \"...\", \"subtitle\": \"...\", \"cta\": \"...\"}",
  "imageUrl": "https://new-image-url-if-generated"
}
```

On error return:
```json
{ "success": false, "error": "error message" }
```

---

## 3. C-Panel Display — Per Image Card

For each image in the WowAdsPanel / WowOrganicPanel / WowLpPanel, add a status row alongside the image.

### Status badge

| `clientStatus` | Display |
|---|---|
| `pending` (or missing) | ⬜ `ממתין לתגובת לקוח` — gray |
| `approved` | ✅ `אושר על ידי הלקוח` — green |
| `rejected`  | ❌ `נדחה על ידי הלקוח` — red |

### Edit counter

Show if `editCount > 0`:
```
✎  3 בקשות עריכה
```

### Edit history (expandable / accordion)

For each entry in `editRequests[]`:

```
📅 12.05.26 • 14:32
  כותרת: "שנה ל..."
  תמונה: "להחליף את המנורה"
  ↳ תוצאת גמיני: { "headline": "...", "cta": "..." }
  ↳ תמונה חדשה: [preview thumbnail]
```

---

## 4. Data Flow Summary

```
App: client approves item
  → POST /api/client/project-detail/:id/approve
  → Server updates: clientStatus="approved", clientApprovedAt=now()
  → C-Panel shows green badge next to image

App: client presses ✎ → fills edit fields → "שלח לעריכה"
  → POST /api/client/project-detail/:id/items/:itemId/edit-request
  → Server calls Gemini Vision with image + instructions
  → Server calls Imagen if image instruction provided
  → Server updates: editCount++, editRequests.push(...)
  → App shows Gemini text response + new image preview
  → C-Panel shows edit counter + history
```

---

## 5. Order of Implementation

1. Add new MongoDB fields to schema docs / seed scripts
2. Update `approve` and `reject` endpoints to set `clientStatus`
3. Build new `edit-request` endpoint (without Gemini first — return mock response)
4. Integrate Gemini Vision call
5. Integrate Imagen (optional, for image instructions)
6. Add C-Panel display per step 3 above
