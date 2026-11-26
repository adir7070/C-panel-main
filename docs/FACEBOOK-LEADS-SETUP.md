# חיבור לידים מפייסבוק ל-CRM של דשן: משימה לקלוד בדפדפן

## המטרה

כל ליד שממלא טופס לידים בדף הפייסבוק של **דשן מדיה טק** צריך להיכנס אוטומטית ל-CRM.
הוא נכנס כליד חדש, עם מקור `facebook`, ומשויך אוטומטית (היום לגלי).

הצד של השרת כבר מוכן ופועל. התפקיד שלך הוא **רק הגדרות** ב-Meta וב-Heroku.
לא נוגעים בקוד.

### איך זה עובד

1. מישהו ממלא טופס בפייסבוק.
2. Meta שולחת התראה ל-webhook של השרת. ההתראה כוללת רק מזהים, כמו `leadgen_id`.
3. השרת קורא את פרטי הליד מה-Graph API עם טוקן הדף.
4. הליד נשמר ב-CRM.

כדי שזה יעבוד צריך:

- את 4 הערכים ב-Heroku.
- מנוי webhook באפליקציה: אובייקט Page, שדה `leadgen`.
- התקנה של האפליקציה על הדף.
- אפליקציה במצב Live.

---

## חוקים (חובה)

1. **רק הדף של דשן מדיה טק.**
   - החשבון כנראה מנהל גם דפים של לקוחות. לא נוגעים בהם, לא מסמנים אותם ולא מתקינים עליהם כלום.
   - אם לא ברור איזה דף הוא של דשן: עוצרים ושואלים את המשתמש.
2. **סודות עוברים ישר מ-Meta ל-Heroku.**
   - הסודות הם App Secret וטוקן הדף.
   - לא כותבים אותם בצ'אט, בקובץ, בהערה או בסיכום, ולא מראים אותם למשתמש.
3. **סיסמאות מקליד רק המשתמש.** אם מופיע חלון שמבקש סיסמת פייסבוק או Heroku, מבקשים מהמשתמש להקליד אותה בעצמו.
4. **עוצרים ושואלים את המשתמש לפני:**
   - הגשה ל-App Review.
   - אימות עסק (Business Verification).
   - כל תשלום.
   - מחיקה של משהו.
   - שינוי של משהו שלא כתוב במסמך הזה.
5. **ב-Heroku מוסיפים רק את 4 המשתנים `FB_LEADS_*`.**
   - לא משנים ולא מוחקים משתנים קיימים.
   - זה כולל את `FB_APP_ID` / `FB_APP_SECRET`, ששייכים לתהליך אחר.
6. **לא יוצרים מודעות, ולא עורכים או מוחקים טפסים.**
7. **מסך שלא נראה כמו שמתואר כאן:**
   - Meta משנה את הממשק לעיתים קרובות, ושמות המסכים פה הם הערכה.
   - מתארים למשתמש מה רואים ושואלים. לא מנחשים.

---

## פרטים קבועים

| מה | ערך |
|---|---|
| השרת | `https://dashen-cpanel-b76c272f93dd.herokuapp.com` |
| Callback URL ל-webhook | `https://dashen-cpanel-b76c272f93dd.herokuapp.com/api/leads/facebook-webhook` |
| מסך הלידים ב-CRM | `https://dashen-cpanel-b76c272f93dd.herokuapp.com/leads` |
| הגדרות Heroku | `https://dashboard.heroku.com/apps/dashen-cpanel/settings` |
| לוגים של Heroku | `https://dashboard.heroku.com/apps/dashen-cpanel/logs` |
| האפליקציות ב-Meta | `https://developers.facebook.com/apps` |
| Graph API Explorer | `https://developers.facebook.com/tools/explorer` |
| Access Token Debugger | `https://developers.facebook.com/tools/debug/accesstoken` |
| Lead Ads Testing Tool | `https://developers.facebook.com/tools/lead-ads-testing` |

**4 משתני ה-Config ב-Heroku** (השמות חייבים להיות מדויקים):

| משתנה | מה שמים בו |
|---|---|
| `FB_LEADS_VERIFY_TOKEN` | מחרוזת אקראית שאתה מייצר (שלב 2). אותה מחרוזת נכנסת גם להגדרת ה-webhook ב-Meta. |
| `FB_LEADS_APP_SECRET` | ה-App Secret של **אותה** אפליקציה שבה מוגדר ה-webhook. |
| `FB_LEADS_PAGE_TOKEN` | טוקן של הדף של דשן שלא פג (Expires: Never). |
| `FB_LEADS_PAGE_ID` | המזהה המספרי של הדף של דשן. |

כל שמירה של משתנה ב-Heroku מפעילה מחדש את השרת. זה לוקח 10–30 שניות. זה תקין.

---

## שלב 0: לבדוק שהקוד כבר עלה לשרת

פותחים בלשונית את ה-Callback URL. התוצאה הצפויה היא JSON כזה:

```json
{"ok":true,"configured":{"verifyToken":false,"appSecret":false,"pageToken":false,"pageId":false}}
```

- **אם מופיע ה-JSON:** ממשיכים. בשלב הזה הערכים יכולים להיות `false`.
- **אם מופיעים 404, `not_found` או דף HTML של המערכת:** הקוד עוד לא עלה.
  1. עוצרים.
  2. אומרים למשתמש: "צריך לעשות push ל-main ולחכות שה-build ב-Heroku יסתיים".

## שלב 1: האפליקציה ב-Meta

1. נכנסים ל-`developers.facebook.com/apps`.
2. בוחרים את האפליקציה של המשתמש. אם יש יותר מאחת, שואלים איזו.
3. רושמים לדיווח הסופי:
   - את שם האפליקציה.
   - את ה-App ID (הוא לא סוד).
   - את המצב שלה (Development / Live, או Unpublished / Published).
4. נכנסים ל-**App settings → Basic** ובודקים אילו שדות קיימים:
   - Privacy Policy URL.
   - Category.
   - App icon.
   - User data deletion.

   הם יידרשו בשלב 7. כתובת או תמונה שחסרה: **שואלים את המשתמש**, לא ממציאים.

## שלב 2: Verify Token ו-App Secret ל-Heroku

1. **מייצרים Verify Token:**
   1. פותחים לשונית כלשהי.
   2. בקונסול מריצים `crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")`.
   3. מעתיקים את התוצאה.
2. **שומרים אותו ב-Heroku:**
   1. נכנסים להגדרות Heroku ולוחצים **Reveal Config Vars**.
   2. מוסיפים KEY = `FB_LEADS_VERIFY_TOKEN` ו-VALUE = המחרוזת.
   3. לוחצים **Add**.
3. **מעבירים את ה-App Secret:**
   1. חוזרים ל-Meta, למסך **App settings → Basic**.
   2. ליד **App Secret** לוחצים **Show**. אם נדרשת סיסמה, המשתמש מקליד אותה.
   3. מעתיקים את הערך.
   4. ב-Heroku מוסיפים `FB_LEADS_APP_SECRET`.

## שלב 3: טוקן דף שלא פג, ומזהה הדף

1. **מגדירים את ה-Explorer:**
   1. פותחים את **Graph API Explorer**.
   2. בשדה **Meta App** בוחרים את האפליקציה משלב 1.
   3. ב-**User or Page** בוחרים **Get User Access Token**.
2. **מוסיפים את ההרשאות האלה:**
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_metadata`
   - `leads_retrieval`
   - `pages_manage_ads`
   - `ads_management`

   אם הרשאה לא מופיעה ברשימה, כנראה צריך להוסיף לאפליקציה Use case או Product שכולל אותה (משהו כמו Lead Ads, Marketing API או Webhooks). מתארים למשתמש מה רואים ושואלים לפני שמוסיפים.
3. **יוצרים את הטוקן:**
   1. לוחצים **Generate Access Token**.
   2. בחלון של פייסבוק, כשהוא שואל לאילו דפים לתת גישה, בוחרים **רק את הדף של דשן מדיה טק**.
   3. מאשרים.
4. **מאריכים אותו:**
   1. מעתיקים את הטוקן שנוצר (טוקן משתמש קצר).
   2. פותחים את **Access Token Debugger**, מדביקים ולוחצים **Debug**.
   3. למטה לוחצים **Extend Access Token** ומעתיקים את הטוקן הארוך שנוצר.
5. **מושכים את טוקן הדף:**
   1. חוזרים ל-Explorer ומדביקים את הטוקן הארוך בשדה Access Token.
   2. מריצים GET על:

      ```text
      me/accounts?fields=id,name,access_token
      ```

   3. בתשובה מוצאים את הדף של דשן מדיה טק לפי `name`.
6. **שומרים ב-Heroku:**
   1. את ה-`id` שלו שומרים ב-`FB_LEADS_PAGE_ID`.
   2. את ה-`access_token` שלו מעתיקים ועוברים לבדיקה בסעיף 7. הוא נכנס ל-`FB_LEADS_PAGE_TOKEN` רק אחריה.
7. **בודקים את טוקן הדף:** מדביקים אותו ב-Access Token Debugger ומוודאים:
   - **Type:** Page.
   - **Page ID:** אותו מזהה של דשן.
   - **Expires:** **Never**.
   - **Scopes:** כוללים לפחות `leads_retrieval`, `pages_manage_metadata`, `pages_show_list` ו-`pages_read_engagement`.

   אם Expires הוא לא Never, חוזרים לסעיף 4. כשהכל תקין, שומרים ב-Heroku את `FB_LEADS_PAGE_TOKEN`.

## שלב 4: לוודא שהשרת רואה את 4 הערכים

1. מחכים כחצי דקה ופותחים שוב את ה-Callback URL.
2. התוצאה הצפויה:

   ```json
   {"ok":true,"configured":{"verifyToken":true,"appSecret":true,"pageToken":true,"pageId":true}}
   ```

3. אם יש `false`:
   1. בודקים ב-Heroku שהשם של המשתנה מדויק, בלי רווחים.
   2. מחכים עוד חצי דקה ופותחים שוב.

## שלב 5: מנוי ה-Webhook באפליקציה

1. **מוצאים את ה-Webhooks:**
   - בדשבורד של האפליקציה מחפשים **Webhooks**.
   - הוא יכול להיות מוצר בתפריט, או בתוך Use case תחת Customize.
   - אם הוא לא קיים, שואלים את המשתמש לפני שמוסיפים מוצר.
2. **מחברים את אובייקט ה-Page:**
   1. באובייקט בוחרים **Page**, ואז **Subscribe to this object** (או Edit subscription).
   2. **Callback URL:** ה-Callback URL מהטבלה.
   3. **Verify token:** הערך של `FB_LEADS_VERIFY_TOKEN`. מעתיקים מ-Heroku דרך Reveal Config Vars, בלי רווחים.
   4. לוחצים **Verify and save**. התוצאה צריכה להיות שמירה מוצלחת.
   5. אם יש שגיאת אימות:
      - מוודאים ששלב 4 עבר.
      - מוודאים שה-token זהה בדיוק.
      - מוודאים שה-URL מדויק.
3. **מפעילים את `leadgen`:**
   1. ברשימת השדות של Page מוצאים את `leadgen` ולוחצים **Subscribe**.
   2. אם יש ליד השדה כפתור **Test**, לוחצים עליו.
   3. בלוגים של Heroku אמורה להופיע שורה כמו `[fb-leads] lead … is for page …, not FB_LEADS_PAGE_ID — ignored`.
   4. זה **תקין**: הבדיקה של Meta שולחת דף דמה. זה מוכיח שהחתימה והחיבור עובדים.

## שלב 6: להתקין את האפליקציה על הדף

1. **בוחרים את הדף ב-Explorer:**
   1. ב-Graph API Explorer בוחרים את האפליקציה.
   2. ב-**User or Page** בוחרים את הדף של דשן מדיה טק. כך נוצר טוקן דף.
2. **מתקינים:**
   1. משנים את ה-method ל-**POST** ומריצים:

      ```text
      <PAGE_ID>/subscribed_apps?subscribed_fields=leadgen
      ```

   2. התשובה הצפויה היא `{"success": true}`.
3. **מוודאים:** מריצים **GET** על `<PAGE_ID>/subscribed_apps`. האפליקציה צריכה להופיע, ו-`leadgen` ב-`subscribed_fields`.

## שלב 7: לפרסם את האפליקציה (Live)

המשתמש החליט לפרסם. לפי התיעוד של Meta, אפליקציה שלא פורסמה מקבלת רק webhooks של בדיקה ולא לידים אמיתיים. גם כלי בדיקת הלידים לא עובד במצב פיתוח.

1. בדשבורד מחפשים **Publish**, או מתג **App Mode → Live**.
2. ממלאים מה ש-Meta דורשת: Privacy Policy URL, Category, אייקון וכו'. ערך שאין לך: **שואלים את המשתמש**.
3. **עוצרים ומדווחים למשתמש בדיוק מה כתוב** אם Meta דורשת אחד מאלה:
   - App Review (להרשאה כמו `leads_retrieval`).
   - Business Verification.
   - Advanced Access.

   בשלב הזה לא מגישים כלום.
4. אחרי הפרסום רושמים לדיווח:
   1. נכנסים ל-**App Review → Permissions and Features**, אם יש מסך כזה.
   2. רושמים את רמת הגישה של כל אחת מההרשאות שבשלב 3 (Standard / Advanced).

## שלב 8: Leads Access (גישת CRM ללידים)

1. נכנסים להגדרות העסק ב-`business.facebook.com/settings` → **Integrations** → **Leads Access**. השם יכול להיות קצת שונה.
2. בוחרים את הדף של דשן מדיה טק.
3. בודקים מה כתוב:
   - **אם הגישה מוגבלת (customized):** מוודאים שהאפליקציה מופיעה בלשונית ה-CRMs ושיש לה גישה. אם אין, נותנים לה גישה.
   - **אם כתוב שכל המנהלים מקבלים גישה, או שאין הגבלה:** אין מה לעשות.
4. אם הדף לא נמצא בהגדרות העסק, או שהמסך לא ברור, מתארים למשתמש ושואלים.

## שלב 9: בדיקה מקצה לקצה

1. **יוצרים ליד בדיקה:**
   1. פותחים את **Lead Ads Testing Tool**.
   2. בוחרים את הדף של דשן מדיה טק, ואז טופס פעיל.
   3. אם כבר יש ליד בדיקה לטופס הזה, לוחצים **Delete lead**. זה מוחק רק את ליד הבדיקה של הכלי.
   4. לוחצים **Create lead**, ואז **Track status**.
   5. מחכים לסטטוס **success** אצל האפליקציה שלנו.
2. **בודקים בלוגים של Heroku:** תוך דקה–שתיים אמורה להופיע השורה:

   ```text
   [fb-leads] lead <id> (form <id>): saved
   ```

3. **בודקים ב-CRM:**
   1. נכנסים למסך הלידים ב-CRM. המשתמש צריך להיות מחובר.
   2. צריך להופיע ליד חדש, עם שם כמו "test lead: dummy data…", מקור `facebook`, משויך לגלי.
   3. לא משנים ולא מוחקים את הליד. רק מדווחים עליו למשתמש.

### אם משהו לא עובד: מה רואים בלוגים של Heroku

| שורה בלוג | מה זה אומר | מה עושים |
|---|---|---|
| אין שום שורה `[fb-leads]` | Meta לא שלחה כלום | בודקים שהאפליקציה Live (שלב 7), ששדה `leadgen` במנוי (שלב 5), שהאפליקציה מותקנת על הדף (שלב 6), ואת Leads Access (שלב 8) |
| `webhook verification refused` | ה-Verify token לא תואם | מעתיקים שוב מ-Heroku ל-Meta (שלב 5) |
| `bad or missing X-Hub-Signature-256` | ה-App Secret לא של האפליקציה הזאת | מעתיקים שוב את ה-App Secret של **אותה** אפליקציה (שלב 2) |
| `… not set — notification refused` | חסר משתנה ב-Heroku | שלב 4 |
| `is for page …, not FB_LEADS_PAGE_ID` (בליד אמיתי) | מזהה הדף שגוי | מתקנים את `FB_LEADS_PAGE_ID` (שלב 3) |
| `lead … failed: Graph …` עם `code` 100, 190 או 200 | לטוקן אין הרשאה, הוא פג, או שהגישה ללידים חסומה | בודקים את הטוקן ב-Debugger (שלב 3, סעיף 7) ואת Leads Access (שלב 8) |
| `database unavailable` | בעיה בשרת | עוצרים ומדווחים למשתמש |

ליד שנכשל לא הולך לאיבוד: Meta שולחת אותו שוב במשך עד 36 שעות. השרת שומר כל ליד פעם אחת בלבד, גם אם הוא נשלח שוב.

---

## בדיקה צדדית (רק לדווח, לא לשנות)

ב-Heroku, ב-Config Vars, בודקים אם קיים משתנה בשם `LEADS_INTAKE_KEY`. **לא חושפים את הערך.**

אם הוא לא קיים, מדווחים למשתמש: בלעדיו, האנדפוינט `/api/leads/intake` פתוח לכל אחד. לא יוצרים אותו בעצמך, כי זה עלול לשבור מערכות שכבר שולחות אליו.

## דיווח סיום למשתמש (בלי שום ערך סודי)

- **האפליקציה:** שם, App ID, ומצב (Live או לא).
- **הדף:** השם והמזהה של הדף שחובר.
- **הרשאות:** אילו הרשאות ניתנו, וברמת גישה Standard או Advanced אם רואים.
- **Heroku:** אילו מ-4 המשתנים נוספו (שמות בלבד), והתוצאה של שלב 4.
- **ה-webhook:**
  - האם האימות עבר.
  - האם `leadgen` במנוי.
  - מה הייתה התשובה של `subscribed_apps`.
- **Leads Access:** מה היה במסך ומה שונה.
- **הבדיקה:** הסטטוס בכלי הבדיקה, השורה מהלוג, והאם הליד הופיע ב-CRM.
- **עצירות:** כל מקום שבו עצרת ושאלת, או ש-Meta דרשה משהו (App Review, אימות עסק וכו').
- **`LEADS_INTAKE_KEY`:** קיים או לא.
