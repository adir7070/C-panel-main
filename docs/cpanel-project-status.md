# CPanel — ניהול סטטוס פרויקט + כפתורי פעולה

## רקע

כל לקוח שרכש חבילה מאוחסן ב-MongoDB תחת:
```
collection: users
field:      activePackage
```

הסטטוס הנוכחי של החבילה נמצא ב:
```
users.activePackage.status   ← כאן מתעדכן הסטטוס
users.activePackage.name     ← שם החבילה (ידנית למשל "חבילת פלטינום")
users.activePackage.purchasedAt ← תאריך הרכישה
users.activePackage.statusUpdatedAt ← תאריך עדכון הסטטוס האחרון
```

התמונות/תוצרים עצמם מאוחסנים בשלושה collections:
```
wow_ads_sessions              → שדה: generatedAds[].imageUrl   (ממומן)
wow_organic_ads_sessions      → שדה: generatedPosts[].imageUrl (סושיאל / קרוסלות)
wow_lp_sessions               → שדה: previewUrl               (דף נחיתה)
```
כולם מקושרים ללקוח לפי שדה `phone`.

---

## 9 הסטטוסים — זרימה ומשמעות

| # | ערך ב-DB | תצוגה ללקוח | מי מעביר | צבע |
|---|-----------|-------------|----------|-----|
| 1 | `waiting_brief` | ממתין להשלמת האיפיון | **אוטומטי** (ברגע יצירת החבילה) | אפור `#667085` |
| 2 | `sent_to_creation` | נשלח ליצירה | **מנהל תיק** (כפתור: "שלח לצוות יצירה") | כחול `#0000B2` |
| 3 | `waiting_manager_approval` | ממתין לאישור מנהל התיק | **אוטומטי** (AI סיים ליצור) | כחול `#0000B2` |
| 4 | `sent_to_client` | נשלח לאישור הלקוח | **מנהל תיק** (כפתור: "שלח לאישור לקוח") | כחול `#0000B2` |
| 5 | `client_returned_corrections` | הלקוח החזיר תיקונים | **אוטומטי** (לקוח דחה בתגובה) | אדום `#C62828` |
| 6 | `in_correction` | בתיקון | **מנהל תיק** (כפתור: "התחל תיקון") | אדום `#C62828` |
| 7 | `corrections_done` | הושלמו תיקונים | **מנהל תיק** (כפתור: "תיקונים הושלמו") | כחול `#0000B2` |
| 8 | `client_approved` | לקוח אישר | **אוטומטי** (לקוח אישר) | ירוק `#2E7D32` |
| 9 | `completed` | הסתיים טיפול | **מנהל תיק** (כפתור: "סמן כהושלם") | אפור `#667085` |

---

## ה-Endpoint לעדכון סטטוס

כבר קיים בשרת:

```
PATCH /api/client/project-detail/:id/status
Authorization: Bearer <cpanel_token>

Body (JSON):
{
  "phone":  "0543089955",
  "status": "sent_to_client"
}
```

- `:id` — המזהה של הפרויקט. עבור חבילה זה מתחיל ב-`pkg_` (למשל `pkg_basic_2025-01-15`)
- הסטטוס מתעדכן ב-`users.activePackage.status`

**תשובה:**
```json
{ "success": true, "id": "pkg_...", "status": "sent_to_client", "matched": 1, "modified": 1 }
```

---

## ה-Endpoint לשליפת פרטי פרויקט (כולל תמונות + URL)

```
GET /api/client/project-detail?phone=<phone>&projectId=<projectId>
```

**תשובה** (בין השאר):
```json
{
  "overallStatus": "sent_to_client",
  "ads_sponsored": [
    {
      "id": "abc_123",
      "imageUrl": "https://...cloudinary.com/...",
      "headline": "כותרת המודעה",
      "status": "pending"
    }
  ],
  "ads_social": [ ... ],
  "carousels":  [ ... ],
  "landing_page": [
    {
      "id": "lp_xyz",
      "imageUrl": "https://app.iconiqmedia.co.il/wow-lp-review/<token>",
      "status": "pending"
    }
  ]
}
```

> **חשוב:** ה-`imageUrl` בכל פריט הוא **ה-URL לצפייה בתמונה/דף**. עבור לנדינג פייג' הוא URL לדף המלא. עבור פרסומות/סושיאל הוא URL לתמונה ב-Cloudinary.

---

## מה צריך לבנות ב-CPanel

### 1. סרגל סטטוס בראש דף הלקוח (`ClientDetailPage.tsx`)

הצג בפינה בולטת:
```
📦 חבילת פלטינום   [● נשלח לאישור הלקוח]
```

שליפה:
```ts
import { getActivePackage } from "../api/client";
// מחזיר activePackage שכולל כרגע את id, name, purchasedAt, items
// צריך להוסיף גם status (ראה שינוי API למטה)
```

> **דרוש שינוי ב-endpoint השרת:** עדכן את `/cpanel/clients/:phone/package` שיחזיר גם את שדה `status` מ-`activePackage`.

---

### 2. כפתורי פעולה לפי סטטוס נוכחי

הצג **רק את הכפתורים הרלוונטיים** לפי הסטטוס הנוכחי:

| סטטוס נוכחי | כפתורים שמוצגים |
|-------------|----------------|
| `waiting_brief` | — (ממתין לאיפיון — אין כפתור) |
| `sent_to_creation` | — (בהמתנה ל-AI) |
| `waiting_manager_approval` | **"אשר ושלח ללקוח"** → `sent_to_client` |
| `sent_to_client` | — (ממתין ללקוח) |
| `client_returned_corrections` | **"התחל תיקון"** → `in_correction` |
| `in_correction` | **"תיקונים הושלמו"** → `corrections_done` |
| `corrections_done` | **"שלח שוב ללקוח"** → `sent_to_client` |
| `client_approved` | **"סמן כהושלם"** → `completed` |
| `completed` | — |

כפתור בכל שלב (כולל "שלח לאישור לקוח" ו"שלח לצוות יצירה" כשרלוונטי).

---

### 3. רשימת תוצרים עם לינק לצפייה

מתחת לסרגל הסטטוס, הצג טבלה:

| סוג | מספר תוצרים | סטטוס | לינק |
|-----|------------|-------|------|
| ממומן | 10 | ● ממתין | 🔗 [צפה בתמונות] |
| סושיאל | 5 | ✓ מאושר | 🔗 [צפה בתמונות] |
| דף נחיתה | 1 | ● ממתין | 🔗 [פתח דף] |

שליפה מ-`GET /api/client/project-detail?phone=...&projectId=pkg_...`
ה-`imageUrl` של כל פריט = הלינק לצפייה.

---

## קוד להוספה ב-`client.ts` (CPanel API)

```ts
export type PackageStatus =
  | "waiting_brief"
  | "sent_to_creation"
  | "waiting_manager_approval"
  | "sent_to_client"
  | "client_returned_corrections"
  | "in_correction"
  | "corrections_done"
  | "client_approved"
  | "completed";

export function updatePackageStatus(phone: string, projectId: string, status: PackageStatus) {
  return req<{ success: boolean; status: string }>(
    `/client/project-detail/${encodeURIComponent(projectId)}/status`,
    {
      method: "PATCH",
      body: JSON.stringify({ phone, status }),
    }
  );
}

export function getProjectDetail(phone: string, projectId: string) {
  return req<ProjectDetail>(
    `/client/project-detail?phone=${encodeURIComponent(phone)}&projectId=${encodeURIComponent(projectId)}`
  );
}

export interface ProjectDetail {
  overallStatus: PackageStatus;
  ads_sponsored: ProductItem[];
  ads_social:    ProductItem[];
  carousels:     ProductItem[];
  logo:          ProductItem[];
  landing_page:  ProductItem[];
  video:         ProductItem[];
}

export interface ProductItem {
  id:       string;
  imageUrl: string | null;
  headline: string;
  status:   "pending" | "approved" | "rejected";
}
```

---

## שינוי קטן ב-cpanel.controller.js

ה-endpoint הקיים `/cpanel/clients/:phone/package` כרגע לא מחזיר `status`.
יש להוסיף:

```js
// בתוך הפונקציה getActivePackage
res.json({
  ...pkg,
  status: pkg.status || "waiting_brief",   // ← הוסף שורה זו
});
```

---

## סיכום קצר מה לבנות

1. **שרת** — הוסף `status` לתשובת `/cpanel/clients/:phone/package`
2. **CPanel `client.ts`** — הוסף `updatePackageStatus`, `getProjectDetail`, וטיפוסים
3. **CPanel `ClientDetailPage.tsx`** — הוסף:
   - סרגל "שם חבילה + סטטוס נוכחי" בראש הדף
   - כפתורי פעולה דינמיים לפי סטטוס
   - טבלת תוצרים עם לינקים לצפייה
