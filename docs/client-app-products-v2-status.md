# אפליקציית לקוח — מסך פירוט פרויקט · סטטוס ביצוע

עודכן: 06.05.2026

מסמך זה מסכם מה כבר נעשה בשרת מול ה-spec ב-`client-app-products-v2.md`,
ומה עוד צריך להיעשות בצד האפליקציה (React Native).

---

## ✅ צד שרת — נעשה

### 1. 🐛 הסרת הפילטר `managerApprovedAt` ב-`pkg_*` path

**קובץ:** `controllers/client-projects.controller.js`

הוסר הפילטר משני המקומות (ads + organic) ב-`getClientProjectDetail`
על ה-`pkg_*` path:

```js
// לפני (באג):
return (s.generatedAds || s.ads || [])
  .filter(a => a.managerApprovedAt)   // ← הוסר
  .map(a => mapItem(a, st, sKey));

// אחרי:
return (s.generatedAds || s.ads || [])
  .map(a => mapItem(a, st, sKey));
```

הסטטוס של החבילה עצמה (`activePackage.status`) הוא עכשיו ה-gate היחיד —
לא יותר סינון פר-פריט שהסתיר הכל מהלקוח.

### 2. שדה `body` ב-`mapItem`

```js
const mapItem = (a, sessStatus, sessKey) => ({
  id:       `${sessKey}_${String(a.id != null ? a.id : a._id)}`,
  imageUrl: a.imageUrl || null,
  headline: a.headline || a.title || "",
  body:     a.description || a.body || a.caption || "",   // ← נוסף
  status:   itemStatus(a, sessStatus),
});
```

קורא מ-`description`, `body`, או `caption` (לפי הסדר הראשון שקיים).

### 3. URL מובטח לדף נחיתה + headline/body

```js
const previewUrl =
     s.previewUrl
  || s.publishedUrl
  || (s.approvalToken         ? `${CLIENT_APP_URL}/wow-lp-review/${s.approvalToken}` : null)
  || (s.clientApprovalToken   ? `${CLIENT_APP_URL}/wow-lp-review/${s.clientApprovalToken}` : null);

return {
  id:       `lp_${String(s.sessionId || s._id)}`,
  imageUrl: previewUrl,
  headline: s.pageTitle || "דף נחיתה",
  body:     s.subtitle || s.tagline || "",
  status:   itemStatus(s, s.approvalStatus || s.clientApprovalStatus || "sent"),
};
```

**PR:** `projects-pkg-filter-fix` · merged ב-#164

---

## חוזה API (לעדכון `useProjectDetail.ts`)

### `GET /api/client/project-detail?phone=&projectId=pkg_*`

**תשובה (מעודכנת):**

```json
{
  "id":            "pkg_platinum_2026-05-06T07-23-11-000Z",
  "name":          "חבילת פלטינום",
  "date":          "2026-05-06T07:23:11.000Z",
  "overallStatus": "sent_to_client",
  "ads_sponsored": [
    {
      "id":       "<sessKey>_<itemId>",
      "imageUrl": "https://res.cloudinary.com/...",
      "headline": "כותרת המודעה",
      "body":     "תיאור המודעה כפי שיוצג מתחת לתמונה",
      "status":   "pending"
    }
  ],
  "ads_social":   [ /* same shape */ ],
  "carousels":    [ /* same shape */ ],
  "logo":         [],
  "landing_page": [
    {
      "id":       "lp_<sessionId>",
      "imageUrl": "https://app.iconiqmedia.co.il/wow-lp-review/<token>",
      "headline": "דף נחיתה",
      "body":     "",
      "status":   "pending"
    }
  ],
  "video":        []
}
```

`status` של פריט יכול להיות `"pending" | "approved" | "rejected"`.

### `POST /api/client/project-detail/:id/approve`
### `POST /api/client/project-detail/:id/reject`

**כבר קיימים בשרת** מהעבודה על per-item approval בעבר. אין צורך לבנות.

```
POST /api/client/project-detail/pkg_platinum_.../approve
Content-Type: application/json

{
  "phone":  "0543089955",
  "kind":   "ads_sponsored",   // ads_sponsored | ads_social | carousels | landing_page
  "itemId": "<id מה-API למעלה>"
}
```

**תשובה:**
```json
{ "success": true, "itemId": "...", "status": "approved", "overall": "approved" }
```

ל-`reject` אפשר להוסיף `feedback` ב-body (string).

---

## 🔧 צד אפליקציה — מה צריך לעשות

### `useProjectDetail.ts`

```ts
export interface ProductItem {
  id:        string;
  imageUrl:  string;
  headline?: string;
  body?:     string;          // ← הוסף
  status:    "pending" | "approved" | "rejected";
}

// בתוך mapItem:
body: a.body ?? a.description ?? a.caption ?? "",   // ← הוסף

// הוסף שני callbacks חדשים:
const approve = useCallback(async (itemId: string, sectionKey: SectionKey) => {
  const url = `${SERVER_URL}/api/client/project-detail/${encodeURIComponent(projectId)}/approve`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, kind: sectionKey, itemId }),
  });
  await load();
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

### `ProductSection.tsx`

חתימה מעודכנת:

```ts
interface ImageItem {
  id:       string;
  imageUrl: string;
  headline?: string;
  body?:    string;
  status:   "pending" | "approved" | "rejected";
}

interface Props {
  title:       string;
  purchased:   number;        // ← כמה נרכש (מ-contents)
  delivered:   number;        // ← כמה הועלו (= items.length)
  statusText:  string;
  dotColor:    string;
  items:       ImageItem[];
  onApprove?:  (itemId: string) => void;
  onReject?:   (itemId: string) => void;
}
```

לכל thumb:
- `headline` ו-`body` מתחת לתמונה
- pill סטטוס בפינה (`pending` כתום-אדום `#F8383C` · `approved` ירוק `#26E129` · `rejected` אדום `#F8383C`)
- כפתורי `[✓][✗]` רק אם `status === "pending"`

בכותרת הסקשן: `${delivered}/${purchased}` בין הכותרת לפיל הסטטוס.

### `ProjectDetailScreen.tsx`

- העבר `onApprove={(id) => approve(id, sec.key)}` ו-`onReject={(id) => reject(id, sec.key)}` לכל `ProductSection`
- העבר `purchased={contents[sec.key]}` ו-`delivered={data[sec.key].length}`
- כש-`sec.key === "landing_page"` — רנדר `LandingPageItem` במקום `ProductSection`

### `LandingPageItem.tsx` (קובץ חדש)

```tsx
import { Linking, TouchableOpacity, Text, View } from "react-native";

export function LandingPageItem({ item, onApprove, onReject }) {
  return (
    <View style={styles.card}>
      <Text style={styles.icon}>🌐</Text>
      <Text style={styles.label}>דף הנחיתה שלך מוכן</Text>

      <TouchableOpacity
        style={styles.linkBtn}
        onPress={() => item.imageUrl && Linking.openURL(item.imageUrl)}
      >
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

---

## בדיקות מומלצות אחרי deploy

1. ✓ פתח את האפליקציה כלקוח שיש לו חבילה ב-`sent_to_client`
2. ✓ ודא שכל המודעות / פוסטים מוצגים (לא חסומים יותר ע"י הפילטר)
3. ✓ לחץ ✓ על מודעה — ה-pill מתעדכן ל-`מאושר`, הכפתורים נעלמים
4. ✓ לחץ ✗ עם feedback — ה-pill ל-`נדחה`
5. ✓ ב-CPanel: סרגל הסטטוס בעמוד הלקוח אמור להציג `client_returned_corrections` אם נדחה לפחות פריט אחד (auto transition שכבר קיים בשרת)
6. ✓ דף נחיתה — לחיצה על "לחץ לצפייה בדף" פותחת את ה-URL ב-browser

---

## סיכום

| # | משימה | צד | סטטוס |
|---|---|---|---|
| 1 | 🐛 הסרת `managerApprovedAt` filter | שרת | ✅ |
| 2 | שדה `body` ב-mapItem | שרת | ✅ |
| 3 | URL מובטח לדף נחיתה | שרת | ✅ |
| 4 | `body` + `approve()` + `reject()` ב-`useProjectDetail.ts` | RN | ⏳ |
| 5 | `ProductSection.tsx` — pill, headline+body, ✓/✗, X/Y counter | RN | ⏳ |
| 6 | `ProjectDetailScreen.tsx` — wire callbacks + purchased | RN | ⏳ |
| 7 | `LandingPageItem.tsx` — קובץ חדש | RN | ⏳ |

ה-endpoints של approve/reject כבר קיימים ועובדים — אפשר לקרוא להם מיידית.
