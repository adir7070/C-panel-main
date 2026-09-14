# Admin Panel — Full Specification · מפרט מלא

עודכן: 06.05.2026
Updated: 2026-05-06

> Bilingual document — every section appears in English first, then Hebrew.
> מסמך דו-לשוני — כל סעיף באנגלית ואז בעברית.

---

## 0. Architecture Decision · החלטת ארכיטקטורה

### EN
The Admin Panel will be built **inside the existing C-Panel codebase**, not as a separate project. Access is gated by `agent.role === "admin"`. Routes live under `/admin/*`. Server endpoints live under `/api/cpanel/admin/*` with strict role enforcement.

**Why:**
- The codebase already has the role infrastructure (`agent.role`, sidebar `adminOnly: true`).
- Same MongoDB — admin views are just unfiltered versions of existing endpoints.
- Avoids 80% code duplication (shared components, API client, auth, design system).
- One deployment, one Heroku app, one repo.

### HEB
לוח האדמין ייבנה **בתוך ה-C-Panel הקיים**, לא כפרויקט נפרד. הגישה מוגבלת ל-`agent.role === "admin"`. כל הראוטים תחת `/admin/*`, ה-endpoints תחת `/api/cpanel/admin/*` עם אכיפת תפקיד קפדנית.

**למה:**
- התשתית של תפקידים כבר קיימת (`agent.role`, סיידבר עם `adminOnly`).
- אותו MongoDB — תצוגות האדמין הן בעצם הגרסאות הלא-מסוננות של ה-endpoints הקיימים.
- חוסך 80% כפילות (קומפוננטות, API client, auth, design system).
- Deploy אחד, Heroku אחד, רפו אחד.

---

## 1. Roles & Permissions · תפקידים והרשאות

### EN
Three roles already exist in the codebase. We expand the permission matrix:

| Role | Sees | Actions |
|---|---|---|
| `account_manager` | Only their own clients | All cpanel actions limited to their `agentId` |
| `supervisor` | Their team's clients (a subset of managers) | Read across team, manage clients within team |
| `admin` | EVERYTHING | All cpanel actions + admin-only pages + system config |

**New role suggestion:** `finance` — read-only access to revenue/payments dashboard, no client data. Optional, ask boss.

### HEB
שלושה תפקידים כבר קיימים בקוד. מטריצת ההרשאות המורחבת:

| תפקיד | רואה | פעולות |
|---|---|---|
| `account_manager` | רק לקוחות שלו | כל פעולות ה-cpanel מוגבלות ל-`agentId` שלו |
| `supervisor` | לקוחות הצוות שלו | קריאה רוחבית בצוות, ניהול לקוחות בצוות |
| `admin` | הכל | כל פעולות ה-cpanel + עמודי אדמין + הגדרות מערכת |

**הצעה לתפקיד חדש:** `finance` — גישה צפייה בלבד ללוח הכנסות/תשלומים, ללא גישה ללקוחות. אופציונלי — לשאול את הבוס.

---

## 2. Page Map — Complete Inventory · מפת עמודים — מלאי מלא

The boss said "all options and control over everything." Below is everything an admin panel for a marketing agency CRM/ops system can reasonably contain. Organized by domain, with priority tier (P0 = MVP, P1 = phase 2, P2 = nice-to-have).

הבוס ביקש "כל האפשרויות ושליטה בהכל". להלן כל מה שלוח אדמין למערכת CRM/אופרציה של סוכנות שיווק יכול להכיל. מסודר לפי תחום, עם דרגת חשיבות (P0 = MVP, P1 = שלב 2, P2 = nice-to-have).

### 2.1 Global Dashboard · דשבורד ראשי

**Path:** `/admin` · **Tier:** P0

#### EN
KPI cards at top: total revenue (today / this month / total), packages sold this month, open projects, clients pending action, total managers, total clients. Below: 3 charts — revenue trend (90 days), package mix (donut), top 10 managers by revenue (bar). Below charts: alerts feed (red/orange items needing immediate attention — overdue tasks, failed payments, unhappy clients).

#### HEB
כרטיסי KPI בראש: הכנסה כוללת (היום / החודש / מצטבר), חבילות שנמכרו החודש, פרויקטים פתוחים, לקוחות הממתינים לטיפול, מספר מנהלים, מספר לקוחות. מתחת: 3 גרפים — מגמת הכנסות (90 ימים), פירוט חבילות (donut), טופ 10 מנהלים לפי הכנסה (bar). מתחת לגרפים: פיד התראות (פריטים אדומים/כתומים שדורשים טיפול מיידי — משימות מעוכבות, תשלומים נכשלו, לקוחות לא מרוצים).

---

### 2.2 Managers · מנהלי תיקים

**Paths:** `/admin/managers`, `/admin/managers/:id` · **Tier:** P0

#### EN
**List page:** Every account manager with: name, role, clients count, total revenue (lifetime + month), commissions earned vs paid, open tasks count, last active date, status (active/disabled). Search + filters.

**Detail page** for each manager:
- Profile + contact
- Their full client list (with revenue per client)
- Commission ledger (paid/unpaid, mark-as-paid button)
- Activity timeline (every action they performed: assigned a client, sent payment link, sent product for approval, etc.)
- Workload heatmap (open tasks by urgency)
- Performance: conversion rate, avg response time, client retention
- Actions: edit profile, change role, transfer their clients to another manager, deactivate, send broadcast

#### HEB
**עמוד רשימה:** כל המנהלים עם: שם, תפקיד, מספר לקוחות, הכנסה כוללת (lifetime + חודש), עמלות שצברו מול ששולמו, מספר משימות פתוחות, תאריך פעילות אחרון, סטטוס (פעיל/מנוטרל). חיפוש + פילטרים.

**עמוד פרטים** לכל מנהל:
- פרופיל + פרטי קשר
- רשימת הלקוחות המלאה שלו (עם הכנסה לכל לקוח)
- ספר עמלות (שולם/לא שולם, כפתור "סמן כשולם")
- ציר זמן פעילות (כל פעולה שביצע: שייך לקוח, שלח לינק תשלום, שלח מוצר לאישור וכו')
- מפת חום עומס (משימות פתוחות לפי דחיפות)
- ביצועים: שיעור המרה, זמן תגובה ממוצע, שימור לקוחות
- פעולות: ערוך פרופיל, שנה תפקיד, העבר לקוחות למנהל אחר, נטרל, שלח הודעה רחבה

---

### 2.3 Clients (Global) · לקוחות (גלובלי)

**Paths:** `/admin/clients`, `/admin/clients/:phone` · **Tier:** P0

#### EN
**List page:** Every client in the system across all managers. Columns: name, phone, business, manager, package, package status, total spend, last activity, tier (Gold/VIP/etc.), tags. Filters: by manager, by package, by status, by tier, by date range. Bulk actions: reassign to another manager, send broadcast, export.

**Detail page:** Same as the existing per-client page (manager view) but with admin extras:
- "Impersonate manager" — view as the assigned manager (so admin can replicate what they see)
- Reassign to another manager (with audit trail)
- Override package (manually edit `users.activePackage`)
- Force status transition (bypass the whitelist — admin emergency control)
- View raw MongoDB document (debug)

#### HEB
**עמוד רשימה:** כל הלקוחות במערכת, מכל המנהלים. עמודות: שם, טלפון, עסק, מנהל, חבילה, סטטוס חבילה, סך הוצאה, פעילות אחרונה, רמה (Gold/VIP וכו'), תגיות. פילטרים: לפי מנהל, חבילה, סטטוס, רמה, טווח תאריכים. פעולות bulk: העברה למנהל אחר, שליחת broadcast, ייצוא.

**עמוד פרטים:** כמו עמוד הלקוח הקיים (תצוגת מנהל) עם תוספות אדמין:
- "התחזה למנהל" — צפייה כמו המנהל המוקצה (האדמין רואה בדיוק מה המנהל רואה)
- העברה למנהל אחר (עם audit trail)
- override של חבילה (עריכה ידנית של `users.activePackage`)
- כפיית מעבר סטטוס (עקיפת whitelist — שליטת חירום של אדמין)
- צפייה ב-MongoDB document גולמי (debug)

---

### 2.4 Finance · פיננסים

**Paths:** `/admin/finance/revenue`, `/admin/finance/payments`, `/admin/finance/commissions`, `/admin/finance/refunds` · **Tier:** P0

#### EN
**Revenue overview:** chart of MRR/total revenue per month, breakdown by package type, by manager, by tier. Compare periods (this month vs last). Forecast next 30 days based on trend.

**Payments ledger:** Every Cardcom transaction — date, amount, customer, package, manager, status (success/failed/refunded), receipt URL. Filterable + exportable to CSV. Click row → full transaction detail (LowProfileId, Token last4, raw Cardcom response).

**Commissions:** Every commission accrued — by manager, by client, by source (`direct_charge`, `payment_link`, `package`). Status: earned vs paid. Bulk "mark paid" workflow with batch ID and date. Export CSV for payroll.

**Refunds:** Initiate / track refunds. Every refund creates a counter-entry in commissions (manager loses commission on refunded amount). Audit trail mandatory — admin must enter a reason.

#### HEB
**סקירת הכנסות:** גרף MRR / הכנסה כוללת לחודש, פילוח לפי סוג חבילה, מנהל, רמה. השוואת תקופות (החודש מול הקודם). תחזית ל-30 יום קדימה לפי מגמה.

**ספר תשלומים:** כל עסקת Cardcom — תאריך, סכום, לקוח, חבילה, מנהל, סטטוס (הצליח/נכשל/הוחזר), קבלה. ניתן לפלטר ולייצא CSV. לחיצה על שורה → פרטי עסקה מלאים (LowProfileId, 4 ספרות אחרונות, תגובת Cardcom גולמית).

**עמלות:** כל עמלה שנצברה — לפי מנהל, לפי לקוח, לפי מקור (`direct_charge`, `payment_link`, `package`). סטטוס: שנצברה מול ששולמה. תהליך "סמן כשולם" עם batch ID ותאריך. ייצוא CSV ל-payroll.

**החזרים:** יזימה / מעקב. כל החזר יוצר רשומה הפוכה בעמלות (המנהל מאבד עמלה על הסכום שהוחזר). Audit trail חובה — האדמין חייב לרשום סיבה.

---

### 2.5 Products & Quality · מוצרים ובקרת איכות

**Paths:** `/admin/products/all`, `/admin/products/quality`, `/admin/products/regenerations` · **Tier:** P1

#### EN
**All products:** Every ad / organic post / landing page / logo / video ever generated. Filterable by manager, client, type, status, date. Click any item → full preview + audit (who generated, when, how many regenerations, AI cost).

**Quality control:** Items the client rejected — feedback transcript, what changed in the regeneration, time-to-fix. Identify managers/AI-flows that produce low-quality work.

**Regenerations:** Every "regenerate this ad" event — client pays coins, AI runs again. Track total coin spend per client. Track AI cost vs revenue per package.

#### HEB
**כל המוצרים:** כל מודעה / פוסט אורגני / דף נחיתה / לוגו / וידאו שנוצר אי פעם. ניתן לפלטר לפי מנהל, לקוח, סוג, סטטוס, תאריך. לחיצה על פריט → תצוגה מקדימה מלאה + audit (מי יצר, מתי, כמה רגנרציות, עלות AI).

**בקרת איכות:** פריטים שהלקוח דחה — טרנסקריפט פידבק, מה השתנה ברגנרציה, זמן עד תיקון. זיהוי מנהלים / AI flows שמייצרים עבודה באיכות נמוכה.

**רגנרציות:** כל אירוע "צור מחדש" — הלקוח משלם מטבעות, ה-AI רץ שוב. מעקב סך הוצאת מטבעות לכל לקוח. השוואת עלות AI מול הכנסה לכל חבילה.

---

### 2.6 Tasks & Operations Overview · משימות ואופרציה

**Path:** `/admin/operations` · **Tier:** P0

#### EN
Combined task feed across all managers — same auto-derived tasks system (`waiting_brief`, `client_returned_corrections`, etc.) but unfiltered. Group by manager, by urgency. Reassign tasks (move client to another manager). SLA tracker — average time from purchase → first product, from sent → client decision, etc.

#### HEB
פיד משימות מאוחד מכל המנהלים — אותה מערכת מסכי משימות אוטומטיים (`waiting_brief`, `client_returned_corrections` וכו') ללא פילטר. קיבוץ לפי מנהל, לפי דחיפות. הקצאת משימה מחדש (העברת לקוח למנהל אחר). מעקב SLA — זמן ממוצע מרכישה → מוצר ראשון, משליחה → החלטת לקוח וכו'.

---

### 2.7 AI Usage & Costs · שימוש ועלות AI

**Path:** `/admin/ai/usage` · **Tier:** P1

#### EN
Coin spend per client + per manager + per product type. Total OpenAI / Gemini API cost per month. Cost per ad generated. Cost per regeneration. Identify abusive regeneration patterns (one client regenerating 10× — flag for manager attention). Margin analysis: revenue per package vs AI cost.

#### HEB
הוצאת מטבעות לכל לקוח + מנהל + סוג מוצר. סך עלות OpenAI / Gemini לחודש. עלות לכל מודעה שנוצרה. עלות לכל רגנרציה. זיהוי דפוסי רגנרציה חריגים (לקוח שמרג'נר 10× — דגל לתשומת לב המנהל). ניתוח שולי רווח: הכנסה לחבילה מול עלות AI.

---

### 2.8 Client Reviews & Approval Activity · תגובות לקוחות

**Path:** `/admin/reviews` · **Tier:** P1

#### EN
Every product review/approval cycle across the system. Approval rate per manager (do their products get approved on first try, or rejected often?). Average client response time. Most-rejected product types. Most-effective product types. Identify managers who consistently get fast approvals — replicate their patterns.

#### HEB
כל מחזור אישור/דחייה במערכת. שיעור אישור לכל מנהל (האם המוצרים שלו עוברים אישור בניסיון הראשון, או נדחים הרבה?). זמן תגובת לקוח ממוצע. סוגי מוצר שנדחים הכי הרבה. סוגי מוצר אפקטיביים ביותר. זיהוי מנהלים שמקבלים אישורים מהירים בעקביות — שכפל את הדפוסים שלהם.

---

### 2.9 Sales Pipeline & Leads · פייפליין ולידים

**Path:** `/admin/pipeline-global` · **Tier:** P1

#### EN
Every prospect / lead in the system, kanban style across stages. Per-manager conversion funnel. Lead source attribution (where did they come from — Facebook ads, organic, referral). Velocity — how fast do leads move through stages. Loss reasons (when prospects drop, why?).

#### HEB
כל פוטנציאל / ליד במערכת, בסגנון kanban על פני שלבים. משפך המרה לכל מנהל. ייחוס מקור ליד (מאיפה הגיע — מודעות פייסבוק, אורגני, הפניה). מהירות — כמה מהר לידים נעים בין שלבים. סיבות אובדן (כשפוטנציאלים נופלים, למה?).

---

### 2.10 Support Conversations · שיחות תמיכה

**Path:** `/admin/chats` · **Tier:** P1

#### EN
Every WhatsApp / SMS / in-app chat message across the system, searchable. Filter by manager, by client, by date, by sentiment (using existing AI summarize). Admin can intervene in any chat (send a message as admin or impersonate the manager). Sentiment heatmap — which clients are unhappy.

#### HEB
כל הודעת WhatsApp / SMS / צ'אט באפליקציה במערכת, ניתן לחפש. פילטר לפי מנהל, לפי לקוח, לפי תאריך, לפי sentiment (דרך ה-AI summarize הקיים). האדמין יכול להתערב בכל צ'אט (לשלוח הודעה כאדמין או להתחזות למנהל). מפת חום sentiment — אילו לקוחות לא מרוצים.

---

### 2.11 Catalog & Pricing · קטלוג ותמחור

**Path:** `/admin/catalog` · **Tier:** P0

#### EN
Edit `cpanel_products` collection through UI (no more direct Atlas access for routine price changes). Add/remove packages, change prices, edit bullets, set discounts, schedule promotions (price X until date Y). Version history — see when a price changed and who changed it.

#### HEB
עריכת `cpanel_products` דרך UI (לא צריך יותר Atlas ידני לשינויי מחיר שגרתיים). הוספה/הסרה של חבילות, שינוי מחירים, עריכת bullets, הגדרת הנחות, תזמון מבצעים (מחיר X עד תאריך Y). היסטוריית גרסאות — לראות מתי מחיר השתנה ומי שינה.

---

### 2.12 Integrations Health · בריאות אינטגרציות

**Path:** `/admin/integrations` · **Tier:** P1

#### EN
Live status panel for every external dependency:
- **Cardcom** — last successful payment, webhook config check
- **Fireberry** — token validity, last successful query, customer count
- **Facebook Ads** — token health per client
- **WhatsApp (GreenAPI)** — connection status
- **SMS (sms4free)** — credit balance
- **Backblaze** — bucket size, last upload, storage cost
- **OpenAI / Gemini** — API key valid, monthly spend, rate-limit hits
- **MongoDB** — connection, slow queries, collection sizes
- **Heroku / AWS** — uptime, last deploy, error rate

Alert when anything goes red.

#### HEB
לוח סטטוס חי לכל תלות חיצונית:
- **Cardcom** — תשלום מוצלח אחרון, בדיקת תצורת webhook
- **Fireberry** — תוקף טוקן, שאילתה מוצלחת אחרונה, מספר לקוחות
- **Facebook Ads** — בריאות טוקן לכל לקוח
- **WhatsApp (GreenAPI)** — סטטוס חיבור
- **SMS (sms4free)** — יתרת קרדיטים
- **Backblaze** — גודל bucket, העלאה אחרונה, עלות אחסון
- **OpenAI / Gemini** — תקף, הוצאה חודשית, פגיעות rate-limit
- **MongoDB** — חיבור, שאילתות איטיות, גדלי קולקציה
- **Heroku / AWS** — uptime, deploy אחרון, שיעור שגיאות

התראה כשמשהו אדום.

---

### 2.13 Audit Log · יומן ביקורת

**Path:** `/admin/audit` · **Tier:** P0 (requires schema work)

#### EN
Every action by every user, immutable. Who, when, what, before/after values. Examples: "Manager X reassigned client Y to manager Z", "Admin changed package price from 749 to 999", "Manager refunded transaction T". Filterable by user, action type, date, target. **This is the boss's accountability tool.**

#### HEB
כל פעולה של כל משתמש, לא ניתן לשנות. מי, מתי, מה, ערך לפני/אחרי. דוגמאות: "מנהל X העביר לקוח Y למנהל Z", "אדמין שינה מחיר חבילה מ-749 ל-999", "מנהל ביטל עסקה T". ניתן לפלטר לפי משתמש, סוג פעולה, תאריך, יעד. **זה כלי האחריותיות של הבוס.**

---

### 2.14 Broadcast & Notifications · הודעות רחבות

**Path:** `/admin/broadcasts` · **Tier:** P1

#### EN
Compose system-wide messages — to all clients, all managers, segments (e.g. "every client with Platinum package"). Schedule for later. WhatsApp + SMS + Push + email channels. Track open rate / click rate.

#### HEB
חיבור הודעות מערכתיות — לכל הלקוחות, כל המנהלים, סגמנטים (למשל "כל לקוח עם חבילת פלטינום"). תזמון להמשך. ערוצים: WhatsApp + SMS + Push + email. מעקב שיעור פתיחה / קליק.

---

### 2.15 System Settings · הגדרות מערכת

**Path:** `/admin/settings` · **Tier:** P0

#### EN
- Default coin grant per package
- Coin cost per AI action (regenerate, generate)
- Manager commission rates by tier
- SLA thresholds (when does a task turn red)
- Default language / timezone
- Maintenance mode toggle
- Feature flags (turn experimental features on/off without deploy)

#### HEB
- מתן מטבעות ברירת מחדל לחבילה
- עלות מטבע לכל פעולת AI (רגנרציה, יצירה)
- שיעורי עמלת מנהל לפי רמה
- ספי SLA (מתי משימה הופכת לאדומה)
- שפה / אזור זמן ברירת מחדל
- הפעלת maintenance mode
- Feature flags (הפעלה/כיבוי של פיצ'רים ניסיוניים בלי deploy)

---

### 2.16 Reports & Exports · דוחות וייצוא

**Path:** `/admin/reports` · **Tier:** P1

#### EN
Pre-built and custom reports — CSV / PDF / Excel.
- Monthly P&L
- Manager performance reviews (for HR)
- Client list snapshot for tax / accounting
- VAT report (Israeli tax compliance — mandatory)
- Activity report by date range
- Custom: "every client of manager X who paid more than Y"

#### HEB
דוחות מובנים מראש ומותאמים — CSV / PDF / Excel.
- P&L חודשי
- ביקורות ביצועי מנהלים (ל-HR)
- צילום מצב לקוחות לחשבונאות / מס
- דוח מע"מ (חובה לציות מסים בישראל)
- דוח פעילות לפי טווח תאריכים
- מותאם אישית: "כל לקוח של מנהל X שהוציא יותר מ-Y"

---

### 2.17 Things You Probably Haven't Thought Of · דברים שכנראה לא חשבת עליהם

#### EN
1. **Impersonation** — Admin "logs in as manager X" without knowing their password. Sees their dashboard 1:1. Critical for support and training.
2. **Manager onboarding wizard** — When a new manager joins, walk them through setup, link Fireberry, assign first clients.
3. **Churn prediction** — ML model flags clients likely to cancel based on last-activity, payment patterns, sentiment.
4. **Customer health score** — composite (payment history + responsiveness + tenure) shown next to every client.
5. **Workload rebalancer** — "Manager A has 87 clients, Manager B has 12 — suggest redistribution."
6. **Vacation mode** — Manager goes on leave → admin reassigns their open tasks for the week.
7. **Data export for GDPR / Israeli privacy law** — generate a full data dump for any client on request.
8. **Right-to-be-forgotten flow** — admin-only delete that wipes client + retains anonymized financial record.
9. **A/B testing of packages** — show different prices to different segments.
10. **Manager scoring / leaderboard** — gamification, monthly competition.
11. **Internal SOP wiki** — admin maintains process docs visible to all managers.
12. **Two-factor auth enforcement** — toggle per role.
13. **Session management** — list of every logged-in agent, force-logout suspicious sessions.
14. **API key management** — for partner integrations (already started in `controllers/partnerUpdates.controller.js` etc.)
15. **Backup verification** — proof MongoDB backups run + can be restored.
16. **Disaster recovery drill** — admin can trigger a test restore.
17. **Currency conversion** — if you ever sell in USD/EUR, central rate management.
18. **Tax exemption flags** — some clients are tax-exempt (NGOs etc.) — flag at client level.
19. **Compliance audit trails** — exportable history for accountant.
20. **Staff payroll integration** — commissions flow into a payroll export (e.g. Hilan, Michpal).
21. **"Spy mode"** — admin can watch a manager's session live (with consent) for training.
22. **Knowledge base / help center** — admin manages tutorial content shown inside cpanel.

#### HEB
1. **Impersonation** — האדמין "מתחבר בתור מנהל X" בלי לדעת את הסיסמה שלו. רואה את הדשבורד שלו 1:1. קריטי לתמיכה ולהדרכה.
2. **אשף קליטת מנהל חדש** — כשמנהל חדש מצטרף, מוביל אותו דרך הגדרה, חיבור Fireberry, הקצאת לקוחות ראשונים.
3. **חיזוי churn** — מודל ML מסמן לקוחות שצפויים לעזוב לפי פעילות אחרונה, דפוסי תשלום, sentiment.
4. **ציון בריאות לקוח** — מורכב (היסטוריית תשלום + תגובתיות + ותק) מוצג ליד כל לקוח.
5. **איזון עומסים** — "למנהל A יש 87 לקוחות, למנהל B יש 12 — הצע חלוקה מחדש".
6. **מצב חופשה** — מנהל יוצא לחופשה → אדמין מקצה מחדש את משימותיו לשבוע.
7. **ייצוא נתונים לחוק הגנת הפרטיות** — יצירת dump מלא של נתונים לכל לקוח על פי בקשה.
8. **תהליך "זכות להישכח"** — מחיקה רק לאדמין שמוחקת לקוח אך שומרת רשומה פיננסית אנונימית.
9. **A/B testing של חבילות** — הצגת מחירים שונים לסגמנטים שונים.
10. **דירוג מנהלים / לוח מובילים** — gamification, תחרות חודשית.
11. **wiki פנימי של נהלים** — האדמין מתחזק נהלי תהליך הנראים לכל המנהלים.
12. **אכיפת 2FA** — הפעלה/כיבוי לפי תפקיד.
13. **ניהול sessions** — רשימת כל ה-agents המחוברים, ניתוק כפוי לחשודים.
14. **ניהול מפתחות API** — לאינטגרציות שותפים (כבר התחיל ב-`partnerUpdates.controller.js` וכו').
15. **אימות גיבוי** — הוכחה שגיבויי MongoDB רצים + ניתנים לשחזור.
16. **תרגיל disaster recovery** — האדמין יכול להפעיל שחזור מבחן.
17. **המרת מטבע** — אם אי פעם תמכרו בדולר/יורו, ניהול שער מרכזי.
18. **דגלי פטור ממס** — חלק מהלקוחות פטורים ממע"מ (עמותות וכו') — סימון ברמת לקוח.
19. **שובלי ביקורת רגולטורית** — היסטוריה ניתנת לייצוא לרואה חשבון.
20. **אינטגרציית payroll עובדים** — עמלות זורמות לייצוא payroll (למשל חילן, מיכפל).
21. **"מצב צפייה"** — האדמין יכול לצפות ב-session של מנהל בזמן אמת (בהסכמה) להדרכה.
22. **בסיס ידע / מרכז עזרה** — האדמין מנהל תוכן הדרכה המוצג בתוך ה-cpanel.

---

## 3. Data Model — New Collections / Fields · מודל נתונים — קולקציות / שדות חדשים

### EN
Existing collections need a few additions; add a few new ones.

**Existing collections — fields to add:**
- `agents.role` already exists
- `agents.team` (string) — for supervisor → managers grouping
- `agents.commissionRate` per role/tier — already partial
- `agents.active` — already exists
- `agents.disabledAt`, `agents.disabledReason`

**New collections:**

| Collection | Purpose |
|---|---|
| `audit_log` | Every admin/manager action — `{ actor, action, target, before, after, at }` |
| `admin_settings` | KV store for system-wide settings (default coin grants, SLA thresholds, etc.) |
| `feature_flags` | `{ key, enabled, rolloutPercent, audience }` |
| `broadcasts` | Scheduled / sent broadcasts with delivery + open metrics |
| `reports` | Saved custom report definitions |
| `cpanel_teams` | Supervisor → managers mapping |
| `commission_batches` | Bulk "mark paid" payroll batches |
| `system_alerts` | Health alerts surfaced on the dashboard |
| `client_health_scores` | Computed nightly, attached to each client |
| `impersonation_log` | Every time admin views as manager — for compliance |

### HEB
לקולקציות קיימות צריך כמה תוספות; להוסיף כמה חדשות.

**קולקציות קיימות — שדות להוסיף:**
- `agents.role` כבר קיים
- `agents.team` (string) — לקיבוץ supervisor → managers
- `agents.commissionRate` לכל תפקיד/רמה — כבר חלקי
- `agents.active` — כבר קיים
- `agents.disabledAt`, `agents.disabledReason`

**קולקציות חדשות:**

| קולקציה | מטרה |
|---|---|
| `audit_log` | כל פעולת אדמין/מנהל — `{ actor, action, target, before, after, at }` |
| `admin_settings` | KV store להגדרות מערכתיות (מטבעות ברירת מחדל, ספי SLA וכו') |
| `feature_flags` | `{ key, enabled, rolloutPercent, audience }` |
| `broadcasts` | broadcasts מתוזמנים / נשלחו עם metrics |
| `reports` | הגדרות דוחות מותאמים |
| `cpanel_teams` | מיפוי supervisor → managers |
| `commission_batches` | תוכניות payroll bulk |
| `system_alerts` | התראות בריאות לדשבורד |
| `client_health_scores` | מחושב מדי לילה, מוצמד לכל לקוח |
| `impersonation_log` | כל פעם שאדמין צופה בתור מנהל — ל-compliance |

---

## 4. API Surface · נקודות קצה

### EN
All admin endpoints under `/api/cpanel/admin/*` and require `req.agent.role === "admin"` middleware.

**Critical endpoints (P0):**

```
# Dashboard
GET    /admin/dashboard
GET    /admin/dashboard/alerts

# Managers
GET    /admin/managers
GET    /admin/managers/:id
PATCH  /admin/managers/:id
POST   /admin/managers/:id/transfer-clients
POST   /admin/managers/:id/disable
POST   /admin/managers/:id/impersonate

# Clients (global)
GET    /admin/clients                          # query: manager, package, status, tier, search
GET    /admin/clients/:phone                   # full detail incl. raw doc
PATCH  /admin/clients/:phone/manager           # reassign
PATCH  /admin/clients/:phone/package           # admin override
POST   /admin/clients/:phone/force-status      # bypass whitelist

# Finance
GET    /admin/finance/revenue
GET    /admin/finance/payments                 # query: from, to, status, manager
GET    /admin/finance/commissions              # query: status, manager
POST   /admin/finance/commissions/batch-pay
POST   /admin/finance/refund                   # body: { transactionId, amount, reason }

# Operations
GET    /admin/tasks                            # all managers
GET    /admin/sla
PATCH  /admin/tasks/:id/reassign

# Catalog
GET    /admin/catalog
POST   /admin/catalog
PATCH  /admin/catalog/:key
DELETE /admin/catalog/:key

# Audit
GET    /admin/audit                            # query: actor, action, from, to

# Settings
GET    /admin/settings
PATCH  /admin/settings

# Health / Integrations
GET    /admin/integrations                     # status of every external dep

# Impersonation
POST   /admin/impersonate/start
POST   /admin/impersonate/end
```

### HEB
כל ה-endpoints של אדמין תחת `/api/cpanel/admin/*` ודורשים middleware של `req.agent.role === "admin"`.

(הרשימה זהה לעיל — לא מתרגם שמות endpoints.)

---

## 5. UI/UX Guidelines · הנחיות עיצוב

### EN
- **Sidebar:** New top-level group **"ניהול ראשי"** visible only when `agent.role === "admin"`. Existing manager sidebar stays the same — admin sees BOTH groups.
- **Color cues:** Admin pages use a subtle accent (e.g., a thin red top border on every admin card) so the user always knows they're in admin mode.
- **Confirmation dialogs:** Every destructive admin action (refund, transfer client, change price, delete data) requires a typed-confirm ("type DELETE to confirm").
- **Audit-attached actions:** Every PATCH/POST on admin endpoints automatically writes to `audit_log` with actor/before/after.
- **Bulk operations:** Show a preview of affected rows before executing.
- **Tables:** Always sortable, always filterable, always exportable.

### HEB
- **סיידבר:** קבוצה חדשה ברמה עליונה **"ניהול ראשי"** נראית רק כש-`agent.role === "admin"`. סיידבר המנהלים נשאר כפי שהוא — האדמין רואה את שתי הקבוצות.
- **רמזי צבע:** עמודי אדמין משתמשים בנגיעה דקיקה (למשל קו עליון אדום דק בכל כרטיס אדמין) כדי שהמשתמש תמיד יידע שהוא ב-admin mode.
- **אישורים:** כל פעולה הרסנית באדמין (החזר, העברת לקוח, שינוי מחיר, מחיקת נתונים) דורשת אישור מודפס ("הקלד DELETE לאישור").
- **פעולות עם audit:** כל PATCH/POST ב-admin endpoints כותב אוטומטית ל-`audit_log` עם actor/before/after.
- **פעולות bulk:** הצגת תצוגה מקדימה של השורות המושפעות לפני הביצוע.
- **טבלאות:** תמיד ניתנות למיון, סינון, וייצוא.

---

## 6. Build Phases · שלבי בנייה

### EN

**Phase 1 — MVP (2-3 weeks):** P0 items only
- Dashboard
- Managers list + detail
- Clients global list + detail
- Finance: revenue + payments + commissions
- Tasks overview
- Catalog editor
- Audit log
- System settings
- Role middleware enforcement

**Phase 2 (2-3 weeks):** P1 items
- AI usage & costs
- Reviews & approval analytics
- Pipeline global view
- Support chats
- Integrations health
- Broadcasts
- Reports & exports

**Phase 3 (ongoing):** P2 items + the "haven't thought of" list
- Impersonation
- Churn prediction
- Workload rebalancer
- 2FA enforcement
- All the rest

### HEB

**שלב 1 — MVP (2-3 שבועות):** רק פריטי P0
- דשבורד
- רשימת מנהלים + פרטים
- רשימה גלובלית של לקוחות + פרטים
- פיננסים: הכנסות + תשלומים + עמלות
- סקירת משימות
- עורך קטלוג
- audit log
- הגדרות מערכת
- אכיפת middleware של תפקיד

**שלב 2 (2-3 שבועות):** פריטי P1
- שימוש ועלות AI
- אנליטיקת תגובות לקוחות
- תצוגת pipeline גלובלית
- צ'אטים תמיכה
- בריאות אינטגרציות
- broadcasts
- דוחות וייצוא

**שלב 3 (מתמשך):** פריטי P2 + רשימת "לא חשבת עליהם"
- impersonation
- חיזוי churn
- איזון עומסים
- אכיפת 2FA
- כל השאר

---

## 7. Open Questions for the Boss · שאלות פתוחות לבוס

### EN
1. Beyond `admin`, do we need `finance`, `support`, `qa` roles? Each more limited?
2. Will the boss want a mobile-friendly admin (phone), or desktop only?
3. Multi-tenant future? Will iconiq ever sell this platform to other agencies (white-label)?
4. Compliance: VAT report generation for Israel's monthly tax filing — required from day 1?
5. Audit retention: how long must `audit_log` be kept (Israeli law: 7 years for financial)?
6. Notifications to admin: when a payment fails, when an integration breaks — email? SMS? in-app only?
7. Daily digest email at 9am with KPIs?
8. Should commissions auto-deduct from a manager's "wallet" if a refund happens, or just flag for manual review?
9. Manager performance reviews: quarterly automatic report?
10. "Disaster mode" — if an integration breaks (Cardcom down), what's the auto-fallback?

### HEB
1. מעבר ל-`admin`, צריכים גם `finance`, `support`, `qa` roles? כל אחד מצומצם יותר?
2. האם הבוס ירצה ניהול ניתן-לנייד (טלפון) או דסקטופ בלבד?
3. עתיד מולטי-tenant? האם iconiq אי פעם תמכור פלטפורמה זו לסוכנויות אחרות (white-label)?
4. ציות: יצירת דוח מע"מ להגשה החודשית בישראל — נדרש מיום 1?
5. שמירת audit: כמה זמן צריך לשמור `audit_log` (חוק ישראלי: 7 שנים לפיננסים)?
6. התראות לאדמין: כשתשלום נכשל, כשאינטגרציה נשברה — מייל? SMS? רק באפליקציה?
7. דיג'סט יומי במייל ב-9 בבוקר עם KPIs?
8. עמלות: לקזז אוטומטית מ-"ארנק" המנהל אם יש החזר, או רק לסמן לבדיקה ידנית?
9. ביקורות ביצועי מנהלים: דוח רבעוני אוטומטי?
10. "מצב חירום" — אם אינטגרציה נשברה (Cardcom down), מה ה-fallback האוטומטי?

---

## 8. Estimated Effort · אומדן עבודה

### EN
| Phase | Pages | Endpoints | Approx. dev time |
|---|---|---|---|
| Phase 1 (P0) | 9 | ~25 | 80-120 hours |
| Phase 2 (P1) | 7 | ~20 | 60-90 hours |
| Phase 3 (P2) | varies | varies | 100+ hours over weeks |

Single developer estimate. Add design + QA time.

### HEB
| שלב | עמודים | endpoints | זמן פיתוח משוער |
|---|---|---|---|
| שלב 1 (P0) | 9 | ~25 | 80-120 שעות |
| שלב 2 (P1) | 7 | ~20 | 60-90 שעות |
| שלב 3 (P2) | משתנה | משתנה | 100+ שעות לאורך שבועות |

אומדן למפתח יחיד. הוסף זמן עיצוב + QA.

---

## 9. Recommended Next Step · צעד הבא מומלץ

### EN
Sit with the boss for ~30 minutes and run through this document section by section. For each, ask:
- Do you need it now, in 3 months, or never?
- Which fields/columns matter most to you?
- Who else needs to see it (besides you)?

After that conversation, lock the Phase 1 MVP scope, then start with the **role-aware sidebar group + audit log + dashboard** as the foundation. Everything else hangs off those three.

### HEB
שב עם הבוס ~30 דקות ועבור על המסמך הזה סעיף סעיף. לכל אחד, שאל:
- צריך עכשיו, בעוד 3 חודשים, או לעולם לא?
- אילו שדות/עמודות הכי חשובים לך?
- מי עוד צריך לראות את זה (חוץ ממך)?

אחרי השיחה הזו, נעל את היקף ה-MVP של שלב 1, ואז התחל עם **קבוצת סיידבר מודעת-תפקיד + audit log + דשבורד** כיסוד. כל השאר תלוי בשלושה אלה.
