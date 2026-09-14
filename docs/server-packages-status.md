# מטלת שרת — חבילות באפליקציית לקוח · סטטוס

עודכן: 06.05.2026

המסמך הזה מסכם מה כבר נעשה בשרת מול ה-spec ב-`server-packages-task.md`,
ואיזה חוזה ה-API מחזיר עכשיו לאפליקציית הלקוח.

---

## ✅ מה נעשה

### 1. `status` נוסף לאובייקט `activePackage`

**קובץ:** `controllers/cpanel.controller.js`

נוסף `status: "waiting_brief"` בכל מקום שכותב `activePackage`:

| איפה | מתי רץ |
|---|---|
| `paymentNotify` (~שורה 1303) | webhook של Cardcom — תשלום ראשון |
| `activePackageFromPending` (~שורה 2448) | פונקציית בנייה משותפת |
| `replayCardcomTransaction` (~שורה 2473) | שחזור ידני מנהל |
| `getClientPackage` self-heal (~שורה 2643) | תיקון אוטומטי בקריאה |

**שדות בדוקומנט `users.activePackage`:**

```js
{
  id:          "platinum",                 // package SKU
  name:        "חבילת פלטינום",
  purchasedAt: "2026-05-06T07:23:11.000Z",
  items: {
    paidAds:    35,
    organicAds: 17,
    videos:     1,
    lps:        1,
    logos:      0,
  },
  coins: 1500,
  status: "waiting_brief",                 // ← חדש
}
```

ערכי `status` הקבילים — אותם תשעה מה-spec:
`waiting_brief` · `sent_to_creation` · `waiting_manager_approval` · `sent_to_client` · `client_returned_corrections` · `in_correction` · `corrections_done` · `client_approved` · `completed`

ברירת מחדל בקריאה: `"waiting_brief"` (אם השדה חסר במסד — קוראת לו ככה).

---

### 2. `GET /api/client/projects?phone=` מחזיר את החבילה

**קובץ:** `controllers/client-projects.controller.js` (`getClientProjects`)

הקוד שולף את `users.activePackage` ומוסיף אותו לראש מערך `projects` עם
ה-id `pkg_<packageId>_<safeDate>`. אם אין חבילה — לא נוסף שום דבר.

**מיפוי `items` → `contents`** (מוטמע):

| `users.activePackage.items` | `projects[].contents` |
|---|---|
| `paidAds` | `ads_sponsored` |
| `organicAds` | `ads_social` |
| `videos` | `video` |
| `lps` | `landing_page` |
| `logos` | `logo` |
| (לא קיים) | `carousels = 0` |

**דוגמת תגובה:**

```json
{
  "projects": [
    {
      "id":     "pkg_platinum_2026-05-06T07-23-11-000Z",
      "name":   "חבילת פלטינום",
      "date":   "2026-05-06T07:23:11.000Z",
      "status": "waiting_brief",
      "contents": {
        "ads_sponsored": 35,
        "ads_social":    17,
        "carousels":     0,
        "logo":          0,
        "landing_page":  1,
        "video":         1
      }
    },
    /* ...sessions ישנים (ads/organic/lp) באים אחרי החבילה ─ */
  ]
}
```

---

### 3. `GET /api/client/project-detail?phone=&projectId=pkg_...`

**קובץ:** `controllers/client-projects.controller.js` (`getClientProjectDetail`)

כש-`projectId` מתחיל ב-`pkg_`:
- שולף את `users.activePackage` (לסטטוס + שם)
- שולף **כל** ה-sessions של הלקוח (ads / organic / lp) ומאחד את הפריטים שאושרו ע"י המנהל
- מחזיר את ששת המערכים מלאים בכל הפריטים שיש כרגע (יכולים להיות ריקים)

**שדות התגובה:**

```json
{
  "id":            "pkg_platinum_...",
  "name":          "חבילת פלטינום",
  "date":          "2026-05-06T...",
  "overallStatus": "waiting_brief",
  "ads_sponsored": [{ "id": "...", "imageUrl": "...", "headline": "...", "status": "pending" }],
  "ads_social":    [...],
  "carousels":     [...],
  "logo":          [],
  "landing_page":  [{ "id": "...", "imageUrl": "..." }],
  "video":         []
}
```

`overallStatus` נלקח מ-`users.activePackage.status` (לא מ-status של ה-sessions).

---

### 4. PATCH endpoint לעדכון סטטוס ע"י המנהל

**מסלול:** `PATCH /api/client/project-detail/:id/status` · body `{ phone, status }`

**קובץ:** `controllers/client-projects.controller.js` · `exports.updateClientProjectStatus`

ולידציות:
- `id` חייב להתחיל ב-`pkg_` (sessions ממשיכים להשתמש ב-approve/reject)
- `phone` חייב להישלח בגוף הבקשה
- `status` חייב להיות אחד מתשעת הערכים של `PACKAGE_STATUSES`

**עדכון במסד:** `users.updateOne({ phone }, { $set: { "activePackage.status": ..., "activePackage.statusUpdatedAt": ... } })`

**Socket push:** משתמש ב-`pushManagerNotification` (אותו פטרן של approve/reject) — שולח event `client_review_responded` למנהל החשבון.

**תגובה:**

```json
{ "success": true, "id": "pkg_platinum_...", "status": "sent_to_creation", "matched": 1, "modified": 1 }
```

**רשימת ערכים תקפים** (יוצאת מהקובץ):

```js
const PACKAGE_STATUSES = [
  "waiting_brief",
  "sent_to_creation",
  "waiting_manager_approval",
  "sent_to_client",
  "client_returned_corrections",
  "in_correction",
  "corrections_done",
  "client_approved",
  "completed",
];
```

---

## ⏳ מה עדיין לא נעשה

### 5. תמיכה ביותר מחבילה אחת

לא מומש — ממתין לתיאום עם הצוות (איך מציגים? `users.packages: []` מערך, או scan
של `cpanel_pending_purchases`?). כרגע `users.activePackage` הוא אובייקט יחיד
ש-paymentNotify דורס בכל רכישה חדשה.

---

## בדיקת שדה — לקוחות קיימים

לקוחות שרכשו לפני התוספת לא יחזיקו `status` במסמך. הקוד נופל ל-
`"waiting_brief"` בקריאה (UI יראה "ממתין להשלמת האיפיון") — אין צורך ב-migration.

אם רוצים שדה פיזי במסד, הרצה חד-פעמית ב-Atlas:

```js
db.users.updateMany(
  { activePackage: { $exists: true }, "activePackage.status": { $exists: false } },
  { $set: { "activePackage.status": "waiting_brief" } }
)
```

---

## מסלולים פעילים בשרת אחרי השינוי

```
GET   /api/client/projects?phone=                       ← מחזיר חבילה + sessions
GET   /api/client/project-detail?phone=&projectId=      ← מטפל גם ב-pkg_*
POST  /api/client/project-detail/:id/approve            ← sessions בלבד
POST  /api/client/project-detail/:id/reject             ← sessions בלבד
PATCH /api/client/project-detail/:id/status             ← לעדכון מנהל (pkg_* בלבד)
```

---

## סיכום משימות

| # | משימה | סטטוס |
|---|---|---|
| 1 | `status` ב-`activePackage` בכל הכתיבות | ✅ |
| 2 | `getClientProjects` קורא `users.activePackage` | ✅ |
| 3 | `getClientProjectDetail` תומך `pkg_*` | ✅ |
| 4 | PATCH endpoint לעדכון סטטוס | ✅ |
| 5 | היסטוריית חבילות | ⏳ ממתין לתיאום |
