# מסך משימות — Task Manager · מפרט מלא

עודכן: 06.05.2026

---

## רעיון כללי

כל לקוח עם חבילה פעילה (`users.activePackage`) עובר תהליך בן 9 שלבים.
כל שלב שלא בוצע במועד — מופיע כ**משימה פתוחה** במסך המשימות של מנהל התיק.
צבע המשימה משתנה לפי כמה זמן היא ממתינה.

---

## 1. שרת — endpoint חדש

### `GET /api/cpanel/tasks`

**Auth:** Bearer token (כמו כל ה-CPanel endpoints)

**מקור הנתונים:**
```
cpanel_clients  →  [{ phone, agentId, customerName }]
users           →  users.activePackage.{ status, statusUpdatedAt, purchasedAt, name }
```

**לוגיקה:**
1. מביא את כל הלקוחות של ה-agent המחובר מ-`cpanel_clients`
2. לכל לקוח — טוען את `users.activePackage`
3. ממיר לרשימת משימות לפי הטבלה בסעיף 2
4. ממיין: urgency (גבוה ראשון) → elapsed time (ישן ראשון)
5. מחזיר `{ tasks, total }`

**שאילתת MongoDB:**
```js
// 1. לקוחות של ה-agent
const clients = await cpanelClientsCol()
  .find({ agentId })
  .toArray();

const phones = clients.map(c => c.phone);

// 2. users עם activePackage
const users = await getDB()
  .collection("users")
  .find(
    { phone: { $in: phones }, "activePackage": { $exists: true } },
    { projection: { phone: 1, activePackage: 1 } }
  )
  .toArray();

// 3. build tasks
```

**תשובה:**
```json
{
  "tasks": [
    {
      "id":          "0543089955_client_returned_corrections",
      "clientPhone": "0543089955",
      "clientName":  "החלקות נוי",
      "packageName": "חבילת פלטינום",
      "taskType":    "client_returned_corrections",
      "taskLabel":   "תיקוני לקוח ממתינים",
      "description": "הלקוח החזיר תיקונים — יש לטפל",
      "since":       "2026-05-04T10:00:00.000Z",
      "elapsedHours": 48,
      "urgency":     "orange"
    }
  ],
  "total": 5,
  "byUrgency": { "normal": 1, "yellow": 2, "orange": 1, "red": 1, "blink": 0 }
}
```

**Route:** הוסף ב-`cpanel.routes.js`:
```js
router.get("/tasks", auth, cpanelCtrl.getTasks);
```

---

## 2. מיפוי סטטוסים → משימות

| סטטוס (`activePackage.status`) | תווית משימה | תיאור | Timer מתחיל מ | האם תמיד משימה |
|---|---|---|---|---|
| `waiting_brief` | השלמת איפיון | לקוח שילם, האיפיון לא הושלם | `purchasedAt` | כן (מיום 1) |
| `sent_to_creation` | יצירת מוצרים | איפיון הושלם, מוצרים לא נוצרו | `statusUpdatedAt` | אחרי 4 שעות |
| `waiting_manager_approval` | אישור תוצרים | מוצרים מוכנים לאישור המנהל | `statusUpdatedAt` | כן (מיידי) |
| `sent_to_client` | לקוח לא הגיב | שלחנו, הלקוח לא הגיב | `statusUpdatedAt` | אחרי 24 שעות |
| `client_returned_corrections` | תיקוני לקוח ממתינים | הלקוח החזיר תיקונים | `statusUpdatedAt` | כן (מיידי) |
| `in_correction` | השלמת תיקונים | בתיקון, לא הוחזר ללקוח | `statusUpdatedAt` | אחרי 24 שעות |
| `corrections_done` | שלח שוב ללקוח | תיקונים הושלמו, לא נשלח | `statusUpdatedAt` | כן (מיידי) |
| `client_approved` | — | לא נדרשת פעולה | — | לא |
| `completed` | — | לא נדרשת פעולה | — | לא |

---

## 3. חישוב דחיפות (urgency)

```js
function computeUrgency(elapsedHours) {
  if (elapsedHours <  24) return "normal";   // לבן/כחול רגיל
  if (elapsedHours <  48) return "yellow";   // 1-2 ימים
  if (elapsedHours <  72) return "orange";   // 2-3 ימים
  if (elapsedHours < 120) return "red";      // 3-5 ימים
  return "blink";                            // 5+ ימים
}
```

---

## 4. קוד הפונקציה בשרת

**ב-`cpanel.controller.js`** (או קובץ חדש `tasks.controller.js`):

```js
const TASK_DEFS = {
  waiting_brief:                { label: "השלמת איפיון",           desc: "לקוח שילם, האיפיון לא הושלם",           minHours: 0  },
  sent_to_creation:             { label: "יצירת מוצרים",           desc: "איפיון הושלם, מוצרים לא נוצרו",          minHours: 4  },
  waiting_manager_approval:     { label: "אישור תוצרים",           desc: "מוצרים מוכנים לאישור המנהל",             minHours: 0  },
  sent_to_client:               { label: "לקוח לא הגיב",           desc: "שלחנו ללקוח, לא קיבלנו תגובה",           minHours: 24 },
  client_returned_corrections:  { label: "תיקוני לקוח ממתינים",   desc: "הלקוח החזיר תיקונים — יש לטפל",          minHours: 0  },
  in_correction:                { label: "השלמת תיקונים",          desc: "בתיקון — לא הוחזר ללקוח",                minHours: 24 },
  corrections_done:             { label: "שלח שוב ללקוח",          desc: "תיקונים הושלמו, טרם נשלח",               minHours: 0  },
};

function computeUrgency(h) {
  if (h <  24) return "normal";
  if (h <  48) return "yellow";
  if (h <  72) return "orange";
  if (h < 120) return "red";
  return "blink";
}

exports.getTasks = async (req, res) => {
  try {
    const agentId = String(req.agent._id);

    const clientRows = await cpanelClientsCol()
      .find({ agentId }, { projection: { phone: 1, customerName: 1 } })
      .toArray();

    if (!clientRows.length) return res.json({ tasks: [], total: 0, byUrgency: {} });

    const phones = clientRows.map(r => r.phone);
    const nameMap = Object.fromEntries(clientRows.map(r => [r.phone, r.customerName || r.phone]));

    const users = await getDB()
      .collection("users")
      .find(
        { phone: { $in: phones }, activePackage: { $exists: true } },
        { projection: { phone: 1, activePackage: 1 } }
      )
      .toArray();

    const now = Date.now();
    const tasks = [];

    for (const user of users) {
      const pkg    = user.activePackage;
      const status = pkg.status || "waiting_brief";
      const def    = TASK_DEFS[status];
      if (!def) continue; // client_approved / completed → skip

      const since  = new Date(pkg.statusUpdatedAt || pkg.purchasedAt || now).getTime();
      const elapsedHours = (now - since) / 3_600_000;

      if (elapsedHours < def.minHours) continue;

      const urgency = computeUrgency(elapsedHours);

      tasks.push({
        id:          `${user.phone}_${status}`,
        clientPhone: user.phone,
        clientName:  nameMap[user.phone] || user.phone,
        packageName: pkg.name || "חבילה",
        taskType:    status,
        taskLabel:   def.label,
        description: def.desc,
        since:       new Date(since).toISOString(),
        elapsedHours: Math.floor(elapsedHours),
        urgency,
      });
    }

    // sort: blink first, then by elapsed desc
    const URGENCY_ORDER = { blink: 0, red: 1, orange: 2, yellow: 3, normal: 4 };
    tasks.sort((a, b) => {
      const ud = (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9);
      if (ud !== 0) return ud;
      return b.elapsedHours - a.elapsedHours;
    });

    const byUrgency = { normal: 0, yellow: 0, orange: 0, red: 0, blink: 0 };
    tasks.forEach(t => { if (byUrgency[t.urgency] !== undefined) byUrgency[t.urgency]++; });

    res.json({ tasks, total: tasks.length, byUrgency });
  } catch (err) {
    console.error("[Tasks] getTasks:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};
```

---

## 5. CPanel — `src/api/client.ts`

```ts
export type TaskUrgency = "normal" | "yellow" | "orange" | "red" | "blink";

export interface Task {
  id:          string;
  clientPhone: string;
  clientName:  string;
  packageName: string;
  taskType:    string;
  taskLabel:   string;
  description: string;
  since:       string;
  elapsedHours: number;
  urgency:     TaskUrgency;
}

export function getTasks() {
  return req<{ tasks: Task[]; total: number; byUrgency: Record<TaskUrgency, number> }>("/cpanel/tasks");
}
```

---

## 6. CPanel — `TasksPage.tsx` (עמוד חדש)

**קובץ:** `src/pages/TasksPage.tsx`

```tsx
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { OrionSidebar, OrionHeader } from "./ClientListPage";
import { getTasks, type Task } from "../api/client";

const URGENCY_COLOR: Record<string, string> = {
  normal: "var(--blue)",
  yellow: "#FDD835",
  orange: "#FB8C00",
  red:    "#E53935",
  blink:  "#E53935",
};

const URGENCY_LABEL: Record<string, string> = {
  normal: "תקין",
  yellow: "יום+",
  orange: "2 ימים+",
  red:    "3 ימים+",
  blink:  "5 ימים+",
};

function elapsed(hours: number): string {
  if (hours < 1)   return "פחות משעה";
  if (hours < 24)  return `${hours} שעות`;
  const days = Math.floor(hours / 24);
  const rem  = hours % 24;
  return rem > 0 ? `${days} ימים ו-${rem} שעות` : `${days} ימים`;
}

export function TasksPage() {
  const navigate = useNavigate();
  const [tasks,   setTasks  ] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter ] = useState<string>("all");

  useEffect(() => {
    getTasks()
      .then(r => setTasks(r.tasks))
      .finally(() => setLoading(false));
  }, []);

  const visible = filter === "all"
    ? tasks
    : tasks.filter(t => t.urgency === filter);

  const counts = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.urgency] = (acc[t.urgency] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg)" }}>
      <OrionSidebar active="tasks" logout={() => navigate("/login")} badge={tasks.filter(t => t.urgency === "blink" || t.urgency === "red").length} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <OrionHeader title="TASKS" sub="TASK MANAGER" />

        {/* Summary pills */}
        <div style={{ display: "flex", gap: 8, padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
          {["all", "blink", "red", "orange", "yellow", "normal"].map(u => (
            <button
              key={u}
              onClick={() => setFilter(u)}
              style={{
                padding: "4px 12px",
                borderRadius: 20,
                border: `1.5px solid ${u === "all" ? "var(--blue)" : URGENCY_COLOR[u] || "var(--blue)"}`,
                background: filter === u ? (URGENCY_COLOR[u] || "var(--blue)") : "transparent",
                color: filter === u ? "#fff" : "var(--text)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}>
              {u === "all" ? `הכל (${tasks.length})` : `${URGENCY_LABEL[u]} (${counts[u] ?? 0})`}
            </button>
          ))}
        </div>

        {/* Task list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
          {loading && <p style={{ color: "var(--muted)", fontSize: 13 }}>טוען...</p>}
          {!loading && visible.length === 0 && (
            <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", marginTop: 40 }}>אין משימות פתוחות 🎉</p>
          )}
          {visible.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              onClick={() => navigate(`/clients/${encodeURIComponent(task.clientPhone)}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const color   = URGENCY_COLOR[task.urgency] ?? "var(--blue)";
  const isBlink = task.urgency === "blink";

  return (
    <div
      onClick={onClick}
      style={{
        background: "var(--card)",
        border: `1.5px solid ${color}`,
        borderRadius: 10,
        padding: "10px 14px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 12,
        transition: "box-shadow .15s",
      }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = `0 0 0 3px ${color}33`)}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}>

      {/* Urgency dot */}
      <div style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        animation: isBlink ? "taskBlink 1s ease-in-out infinite" : undefined,
      }} />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, direction: "rtl" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {task.clientName}
          </span>
          <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>{task.packageName}</span>
        </div>
        <div style={{ fontSize: 12, color: color, fontWeight: 600, marginTop: 2 }}>{task.taskLabel}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{task.description}</div>
      </div>

      {/* Elapsed time */}
      <div style={{ textAlign: "center", flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>
          {elapsed(task.elapsedHours)}
        </div>
        <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: 0.5 }}>ממתין</div>
      </div>

      {/* Arrow */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  );
}
```

---

## 7. CSS — אנימציית הבהוב

ב-`index.css` (או בקובץ ה-styles הגלובלי):

```css
@keyframes taskBlink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.2; }
}
```

---

## 8. עדכון `App.tsx` — Route חדש

```tsx
import { TasksPage } from "./pages/TasksPage";

// בתוך ProtectedRoutes:
<Route path="/tasks" element={<TasksPage />} />
```

---

## 9. עדכון `OrionSidebar` — כפתור "משימות"

**ב-`ClientListPage.tsx`**, ב-`icons` array, הוסף לפני `bell`:

```ts
{ id: "tasks", title: "משימות", path: "M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
```

ועדכן את לוגיקת ה-navigate בכפתורים (כרגע הכפתורים לא מנווטים — יש לעדכן):

```tsx
const ROUTES: Record<string, string> = {
  clients:   "/",
  tasks:     "/tasks",
  analytics: "/analytics",
};

// על כל כפתור:
onClick={() => { if (ROUTES[ic.id]) navigate(ROUTES[ic.id]); }}
```

---

## 10. Badge על "משימות" בסרגל

`getTasks().then(r => setTaskBadge(r.tasks.filter(t => t.urgency === "red" || t.urgency === "blink").length))`

הצג badge אדום בדיוק כמו badge ה-bell הקיים — אבל על כפתור "משימות".

---

## 11. סנכרון עם אפליקציית הלקוח

הסנכרון עובד **בשני הכיוונים** ואינו דורש בנייה נוספת:

**CPanel → App:**
כאשר מנהל תיק מעדכן סטטוס (למשל "שלח לאישור לקוח") → `PATCH /api/client/project-detail/:id/status`  
→ מעדכן `users.activePackage.status` ב-MongoDB  
→ האפליקציה קוראת את הנתונים בכל פוקוס (`useFocusEffect` + `useClientProjects`) → מציגה סטטוס חדש.

**App → CPanel:**
כאשר לקוח אוֹשר/דחה פריטים ב-app → `POST /api/client/project-detail/:id/approve|reject`  
→ השרת מעדכן `clientApprovalStatus` ומפעיל `pushManagerNotification` (Socket.io)  
→ **מומלץ:** ה-TasksPage יאזין ל-Socket ויעדכן את רשימת המשימות בזמן אמת.

**Socket.io (המלצה):**
```js
// client-side CPanel:
socket.on("client_review_responded", () => {
  getTasks().then(r => setTasks(r.tasks));
});
```

---

## סיכום — מה לבנות

| # | קובץ / מיקום | שינוי |
|---|---|---|
| 1 | `cpanel.controller.js` | הוסף `exports.getTasks` |
| 2 | `cpanel.routes.js` | `router.get("/tasks", auth, cpanelCtrl.getTasks)` |
| 3 | `src/api/client.ts` | הוסף `Task` type + `getTasks()` |
| 4 | `src/pages/TasksPage.tsx` | **קובץ חדש** |
| 5 | `src/App.tsx` | הוסף `<Route path="/tasks">` |
| 6 | `src/pages/ClientListPage.tsx` (`OrionSidebar`) | הוסף כפתור "משימות" + navigate |
| 7 | `src/index.css` | הוסף `@keyframes taskBlink` |
