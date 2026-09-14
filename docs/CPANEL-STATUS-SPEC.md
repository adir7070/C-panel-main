# C-Panel — מערכת סטטוסים למוצרים

> מסמך זה מיועד למתכנת ה-C-Panel. תיאור מלא של מה צריך לבנות: שרת + פרונט.

---

## רקע ומה קיים היום

כל לקוח יכול לקבל עד 3 סוגי מוצרים שה-AI מייצר:
| מוצר | Session Type | שדה קיים ב-DB |
|------|-------------|--------------|
| מודעות ממומנות (Ads) | `WowAdsSession` | `clientApprovalStatus: "draft" \| "sent" \| "approved" \| "rejected" \| null` |
| פוסטים אורגניים (Organic) | `WowOrganicSession` | `clientApprovalStatus: "draft" \| "sent" \| "approved" \| "rejected" \| null` |
| דף נחיתה (LP) | `WowLpSession` | `approvalStatus: "draft" \| "sent" \| "approved" \| "rejected"` |

**בעיה:** הסטטוסים הקיימים לא מספיקים — הם לא מכסים את כל שלבי תהליך העבודה הפנימי.

---

## תהליך עבודה — 9 סטטוסים

```
1  ממתין להשלמת האיפיון      ← before generation is possible
2  נשלח ליצירה               ← AI generation is running
3  ממתין לאישור מנהל התיק    ← generation done, manager must review ← HERE: כפתור "שלח ללקוח"
4  נשלח לאישור הלקוח         ← client received, waiting
5  הלקוח החזיר תיקונים       ← client rejected with feedback
6  בתיקון                    ← manager actively fixing
7  הושלמו תיקונים             ← corrections done, ready to resend
8  לקוח אישר                  ← client approved
9  הסתיים טיפול               ← fully done and closed
```

כל מוצר (Ads / Organic / LP) עובר את התהליך **בנפרד ובאופן עצמאי**.

---

## 1. שינויי שרת (Backend)

### 1.1 הוסף שדה `productStatus` לכל session document

הוסף שדה חדש **לצד** `clientApprovalStatus` הקיים (אל תשנה אותו — backward compat).

```
productStatus: {
  type: String,
  enum: [
    "pending_characterization",   // ממתין להשלמת האיפיון
    "sent_for_creation",          // נשלח ליצירה
    "pending_manager_approval",   // ממתין לאישור מנהל התיק
    "sent_to_client",             // נשלח לאישור הלקוח
    "client_returned_corrections",// הלקוח החזיר תיקונים
    "in_correction",              // בתיקון
    "corrections_completed",      // הושלמו תיקונים
    "client_approved",            // לקוח אישר
    "completed"                   // הסתיים טיפול
  ],
  default: "pending_characterization"
}
```

**מיפוי עם הסטטוסים הקיימים:**
| productStatus | clientApprovalStatus (קיים) |
|---|---|
| sent_to_client | sent |
| client_returned_corrections | rejected |
| client_approved | approved |
| שאר הסטטוסים | draft / null |

### 1.2 עדכן מעברי סטטוס אוטומטיים

בקוד הקיים כבר יש hooks שאפשר לנצל:

| טריגר | עדכן `productStatus` ל |
|-------|----------------------|
| האיפיון לא שלם בזמן בקשת יצירה | `pending_characterization` |
| `generateWowAds/Organic/Lp` נקרא | `sent_for_creation` |
| status הסשן עבר ל-`"done"` | `pending_manager_approval` |
| `sendProductsForApproval` נקרא | `sent_to_client` |
| הלקוח סירב (approval rejected) | `client_returned_corrections` |
| הלקוח אישר (approval approved) | `client_approved` |

### 1.3 נקודות קצה חדשות

#### GET `/api/cpanel/clients/:phone/products/status`
מחזיר את ה-`productStatus` של כל מוצר:
```json
{
  "ads":     { "productStatus": "pending_manager_approval", "sessionExists": true },
  "organic": { "productStatus": "pending_characterization", "sessionExists": false },
  "lp":      { "productStatus": "sent_to_client", "sessionExists": true }
}
```

#### PUT `/api/cpanel/clients/:phone/products/:type/status`
עדכון ידני של `productStatus` על-ידי מנהל התיק.

**Params:**
- `:type` = `ads` | `organic` | `lp`
- **Body:** `{ "status": "<productStatus value>" }`

**מותר לעדכן ידנית:**
- `pending_manager_approval` → (כפתור "שלח ללקוח" יש לוגיקה נפרדת)
- `client_returned_corrections` → `in_correction`
- `in_correction` → `corrections_completed`
- `corrections_completed` → `pending_manager_approval`
- `client_approved` → `completed`

**אסור לעדכן ידנית:** מעברים שנשלטים על ידי הלוגיקה (יצירה, שליחה ללקוח, תגובת לקוח).

#### POST `/api/cpanel/clients/:phone/products/:type/send-to-client`
**מחליף** את הכפתורים הישנים `sendProductsForApproval` / `sendWowLpForApproval`.
**`:type`** = `ads` | `organic` | `lp` — כל מוצר נשלח **בנפרד**.

**לוגיקת השרת:**

1. מוודא שה-`productStatus` הנוכחי הוא `pending_manager_approval`
   - אם לא — מחזיר `400 { error: "STATUS_NOT_READY" }`
2. שולח ללקוח (לוגיקה קיימת per type)
3. שולח **Push Notification** ללקוח (ראה סעיף 1.4)
4. מעדכן `productStatus = "sent_to_client"` + `clientApprovalStatus = "sent"`

---

### 1.4 Push Notification — שליחה ללקוח

כשסטטוס מוצר עובר ל-`sent_to_client`, יש לשלוח push notification ללקוח.

**איך לקחת את ה-Expo token:**
הטוקן מאוחסן ב-MongoDB בקולקציית המשתמשים. חפש לפי phone את השדה `expoToken` (כבר קיים — נמצא דרך endpoint `/api/cpanel/clients/:phone/app-data` שמחזיר `expoToken`).

**קריאה ל-Expo Push API:**

```javascript
async function sendPushNotification(expoToken, productType) {
  const productLabels = {
    ads:     "המודעות הממומנות שלך מוכנות לאישור",
    organic: "הפוסטים האורגניים שלך מוכנים לאישור",
    lp:      "דף הנחיתה שלך מוכן לאישור",
  };

  if (!expoToken || !expoToken.startsWith("ExponentPushToken[")) return;

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: expoToken,
      title: "יש לך מוצר חדש לאישור! 🎉",
      body: productLabels[productType],
      data: { screen: "products", type: productType },
    }),
  });
}
```

**הערות:**

- אם `expoToken` ריק או null — דלג על ה-push בשקט (אל תכשיל את הבקשה)
- ה-`data` payload ישמש את האפליקציה לנווט למסך הנכון (כשיבנה)

---

## 2. שינויי C-Panel (Frontend)

### 2.1 טבלת סטטוס מעל הכל (Summary Table)

**מיקום:** בראש `ProductsTab`, מעל `PackageBanner`.

**מה להציג — שורה לכל מוצר שקיים בחבילה:**

```
┌──────────────────────────┬────────────────────────────────────┬──────────────────────┐
│ מוצר                     │ סטטוס                              │ פעולה                │
├──────────────────────────┼────────────────────────────────────┼──────────────────────┤
│ 📣 מודעות ממומנות (ADS)  │ 🟡 ממתין לאישור מנהל התיק         │ [שלח ללקוח ▶]        │
│ 📱 פוסטים אורגניים       │ 🔵 נשלח לאישור הלקוח               │                      │
│ 🌐 דף נחיתה              │ 🟣 ממתין להשלמת האיפיון            │                      │
└──────────────────────────┴────────────────────────────────────┴──────────────────────┘
```

**כללי עיצוב:**
- כפתור "שלח ללקוח" מוצג **רק כשהסטטוס הוא `pending_manager_approval`**
- כשהסטטוס הוא `sent_for_creation` — להציג spinner קטן ליד שם המוצר
- כל שורה — לחיצה עליה גוללת לפאנל הרלוונטי (WowAdsPanel / WowOrganicPanel / WowLpPanel)

**צבעי badge לפי סטטוס:**

| productStatus | צבע badge | טקסט |
|---|---|---|
| `pending_characterization` | אפור | ממתין להשלמת האיפיון |
| `sent_for_creation` | כחול בהיר (בהבהוב) | נשלח ליצירה... |
| `pending_manager_approval` | כתום | ממתין לאישור מנהל התיק |
| `sent_to_client` | כחול | נשלח לאישור הלקוח |
| `client_returned_corrections` | אדום | הלקוח החזיר תיקונים |
| `in_correction` | כתום כהה | בתיקון |
| `corrections_completed` | סגול | הושלמו תיקונים |
| `client_approved` | ירוק | לקוח אישר ✓ |
| `completed` | ירוק כהה | הסתיים טיפול ✓ |

### 2.2 כפתור "שלח ללקוח" — לוגיקה

**תנאי הופעה:** `productStatus === "pending_manager_approval"` בלבד.

**כאשר נלחץ:**
1. שאלת אישור: `"לשלוח את ה[מוצר] ל[שם לקוח] לאישור?"`
2. קריאה ל-`POST /api/cpanel/clients/:phone/products/:type/send-to-client`
3. בהצלחה — עדכון ה-status בטבלה + toast "נשלח ללקוח"
4. בשגיאה — toast עם הודעת שגיאה

### 2.3 שינוי ידני של סטטוס מנהל (State Transitions)

בכל פאנל מוצר (WowAdsPanel, WowOrganicPanel, WowLpPanel) — הוסף **status bar** בצמוד לכותרת הפאנל.

**מה להציג:**
- badge צבעוני עם הסטטוס הנוכחי
- כפתור dropdown `↓` לשינוי ידני (רק המעברים המותרים — ראה סעיף 1.3)

**מעברים ידניים שצריך לאפשר:**
- `client_returned_corrections` → `in_correction` — כפתור: "התחל תיקון"
- `in_correction` → `corrections_completed` — כפתור: "סיים תיקונים"
- `corrections_completed` → `pending_manager_approval` — כפתור: "מוכן לשליחה מחדש"
- `client_approved` → `completed` — כפתור: "סגור טיפול"

### 2.4 API functions להוסיף ב-`client.ts`

```typescript
// Get all product statuses for a client
export function getProductStatuses(phone: string) {
  return req<{
    ads:     { productStatus: ProductStatus; sessionExists: boolean } | null;
    organic: { productStatus: ProductStatus; sessionExists: boolean } | null;
    lp:      { productStatus: ProductStatus; sessionExists: boolean } | null;
  }>(`/cpanel/clients/${encodeURIComponent(phone)}/products/status`);
}

// Send a specific product to client for approval
export function sendProductToClient(phone: string, type: "ads" | "organic" | "lp") {
  return req<{ success: boolean; previewUrl: string }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/products/${type}/send-to-client`,
    { method: "POST", body: "{}" }
  );
}

// Manually update product status (manager only)
export function updateProductStatus(phone: string, type: "ads" | "organic" | "lp", status: ProductStatus) {
  return req<{ success: boolean }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/products/${type}/status`,
    { method: "PUT", body: JSON.stringify({ status }) }
  );
}

export type ProductStatus =
  | "pending_characterization"
  | "sent_for_creation"
  | "pending_manager_approval"
  | "sent_to_client"
  | "client_returned_corrections"
  | "in_correction"
  | "corrections_completed"
  | "client_approved"
  | "completed";
```

---

## 3. צד הלקוח באפליקציה (App-side — React Native)

> **זה נדרש מצוות האפליקציה, לא מצוות ה-C-Panel.**

הלקוח צריך לראות את ההתקדמות שלו. בנה **מסך/קומפוננטה "התקדמות מוצרים"** שמציג:

```
מודעות ממומנות   [=====>       ] שלב 3/9 — ממתין לאישור
פוסטים אורגניים  [==>          ] שלב 2/9 — בייצור...
דף נחיתה        [==========>  ] שלב 8/9 — לקוח אישר ✓
```

**Endpoint מומלץ (לבנות בשרת):** `GET /api/products/status` — דורש auth של הלקוח.

---

## 4. סדר בנייה מומלץ

```
1. הוסף שדה `productStatus` ל-DB schemas (Ads, Organic, LP)
2. בנה GET + PUT endpoints לסטטוסים
3. בנה POST /send-to-client עם guard על pending_manager_approval
4. הוסף מיפוי אוטומטי: generateWowX → sent_for_creation, done → pending_manager_approval
5. הוסף API functions ב-client.ts
6. בנה ProductStatusTable component (הטבלה מעל ProductsTab)
7. הוסף כפתור "שלח ללקוח" בטבלה + guard logic
8. הוסף status badge + כפתורי מעבר ידני לכל פאנל
9. (אחרון) — endpoint לצד האפליקציה של הלקוח
```

---

## שאלות פתוחות לברר לפני תחילת עבודה

1. **שליחה ללקוח:** כשלוחצים "שלח ללקוח" על מודעות — האם זה שולח **רק מודעות** או **את כל המוצרים ביחד**?
   - ממה שנראה בקוד הנוכחי יש `sendProductsForApproval` (שולח הכל) ו-`sendWowLpForApproval` (LP בלבד).
   - ההמלצה: **לכל מוצר כפתור נפרד**, שולח רק אותו.

2. **הודעה ללקוח:** כשסטטוס עובר ל-`sent_to_client` — איך מודיעים ללקוח? WA? Push notification? שניהם?

3. **תיקון ממי?** כשהלקוח "מחזיר תיקונים" — מי בדיוק שולח את הפידבק? דרך האפליקציה? דרך טופס אחר?
