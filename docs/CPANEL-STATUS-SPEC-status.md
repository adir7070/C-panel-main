# C-Panel · מערכת סטטוסים למוצרים — סטטוס ביצוע

עודכן: 06.05.2026

מסמך זה מסכם מה כבר נעשה מול ה-spec ב-`CPANEL-STATUS-SPEC.md`,
ומה עוד נשאר לבנות.

---

## סיכום משימות

| # | תחום | סטטוס |
|---|---|---|
| 1.1 | שדה `productStatus` בכל session | ✅ |
| 1.2 | מעברי סטטוס אוטומטיים (יצירה → done → אישור/דחייה) | ✅ |
| 1.3 | GET `/products/status` | ✅ |
| 1.3 | PUT `/products/:type/status` (manual, whitelist) | ✅ |
| 1.3 | POST `/products/:type/send-to-client` | ✅ |
| 1.4 | Expo Push Notification | ✅ |
| 2.1 | טבלת סטטוס מעל `ProductsTab` | ✅ |
| 2.2 | כפתור "שלח ללקוח" (גייטד על `pending_manager_approval`) | ✅ |
| 2.4 | API functions ב-`client.ts` | ✅ |
| 2.3 | status badge + manual buttons בכל פאנל (WowAdsPanel וכד') | ⏳ דחוי ל-v2 |
| 3   | מסך התקדמות באפליקציית הלקוח (RN) | ⏳ למפתח האפליקציה |

---

## שרת (iconiq-server)

### קבצים חדשים

- `services/product-status.service.js` — מקור אמת יחיד לכל מעברי הסטטוס. מחשב, קורא, וכותב את `productStatus` בקולקציות `wow_ads_sessions` / `wow_organic_ads_sessions` / `wow_lp_sessions`.
- `services/expo-push.service.js` — Wrapper ל-Expo Push API. **never throws** — כשלון בשליחה לא מכשיל את הבקשה.
- `controllers/products-status.controller.js` — שלוש נקודות הקצה החדשות.

### מעברי סטטוס אוטומטיים

| טריגר | קובץ | productStatus → |
|---|---|---|
| `runAdsPipeline` נקרא — session נוצר | `services/wow-ads.service.js` | `sent_for_creation` |
| `runOrganicAdsPipeline` נקרא | `services/wow-organic-ads.service.js` | `sent_for_creation` |
| `runLpPipeline` נקרא | `services/wow-lp.service.js` | `sent_for_creation` |
| pipeline סיים בהצלחה (`status: "done"`) | באותם 3 קבצים | `pending_manager_approval` |
| מנהל לחץ "שלח ללקוח" | `products-status.controller.js` | `sent_to_client` (+ Expo push) |
| לקוח אישר את כל הפריטים | `client-projects.controller.js` (per-item path) | `client_approved` |
| לקוח דחה לפחות פריט אחד | אותו קובץ | `client_returned_corrections` |

### Backward compat — `clientApprovalStatus` המקורי

נשמר כפי שהוא. כש-`productStatus` עובר ל-`sent_to_client` / `client_returned_corrections` / `client_approved`, ה-service מעדכן גם את הערך הישן (`sent` / `rejected` / `approved` בהתאם). שום קוד קיים לא נשבר.

### Endpoints חדשים

#### `GET /api/cpanel/clients/:phone/products/status`

```json
{
  "ads":     { "productStatus": "pending_manager_approval", "sessionExists": true },
  "organic": { "productStatus": "pending_characterization", "sessionExists": false },
  "lp":      { "productStatus": "sent_to_client",          "sessionExists": true }
}
```

אם אין session ללקוח עבור type מסוים — מחזיר `pending_characterization` עם `sessionExists: false`. אין דרישה ל-migration לתעודות ישנות.

#### `PUT /api/cpanel/clients/:phone/products/:type/status`

Body: `{ "status": "<productStatus value>" }`

**מעברים מותרים** (אכיפה ב-`MANUAL_TRANSITIONS` ב-service):

| מ | ל |
|---|---|
| `client_returned_corrections` | `in_correction` |
| `in_correction` | `corrections_completed` |
| `corrections_completed` | `pending_manager_approval` |
| `client_approved` | `completed` |

מעברים לא מותרים → `409 { ok: false, code: "TRANSITION_NOT_ALLOWED", current, allowed }`.

#### `POST /api/cpanel/clients/:phone/products/:type/send-to-client`

Body: `{}`

Guard: ה-`productStatus` הנוכחי חייב להיות `pending_manager_approval`. אחרת → `400 { error: "STATUS_NOT_READY", productStatus }`.

בהצלחה:
- מעדכן `productStatus = sent_to_client` + `clientApprovalStatus = sent`
- שולח Expo push (best-effort) דרך `users.expoPushToken` או `users.expoToken`
- מחזיר `{ success, productType, productStatus, pushSent, pushReason }`

`pushSent: false` עם `pushReason` = `"no_token"` או `"bad_token_format"` כשללקוח אין טוקן תקין. **זה לא כשלון** — הסטטוס בכל זאת מתעדכן.

---

## CPanel (frontend)

### קבצים חדשים / מעודכנים

- `src/api/client.ts` — נוספו טיפוסים `ProductStatus` / `ProductType` / `ProductStatusEntry` ושלוש פונקציות:
  - `getProductStatuses(phone)`
  - `sendProductToClient(phone, type)`
  - `updateProductStatus(phone, type, status)`
- `src/components/client-detail/ProductStatusTable.tsx` — קובץ חדש, הטבלה.
- `src/components/tabs/ProductsTab.tsx` — מוסיף `<ProductStatusTable />` בראש העמוד, מעל `<PackageBanner />`.

### מבנה הטבלה

לכל סוג מוצר (ads / organic / lp) — שורה אחת:
- אייקון + שם המוצר
- pill צבעוני עם הסטטוס הנוכחי (9 ערכים, ראה מיפוי למטה)
- כפתור "שלח ללקוח ▶" (מוצג רק כשהסטטוס הוא `pending_manager_approval`)

לחיצה על "שלח ללקוח":
1. window.confirm: "לשלוח את [המוצר] ל[שם הלקוח] לאישור?"
2. POST ל-`/products/:type/send-to-client`
3. בהצלחה: toast עם ציון אם ה-push נשלח, וטעינה מחדש של הטבלה

### מיפוי צבעים

| productStatus | תווית | צבע |
|---|---|---|
| `pending_characterization` | ממתין להשלמת האיפיון | `#5C5F66` אפור |
| `sent_for_creation` | נשלח ליצירה (pulse) | `#1E88E5` כחול |
| `pending_manager_approval` | ממתין לאישור מנהל התיק | `#FB8C00` כתום |
| `sent_to_client` | נשלח לאישור הלקוח | `#0000B2` כחול כהה |
| `client_returned_corrections` | הלקוח החזיר תיקונים | `#E53935` אדום |
| `in_correction` | בתיקון | `#D84315` כתום כהה |
| `corrections_completed` | הושלמו תיקונים | `#7B1FA2` סגול |
| `client_approved` | לקוח אישר ✓ | `#2E7D32` ירוק |
| `completed` | הסתיים טיפול ✓ | `#1B5E20` ירוק כהה |

---

## מה עדיין לא נעשה

### 2.3 Status bar + manual transition buttons בכל פאנל

ה-spec ביקש שגם בתוך כל `WowAdsPanel` / `WowOrganicPanel` / `WowLpPanel` יוצג badge של הסטטוס + כפתור dropdown למעבר ידני (התחל תיקון / סיים תיקונים / מוכן לשליחה / סגור טיפול).

**לא מומש** — הטבלה בראש ה-`ProductsTab` כבר מספקת את הסטטוס + הכפתור החשוב ("שלח ללקוח"). ה-PUT endpoint למעברים ידניים **קיים** וזמין — ה-UI שלו פשוט עוד לא בנוי.

לכשיבנה — יקרא את:
```ts
import { updateProductStatus, type ProductStatus } from "../../api/client";

await updateProductStatus(phone, "ads", "in_correction");
```

עם 4 כפתורים בהתאם למיפוי המעברים בטבלה למעלה.

### 3. מסך התקדמות באפליקציית הלקוח (React Native)

**זה לצוות האפליקציה.** השרת כבר מוכן — אפשר להשיג את הסטטוסים דרך
`GET /api/cpanel/clients/:phone/products/status` (Auth מנהל) או דרך endpoint
פומבי חדש שייבנה (כמו `GET /api/client/products/status?phone=...`) — לא בנוי
עדיין כי טרם תואמה האימות בצד הלקוח.

הצעה מההמלצות בספק:

```
מודעות ממומנות   [=====>       ] 3/9 — ממתין לאישור
פוסטים אורגניים  [==>          ] 2/9 — בייצור...
דף נחיתה         [==========>  ] 8/9 — לקוח אישר ✓
```

---

## בדיקה אחרי deploy

1. ✓ `GET /products/status` ללקוח חדש (אין sessions) → 3× `{ pending_characterization, false }`
2. ✓ "צור מודעות" בפאנל → תוך שניות הסטטוס בטבלה זז ל-`sent_for_creation` עם pulse
3. ✓ Pipeline מסיים → הסטטוס בטבלה זז ל-`pending_manager_approval` (כתום), כפתור "שלח ללקוח" מופיע
4. ✓ לחיצה על "שלח ללקוח" → confirm → toast → סטטוס ל-`sent_to_client`, ולקוח עם `expoToken` תקין מקבל push
5. ✓ אישור/דחייה של פריטים באפליקציה → סטטוס בטבלה זז ל-`client_approved` או `client_returned_corrections`
6. ✓ נסיון PUT לסטטוס לא חוקי (למשל `pending_characterization` → `client_approved`) → 409

---

## PRs

- שרת: `feat/per-product-status` — https://github.com/IconiqMotion/iconiq-server/pull/new/feat/per-product-status
- CPanel: `feat/product-status-table` — https://github.com/IconiqMotion/C-panel/pull/new/feat/product-status-table

לאחר merge ב-deploy אוטומטי (AWS pm2 + Heroku) — הטבלה גלויה בכל לקוח עם חבילה.

---

## שאלות פתוחות מהספק — תשובות

1. **שליחה ללקוח:** מומש כמומלץ — **לכל מוצר כפתור נפרד**. הלוגיקה הישנה
   `sendProductsForApproval` (כל המוצרים יחד) נשארה כפי שהיא לתאימות. שני
   הזרמים יושבים זה לצד זה.

2. **הודעה ללקוח:** הסטטוס `sent_to_client` מפעיל **Expo Push בלבד** ב-
   v1. WhatsApp/SMS לא נוסף — אפשר להוסיף בקלות אם צריך (יש כבר
   `greenapi.service.js` ו-`sms4free.service.js`).

3. **מי שולח את הפידבק על תיקונים:** האפליקציה — דרך
   `POST /api/client/project-detail/:id/reject` עם שדה `feedback` בגוף.
   זה כבר קיים ועובד.
