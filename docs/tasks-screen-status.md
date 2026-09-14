# מסך משימות · סטטוס ביצוע

עודכן: 06.05.2026

מסמך זה מסכם מה כבר בוצע מול ה-spec ב-`tasks-screen.md`,
ואת חוזה ה-API החי של ה-Tasks endpoint.

---

## סיכום משימות

| # | משימה | קובץ | סטטוס |
|---|---|---|---|
| 1 | שרת: `GET /api/cpanel/tasks` | `controllers/cpanel.controller.js` | ✅ |
| 2 | מיפוי סטטוסים → משימות (`TASK_DEFS` + `minHours`) | אותו קובץ | ✅ |
| 3 | חישוב דחיפות (`computeTaskUrgency`) | אותו קובץ | ✅ |
| 4 | Route ב-`/cpanel/tasks` | `routes/cpanel.routes.js` | ✅ |
| 5 | Type `Task` + `getTasks()` | `src/api/client.ts` | ✅ |
| 6 | `TasksPage.tsx` (חדש — מחליף את הגרסה הישנה ב-localStorage) | `src/pages/TasksPage.tsx` | ✅ |
| 7 | `@keyframes taskBlink` | `src/index.css` | ✅ |
| 8 | Route `/tasks` ב-`App.tsx` | `src/App.tsx` | ✅ (היה קיים) |
| 9 | קישור "משימות" ב-sidebar | `src/components/shell/Sidebar.tsx` | ✅ (היה קיים) |
| 10 | סנכרון socket חי | — | ⏳ נשמר ל-v2 |

---

## חוזה API

### `GET /api/cpanel/tasks`

**Auth:** Bearer token (כמו כל endpoint של CPanel)

**לוגיקה צד שרת:**
1. שולף `cpanel_clients` של ה-agent המחובר
2. לכל לקוח שולף `users.activePackage`
3. עבור כל חבילה בסטטוס פעולה (לא `client_approved` ולא `completed`) → בונה משימה
4. מסנן לפי `minHours` (נותן זמן חסד לסטטוסים מסוימים)
5. ממיין: `blink → red → orange → yellow → normal`, ובתוך כל קבוצה — הישן ראשון

**תשובה:**

```json
{
  "tasks": [
    {
      "id":           "0543089955_client_returned_corrections",
      "clientPhone":  "0543089955",
      "clientName":   "החלקות נוי",
      "packageName":  "חבילת פלטינום",
      "taskType":     "client_returned_corrections",
      "taskLabel":    "תיקוני לקוח ממתינים",
      "description":  "הלקוח החזיר תיקונים — יש לטפל",
      "since":        "2026-05-04T10:00:00.000Z",
      "elapsedHours": 48,
      "urgency":      "orange"
    }
  ],
  "total": 5,
  "byUrgency": { "normal": 1, "yellow": 2, "orange": 1, "red": 1, "blink": 0 }
}
```

---

## מיפוי סטטוסים → משימות (כפי שמומש בשרת)

| סטטוס | תווית | תיאור | minHours |
|---|---|---|---|
| `waiting_brief` | השלמת איפיון | לקוח שילם, האיפיון לא הושלם | 0 |
| `sent_to_creation` | יצירת מוצרים | איפיון הושלם, מוצרים לא נוצרו | 4 |
| `waiting_manager_approval` | אישור תוצרים | מוצרים מוכנים לאישור המנהל | 0 |
| `sent_to_client` | לקוח לא הגיב | שלחנו ללקוח, לא קיבלנו תגובה | 24 |
| `client_returned_corrections` | תיקוני לקוח ממתינים | הלקוח החזיר תיקונים — יש לטפל | 0 |
| `in_correction` | השלמת תיקונים | בתיקון — לא הוחזר ללקוח | 24 |
| `corrections_done` | שלח שוב ללקוח | תיקונים הושלמו, טרם נשלח | 0 |
| `client_approved` / `completed` | — | לא נדרשת פעולה | (לא מופיע ברשימה) |

---

## דחיפות (urgency)

```js
elapsedHours <  24  → "normal"   /* כחול רגיל                 */
elapsedHours <  48  → "yellow"   /* 1-2 ימים                    */
elapsedHours <  72  → "orange"   /* 2-3 ימים                    */
elapsedHours < 120  → "red"      /* 3-5 ימים                    */
                       "blink"   /* 5+ ימים — מתנדנד באנימציה */
```

---

## מבנה ה-TasksPage

**מסך מלא (Layout + Header) ב-`src/pages/TasksPage.tsx`.** הסידבר הראשי
(`Sidebar.tsx`) כבר מכיל קישור "משימות" → `/tasks`.

**קומפוננטות:**
- שורת pills לסינון לפי urgency (`hakol`, `blink`, `red`, `orange`, `yellow`, `normal`)
- רשימת `TaskCard` ממוינת לפי spec
- מצב ריק: "אין משימות פתוחות 🎉"

**TaskCard:**
- נקודה צבעונית בצד (blink מתנדנדת)
- שם הלקוח + שם החבילה
- תווית המשימה בצבע ה-urgency
- תיאור
- זמן שעבר ("3 ימים", "5 שעות"...)
- חץ ←
- לחיצה: ניווט ל-`/clients/:phone`

**שינוי מה-spec:** ה-spec השתמש ב-`OrionSidebar`/`OrionHeader` שלא קיימים
בקוד הזה. במקום השתמשתי ב-`Layout`/`Header` שהם הסידבר/הדר הסטנדרטיים של
כל שאר העמודים — חוויה זהה, עקביות עם שאר ה-CPanel.

---

## עדכון endpoints קיימים

`/cpanel/tasks` GET שינה משמעות מ"משימות אישיות שמורות" לרשימה האוטומטית
שמתבססת על סטטוס החבילה. הגרסה הישנה (CRUD ידני של משימות אישיות) זמינה
ב-`/cpanel/personal-tasks` — לא בשימוש בממשק החדש, נשמר לתאימות לאחור.

| שינוי | לפני | אחרי |
|---|---|---|
| GET `/cpanel/tasks` | משימות אישיות מ-`cpanel_tasks` | אוטו-משימות מסטטוס חבילה |
| GET `/cpanel/personal-tasks` | (לא קיים) | משימות אישיות (כמו GET הישן) |
| POST/PATCH/DELETE `/cpanel/tasks/:id` | יצירה/עדכון/מחיקה של משימה אישית | ללא שינוי |

---

## מה עדיין לא נעשה

### 10. סנכרון socket חי

ה-spec מציין שה-TasksPage יאזין ל-socket event `client_review_responded`
ויטען מחדש את הרשימה. **לא מומש.** כרגע הרשימה נטענת בכניסה ל-עמוד בלבד.

לתוספת עתידית:

```ts
import { useSocket } from "../hooks/useSocket";

useEffect(() => {
  const socket = getGlobalSocket();
  if (!socket) return;
  const handler = () => getTasks().then(r => setTasks(r.tasks));
  socket.on("client_review_responded", handler);
  return () => { socket.off("client_review_responded", handler); };
}, []);
```

**טעם להמתין:** הסטטוסים מתעדכנים גם ע"י המנהל עצמו (PATCH /status מתוך
`PackageStatusBanner`) — לא רק מתגובות לקוח. לכן צריך גם event שני
(`package_status_updated`) שכרגע השרת לא משדר. עדיף לבנות את שני הצדדים יחד.

---

## בדיקות אחרי deploy

1. ✓ עבור ללקוח עם חבילה ב-`waiting_brief` שנרכשה אתמול → המשימה מופיעה בצהוב (24-48h)
2. ✓ עבור ללקוח עם חבילה ב-`sent_to_creation` שנשלחה ליצירה לפני שעתיים → לא מופיעה (minHours: 4)
3. ✓ עבור ללקוח עם `client_returned_corrections` → מופיע מיידית, צבע לפי כמה זמן
4. ✓ pill `blink` מציג רק משימות 5+ ימים, נקודה מתנדנדת
5. ✓ לחיצה על TaskCard → ניווט לדף הלקוח
6. ✓ מצב ריק תקין כשאין משימות

---

## PRs

- שרת: `tasks-auto-from-status` — https://github.com/IconiqMotion/iconiq-server/pull/new/tasks-auto-from-status
- CPanel: `feat/tasks-page` — https://github.com/IconiqMotion/C-panel/pull/new/feat/tasks-page

לאחר merge ב-deploy אוטומטי (AWS pm2 + Heroku) — העמוד פעיל.
