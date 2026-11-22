/* Dashen Media Tech price list — the 64 services of the sales kit
   ("ערכת הכשרה למכירות", 12.11.2026, chapter 02), in kit order.

   Seeded into cpanel_products as kind "service" by
   cpanel-products.service.seedDefaults() (insert-if-missing by key, so a
   price edited in the DB is never overwritten on boot).

     role:    "core"  = מרכזי   (brings or manages clients)
              "addon" = משלים   (grows the result of a core service)
     billing: "setup"   = הקמה  (one-time, paid at signing)
              "monthly" = חודשי (recurring)
     onDemand: true → "הקמה · לפי הזמנה" (charged per order)
     price:   ILS before VAT
     keywords: extra search words (English names, synonyms) for the
               quote builder's search. */

const CATEGORIES = [
  { key: "web",          order: 1,  name: "אתר ונוכחות דיגיטלית" },
  { key: "ads",          order: 2,  name: "פרסום ממומן" },
  { key: "leads",        order: 3,  name: "לידים, CRM ו-WhatsApp" },
  { key: "automation",   order: 4,  name: "אוטומציות" },
  { key: "social",       order: 5,  name: "סושיאל ותוכן" },
  { key: "sales",        order: 6,  name: "מכירות ותשלומים" },
  { key: "retention",    order: 7,  name: "תקשורת ושימור לקוחות" },
  { key: "data",         order: 8,  name: "דוחות ודאטה" },
  { key: "integrations", order: 9,  name: "אינטגרציות" },
  { key: "infra",        order: 10, name: "תשתית, אבטחה ורגולציה" },
];

const S = (category, key, name, description, role, billing, price, keywords = "", onDemand = false) =>
  ({ category, key, name, description, role, billing, price, keywords, onDemand });

const SERVICES = [
  // 1 · אתר ונוכחות דיגיטלית
  S("web", "website", "אתר אינטרנט", "אתר תדמית מותאם לנייד, כולל דומיין, אחסון ועיצוב", "core", "setup", 3000, "website אתר תדמית wordpress elementor דומיין אחסון"),
  S("web", "landing_page", "דף נחיתה", "עמוד אחד ממוקד להמרה, לקמפיין או לשירות מסוים", "core", "setup", 1080, "landing page lp עמוד נחיתה"),
  S("web", "google_business", "הקמת Google Business Profile", "פרופיל עסק בגוגל ובמפות: שעות, תמונות, ביקורות", "addon", "setup", 300, "google business profile גוגל מפות maps ביקורות gmb"),
  S("web", "seo_blog", "SEO לאתר + בלוג / מאמרים", "קידום אורגני שוטף ומאמרים שמביאים תנועה מגוגל", "addon", "monthly", 300, "seo קידום אורגני בלוג מאמרים גוגל"),
  S("web", "site_content", "ניהול תוכן באתר", "עדכון עמודים, טקסטים ותמונות באופן שוטף", "addon", "monthly", 400, "content cms עדכון אתר"),
  S("web", "site_speed", "אופטימיזציה למהירות האתר", "קיצור זמן טעינה, שמשפר המרות ודירוג", "addon", "setup", 300, "speed מהירות טעינה performance"),
  S("web", "site_security_backup", "אבטחה וגיבויים", "הקשחת האתר וגיבוי קבוע", "addon", "setup", 840, "security backup אבטחה גיבוי"),
  S("web", "analytics_setup", "חיבור Analytics + Search Console + Google Ads", "מדידה מלאה: מאיפה מגיעים גולשים ומה הם עושים", "addon", "setup", 840, "google analytics ga4 search console google ads מדידה"),

  // 2 · פרסום ממומן
  S("ads", "meta_campaigns", "ניהול קמפיינים + סושיאל ב-Meta", "קמפיינים בפייסבוק ובאינסטגרם יחד עם ניהול העמודים", "core", "monthly", 1000, "meta facebook instagram פייסבוק אינסטגרם קמפיין ממומן"),
  S("ads", "tiktok_ads", "TikTok Ads", "קמפיינים ממומנים בטיקטוק", "addon", "monthly", 800, "tiktok טיקטוק ממומן קמפיין"),
  S("ads", "audiences", "יצירת קהלים + קבוצות", "בניית קהלי יעד, קהלים דומים ורימרקטינג", "addon", "monthly", 670, "audiences lookalike remarketing רימרקטינג קהל"),
  S("ads", "campaign_optimization", "אופטימיזציה שוטפת לקמפיינים", "בדיקות ושיפור מתמיד להורדת עלות לליד", "addon", "monthly", 910, "optimization אופטימיזציה עלות לליד cpl"),

  // 3 · לידים, CRM ו-WhatsApp
  S("leads", "crm", "מערכת CRM", "מקום אחד לכל הלידים והלקוחות, עם סטטוסים ומעקב", "core", "setup", 2160, "crm ניהול לקוחות לידים"),
  S("leads", "whatsapp_business", "WhatsApp Business", "חשבון עסקי מסודר: קטלוג, תגיות, הודעות מוכנות", "addon", "setup", 500, "whatsapp business וואטסאפ עסקי"),
  S("leads", "reminders", "תזכורות ללקוחות", "הודעת תזכורת אוטומטית לפני תור או פגישה", "addon", "setup", 480, "reminders תזכורת תור פגישה"),
  S("leads", "payment_link", "שליחת קישור לתשלום", "קישור תשלום שנשלח ללקוח בהודעה", "addon", "setup", 360, "payment link קישור תשלום"),
  S("leads", "whatsapp_ai_bot", "צ’אטבוט AI ב-WhatsApp", "בוט שעונה, מסנן ואוסף פרטים בוואטסאפ", "core", "setup", 1500, "chatbot bot בוט צאטבוט ai וואטסאפ manychat"),
  S("leads", "lead_autoreply", "מענה אוטומטי ללידים", "תגובה מיידית לכל ליד חדש שנכנס", "addon", "setup", 1300, "auto reply מענה אוטומטי"),
  S("leads", "ai_agent", "AI שעונה ללקוחות", "סוכן AI מותאם לעסק שעונה לשאלות לקוחות", "core", "setup", 4000, "ai agent סוכן voiceflow שירות לקוחות"),

  // 4 · אוטומציות
  S("automation", "auto_quotes", "יצירת הצעות מחיר אוטומטית", "הצעה שנבנית ונשלחת מתבנית בלי הקלדה", "addon", "setup", 840, "quotes הצעת מחיר אוטומציה"),
  S("automation", "auto_emails", "שליחת מיילים אוטומטית", "מיילים שיוצאים לפי אירוע: ליד חדש, רכישה, מעקב", "addon", "setup", 600, "email מייל דוא\"ל אוטומציה"),
  S("automation", "auto_whatsapp", "שליחת WhatsApp אוטומטית", "הודעות וואטסאפ שיוצאות לפי אירוע", "addon", "setup", 660, "whatsapp וואטסאפ אוטומציה הודעות"),
  S("automation", "systems_integration", "חיבור בין מערכות שונות", "מידע שעובר לבד בין האתר, ה-CRM והנהלת החשבונות", "addon", "setup", 1620, "integration חיבור מערכות"),
  S("automation", "post_purchase_automation", "אוטומציה לאחר רכישה", "תודה, הוראות, בקשת ביקורת והצעת המשך", "addon", "setup", 1020, "post purchase אחרי רכישה ביקורת"),

  // 5 · סושיאל ותוכן
  S("social", "instagram_mgmt", "ניהול Instagram", "ניהול שוטף של העמוד", "core", "monthly", 1200, "instagram אינסטגרם סושיאל"),
  S("social", "facebook_mgmt", "ניהול Facebook", "ניהול שוטף של העמוד", "core", "monthly", 1020, "facebook פייסבוק סושיאל"),
  S("social", "tiktok_mgmt", "ניהול TikTok", "ניהול שוטף של החשבון", "addon", "monthly", 1380, "tiktok טיקטוק סושיאל"),
  S("social", "content_creation", "יצירת תוכן", "כתיבה והפקה של תוכן שוטף", "addon", "monthly", 1140, "content תוכן כתיבה"),
  S("social", "post_design", "עיצוב פוסטים", "עיצוב גרפי לפוסטים בשפת המותג", "addon", "monthly", 840, "design עיצוב גרפי פוסטים"),
  S("social", "content_planning", "תכנון תוכן חודשי", "לוח תוכן מראש לכל החודש", "addon", "monthly", 360, "planning גאנט לוח תוכן"),
  S("social", "reels", "יצירת Reels", "סרטונים קצרים לרשתות", "addon", "setup", 840, "reels רילס סרטון וידאו video", true),
  S("social", "video_editing", "עריכת סרטונים", "עריכה של חומר מצולם קיים", "addon", "setup", 660, "video editing עריכה סרטון וידאו", true),
  S("social", "ai_video", "יצירת סרטון עם AI", "סרטון שנוצר בכלי AI, בלי צילום", "addon", "setup", 1020, "ai video סרטון וידאו", true),
  S("social", "copywriting", "כתיבת קופי", "טקסט שיווקי למודעה, לעמוד או לפוסט", "addon", "setup", 180, "copy קופי קופירייטינג טקסט", true),

  // 6 · מכירות ותשלומים
  S("sales", "payments_clearing", "סליקה", "חיבור תשלום בכרטיס אשראי לאתר או למערכת", "addon", "setup", 750, "clearing payments אשראי תשלום"),
  S("sales", "invoices", "חשבוניות / קבלות", "הפקה אוטומטית אחרי כל תשלום", "addon", "setup", 750, "invoice receipt חשבונית קבלה"),
  S("sales", "quotes_system", "מערכת הצעות מחיר", "ניהול, שליחה ומעקב אחרי הצעות", "addon", "setup", 970, "quotes הצעת מחיר"),
  S("sales", "booking_system", "מערכת הזמנות", "קבלה וניהול של הזמנות או תורים", "addon", "setup", 970, "booking orders הזמנות תורים יומן"),
  S("sales", "product_mgmt", "ניהול מוצרים", "קטלוג, מחירים ומלאי", "addon", "setup", 750, "products catalog inventory מוצרים מלאי חנות"),
  S("sales", "abandoned_carts", "עגלות נטושות", "פנייה אוטומטית למי שהתחיל רכישה ולא סיים", "addon", "setup", 810, "abandoned cart עגלה נטושה חנות"),
  S("sales", "purchase_tracking", "מעקב אחר רכישות", "תיעוד כל רכישה ומקורה", "addon", "setup", 750, "purchase tracking רכישות"),

  // 7 · תקשורת ושימור לקוחות
  S("retention", "sms_marketing", "SMS", "דיוור הודעות טקסט", "addon", "setup", 660, "sms דיוור מסרונים"),
  S("retention", "whatsapp_marketing", "WhatsApp", "דיוור הודעות וואטסאפ", "addon", "setup", 840, "whatsapp וואטסאפ דיוור"),
  S("retention", "post_purchase_surveys", "סקרים לאחר רכישה", "סקר שביעות רצון אוטומטי", "addon", "setup", 720, "survey סקר שביעות רצון"),
  S("retention", "loyalty", "תוכנית נאמנות", "מועדון, נקודות או הטבות ללקוחות חוזרים", "addon", "setup", 1260, "loyalty מועדון לקוחות נקודות"),

  // 8 · דוחות ודאטה
  S("data", "dashboard", "Dashboard מרכזי", "מסך אחד עם כל נתוני העסק", "addon", "setup", 1680, "dashboard דשבורד דוחות"),
  S("data", "cac", "עלות לרכישה", "כמה עולה להשיג לקוח", "addon", "setup", 720, "cac עלות לקוח דוח"),
  S("data", "conversion_rate", "שיעור המרה", "כמה מהפונים הופכים ללקוחות", "addon", "setup", 720, "conversion המרה דוח"),
  S("data", "sales_performance", "ביצועי אנשי מכירות", "סגירות ופעילות לפי איש מכירות", "addon", "setup", 900, "sales performance אנשי מכירות דוח"),
  S("data", "lead_sources", "מקורות לידים", "מאיזה ערוץ הגיע כל ליד", "addon", "setup", 840, "lead sources מקור ליד ערוץ דוח"),
  S("data", "sales_forecast", "תחזית מכירות", "הערכת הכנסות קדימה לפי הנתונים", "addon", "setup", 1260, "forecast תחזית הכנסות"),

  // 9 · אינטגרציות
  S("integrations", "erp", "מערכות ERP", "חיבור למערכת הניהול הקיימת של העסק", "addon", "setup", 1680, "erp priority sap חיבור"),
  S("integrations", "make_zapier", "Zapier / Make", "הקמת תרחישי אוטומציה בין כלים", "addon", "setup", 900, "make zapier אוטומציה תרחיש"),
  S("integrations", "api_integration", "API למערכות חיצוניות", "חיבור בקוד למערכת צד שלישי", "addon", "setup", 1320, "api חיבור קוד"),

  // 10 · תשתית, אבטחה ורגולציה
  S("infra", "ssl", "SSL", "תעודת אבטחה, האתר עולה ב-https", "addon", "setup", 360, "ssl https תעודה"),
  S("infra", "backups", "גיבויים", "גיבוי אוטומטי ושחזור", "addon", "setup", 540, "backup גיבוי שחזור"),
  S("infra", "site_security", "אבטחת האתר", "הגנה מפני פריצות", "addon", "setup", 840, "security אבטחה פריצות"),
  S("infra", "spam_protection", "הגנה מפני ספאם", "חסימת פניות זבל בטפסים", "addon", "setup", 540, "spam ספאם captcha טפסים"),
  S("infra", "permissions", "ניהול הרשאות עובדים", "מי רואה ומי עורך מה", "addon", "setup", 720, "permissions הרשאות עובדים"),
  S("infra", "privacy", "פרטיות", "מדיניות פרטיות והתאמת האתר", "addon", "setup", 720, "privacy פרטיות מדיניות"),
  S("infra", "cookie_consent", "Cookie consent", "חלונית הסכמה לעוגיות", "addon", "setup", 480, "cookies עוגיות הסכמה"),
  S("infra", "accessibility", "נגישות", "התאמת האתר לדרישות הנגישות והצהרת נגישות", "addon", "setup", 1080, "accessibility נגישות תקן"),
  S("infra", "site_maintenance", "תחזוקת האתר", "עדכונים ותיקונים שוטפים", "addon", "monthly", 600, "maintenance תחזוקה עדכונים"),
  S("infra", "uptime_monitoring", "ניטור תקלות", "התראה כשהאתר נופל", "addon", "monthly", 480, "monitoring uptime ניטור התראה"),
];

/* The kit's example combinations (chapter 02, "דוגמאות חישוב") — offered in
   the quote builder as one-click starting points. Not official packages. */
const QUICK_STARTS = [
  { key: "quick_start", name: "התחלה מהירה", description: "דף נחיתה + קמפיינים וסושיאל ב-Meta",
    services: ["landing_page", "meta_campaigns"] },
  { key: "clinic", name: "קליניקה / נותן שירות", description: "דף נחיתה, Google Business, WhatsApp Business, תזכורות + Meta",
    services: ["landing_page", "google_business", "whatsapp_business", "reminders", "meta_campaigns"] },
  { key: "online_store", name: "חנות אונליין", description: "אתר, סליקה, ניהול מוצרים, עגלות נטושות + Meta ו-SEO",
    services: ["website", "payments_clearing", "product_mgmt", "abandoned_carts", "meta_campaigns", "seo_blog"] },
];

/* "שילובים שעובדים יחד" (chapter 01) — the builder suggests the missing
   parts once a quote holds part of a combination. */
const COMBOS = [
  { services: ["landing_page", "meta_campaigns", "lead_autoreply"], solves: "ליד מקבל תשובה מיד, גם מחוץ לשעות העבודה" },
  { services: ["crm", "lead_sources", "dashboard"], solves: "רואים מאיזה ערוץ הגיע כל לקוח וכמה הוא עלה" },
  { services: ["website", "seo_blog", "google_business"], solves: "תנועה אורגנית שנבנית לאורך חודשים, לצד הממומן" },
  { services: ["whatsapp_business", "reminders", "payment_link"], solves: "פחות ביטולים וגבייה בלי שיחת טלפון" },
  { services: ["website", "abandoned_carts", "post_purchase_automation"], solves: "מחזירים קונים שנטשו ומייצרים רכישה חוזרת" },
  { services: ["crm", "whatsapp_ai_bot", "quotes_system"], solves: "הליד מסונן, נרשם ומקבל הצעה בלי עבודה ידנית" },
];

module.exports = { CATEGORIES, SERVICES, QUICK_STARTS, COMBOS };
