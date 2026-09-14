# קטלוג אישי — מדריך טכני לדב

> **קהל יעד:** מפתח שמכיר את הבסיס נתונים ורוצה להוסיף פיצ'רים על גבי הנתונים הקיימים.  
> **מערכת:** C-Panel (React + Express proxy). הבקאנד חי ב-`https://api.iconiqmedia.co.il`.

---

## 1. מה זה הקטלוג האישי

כל לקוח יכול לקבל **חבילות מותאמות אישית** שהסוכן בונה עבורו.  
החבילה גלויה ללקוח **באפליקציה שלו** לרכישה עצמאית, ואפשר גם לחייב ישירות מה-CPanel.

---

## 2. מודל הדאטה — `PersonalPackage`

```ts
interface PersonalPackage {
  _id:          string;          // MongoDB ObjectId
  phone:        string;          // מספר הלקוח — מפתח לחיפוש (e.g. "0526706503")
  agentId:      string;          // id הסוכן שיצר את ההצעה — קריטי לאנליטיקס
  name:         string;          // שם החבילה (e.g. "חבילת הפתעה לדנה")
  items:        Record<string, number>; // { "posts": 8, "reels": 4, ... } כמויות לפי מפתח פריט
  bullets:      string[];        // תיאור שנשלח לאפליקציה (אוטו-גנרטד בשמירה)
  basePrice:    number;          // מחיר לפני הנחה (₪, מחושב אוטומטית לפי items + coins)
  discountPct:  number;          // % הנחה (0-20 לסוכן רגיל, 0-100 לאדמין)
  finalPrice:   number;          // מחיר סופי = basePrice * (1 - discountPct/100)
  coins:        number;          // כמות מטבעות שהלקוח מקבל (0 = ללא)
  notes:        string | null;   // הערות פנימיות — לא גלויות ללקוח
  active:       boolean;         // גלוי/מוסתר באפליקציה
  purchased:    boolean;         // האם שולם ✓
  purchasedAt?: string;          // ISO timestamp של תשלום
  createdAt:    string;          // ISO timestamp של יצירה
  updatedAt:    string;
}
```

> **שדה קריטי לאנליטיקס:** `agentId` — מי מהסוכנים בנה את ההצעה.  
> `purchased` + `finalPrice` → כמה נסגר ובכמה כסף.

---

## 3. REST endpoints קיימים

| Method | Path | תיאור |
|--------|------|--------|
| `GET` | `/cpanel/clients/:phone/personal-catalog` | כל החבילות של לקוח |
| `POST` | `/cpanel/clients/:phone/personal-catalog` | יצירת חבילה חדשה |
| `PATCH` | `/cpanel/clients/:phone/personal-catalog/:id` | עדכון חבילה |
| `DELETE` | `/cpanel/clients/:phone/personal-catalog/:id` | מחיקת חבילה |
| `POST` | `/cpanel/clients/:phone/personal-catalog/:id/charge-iframe` | מחזיר `{ url }` לחלון תשלום Tranzila |

כל ה-endpoints דורשים `Authorization: Bearer <token>` מ-`localStorage.cpanel_token`.

### גוף POST / PATCH (PersonalPackageDraft)

```json
{
  "name": "חבילת צמיחה לדנה",
  "items": { "posts": 8, "reels": 4 },
  "bullets": ["📸 8 פוסטים", "🎬 4 ריילס"],
  "basePrice": 2400,
  "discountPct": 10,
  "finalPrice": 2160,
  "coins": 500,
  "notes": "הלקוחה רוצה תוכן ויז'ואלי בלבד",
  "active": true
}
```

> `basePrice` ו-`finalPrice` מחושבים על ידי ה-Frontend — הבקאנד שומר מה שנשלח.

---

## 4. לוגיקת חישוב המחיר (Frontend)

```ts
// basePrice = סכום פריטים + מחיר חבילת מטבעות
const itemsTotal = baseItems.reduce((s, bi) =>
  s + (draft.items[bi.key] || 0) * (bi.unitPrice || 0), 0
);
const coinsPrice = coinPackages.find(cp => cp.coins === draft.coins)?.price ?? 0;
const computedBase = itemsTotal + coinsPrice;

// finalPrice = אחרי הנחה
const finalPrice = Math.round(computedBase * (1 - discountPct / 100));
```

פריטי הבסיס (`ProductItem[]`) ומחירי המטבעות (`ProductCoins[]`) מגיעים מ-`GET /cpanel/products`.

---

## 5. מגבלת הנחה לפי תפקיד

```ts
// PersonalCatalogTab.tsx:60
const maxDiscount = (
  agent?.name === "admin-boss" ||
  (agent?.phone ?? "").replace(/\D/g, "").endsWith("542587070")
) ? 100 : 20;
```

סוכן רגיל: עד 20%. אדמין ספציפי: עד 100%.

---

## 6. זרימת תשלום

```
הסוכן לוחץ "חייב"
  → POST /personal-catalog/:id/charge-iframe
  → { url } חלון Tranzila נפתח
  → לאחר תשלום מוצלח: Socket.io event "cpanel_new_purchase" { phone }
  → purchased = true, purchasedAt = now()
```

---

## 7. אנליטיקס סוכנים — מה חסר ואיך לבנות

### המטרה

עבור כל סוכן מכירות לדעת:
- כמה הצעות מחיר שלח (= כמה packages יצר)
- כמה נסגרו (`purchased: true`) וכמה לא
- כמה לקוחות ייחודיים קיבלו הצעה (unique `phone`)
- כמה לקוחות ייחודיים סגרו
- סה"כ כסף שנכנס (`sum(finalPrice) where purchased`)

### הבעיה הנוכחית

אין endpoint שמחזיר aggregation. כל GET הוא per-client.

---

### 7.1 Endpoint חדש לבנות בבקאנד

```
GET /cpanel/admin/reports/personal-catalog-stats
  ?from=2024-01-01   (אופציונלי, ISO date)
  ?to=2024-12-31     (אופציונלי)
  ?agentId=xxx       (אופציונלי — לסנן לסוכן ספציפי)
```

**תשובה:**

```json
{
  "agents": [
    {
      "agentId": "abc123",
      "agentName": "יוסי כהן",
      "quotesTotal": 47,
      "quotesClosed": 31,
      "quotesOpen": 16,
      "clientsReached": 28,
      "clientsClosed": 21,
      "revenueTotal": 156800,
      "conversionRate": 0.66
    }
  ],
  "totals": {
    "quotesTotal": 120,
    "quotesClosed": 78,
    "revenueTotal": 384500
  }
}
```

---

### 7.2 MongoDB Aggregation Pipeline (Node.js / Mongoose)

```js
// GET /cpanel/admin/reports/personal-catalog-stats
async function personalCatalogStats(req, res) {
  const { from, to, agentId } = req.query;

  const match = {};
  if (agentId) match.agentId = agentId;
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to)   match.createdAt.$lte = new Date(to);
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$agentId",
        quotesTotal:    { $sum: 1 },
        quotesClosed:   { $sum: { $cond: ["$purchased", 1, 0] } },
        revenueTotal:   { $sum: { $cond: ["$purchased", "$finalPrice", 0] } },
        clientsReached: { $addToSet: "$phone" },          // unique phones
        clientsClosed: {
          $addToSet: {
            $cond: ["$purchased", "$phone", "$$REMOVE"]
          }
        }
      }
    },
    {
      $project: {
        agentId:        "$_id",
        quotesTotal:    1,
        quotesClosed:   1,
        quotesOpen:     { $subtract: ["$quotesTotal", "$quotesClosed"] },
        revenueTotal:   1,
        clientsReached: { $size: "$clientsReached" },
        clientsClosed:  { $size: "$clientsClosed" },
        conversionRate: {
          $cond: [
            { $gt: ["$quotesTotal", 0] },
            { $divide: ["$quotesClosed", "$quotesTotal"] },
            0
          ]
        }
      }
    },
    { $sort: { revenueTotal: -1 } }
  ];

  const rows = await PersonalPackage.aggregate(pipeline);

  // enrich with agent names from Agent collection
  const agentIds = rows.map(r => r.agentId);
  const agents = await Agent.find({ _id: { $in: agentIds } }, "name").lean();
  const nameMap = Object.fromEntries(agents.map(a => [a._id.toString(), a.name]));

  const enriched = rows.map(r => ({
    ...r,
    agentName: nameMap[r.agentId] ?? "לא ידוע"
  }));

  const totals = enriched.reduce((acc, r) => ({
    quotesTotal:  acc.quotesTotal  + r.quotesTotal,
    quotesClosed: acc.quotesClosed + r.quotesClosed,
    revenueTotal: acc.revenueTotal + r.revenueTotal,
  }), { quotesTotal: 0, quotesClosed: 0, revenueTotal: 0 });

  res.json({ agents: enriched, totals });
}
```

> ⚠️ שים לב: `$addToSet` עם `$$REMOVE` עובד ב-MongoDB 4.2+.  
> לגרסאות ישנות יותר, שנה ל-`$filter` נפרד.

---

### 7.3 Frontend — מסך אדמין חדש

בקובץ [src/App.tsx](../src/App.tsx) כבר קיים Pattern לדפי אדמין:

```tsx
// להוסיף ל-ADMIN routes:
<Route path="/admin/catalog-stats" element={
  <Protected adminOnly>
    <AdminCatalogStatsPage />
  </Protected>
} />
```

הוסף גם לתפריט הצד ב-[src/components/shell/Layout.tsx](../src/components/shell/Layout.tsx).

**דפוס ה-hook לקריאה:**

```tsx
const { data, loading } = useApi(
  (signal) => fetchAdminCatalogStats({ from, to }, signal),
  [from, to]
);
```

---

## 8. קשרים עם מודלים קיימים

| Collection | שדה | קשר |
|------------|-----|-----|
| `Agent` | `_id` | `PersonalPackage.agentId` |
| `Chat` / `Client` | `phone` | `PersonalPackage.phone` |
| `ManagerListEntry` | `revenue.deals` | **לא כולל** personal packages — הם נפרדים |

> שים לב: `ManagerListEntry.revenue.deals` (ב-`GET /cpanel/admin/managers`) עוקב אחרי עסקאות אחרות, **לא** הצעות מחיר אישיות. Personal Catalog הוא מערכת משנה עצמאית.

---

## 9. Collection name ב-MongoDB

הסבירות הגבוהה ביותר: `personalpakages` או `personal_packages` — תאמת מול הבקאנד.  
חפש ב-Mongoose models: `mongoose.model("PersonalPackage", ...)`.

---

## 10. טיפים לעבודה

- **Auth:** כל ה-admin endpoints בודקים `req.agent.role === "admin"` — ודא שה-middleware קיים
- **Timezone:** תאריכים ב-UTC. בממשק תציג לפי `he-IL` locale
- **Socket event לאחר רכישה:** `cpanel_new_purchase` — אפשר גם ב-webhook לעדכן stats cache
- **צד ה-CPanel:** כל הקוד ב-[src/api/client.ts](../src/api/client.ts) ו-[src/api/admin.ts](../src/api/admin.ts) — ניתן לראות איך endpoints קיימים בנויים ולשכפל את הדפוס
