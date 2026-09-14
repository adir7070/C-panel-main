# Iconiq — MongoDB Reference Guide

> תאריך: 2026-04-09 | זה הקובץ הראשי. ראה גם: `DB_ARCHITECTURE.md`, `DB_COLLECTIONS_GUIDE.md`

---

## טבלת סיכום — כל ה-Collections

| Collection | מה זה | סטטוס |
|---|---|---|
| `action_prices` | מחיר מטבעות לכל פעולה | ✅ KEEP |
| `ad_briefs` | שאלון מיתוג לפני יצירת קמפיין | ✅ KEEP |
| `ad_image_jobs` | Job tracking ליצירת תמונות AI | ⚠️ MERGE → `jobs` |
| `ad_plans` | עותקי מודעות שנוצרו ע"י AI | ✅ KEEP |
| `ad_sessions` | Session של תהליך יצירת קמפיין | ✅ KEEP |
| `agent_chats` | צ'אט פנימי בין נציגים | ✅ KEEP (תקן embedded messages) |
| `agent_ratings` | דירוגי נציגים מלקוחות | ✅ KEEP |
| `agents` | נציגי תמיכה + הרשאות | 🔴 KEEP (הוסף index על token!) |
| `allowed_file_types` | סוגי קבצים מותרים להעלאה | ✅ KEEP |
| `appointments` | פגישות מתוזמנות | ✅ KEEP |
| `chat_ratings` | דירוגי שיחות תמיכה | ✅ KEEP |
| `client_briefs` | שאלון onboarding למפרסמים חדשים | ✅ KEEP |
| `coin_transactions` | ספר חשבונות מטבעות | ✅ KEEP |
| `custom_roles` | הגדרות הרשאות מותאמות | ✅ KEEP |
| `customers` | Cache ישן של לקוחות | ⚠️ DELETE — שלב 2 (יש קוד שמשתמש) |
| `fireberry_customers` | Cache של Fireberry CRM | ✅ KEEP (הוסף TTL) |
| `gallery_statuses` | סטטוס אישור תמונות בגלריה | ✅ KEEP |
| `image_batch_jobs` | Job tracking ליצירת תמונות batch | ⚠️ MERGE → `jobs` |
| `images` | תמונות שנוצרו ע"י AI | ✅ KEEP |
| `instagram_jobs` | Job tracking לפעולות אינסטגרם | ⚠️ MERGE → `jobs` |
| `instagram_posts` | Cache של פוסטים באינסטגרם | ✅ KEEP |
| `leads` | לידים מ-Facebook Lead Ads | ✅ KEEP (source of truth) |
| `marketing_weather_cache` | Cache לניתוחי AI שיווקיים | ✅ KEEP |
| `meeting_statuses` | Lookup סטטוסי פגישות | ✅ KEEP |
| `profiles` | פרופיל ציבורי של מפרסם | ⚠️ DELETE — שלב 2 (merge עם users) |
| `profiles_by_page` | עותק של profiles לפי pageId | ⚠️ DELETE — שלב 1 (יש קוד שמשתמש) |
| `sms_counter` | Counter יחיד ליתרת SMS | ⚠️ DELETE — שלב 2 (העבר ל-users) |
| `sms_logs` | לוג של כל שליחות SMS | ✅ KEEP |
| `stations` | מחלקות צוות התמיכה | ✅ KEEP |
| `support_chats` | שיחות תמיכה עם לקוחות | 🔴 KEEP (messages מוטמעות — בעיה) |
| `user_leads` | כפול של leads בפורמט nested | ⚠️ DELETE — שלב 2 (וודא sync לפני) |
| `users` | חשבונות מפרסמים + מאזן מטבעות | ✅ KEEP |
| `wa_auth_keys` | מפתחות Baileys ל-WhatsApp | ✅ KEEP |
| `wa_health_log` | לוג בריאות חשבונות WhatsApp | ✅ KEEP |
| `wa_marketing_config` | הגדרות שיווק WhatsApp | ✅ KEEP |
| `wa_marketing_jobs` | Job queue לשליחות WA bulk | ⚠️ MERGE → `jobs` |
| `wa_sessions` | Sessions של WhatsApp (Baileys) | ✅ KEEP |
| `willbox_invoices` | חשבוניות שחולצו ע"י AI | ✅ KEEP |

---

## מה למחוק — מסודר לפי שלבים

---

### שלב 0 — מיידי (אין מחיקה, רק indexes)

לפני כל מחיקה — הוסף את ה-indexes האלה:

```js
// 1. הכי דחוף — full scan על כל API request
db.agents.createIndex({ token: 1 }, { unique: true, sparse: true })

// 2. queries איטיים על leads
db.leads.createIndex({ page_id: 1, status: 1, updated_at: -1 })

// 3. Fireberry cache לא נמחק לעולם — TTL אוטומטי 24 שעות
db.fireberry_customers.createIndex({ cached_at: 1 }, { expireAfterSeconds: 86400 })
```

---

### שלב 1 — אפשר למחוק עכשיו (תנאים קלים)

#### `profiles_by_page`

**מה זה:** עותק זהה של `profiles` אבל indexed לפי `pageId`. נוצר כ-denormalization מיותרת.

**מה צריך לעשות לפני מחיקה:**
1. הוסף index על `profiles`:
   ```js
   db.profiles.createIndex({ pageId: 1 }, { sparse: true })
   ```
2. ב-`profile.controller.js` — שנה 2 שורות:
   ```js
   // במקום:
   .collection("profiles_by_page").findOne({ pageId })
   .collection("profiles_by_page").updateOne({ pageId }, ...)
   
   // שנה ל:
   .collection("profiles").findOne({ pageId })
   .collection("profiles").updateOne({ pageId }, ...)
   ```
3. מחק מ-MongoDB Atlas: `db.profiles_by_page.drop()`

**זמן משוער:** 30 דקות

---

### שלב 2 — מחיקה אחרי וידוא data

#### `user_leads`

**מה זה:** כל הלידים של כל מפרסם מאוחסנים בdoc אחד ענקי עם arrays מקוננות. כפול לחלוטין עם `leads`.

**סיכון:** ייתכן שיש לידים ב-`user_leads` שלא הועברו ל-`leads`. צריך לבדוק.

**מה צריך לעשות לפני מחיקה:**
1. בדק כמה לידים יש בכל collection:
   ```js
   // ב-leads:
   db.leads.countDocuments()
   
   // ב-user_leads (כמות לידים בפועל — מקוננים):
   db.user_leads.aggregate([
     { $unwind: "$forms" },
     { $unwind: "$forms.leads" },
     { $count: "total" }
   ])
   ```
2. אם המספרים שונים — הרץ migration script שמשטח את `user_leads` ל-`leads`
3. רק אחרי שהמספרים שווים: `db.user_leads.drop()`

---

#### `customers`

**מה זה:** Cache ישן של לקוחות מלפני האינטגרציה עם Fireberry.

**מי עדיין משתמש:**
- `ai.controller.js` — כותב לקוח חדש כשמגיע ליד מ-Facebook
- `mongo-appointments.service.js` — קורא לקוח לפי phone

**מה צריך לעשות לפני מחיקה:**
1. ב-`ai.controller.js` — החלף את ה-insert ל-`customers` ב-insert ל-`leads` (אם זה ליד חדש) או ל-`fireberry_customers` (אם זה cache)
2. ב-`mongo-appointments.service.js` — החלף את ה-`findOne` מ-`customers` ל-`fireberry_customers`
3. ודא ש-`fireberry_customers` מכיל את אותם לקוחות
4. `db.customers.drop()`

**זמן משוער:** 2-3 שעות

---

#### `sms_counter`

**מה זה:** Doc יחיד (`_id: "main"`) שסופר כמה SMS נשלחו. בעייתי כי כל שליחת SMS כותבת לאותו doc — race condition פוטנציאלי.

**מה צריך לעשות לפני מחיקה:**
1. הוסף field `sms_credits` על `users` collection
2. ב-`whatsapp.controller.js` — שנה את הלוגיקה של `trackSmsUsage`:
   ```js
   // במקום לכתוב ל-sms_counter:
   await DB.collection("sms_counter").updateOne({ _id: "main" }, { $inc: { sent_count: 1 } })
   
   // כתוב ל-users:
   await DB.collection("users").updateOne({ phone }, { $inc: { sms_credits: -1 } })
   ```
3. `db.sms_counter.drop()`

---

### שלב 3 — אחד ל-`jobs` (אופציונלי, שיפור ארכיטקטוני)

4 collections עם **אותו shape בדיוק** — כדאי לאחד ל-collection אחד:

| למחוק | `job_type` חדש ב-`jobs` |
|---|---|
| `ad_image_jobs` | `"ad_images"` |
| `image_batch_jobs` | `"image_batch"` |
| `instagram_jobs` | `"instagram_post"` |
| `wa_marketing_jobs` | `"wa_send_text"` |

**איך:**
1. צור collection חדש `jobs` עם שדה `job_type`
2. העבר נתונים קיימים (migration script)
3. עדכן את הworkers/services לכתוב ל-`jobs` במקום
4. מחק את 4 הcollections הישנים

---

### לא למחוק — גם אם נראה כפול

| Collection | למה לא למחוק |
|---|---|
| `profiles` | עדיין נקרא בכמה מקומות — צריך migration לפני |
| `leads` | ה-source of truth — לא למחוק! |
| `fireberry_customers` | Cache פעיל — נמחק אוטומטי אחרי הוספת TTL |

---

## מבנה ה-DB לאחר ניקוי

```
collections שנשארים (33):
✅ action_prices          ✅ ad_briefs
✅ ad_plans               ✅ ad_sessions
✅ agent_chats            ✅ agent_ratings
✅ agents                 ✅ allowed_file_types
✅ appointments           ✅ chat_ratings
✅ client_briefs          ✅ coin_transactions
✅ custom_roles           ✅ fireberry_customers
✅ gallery_statuses       ✅ images
✅ instagram_posts        ✅ leads
✅ marketing_weather_cache ✅ meeting_statuses
✅ profiles               ✅ sms_logs
✅ stations               ✅ support_chats
✅ users                  ✅ wa_auth_keys
✅ wa_health_log          ✅ wa_marketing_config
✅ wa_sessions            ✅ willbox_invoices
✅ jobs (חדש)

collections שנמחקים (5):
🗑️ profiles_by_page      ← שלב 1
🗑️ user_leads            ← שלב 2
🗑️ customers             ← שלב 2
🗑️ sms_counter           ← שלב 2
🗑️ ad_image_jobs         ← שלב 3 (merge)
🗑️ image_batch_jobs      ← שלב 3 (merge)
🗑️ instagram_jobs        ← שלב 3 (merge)
🗑️ wa_marketing_jobs     ← שלב 3 (merge)
```
