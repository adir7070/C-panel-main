# C-Panel Edit Tracking · סטטוס ביצוע

עודכן: 06.05.2026

מסמך זה מסכם מה כבר נעשה מול ה-spec ב-`CPANEL-EDIT-TRACKING-SPEC.md`,
כולל חוזה ה-API החדש ומה החוקיות במסד.

---

## סיכום משימות

| § | משימה | סטטוס |
|---|---|---|
| 1   | שדות חדשים על פריטים (`clientStatus`, `clientApprovedAt`, `clientRejectedAt`, `editCount`, `editRequests`) | ✅ נכתבים אוטומטית, אין צורך ב-migration |
| 2A  | endpoint `approve` כותב `clientStatus="approved"` + `clientApprovedAt` | ✅ |
| 2B  | endpoint `reject` כותב `clientStatus="rejected"` + `clientRejectedAt` | ✅ |
| 2C  | endpoint חדש `edit-request` עם אינטגרציה ל-Gemini | ✅ |
| 3   | Badge סטטוס פר פריט (⬜/✅/❌) ב-cpanel | ✅ |
| 3   | מונה עריכות (`✎ N בקשות עריכה`) | ✅ |
| 3   | היסטוריית עריכות באקורדיון | ✅ |

---

## שרת — שינויים

### `controllers/client-projects.controller.js`

#### 1. עדכון `updateItemApproval` (שורה ~155)
פונקציה זו רצה גם ב-approve וגם ב-reject. נוספו שלושה שדות לכתיבה על הפריט:
```js
items[idx].clientStatus      = approved ? "approved" : "rejected";
items[idx].clientApprovedAt  = approved ? now : null;
items[idx].clientRejectedAt  = approved ? null : now;
```
השדות הישנים (`clientApproved`, `clientFeedback`, `clientResponseAt`) נשמרים — backward compat.

#### 2. שינוי `mapItem` ב-`getClientProjectDetail` (pkg_* path)
פריטי ה-API החיצוני כעת חושפים את ה-tracking:
```js
{
  clientStatus,            // pending | approved | rejected
  clientApprovedAt,        // ISODate | null
  clientRejectedAt,        // ISODate | null
  editCount,               // number, 0 if missing
  editRequests,            // array, [] if missing
}
```
לפריטים ישנים (לפני ההוספה) — נופל ל-`pending`/0/[].

#### 3. endpoint חדש: `editRequestForItem` (~שורה 575)
ראה החוזה למטה.

### `routes/api.js`
נוסף route חדש:
```js
router.post("/client/project-detail/:projectId/items/:itemId/edit-request",
            clientProjectsCtrl.editRequestForItem);
```

---

## חוזה API — `POST /api/client/project-detail/:projectId/items/:itemId/edit-request`

### Body

```json
{
  "phone":    "0501234567",
  "kind":     "ads_social",        // ads_sponsored | ads_social | carousels
  "imageUrl": "https://...",
  "instructions": {
    "title":    "שנה את הכותרת ל...",
    "subtitle": "תת כותרת חדשה...",
    "cta":      "לחץ כאן",
    "image":    "להחליף את המנורה למנורה מודרנית"
  }
}
```

### Response (success)

```json
{
  "success":  true,
  "text":     "{ \"headline\": \"...\", \"subtitle\": \"...\", \"cta\": \"...\", \"imageNote\": \"...\" }",
  "imageUrl": "https://...new-image-if-generated"
}
```

`text` הוא ה-raw text מ-Gemini (אמור להיות JSON; ה-cpanel parser שלי מנקה ```json``` fences לפני parse).

### Response (errors)

| HTTP | Body | מתי |
|---|---|---|
| 400 | `{ success: false, error: "projectId, itemId, phone, kind required" }` | שדה חסר |
| 400 | `{ success: false, error: "unsupported kind: ..." }` | kind לא במפה (רק ads_sponsored / ads_social / carousels) |
| 400 | `{ success: false, error: "at least one instruction required" }` | אין שדה instructions לא ריק |
| 500 | `{ success: false, error: "GOOGLE_AI_API_KEY not configured" }` | env חסר |
| 502 | `{ success: false, error: "Gemini error: ..." }` | Gemini API נכשל |
| 500 | `{ success: false, error: "..." }` | שגיאה כללית |

### זרימת פנימית

1. Validate fields + map kind → collection (`wow_ads_sessions` או `wow_organic_ads_sessions`)
2. בנה prompt עברית (`שנה לי את המודעה הזאת לפי ההנחיות הבאות:` ...)
3. Fetch של ה-imageUrl כ-base64 → inline part ב-Gemini contents
4. קריאה ל-`gemini-2.5-flash` (אפשר לעקוף עם `GEMINI_TEXT_MODEL` env)
5. אם `instructions.image` קיים → קריאה ל-`services/wow/gemini-image.service` (מנסה `generateSingleImage`; אם לא קיים — דילוג שקט, ה-text response עדיין מוחזר)
6. Mongo update עם positional `$`:
   ```js
   $inc:  { "generatedAds.$.editCount": 1 },
   $push: { "generatedAds.$.editRequests": { requestedAt, instructions, geminiResult, newImageUrl } },
   $set:  { "generatedAds.$.imageUrl": newImageUrl }    // רק אם תמונה חדשה
   ```
7. החזרת `{ success, text, imageUrl }`

---

## מיפוי kind → collection

| `kind` בבקשה | קולקציה | שדה הפריטים |
|---|---|---|
| `ads_sponsored` | `wow_ads_sessions` | `generatedAds[]` |
| `ads_social` | `wow_organic_ads_sessions` | `generatedPosts[]` |
| `carousels` | `wow_organic_ads_sessions` | `generatedPosts[]` |

(ה-positional `$` ב-update בנוי דינמית מ-itemsField, כך ש-`generatedPosts.$.editCount` עובד עם אותו קוד.)

---

## C-Panel — שינויים

### `src/api/client.ts`
נוסף interface `EditRequest` ו-`ProductItem` הורחב:
```ts
export interface EditRequest {
  requestedAt:  string;
  instructions: { title?: string; subtitle?: string; cta?: string; image?: string };
  geminiResult?: string | null;
  newImageUrl?:  string | null;
}

export interface ProductItem {
  // existing fields...
  clientStatus?:     "pending" | "approved" | "rejected";
  clientApprovedAt?: string | null;
  clientRejectedAt?: string | null;
  editCount?:        number;
  editRequests?:     EditRequest[];
}
```

### `src/components/client-detail/PackageStatusBanner.tsx`
ה-`ImageGalleryModal` עכשיו מציג כל פריט דרך קומפוננטה חדשה `ItemCard`.

**`ItemCard`:**
- Badge סטטוס לפי `item.clientStatus` (אם קיים) או fallback ל-`item.status`:
  | clientStatus | תווית | צבע |
  |---|---|---|
  | `pending` | ⬜ ממתין לתגובת לקוח | אפור |
  | `approved` | ✅ אושר על ידי הלקוח | ירוק |
  | `rejected` | ❌ נדחה על ידי הלקוח | אדום |
- אם `editCount > 0`: כפתור **"✎ N בקשות עריכה ▾"** שפותח אקורדיון
- אקורדיון מציג כל `editRequest`:
  - תאריך + שעה (he-IL format)
  - הנחיות הלקוח (כותרת / תת כותרת / CTA / תמונה)
  - תוצאת Gemini (parsed JSON — headline + cta)
  - לינק "↳ תמונה חדשה" אם הוחזר newImageUrl

---

## מה עוד צריך מצד צוות האפליקציה (RN)

המסמך הזה מכסה את **השרת + ה-cpanel**. צוות האפליקציה צריך לקרוא ל-endpoint החדש ב-RN:

```ts
async function sendEditRequest(projectId, itemId, phone, kind, imageUrl, instructions) {
  const res = await fetch(
    `${SERVER_URL}/api/client/project-detail/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/edit-request`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, kind, imageUrl, instructions }),
    }
  );
  return res.json();
}
```

ה-UX באפליקציה:
1. הלקוח לוחץ ✎ ליד תמונה
2. מודאל עם 4 שדות: כותרת / תת כותרת / CTA / שינוי תמונה (אופציונליים)
3. כפתור "שלח לעריכה"
4. spinner תוך כדי קריאה (Gemini לוקח 5-15 שניות + Imagen עוד 10-20 אם נדרש)
5. בהצלחה — הצג את `text` שהתקבל + `imageUrl` חדש אם יש

---

## הערות לקוורקר

### לגבי Imagen
ה-endpoint מנסה לקרוא ל-`generateSingleImage(...)` ב-`services/wow/gemini-image.service.js`. אם החתימה שונה ב-service הקיים — ה-Imagen נופל בשקט (warn ב-console, לא מכשיל את הבקשה). ה-coworker יכול לחבר את הקריאה לפי החתימה האמיתית של ה-service.

### Backward compat
- פריטים ישנים בלי השדות החדשים → fallback ל-`clientStatus = pending`, `editCount = 0`, `editRequests = []`. אין צורך ב-migration.
- השדות הישנים (`clientApproved`, `clientFeedback`, `clientResponseAt`) נשמרים — קוד אחר במערכת אולי משתמש בהם.

### Throttling / abuse
ה-endpoint לא מטיל rate limit. אם לקוח מנדנד 100 פעמים → 100 קריאות Gemini → 100 חיובים. שווה להוסיף בעתיד:
- מינימום זמן בין בקשות (5 שניות)
- max edits per item per day (10)
- חיוב מטבעות (כמו `REGENERATE_AD = 5 coins`)

---

## בדיקות אחרי deploy

1. ✓ הלקוח לוחץ "אשר" באפליקציה → במסד `clientStatus = "approved"` + `clientApprovedAt = ISODate`
2. ✓ הלקוח לוחץ "דחה" → `clientStatus = "rejected"` + `clientRejectedAt`
3. ✓ ב-cpanel: פתיחת גלריה → badge נכון מוצג לכל פריט
4. ✓ הלקוח שולח עריכה → במסד `editCount` מתעלה, `editRequests` מקבל entry חדש
5. ✓ אם הוחזר `newImageUrl` → `imageUrl` של הפריט מתעדכן (התמונה החדשה נראית בכל מקום)
6. ✓ ב-cpanel: כפתור "✎ N בקשות עריכה" מופיע, פתיחתו חושפת היסטוריה
7. ✓ Gemini מחזיר JSON בלבד (ללא markdown) — ה-parser ב-cpanel מנקה גם אם הוחזר ב-fence

---

## PRs

- שרת: `feat/edit-tracking` — https://github.com/IconiqMotion/iconiq-server/pull/new/feat/edit-tracking
- CPanel: `feat/edit-tracking-cpanel` — https://github.com/IconiqMotion/C-panel/pull/new/feat/edit-tracking-cpanel

לאחר merge ב-deploy אוטומטי (AWS pm2 + Heroku) — הזרימה פעילה מקצה לקצה.
