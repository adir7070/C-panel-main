# Admin Panel · Delivery Status & Bootstrap Guide

עודכן: 07.05.2026
Updated: 2026-05-07

> Bilingual document — every section appears in English first, then Hebrew.
> מסמך דו-לשוני — כל סעיף באנגלית ואז בעברית.

---

## 1. Status — What's Built · סטטוס — מה נבנה

### EN
The admin panel from `ADMIN-PANEL-SPEC.md` is **fully delivered through Phase 2**. 17 admin pages live in production behind `agent.role === "admin"`, plus all backing endpoints, audit logging, and CSV exports.

### HEB
פאנל האדמין מהמפרט `ADMIN-PANEL-SPEC.md` **הושלם עד שלב 2 כולל**. 17 עמודי אדמין חיים בפרודקשן מאחורי `agent.role === "admin"`, יחד עם כל ה-endpoints, audit log, וייצוא CSV.

---

## 2. Page Inventory · מלאי עמודים

### Phase 1 (P0) — MVP · שלב 1

| Path | Page | What |
|---|---|---|
| `/admin` | דשבורד אדמין | KPIs · revenue trend · package mix · top managers · alerts |
| `/admin/managers` | מנהלי תיקים | List + per-manager detail with stats, clients, commissions |
| `/admin/managers/:id` | פרטי מנהל | Drill-down view |
| `/admin/clients` | כל הלקוחות | Global client list with manager / status / tier filters |
| `/admin/finance/revenue` | הכנסות | Monthly chart + breakdowns by package/manager/tier |
| `/admin/finance/payments` | ספר תשלומים | Cardcom transactions ledger + CSV export |
| `/admin/finance/commissions` | עמלות מנהלים | Commission ledger + per-manager rollup + payroll CSV |
| `/admin/tasks` | כל המשימות | Auto-derived task feed across all managers |
| `/admin/catalog` | קטלוג ותמחור | Edit packages / coins / items with audit log |
| `/admin/audit` | יומן ביקורת | Every admin/manager action with diff |
| `/admin/settings` | הגדרות מערכת | Coin costs · commission rates · SLA · feature flags |

### Phase 2 (P1) · שלב 2

| Path | Page | What |
|---|---|---|
| `/admin/ai-usage` | שימוש AI | Coin spend rollup + regen counts |
| `/admin/reviews-analytics` | ניתוח תגובות | Approval rates, response times, recent rejections |
| `/admin/pipeline-global` | פייפליין גלובלי | Kanban + per-manager funnel + stage velocity |
| `/admin/chats` | צ'אטים גלובליים | Search + manager filter + unread filter |
| `/admin/integrations` | בריאות אינטגרציות | Live health for 10 deps (auto-refresh 30s) |
| `/admin/broadcasts` | הודעות רחבות | Segment-targeted SMS/WA + audit-logged |
| `/admin/reports` | דוחות וייצוא | 5 CSV reports (P&L, manager-perf, clients, VAT, audit) |

---

## 3. Bootstrap — Create the First Admin User · יצירת משתמש אדמין ראשון

### EN
There is no admin user yet. The admin panel is gated by `agent.role === "admin"` — you must create one document in MongoDB to bootstrap. Once an admin exists, future admin promotion can happen via the audit-logged settings UI.

**Steps:**

1. Open **MongoDB Atlas** → cluster → **Browse Collections** → DB **`iconiq`** → collection **`agents`**
2. Click **INSERT DOCUMENT** → switch to **JSON view**
3. Paste this exact document:

```json
{
  "_id": "e6c4443b-f714-450d-bbf3-308e272cb8cb",
  "name": "admin-boss",
  "nickname": "מנהל ראשי",
  "password": "4ec872ec8819a323f5ac6889d7289d83a9acc65670050f5e17833a7394c9c874",
  "role": "admin",
  "station": null,
  "active": true,
  "createdAt": "2026-05-07T07:57:59.907Z"
}
```

4. Click **Insert**
5. Open the cpanel → **Logout** (if logged in) → log back in with:
   - **Username:** `admin-boss`
   - **Password:** `Admin#2026`
6. Sidebar should now show the **"ניהול ראשי"** group at the bottom with 17 entries

⚠️ **Change the password right after first login** — `Admin#2026` is for bootstrap only.

### HEB
עדיין אין משתמש אדמין. פאנל האדמין מוגן ב-`agent.role === "admin"` — חייבים ליצור מסמך אחד ב-MongoDB כדי לאתחל. אחרי שאדמין קיים, קידום אדמינים עתידי יכול להיעשות דרך הממשק עם audit log.

**שלבים:**

1. פתח **MongoDB Atlas** → cluster → **Browse Collections** → DB **`iconiq`** → collection **`agents`**
2. לחץ **INSERT DOCUMENT** → עבור ל-**JSON view**
3. הדבק את המסמך הזה:

```json
{
  "_id": "e6c4443b-f714-450d-bbf3-308e272cb8cb",
  "name": "admin-boss",
  "nickname": "מנהל ראשי",
  "password": "4ec872ec8819a323f5ac6889d7289d83a9acc65670050f5e17833a7394c9c874",
  "role": "admin",
  "station": null,
  "active": true,
  "createdAt": "2026-05-07T07:57:59.907Z"
}
```

4. לחץ **Insert**
5. פתח את ה-cpanel → **התנתק** (אם מחובר) → התחבר מחדש עם:
   - **שם משתמש:** `admin-boss`
   - **סיסמה:** `Admin#2026`
6. הסיידבר אמור להציג את הקבוצה **"ניהול ראשי"** בתחתית עם 17 כניסות

⚠️ **שנה את הסיסמה מיד לאחר ההתחברות הראשונה** — `Admin#2026` נועד לאתחול בלבד.

---

## 4. How to Generate a Different Username/Password · יצירת שם/סיסמה אחרים

### EN
The password hash uses `sha256(password + "iconiq2024")` — same as the existing manager login.

To make a different admin, run this on any machine with Node:

```powershell
node -e "console.log(require('crypto').createHash('sha256').update('YOUR_PASSWORD_HERE' + 'iconiq2024').digest('hex'))"
```

Replace `YOUR_PASSWORD_HERE`. Copy the output, replace the `password` field in the JSON above. Also change `name` and `nickname` to whatever you want. Generate a fresh `_id` (any unique string — UUID preferred).

### HEB
ה-hash של הסיסמה הוא `sha256(password + "iconiq2024")` — זהה ל-login הקיים של המנהלים.

ליצירת אדמין אחר, הרץ ב-Node:

```powershell
node -e "console.log(require('crypto').createHash('sha256').update('YOUR_PASSWORD_HERE' + 'iconiq2024').digest('hex'))"
```

החלף את `YOUR_PASSWORD_HERE`. העתק את הפלט והחלף את שדה `password` ב-JSON למעלה. גם תחליף את `name` ו-`nickname` למה שתרצה. צור `_id` חדש (כל מחרוזת ייחודית — UUID מועדף).

---

## 5. Promoting an Existing Manager to Admin · קידום מנהל קיים לאדמין

### EN
If you don't want a new user — just promote an existing manager:

1. Atlas → `agents` collection
2. Find the manager (search by `name` or `nickname`)
3. Edit the document → change `"role": "account_manager"` → `"role": "admin"`
4. The manager logs out + back in
5. Sidebar now shows the admin group

### HEB
אם לא רוצים משתמש חדש — אפשר לקדם מנהל קיים:

1. Atlas → `agents` collection
2. מצא את המנהל (חיפוש לפי `name` או `nickname`)
3. ערוך את המסמך → שנה `"role": "account_manager"` → `"role": "admin"`
4. המנהל מתנתק וחוזר להתחבר
5. הסיידבר מציג את קבוצת האדמין

---

## 6. Server Endpoints — Full List · רשימת endpoints מלאה

### EN
All under `/api/cpanel/admin/*`. Every endpoint enforces `req.agent.role === "admin"` via `requireAdmin` middleware. Mutations write to `audit_log`.

```
# Dashboard
GET    /admin/dashboard

# Managers
GET    /admin/managers
GET    /admin/managers/:id

# Clients (global)
GET    /admin/clients?manager=&status=&tier=&search=&limit=

# Finance
GET    /admin/finance/revenue?months=
GET    /admin/finance/payments?from=&to=&manager=&status=&search=&limit=
GET    /admin/finance/commissions?manager=&status=&from=&to=&limit=

# Operations
GET    /admin/tasks

# Catalog
GET    /admin/catalog
POST   /admin/catalog                  ← upsert + audit
DELETE /admin/catalog/:key             ← soft-delete + audit

# Settings
GET    /admin/settings
PATCH  /admin/settings                 ← per-section + audit

# AI / analytics
GET    /admin/ai-usage
GET    /admin/reviews-analytics
GET    /admin/pipeline-global

# Chats
GET    /admin/chats?search=&manager=&unreadOnly=

# Integrations health
GET    /admin/integrations

# Broadcasts
GET    /admin/broadcasts
POST   /admin/broadcasts               ← send + audit (dryRun supported)

# Reports (CSV)
GET    /admin/reports/monthly-pnl?year=
GET    /admin/reports/manager-performance?from=&to=
GET    /admin/reports/client-list
GET    /admin/reports/vat?from=&to=
GET    /admin/reports/activity?from=&to=

# Audit
GET    /admin/audit?actor=&action=&kind=&id=&from=&to=&limit=
```

### HEB
כולם תחת `/api/cpanel/admin/*`. כל endpoint דורש `req.agent.role === "admin"` דרך middleware בשם `requireAdmin`. שינויים נכתבים ל-`audit_log`.

(הרשימה זהה לעיל.)

---

## 7. New Collections · קולקציות חדשות

### EN
Added to MongoDB by the admin panel work:

| Collection | Purpose |
|---|---|
| `audit_log` | Every admin/manager mutation. Indexed by `at`, `actor.id`, `action`, `target.kind+id` |
| `admin_settings` | KV store for system-wide settings (coin costs, commission rates, SLA, flags). Indexed by `section` (unique) |
| `admin_broadcasts` | Sent broadcast history with per-recipient results |

All three are auto-indexed on first use — no manual setup needed.

### HEB
נוספו ל-MongoDB ע"י עבודת פאנל האדמין:

| קולקציה | מטרה |
|---|---|
| `audit_log` | כל שינוי של אדמין/מנהל. עם indexes על `at`, `actor.id`, `action`, `target.kind+id` |
| `admin_settings` | KV store להגדרות מערכת (מטבעות, עמלות, SLA, flags). index ייחודי על `section` |
| `admin_broadcasts` | היסטוריית broadcasts ששודרו עם תוצאות פר-נמען |

כל שלושת הקולקציות נוצרות ומקבלות אינדקסים בשימוש ראשון — אין צורך בהקמה ידנית.

---

## 8. Test Checklist (After Login) · רשימת בדיקות

### EN
After logging in as admin, verify:

1. ✅ Sidebar shows **"ניהול ראשי"** group with 17 entries
2. ✅ `/admin` (Dashboard) loads with KPIs + revenue chart
3. ✅ `/admin/managers` lists all managers with revenue + commission stats
4. ✅ Click any manager → detail page loads with their clients + commissions
5. ✅ `/admin/clients` lists every client across all managers
6. ✅ `/admin/finance/payments` exports CSV in Hebrew
7. ✅ `/admin/catalog` allows editing a package, save → check `/admin/audit` for the entry
8. ✅ `/admin/settings` lets you flip a feature flag and save
9. ✅ `/admin/integrations` shows 10 health cards, auto-refreshes
10. ✅ `/admin/broadcasts` dry-run shows recipient count without sending
11. ✅ `/admin/reports` downloads each of the 5 CSVs

### HEB
לאחר התחברות כאדמין, ודא:

1. ✅ הסיידבר מציג קבוצת **"ניהול ראשי"** עם 17 כניסות
2. ✅ `/admin` (דשבורד) נטען עם KPIs + גרף הכנסות
3. ✅ `/admin/managers` מציג את כל המנהלים עם הכנסות ועמלות
4. ✅ לחיצה על מנהל → עמוד פרטים נטען עם הלקוחות והעמלות שלו
5. ✅ `/admin/clients` מציג כל לקוח מכל המנהלים
6. ✅ `/admin/finance/payments` מייצא CSV בעברית
7. ✅ `/admin/catalog` מאפשר עריכת חבילה, שמירה → בדוק `/admin/audit` לרשומה
8. ✅ `/admin/settings` מאפשר feature flag toggle ושמירה
9. ✅ `/admin/integrations` מציג 10 כרטיסי בריאות, עם רענון אוטומטי
10. ✅ `/admin/broadcasts` תצוגה מקדימה מציגה מספר נמענים ללא שליחה
11. ✅ `/admin/reports` מוריד כל אחד מ-5 ה-CSVs

---

## 9. Security Notes · הערות אבטחה

### EN
- Server-side `requireAdmin` middleware is the canonical guard. Sidebar hiding + `<AdminOnly>` route guard are UX conveniences only.
- Every admin mutation (catalog edit, settings change, broadcast send, report export, refund) writes to `audit_log` automatically — see `services/audit-log.service.js`.
- Bootstrap password `Admin#2026` is shared in this doc — change it immediately after first login.
- The `agents.token` field is the live session token. Logout invalidates by clearing it.
- All admin routes require Bearer token in Authorization header — same auth as the manager cpanel.

### HEB
- ה-middleware `requireAdmin` בצד שרת הוא ה-gate הקנוני. הסתרת סיידבר ו-`<AdminOnly>` הם רק UX.
- כל שינוי אדמין (עריכת קטלוג, שינוי הגדרות, broadcast, ייצוא דוח, החזר) נכתב אוטומטית ל-`audit_log` — ראה `services/audit-log.service.js`.
- סיסמת bootstrap `Admin#2026` משותפת במסמך זה — שנה אותה מיד לאחר ההתחברות הראשונה.
- שדה `agents.token` הוא טוקן ה-session החי. התנתקות מנקה אותו.
- כל ה-routes של אדמין דורשים Bearer token ב-Authorization header — אותה אותנטיקציה כמו cpanel מנהלים.

---

## 10. What's NOT Built (Phase 3) · מה לא נבנה (שלב 3)

### EN
Per `ADMIN-PANEL-SPEC.md` sec 6 Phase 3 + section 2.17 — these are deferred:

- Manager impersonation (admin "log in as" any manager)
- Manager onboarding wizard
- Churn prediction (ML)
- Customer health scores
- Workload rebalancer
- Vacation mode
- GDPR / right-to-be-forgotten flow
- A/B testing of packages
- Manager leaderboard / gamification
- 2FA enforcement
- Session management (force-logout other agents)
- Refund flow (sec 2.4 — destructive, deferred from Phase 1)
- Destructive admin actions on existing pages (transfer clients, mark-commission-paid, force-status — currently disabled UI buttons)

### HEB
לפי `ADMIN-PANEL-SPEC.md` סעיף 6 שלב 3 + 2.17 — נדחו:

- התחזות אדמין למנהל
- אשף קליטת מנהל חדש
- חיזוי churn (ML)
- ציון בריאות לקוח
- איזון עומסים
- מצב חופשה
- ייצוא נתונים לחוק הגנת הפרטיות / זכות להישכח
- A/B testing של חבילות
- לוח מובילים / gamification
- אכיפת 2FA
- ניהול sessions (ניתוק כפוי)
- תהליך החזרים (סעיף 2.4 — הרסני, נדחה משלב 1)
- פעולות אדמין הרסניות בעמודים קיימים (העברת לקוחות, סימון עמלה כשולמת, כפיית סטטוס — כרגע כפתורים מנוטרלים)

---

## 11. Contacts & References · אנשי קשר וקישורים

### EN
- **Original spec:** `docs/ADMIN-PANEL-SPEC.md`
- **Server code:** `iconiq-server-new/controllers/admin.controller.js` + `services/audit-log.service.js` + `services/admin-settings.service.js`
- **Cpanel code:** `C-panel/src/api/admin.ts` + `src/pages/admin/*` + `src/components/shell/Sidebar.tsx`
- **All 23 PRs:** see `git log` for branches starting with `admin-` (server) or `feat/admin-` (cpanel)

### HEB
- **מפרט מקורי:** `docs/ADMIN-PANEL-SPEC.md`
- **קוד שרת:** `iconiq-server-new/controllers/admin.controller.js` + `services/audit-log.service.js` + `services/admin-settings.service.js`
- **קוד cpanel:** `C-panel/src/api/admin.ts` + `src/pages/admin/*` + `src/components/shell/Sidebar.tsx`
- **כל 23 ה-PRs:** ראה `git log` לענפים שמתחילים ב-`admin-` (שרת) או `feat/admin-` (cpanel)
