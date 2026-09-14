# תיקונים ותוספות — אפליקציית לקוח · מסך פירוט פרויקט

עודכן: 06.05.2026

---

## 🐛 באג קריטי לתיקון מיידי — תמונות לא מופיעות ב-app

**תיאור:**  
בקובץ `controllers/client-projects.controller.js`, ב-path של `pkg_*` בפונקציה `getClientProjectDetail` (שורות ~252, ~260), קיים פילטר:

```js
.filter(a => a.managerApprovedAt)
```

כשמנהל תיק לוחץ "שלח לאישור לקוח" דרך כפתור הסטטוס ב-CPanel (עדכון `activePackage.status = "sent_to_client"`), הפריטים **לא** מקבלים `managerApprovedAt`. הפילטר מסנן את כולם → הלקוח רואה "ממתין לתוצרים".

**תיקון:**  
הסר את הפילטר `managerApprovedAt` ב-`pkg_*` path. כאשר חבילה היא ברמת `pkg_*`, הסטטוס של החבילה עצמה (`sent_to_client`, `sent_to_creation` וכו') הוא האינדיקציה — אין צורך לסנן לפי אישור פר-פריט.

```js
// לפני:
return (s.generatedAds || s.ads || [])
  .filter(a => a.managerApprovedAt)          // ← הסר שורה זו
  .map(a => mapItem(a, st, sKey));

// אחרי:
return (s.generatedAds || s.ads || [])
  .map(a => mapItem(a, st, sKey));
```

**אותו שינוי** ב-`organicRows.flatMap` עבור `generatedPosts`.

---

## 1. כפתורי אשר / דחה לכל מוצר בנפרד (client app)

### מה לבנות

ב-`screen2/flow/components/ProductSection.tsx` (ואו ב-`ProjectDetailScreen.tsx`), הוסף לכל תמונה (thumb) כפתורי אשר ✓ ודחה ✗.

```
┌─────────────────────────────────────────┐
│  סושיאל        ● ממתינים לאישור         │
│  ┌──┐  ┌──┐  ┌──┐                       │
│  │  │  │  │  │  │                       │
│  └──┘  └──┘  └──┘                       │
│  [✓][✗] [✓][✗] [✓][✗]                   │
└─────────────────────────────────────────┘
```

### Endpoints לאישור / דחיה

```
POST /api/client/project-detail/:id/approve
POST /api/client/project-detail/:id/reject

Body (JSON):
{
  "phone":  "0543089955",
  "kind":   "ads_sponsored",   // ← ads_sponsored | ads_social | carousels | landing_page
  "itemId": "123"              // ← id המוצר הספציפי
}
```

`id` ב-URL = ה-`projectId` (מתחיל ב-`pkg_...`).

**תשובה:**
```json
{ "success": true, "itemId": "123", "status": "approved", "overall": "approved" }
```

### שינוי ב-`ProductSection.tsx`

עדכן את Props:
```ts
interface ImageItem {
  id:       string;
  imageUrl: string;
  status:   "pending" | "approved" | "rejected";
}

interface Props {
  title:       string;
  statusText:  string;
  dotColor:    string;
  items:       ImageItem[];
  onApprove?:  (itemId: string) => void;
  onReject?:   (itemId: string) => void;
}
```

כפתורי אשר/דחה מוצגים רק כאשר `item.status === "pending"`.
אם אושר — הצג ✓ ירוק בלבד. אם נדחה — הצג ✗ אדום בלבד.

### `useProjectDetail.ts` — הוסף `approve` / `reject`

```ts
const approve = useCallback(async (itemId: string, sectionKey: SectionKey) => {
  const url = `${SERVER_URL}/api/client/project-detail/${encodeURIComponent(projectId)}/approve`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, kind: sectionKey, itemId }),
  });
  await load(); // רענן נתונים
}, [phone, projectId, load]);

const reject = useCallback(async (itemId: string, sectionKey: SectionKey, feedback?: string) => {
  const url = `${SERVER_URL}/api/client/project-detail/${encodeURIComponent(projectId)}/reject`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, kind: sectionKey, itemId, feedback }),
  });
  await load();
}, [phone, projectId, load]);
```

---

## 2. קופי (כותרת + תיאור) על כל מוצר

### מה לבנות

מתחת לכל תמונה בסקשן, הצג את ה-`headline` של הפריט.

```
┌──────┐
│      │
│ IMG  │
│      │
└──────┘
  כותרת המודעה
  עד 2 שורות
```

עדכן `ProductItem` ב-`useProjectDetail.ts`:
```ts
export interface ProductItem {
  id:        string;
  imageUrl:  string;
  headline?: string;
  body?:     string;         // ← תוסיף שדה זה
  status:    "pending" | "approved" | "rejected";
}
```

עדכן `mapItem()`:
```ts
function mapItem(a: any, prefix: string, index: number): ProductItem {
  return {
    id:       `${prefix}_${String(a.id ?? a._id ?? index)}`,
    imageUrl:  a.imageUrl ?? a.image_url ?? a.coverImageUrl ?? a.thumbnailUrl ?? a.previewUrl ?? "",
    headline:  a.headline ?? "",
    body:      a.description ?? a.body ?? a.caption ?? "",   // ← הוסף
    status:    a.status === "approved" ? "approved" : a.status === "rejected" ? "rejected" : "pending",
  };
}
```

עדכן `ProductSection.tsx` להציג `headline` + `body` מתחת לתמונה.

### עדכון שרת — `mapItem` ב-`client-projects.controller.js`

```js
const mapItem = (a, sessStatus, sessKey) => ({
  id:       `${sessKey}_${String(a.id != null ? a.id : a._id)}`,
  imageUrl: a.imageUrl || null,
  headline: a.headline || a.title || "",
  body:     a.description || a.body || a.caption || "",   // ← הוסף
  status:   itemStatus(a, sessStatus),
});
```

---

## 3. סטטוס נראה על כל פריט

### מה לבנות

כל כרטיס מוצר יציג פיל סטטוס:

```
┌──────┐
│      │
│ IMG  │
│      │
│[●מאושר]│   ← pill צבעוני
└──────┘
```

| סטטוס | תווית | צבע |
|-------|-------|-----|
| `pending` | ממתין | `#F8383C` (כתום-אדום) |
| `approved` | מאושר | `#26E129` (ירוק) |
| `rejected` | נדחה | `#F8383C` (אדום) |

ב-`ProductSection.tsx`, עטוף כל thumb ב-`View` ייעודי:
```tsx
<View style={styles.thumbWrapper}>
  <Image ... />
  <View style={[styles.statusPill, { backgroundColor: STATUS_COLORS[item.status] }]}>
    <Text style={styles.statusPillText}>{STATUS_LABELS[item.status]}</Text>
  </View>
</View>
```

---

## 4. סנכרון כמות — "X מתוך Y" לכל סוג מוצר

### מה לבנות

בכותרת כל סקשן, הצג כמה תוצרים הועלו מתוך כמה נרכשו:

```
│  סושיאל         17/35    ● ממתינים לאישור  │
```

### איפה הנתונים

ב-`ProjectDetailScreen.tsx` יש גישה ל-`contents` (פרמטר ניווט) שמכיל את מה שנרכש:
```ts
contents.ads_social    // → 17 (נרכש)
data.ads_social.length // → 10 (הועלו עד כה)
```

עדכן את ה-`ProductSection` Props:
```ts
interface Props {
  title:       string;
  purchased:   number;       // ← כמה נרכש
  delivered:   number;       // ← כמה הועלו
  statusText:  string;
  dotColor:    string;
  items:       ImageItem[];
  onApprove?:  (itemId: string) => void;
  onReject?:   (itemId: string) => void;
}
```

תצוגה: `${delivered}/${purchased}` בצבע לבן, פונט Rubik_300Light, ברוחב בין הכותרת לפיל הסטטוס.

---

## 5. דף נחיתה — קישור URL לחיץ

### מה לבנות

כאשר סוג המוצר הוא `landing_page`, במקום תמונה (thumb) הצג כרטיס עם:

```
┌────────────────────────────────────┐
│  🌐  דף הנחיתה שלך מוכן            │
│  [לחץ לצפייה בדף]                  │
│                                    │
│  [✓ אשר] [✗ דחה]                   │
└────────────────────────────────────┘
```

הכפתור "לחץ לצפייה בדף" פותח `Linking.openURL(item.imageUrl)` (שהוא ה-URL של הדף).

קובץ: `screen2/flow/components/LandingPageItem.tsx` (חדש)

```tsx
import { Linking, TouchableOpacity, Text, View } from "react-native";

interface Props {
  item: ProductItem;
  onApprove?: () => void;
  onReject?:  () => void;
}

export function LandingPageItem({ item, onApprove, onReject }: Props) {
  return (
    <View style={styles.card}>
      <Text style={styles.icon}>🌐</Text>
      <Text style={styles.label}>דף הנחיתה שלך מוכן</Text>
      <TouchableOpacity style={styles.linkBtn} onPress={() => item.imageUrl && Linking.openURL(item.imageUrl)}>
        <Text style={styles.linkText}>לחץ לצפייה בדף</Text>
      </TouchableOpacity>
      {item.status === "pending" && (
        <View style={styles.actions}>
          <TouchableOpacity style={styles.approveBtn} onPress={onApprove}>
            <Text style={styles.actionText}>✓ אשר</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.rejectBtn} onPress={onReject}>
            <Text style={styles.actionText}>✗ דחה</Text>
          </TouchableOpacity>
        </View>
      )}
      {item.status === "approved" && <Text style={[styles.badge, { color: "#26E129" }]}>✓ מאושר</Text>}
      {item.status === "rejected" && <Text style={[styles.badge, { color: "#F8383C" }]}>✗ נדחה</Text>}
    </View>
  );
}
```

ב-`ProjectDetailScreen.tsx` — כאשר `sec.key === "landing_page"`, רנדר `LandingPageItem` במקום `ProductSection`.

### עדכון שרת — ה-URL לדף נחיתה

ב-`getClientProjectDetail`, ב-`lpRows.map`:
```js
const lp_items = lpRows.map(s => {
  const previewUrl =
    s.previewUrl
    || s.publishedUrl
    || (s.approvalToken
          ? `https://app.iconiqmedia.co.il/wow-lp-review/${s.approvalToken}`
          : null)
    || (s.clientApprovalToken
          ? `https://app.iconiqmedia.co.il/wow-lp-review/${s.clientApprovalToken}`
          : null);
  // ← ודא שיש URL!
  return {
    id:       `lp_${String(s.sessionId || s._id)}`,
    imageUrl: previewUrl,    // זה ה-URL שיפתח ב-Linking.openURL
    headline: s.pageTitle || "דף נחיתה",
    status:   itemStatus(s, s.approvalStatus || s.clientApprovalStatus || "sent"),
  };
});
```

---

## סיכום שינויים

### שרת (`client-projects.controller.js`)

| שינוי | שורות מקוריות |
|-------|--------------|
| 🐛 הסר `.filter(a => a.managerApprovedAt)` ב-`pkg_*` path | ~252, ~260 |
| הוסף שדה `body` ב-`mapItem` | ~240 |
| ודא `previewUrl` לדף נחיתה | ~270 |

### App — React Native

| קובץ | שינוי |
|------|-------|
| `useProjectDetail.ts` | הוסף `body` ל-`ProductItem`, הוסף `approve()` ו-`reject()` |
| `ProductSection.tsx` | הוסף status pill, headline/body, כפתורי אשר/דחה, counter X/Y |
| `ProjectDetailScreen.tsx` | העבר `onApprove`/`onReject` callbacks, הוסף `purchased` לכל סקשן |
| `LandingPageItem.tsx` | **קובץ חדש** — כרטיס URL לחיץ + כפתורי אשר/דחה |
