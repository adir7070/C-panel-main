# מטלת שרת — הצגת חבילות באפליקציית לקוח

עודכן: 06.05.2026

---

## הבעיה

הלקוח רכש חבילה — היא נשמרת ב-`users.activePackage` — אך לא מוצגת באפליקציה.

ה-endpoint הנוכחי (`GET /api/client/projects`) קורא רק מ-`wow_ads_sessions`, `wow_organic_ads_sessions`, `wow_lp_sessions`.
הוא לא קורא כלל מ-`users.activePackage`.

---

## סטטוסים — רשימה מלאה

כל חבילה חייבת לשאת שדה `status` עם אחד מהערכים הבאים:

| ערך (באנגלית — מה שנשמר ב-DB) | טקסט לתצוגה (עברית) | צבע בבר |
|---|---|---|
| `waiting_brief` | ממתין להשלמת האיפיון | `#667085` אפור |
| `sent_to_creation` | נשלח ליצירה | `#0000B2` כחול |
| `waiting_manager_approval` | ממתין לאישור מנהל התיק | `#0000B2` כחול |
| `sent_to_client` | נשלח לאישור הלקוח | `#0000B2` כחול |
| `client_returned_corrections` | הלקוח החזיר תיקונים | `#C62828` אדום |
| `in_correction` | בתיקון | `#C62828` אדום |
| `corrections_done` | הושלמו תיקונים | `#0000B2` כחול |
| `client_approved` | לקוח אישר | `#2E7D32` ירוק |
| `completed` | הסתיים טיפול | `#667085` אפור |

**ברירת מחדל בעת יצירת חבילה חדשה:** `"waiting_brief"`

---

## מה נדרש מהשרת

### 1. הוסף `status` לאובייקט `activePackage` בכל מקום שהוא נכתב

**קובץ:** `controllers/cpanel.controller.js`
- פונקציה `activePackageFromPending` (שורה ~2448)
- פונקציית `paymentNotify`

```js
// הוסף לאובייקט:
status: "waiting_brief"   // ברירת מחדל — נרכש, טרם נמלא איפיון
```

---

### 2. עדכן `GET /api/client/projects` להחזיר גם את `activePackage`

**קובץ:** `controllers/client-projects.controller.js`

```js
// שלוף את ה-user ואת activePackage שלו
const user = await getDB().collection("users").findOne(
  { phone },
  { projection: { activePackage: 1 } }
);

if (user?.activePackage) {
  const pkg = user.activePackage;
  projects.push({
    id:     `pkg_${pkg.id}_${pkg.purchasedAt}`,
    name:   pkg.name || "חבילה",
    date:   pkg.purchasedAt,
    status: pkg.status || "waiting_brief",
    contents: {
      ads_sponsored: pkg.items?.paidAds    || 0,
      ads_social:    pkg.items?.organicAds || 0,
      carousels:     pkg.items?.carousels  || 0,
      logo:          pkg.items?.logos      || 0,
      landing_page:  pkg.items?.lps        || 0,
      video:         pkg.items?.videos     || 0,
    },
  });
}
```

**חשוב:** כלול אותו במיון `cleaned` לפי תאריך.

---

### 3. פרטי חבילה ללא תוצרים עדיין

`GET /api/client/project-detail?phone=&projectId=pkg_...`

כשה-id מתחיל ב-`pkg_` — שלוף מ-`users.activePackage` ולא מה-sessions.
החזר:

```json
{
  "id": "pkg_...",
  "name": "חבילת פלטינום",
  "overallStatus": "waiting_brief",
  "ads_sponsored": [],
  "ads_social": [],
  "carousels": [],
  "logo": [],
  "landing_page": [],
  "video": []
}
```

האפליקציה תציג הודעה מתאימה לפי הסטטוס.

---

### 4. עדכון סטטוס מנהל החשבון

**endpoint נדרש:**
```
PATCH /api/client/project-detail/:id/status
Body: { "phone": "...", "status": "sent_to_creation" }
```

המנהל יעדכן את הסטטוס דרך הCPanel שלו בכל מעבר שלב.

---

### 5. תמיכה ביותר מחבילה אחת

כרגע `users.activePackage` = אובייקט יחיד.

**הצעה:** הוסף מערך `packages` לצד `activePackage`:
```js
packages: [
  { ...activePackage },       // הנוכחית
  { ...previousPackage },     // ישנה
]
```

או: קרא מ-`cpanel_pending_purchases` לפי `phone` + `status: "completed"`.

**לתאום עם הצוות.**

---

## מיפוי שדות: `items` → `contents`

| שדה ב-`items` | שדה ב-`contents` (API ← אפליקציה) |
|---|---|
| `paidAds` | `ads_sponsored` |
| `organicAds` | `ads_social` |
| `logos` | `logo` |
| `lps` | `landing_page` |
| `videos` | `video` |
| (לא קיים) | `carousels` = 0 |

---

## סיכום — מה חסר

| # | משימה | קובץ |
|---|---|---|
| 1 | הוסף `status: "waiting_brief"` ל-`activePackage` בכתיבה | `cpanel.controller.js` |
| 2 | קרא `users.activePackage` ב-`getClientProjects` | `client-projects.controller.js` |
| 3 | טיפול ב-`project-detail` עבור id שמתחיל ב-`pkg_` | `client-projects.controller.js` |
| 4 | endpoint לעדכון סטטוס ע"י מנהל | חדש |
| 5 | תאם: היסטוריית חבילות (יותר מאחת) | — |
