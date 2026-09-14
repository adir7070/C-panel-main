# CPanel — ניהול סטטוס פרויקט · סטטוס ביצוע

עודכן: 06.05.2026

מסמך זה מסכם מה נעשה בפועל מול ה-spec ב-`cpanel-project-status.md`,
ומה פעיל עכשיו בשרת + ב-CPanel אחרי ה-merge של שני ה-PRs.

---

## סיכום משימות

| # | משימה | סטטוס |
|---|---|---|
| 1 | שרת: `/cpanel/clients/:phone/package` מחזיר `status` | ✅ |
| 2 | שרת: `PATCH /api/client/project-detail/:id/status` | ✅ |
| 3 | שרת: `GET /api/client/project-detail` תומך `pkg_*` | ✅ |
| 4 | שרת: `POST /cpanel/clients/:phone/products/send-for-approval` | ✅ |
| 5 | שרת: `GET /cpanel/clients/:phone/products/latest-review` | ✅ |
| 6 | שרת: `GET /cpanel/reviews` | ✅ |
| 7 | CPanel: סוגים + מתודות API ב-`client.ts` | ✅ |
| 8 | CPanel: סרגל סטטוס בראש דף הלקוח | ✅ |
| 9 | CPanel: כפתורי פעולה דינמיים לפי סטטוס | ✅ |
| 10 | CPanel: טבלת תוצרים עם לינקים לצפייה | ✅ |

---

## 1. השרת (iconiq-server)

### השדה `status` ב-`users.activePackage`

נוסף `status: "waiting_brief"` בכל מקום שה-activePackage נכתב:

```js
{
  id:          "platinum",
  name:        "חבילת פלטינום",
  purchasedAt: "2026-05-06T07:23:11.000Z",
  items: { paidAds: 35, organicAds: 17, videos: 1, lps: 1, logos: 0 },
  coins: 1500,
  status: "waiting_brief"          // ← נוסף
}
```

לקוחות שרכשו לפני התוספת: השדה חסר במסמך, אך הקריאות מחזירות `"waiting_brief"`
כברירת מחדל (אין צורך ב-migration).

### תשעת הסטטוסים

| ערך | תצוגה | מי מעביר | צבע |
|---|---|---|---|
| `waiting_brief` | ממתין להשלמת האיפיון | אוטומטי (יצירת חבילה) | `#667085` |
| `sent_to_creation` | נשלח ליצירה | מנהל | `#0000B2` |
| `waiting_manager_approval` | ממתין לאישור מנהל התיק | אוטומטי (AI סיים) | `#0000B2` |
| `sent_to_client` | נשלח לאישור הלקוח | מנהל / send-for-approval | `#0000B2` |
| `client_returned_corrections` | הלקוח החזיר תיקונים | אוטומטי (לקוח דחה) | `#C62828` |
| `in_correction` | בתיקון | מנהל | `#C62828` |
| `corrections_done` | הושלמו תיקונים | מנהל | `#0000B2` |
| `client_approved` | לקוח אישר | אוטומטי (לקוח אישר) | `#2E7D32` |
| `completed` | הסתיים טיפול | מנהל | `#667085` |

### Endpoints פעילים

```
# סטטוס + תוכן
GET   /api/cpanel/clients/:phone/package                       (auth)
GET   /api/client/projects?phone=                              (no auth)
GET   /api/client/project-detail?phone=&projectId=             (no auth)
PATCH /api/client/project-detail/:id/status                    (no auth, body: { phone, status })

# Consolidated review
POST  /api/cpanel/clients/:phone/products/send-for-approval    (auth)
GET   /api/cpanel/clients/:phone/products/latest-review        (auth)
GET   /api/cpanel/reviews?status=&limit=                       (auth)
```

### `POST /products/send-for-approval` — איך זה עובד

1. אוסף מ-`wow_ads_sessions` / `wow_organic_ads_sessions` / `wow_lp_sessions` את כל הפריטים שאושרו ע"י המנהל (`managerApprovedAt` מסומן)
2. דורש לפחות פריט מאושר אחד — אחרת מחזיר `400`
3. מייצר token, יוצר רשומה ב-`cpanel_product_reviews`
4. מעדכן `users.activePackage.status` ל-`sent_to_client`
5. שולח SMS + WhatsApp ללקוח עם הלינק `https://app.iconiqmedia.co.il/products-review/<token>`
6. מחזיר `{ success, token, previewUrl, summary, sentChannels }`

### Collection חדש: `cpanel_product_reviews`

```js
{
  phone:       "0543089955",
  token:       "abc123def456",
  agentId:     "...",
  packageName: "חבילת פלטינום",
  status:      "sent" | "approved" | "rejected",
  sentAt:      ISODate,
  respondedAt: ISODate | null,
  feedback:    string | null,
  ads:      { count: 35, items: [...] },
  organic:  { count: 17, items: [...] },
  carousels:{ count: 0 },
  lp:       { present: true, sessionId: "..." },
  logo:     { count: 0 },
  video:    { count: 0 },
  createdAt, updatedAt,
}
```

---

## 2. CPanel — `src/api/client.ts`

נוספו טיפוסים + מתודות:

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

export interface ProductItem {
  id:       string;
  imageUrl: string | null;
  headline: string;
  status:   "pending" | "approved" | "rejected";
}

export interface ProjectDetail {
  id:            string;
  name:          string | null;
  date:          string;
  overallStatus: PackageStatus;
  ads_sponsored: ProductItem[];
  ads_social:    ProductItem[];
  carousels:     ProductItem[];
  logo:          ProductItem[];
  landing_page:  ProductItem[];
  video:         ProductItem[];
}

export function getProjectDetail(phone: string, projectId: string): Promise<ProjectDetail>;
export function updatePackageStatus(phone: string, projectId: string, status: PackageStatus);
```

`ClientPackage` קיבל שדה `status: PackageStatus`.

---

## 3. CPanel — סרגל הסטטוס

**קובץ חדש:** `src/components/client-detail/PackageStatusBanner.tsx`
**שילוב:** `src/pages/ClientDetailPage.tsx` — בין סרגל הזיהוי לבין ה-Tabs.
לכן הסרגל גלוי מכל טאב.

### מה הסרגל מציג

1. **כותרת:** `📦 חבילת פלטינום` + pill צבעוני עם הסטטוס הנוכחי (תווית עברית + צבע מהמיפוי)
2. **כפתורי פעולה דינמיים** — רק אלה התקפים בסטטוס הנוכחי:

| סטטוס | כפתור | מעביר ל- |
|---|---|---|
| `waiting_brief` | שלח לצוות יצירה | `sent_to_creation` |
| `waiting_manager_approval` | אשר ושלח ללקוח | `sent_to_client` |
| `client_returned_corrections` | התחל תיקון | `in_correction` |
| `in_correction` | תיקונים הושלמו | `corrections_done` |
| `corrections_done` | שלח שוב ללקוח | `sent_to_client` |
| `client_approved` | סמן כהושלם | `completed` |
| `sent_to_creation` / `sent_to_client` / `completed` | (בלי כפתור) | — |

לחיצה → `PATCH /api/client/project-detail/pkg_*/status` → toast הצלחה → ה-pill מתעדכן מיד ללא reload.

3. **טבלת תוצרים** — עבור כל סוג שיש בו פריטים:

| עמודה | תוכן |
|---|---|
| סוג | ממומן / סושיאל / קרוסלות / דף נחיתה / וידאו / לוגו |
| כמות | מספר פריטים |
| סטטוס מצרפי | ✓ מאושר (כל הפריטים אושרו) / ● נדחה (לפחות אחד נדחה) / ● ממתין |
| לינק | 🔗 פתיחת התמונה / דף הנחיתה ב-tab חדש |

**מקור הנתונים:** `GET /api/client/project-detail?phone=&projectId=pkg_*`
ה-`imageUrl` של כל פריט הוא הלינק הפעיל.

### מה קורה אם אין חבילה פעילה
הסרגל מוסתר לחלוטין (אין שום פגיעה ויזואלית בדף).

---

## 4. הערות שילוב חשובות

### `pkg_id` — איך נבנה
מצד שרת: `pkg_${pkg.id || "custom"}_${pkg.purchasedAt.replace(/[:.]/g, "-")}`
ב-CPanel הסרגל בונה אותו זהה (`buildPkgId`) — חובה לשמור על אותה לוגיקה אם משנים בעתיד.

### דף `/products-review/:token` באפליקציית הלקוח
ה-`previewUrl` שנשלח ב-SMS מצביע ל:
```
https://app.iconiqmedia.co.il/products-review/<token>
```

**יש לוודא** שהמסלול הזה קיים באפליקציית הלקוח. אם לא — הלקוח יקבל 404
ב-SMS. מומלץ לבדוק לפני שליחה ראשונה.

### לקוחות קיימים (לפני ההוספה)
- אריאל מזרחי (`0542587070`) — חבילת פלטינום
- אליהו טורס (`0528393196`) — אין חבילה (נראה שלא רכש דרך CPanel)
- החלקות נוי (`0543089955`) — חבילת פלטינום

עבור לקוחות עם חבילה, ה-`status` יחזור `"waiting_brief"` בקריאה (default).
לאחר שהמנהל ילחץ על כפתור פעם ראשונה — השדה יישמר במסמך.

---

## 5. מה לבדוק אחרי deploy

1. ✓ פתח לקוח עם חבילה → סרגל מופיע עם "ממתין להשלמת האיפיון"
2. ✓ לחץ "שלח לצוות יצירה" → ה-pill מתחלף ל"נשלח ליצירה"
3. ✓ ב-MongoDB: `users.activePackage.status` = `"sent_to_creation"`
4. ✓ במצב `waiting_manager_approval` (חוצה אוטומטית כש-AI מסיים) — לחץ "אשר ושלח ללקוח" → SMS נשלח ללקוח
5. ✓ Console נקי מ-`latest-review` 404
6. ✓ דף `/api/cpanel/reviews` מחזיר את הרשומה החדשה

---

## PRs

- שרת: `feat/products-send-for-approval` — merged ל-main
- שרת קודם: `feat/package-status-lifecycle` — merged ל-main
- CPanel: `feat/package-status-banner` — merged ל-main

הכל פעיל לאחר שה-deployments הסתיימו (AWS pm2 + Heroku).
