import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";

interface Section {
  id:        string;
  title:     string;
  emoji:     string;
  link:      string;
  intent:    string;
  howTo:     string[];
  watchFor:  string[];
  notes?:    string[];
}

/* Operating manual for every screen a manager (account_manager) sees in
   the sidebar, plus the client-detail page (the workhorse — most of the
   manager's day is spent there). Mirrors AdminInstructionsPage. */
const SECTIONS: Section[] = [
  {
    id: "home",
    title: "דף הבית",
    emoji: "🏠",
    link: "/",
    intent:
      "תמונת מצב אישית של היום והשבוע — מה דחוף, מה תכננת, איפה הלקוחות שלך עומדים. מתחילים כאן כל בוקר.",
    howTo: [
      "בדוק התראות אדומות בראש העמוד לפני כל דבר אחר",
      "עבור על המשימות הפתוחות לפי סדר עדיפות",
      "גרף הכנסה אישית מציג איפה אתה עומד מול היעד החודשי",
      "לחיצה על שורת לקוח פותחת את עמוד הלקוח המלא",
    ],
    watchFor: [
      "לקוחות במצב 'החזיר תיקונים' — דורש טיפול היום",
      "משימות כתומות (פג תוקף) — סגור היום",
      "ירידה חדה בהכנסה השבועית מול שבוע שעבר",
    ],
  },
  {
    id: "clients",
    title: "לקוחות",
    emoji: "👥",
    link: "/clients",
    intent:
      "כל הלקוחות שמשויכים אליך — חיפוש, סינון, וכניסה מהירה לכל לקוח. הציר המרכזי של היום-יום.",
    howTo: [
      "חפש לקוח לפי שם / טלפון / חבילה",
      "סנן לפי סטטוס חבילה כדי לראות מי מחכה למה",
      "לחיצה על שורה → עמוד הלקוח עם כל הטאבים",
      "כפתור 'הוסף לקוח' מימין למעלה ליצירת לקוח חדש",
    ],
    watchFor: [
      "לקוחות שלא היו פעילים יותר מ-7 ימים",
      "חבילות שעומדות באותו סטטוס יותר משבוע",
      "לקוחות ללא 'כרטיס שמור' — צפי בעיה בחיוב הבא",
    ],
  },
  {
    id: "client-detail",
    title: "עמוד הלקוח",
    emoji: "📋",
    link: "/clients",
    intent:
      "הליבה של היום-יום — 7 טאבים: קטלוג אישי, איפיון, פרופיל, מוצרים, קמפיינים, לידים, לוח שנה. כל הטיפול בלקוח עובר דרך כאן.",
    howTo: [
      "טאב 'איפיון' חייב להיות מלא לפני יצירת מוצרים — חוסם את שאר הטאבים",
      "טאב 'קטלוג אישי' — בניית חבילה ללקוח וסליקה",
      "טאב 'מוצרים' זמין רק אחרי שהלקוח שילם — מציג רק מה שנכלל בחבילה",
      "טאב 'פרופיל' — פרטי העסק, הערות מנהל ושליחת SMS",
      "באנר עליון מציג סטטוס חבילה — לחץ עליו לראות פירוט",
    ],
    watchFor: [
      "איפיון חסר → חוסם יצירת מוצרים — סיים את האיפיון קודם",
      "סטטוס חבילה 'החזיר תיקונים' — דחוף, פתח את המוצרים והגב",
      "כרטיס לא שמור — בקש מהלקוח לאשר חיוב הבא בקישור",
    ],
  },
  {
    id: "chat",
    title: "צ'אט כללי",
    emoji: "💬",
    link: "/chat",
    intent:
      "תיבת ההודעות המאוחדת — כל ההודעות מכל הלקוחות במקום אחד, ממוין לפי הכי לא נקרא ראשון.",
    howTo: [
      "שיחות בראש הרשימה הן עם הודעות לא נקראות",
      "לחיצה על שיחה פותחת את ההיסטוריה המלאה",
      "ניתן להגיב ידנית או להשתמש ב-AI להצעת תגובה",
      "אחרי טיפול — סמן כנקרא כדי לנקות את התור",
    ],
    watchFor: [
      "הודעות לא נקראות יותר מ-2 שעות בשעות עבודה",
      "סנטימנט שלילי (תג אדום) — לקוח כועס, התקשר",
    ],
  },
  {
    id: "broadcast",
    title: "שליחה רחבה",
    emoji: "📢",
    link: "/broadcast",
    intent:
      "שליחת הודעה לקבוצה גדולה של לקוחות — מבצע, עדכון, קמפיין. WhatsApp עם פרסונליזציה.",
    howTo: [
      "בחר קהל יעד לפי תגיות / סטטוס / רמה",
      "כתוב הודעה — השתמש במשתנים ({{שם}}) לפרסונליזציה",
      "תצוגה מקדימה לפני שליחה — בדוק על נמען בודד",
      "שלח בקבוצות של עד 50 כדי לא להיחסם",
    ],
    watchFor: [
      "שליחה ליותר מ-100 איש בו-זמנית — סיכון לחסימת מספר WhatsApp",
      "הודעה גנרית ללא {{שם}} — שיעור תגובה נמוך משמעותית",
      "לחיצה על 'שלח' לא הפיכה — קרא שוב לפני",
    ],
  },
  {
    id: "leads",
    title: "לידים",
    emoji: "🎯",
    link: "/leads",
    intent:
      "לידים שנכנסו למערכת (דפי נחיתה / טפסים / ייבוא / ידני) — לפני שהפכו ללקוחות. כל ליד עם סטטוס, הערות ומקור.",
    howTo: [
      "לידים חדשים מסומנים בסטטוס 'חדש'",
      "לחיצה על ליד → אפשר לפתוח WhatsApp ישירות, להוסיף הערה ולשנות סטטוס",
      "אחרי שיחה — עדכן סטטוס: להתקשר שוב / לא רלוונטי / בתהליך / לסלוק, או 'הפוך ללקוח פעיל'",
      "מקור הליד מופיע בכל שורה — Facebook / Instagram / טופס",
    ],
    watchFor: [
      "ליד יותר מ-24 שעות שלא נוגעת — קור, נכבה",
      "מקור ליד שכל הלידים שלו לא ממירים — דווח לאדמין",
    ],
  },
  {
    id: "pipeline",
    title: "פייפליין",
    emoji: "📈",
    link: "/pipeline",
    intent:
      "ניהול עסקאות לפי שלב — מעוניין → הצעה → משא ומתן → סגירה. תמונה ויזואלית של מה בצנרת.",
    howTo: [
      "גרור עסקה משלב לשלב כדי לעדכן סטטוס",
      "לחיצה על עסקה פותחת פרטים — סכום, לקוח, הערות",
      "כפתור 'הוסף עסקה' מימין למעלה",
      "סינון לפי תקופה / לקוח / שלב",
    ],
    watchFor: [
      "עסקאות תקועות יותר משבוע באותו שלב — להגיע ללקוח",
      "ערימה גדולה ב'הצעה' שלא מתקדמת — חבל לאבד",
    ],
  },
  {
    id: "tasks",
    title: "משימות",
    emoji: "✅",
    link: "/tasks",
    intent:
      "כל המטלות שלך — אוטומטיות (זוהו ע\"י המערכת) + ידניות (יצרת בעצמך). סוגרים אותן יום-יום.",
    howTo: [
      "משימות אוטומטיות מסומנות בתג AI — המערכת זיהתה צורך מסטטוסים",
      "לחיצה על משימה פותחת פרטים + קישור ישיר ללקוח הרלוונטי",
      "סמן ✓ אחרי ביצוע — מתעדכן גם בלקוח",
      "כפתור 'צור משימה' למשימות ידניות",
    ],
    watchFor: [
      "משימות באדום (פג תוקף) — סגור היום",
      "הצטברות של 10+ משימות — סימן לעומס, חלק מחדש",
    ],
  },
  {
    id: "appointments",
    title: "פגישות",
    emoji: "📅",
    link: "/appointments",
    intent:
      "לוח פגישות חודשי ויומי. שיוך פגישה ללקוח קיים מאפשר מעקב מאוחד.",
    howTo: [
      "תצוגת שבוע מציגה את 7 הימים הבאים — RTL",
      "לחיצה על תא ריק יוצרת פגישה חדשה",
      "שיוך לקוח (אופציונלי) — מקשר את הפגישה לעמוד שלו",
    ],
    watchFor: [
      "חפיפה בין פגישות — בדוק שהזמן ריק לפני שאישרת",
      "פגישה בלי לקוח — תזכור איפה היא ומה הקונטקסט",
    ],
  },
  {
    id: "campaigns",
    title: "קמפיינים",
    emoji: "📊",
    link: "/campaigns",
    intent:
      "ניהול מודעות פייסבוק / מטא של הלקוחות שלך — סטטיסטיקות, תקציב, ביצוע, הפעלה/השהיה.",
    howTo: [
      "רשימת קמפיינים פעילים עם CPM / CTR / הוצאה / המרות",
      "לחיצה על קמפיין → גרף ביצוע יומי + פילוח קהל",
      "כפתורי הפעלה/השהיה ישירים מהרשימה",
      "'צור קמפיין חדש' דורש שהלקוח חיבר טוקן פייסבוק",
    ],
    watchFor: [
      "CTR נמוך (< 1%) — המודעה לא עובדת, החלף",
      "הוצאה גבוהה ללא המרות — עצור מיידית, אבחן",
      "טוקן פייסבוק שפג — קמפיינים מפסיקים בלי הודעה",
    ],
  },
  {
    id: "reviews",
    title: "תגובות לקוחות",
    emoji: "✓",
    link: "/reviews",
    intent:
      "כל אישורי הלקוחות (אישור / תיקונים) על מוצרים שיצרת — מודעות, LP, וידאו. סוגר את לולאת ההפקה.",
    howTo: [
      "תור הממתינים בראש הרשימה — תגובות חדשות שעדיין לא טופלו",
      "לחיצה על שורה → צפייה בתגובה המלאה + במוצר",
      "אישור → סוגר אוטומטית את החבילה לסטטוס 'הסתיים'",
      "בקשה לתיקונים → פותח את המוצר לעריכה ומאפשר שליחה חוזרת",
    ],
    watchFor: [
      "תגובות שלא טופלו יותר מ-24 שעות — הלקוח מתעצבן",
      "דחייה חוזרת על אותה מודעה — סימן שצריך שיחה ישירה, לא רק תיקון",
    ],
  },
  {
    id: "wallet",
    title: "ארנק ועמלות",
    emoji: "💰",
    link: "/wallet",
    intent:
      "ההכנסה האישית שלך — עמלות מצטברות, היסטוריה, מה שולם ומה ממתין לתשלום.",
    howTo: [
      "מאזן עליון: חייבים אליך / שולם החודש",
      "גרף חודשי של הכנסה לאורך זמן",
      "היסטוריה מפורטת: עמלה לפי לקוח + תאריך + חבילה",
      "ייצוא CSV אם צריך לבנות חשבונית",
    ],
    watchFor: [
      "עמלות 'לתשלום' שעוברות 30+ ימים — דרוש מהאדמין",
      "חוסר התאמה בין סכום העמלה לעסקאות שסגרת — דווח",
    ],
  },
  {
    id: "digest",
    title: "דייג'סט AI",
    emoji: "🤖",
    link: "/digest",
    intent:
      "סיכום AI של פעילות השבוע שלך — מה קרה, מה דחוף, רעיונות לפעולה. נחסך זמן בקריאה ידנית של דוחות.",
    howTo: [
      "דייג'סט יומי / שבועי — בחר תקופה",
      "Top 3 פעולות מומלצות בראש — מבוסס AI על דפוסי הלקוחות שלך",
      "לחיצה על המלצה פותחת ישר את הלקוח הרלוונטי",
    ],
    watchFor: [
      "המלצות שחוזרות שלא טיפלת בהן — סימן שמשהו תקוע",
    ],
  },
  {
    id: "logs",
    title: "לוגים",
    emoji: "📜",
    link: "/logs",
    intent:
      "פעילות מערכת — מי שלח, מתי, מה קרה. כלי דיבאג לאיתור בעיות בחיוב או בשליחה.",
    howTo: [
      "סינון לפי תאריך / לקוח / סוג פעולה",
      "חיפוש חופשי בטקסט הודעות",
      "שגיאות מסומנות באדום — לחץ לפרטים מלאים",
    ],
    watchFor: [
      "שגיאות אדומות חוזרות — דווח לאדמין כמקבץ, לא בודד",
      "שליחות WhatsApp שנכשלו — נסה שוב או החלף ערוץ",
    ],
  },
];

export function InstructionsPage() {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(s => {
      const hay = `${s.title} ${s.intent} ${s.howTo.join(" ")} ${s.watchFor.join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [search]);

  return (
    <Layout
      header={
        <Header
          eyebrow="כלים"
          title="הוראות הפעלה"
          meta={`${SECTIONS.length} מסכים · מדריך שימוש לכל אחד`}
        />
      }
    >
      <section className="section" style={{ marginTop: 0 }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="חיפוש: שם מסך / מה לחפש / מה לעשות…"
          style={{
            width: "100%",
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid var(--rule)",
            background: "var(--paper)",
            fontSize: 14,
          }}
        />
        {search && (
          <p className="t-meta" style={{ marginTop: 6, fontSize: 11 }}>
            {filtered.length} תוצאות
          </p>
        )}
      </section>

      <section className="section" style={{ marginTop: "var(--s-3)" }}>
        <div className="card" style={{ padding: "var(--s-4)", borderTop: "3px solid var(--blue)" }}>
          <p className="t-eyebrow">תוכן עניינים</p>
          <div style={{
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 6,
          }}>
            {SECTIONS.map(s => (
              <button
                key={s.id}
                onClick={() => {
                  setOpenId(s.id);
                  document.getElementById(`section-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                style={{
                  background: "transparent",
                  border: "1px solid var(--rule)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 12,
                  textAlign: "right",
                  cursor: "pointer",
                  color: "var(--ink)",
                }}
              >
                {s.emoji} {s.title}
              </button>
            ))}
          </div>
        </div>
      </section>

      {filtered.map(s => (
        <SectionCard
          key={s.id}
          section={s}
          open={openId === s.id}
          onToggle={() => setOpenId(o => o === s.id ? null : s.id)}
        />
      ))}

      {filtered.length === 0 && (
        <p className="t-meta" style={{ textAlign: "center", padding: "var(--s-5)" }}>
          לא נמצאו עמודים תואמים — נסה חיפוש אחר.
        </p>
      )}
    </Layout>
  );
}

function SectionCard({ section, open, onToggle }: { section: Section; open: boolean; onToggle: () => void }) {
  return (
    <section id={`section-${section.id}`} className="section" style={{ marginTop: "var(--s-3)" }}>
      <div className="card" style={{ padding: 0, borderTop: "3px solid var(--blue)", overflow: "hidden" }}>
        <button
          onClick={onToggle}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--s-4) var(--s-5)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            textAlign: "right",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 26 }}>{section.emoji}</span>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)", margin: 0 }}>{section.title}</h3>
              <p className="t-meta" style={{ marginTop: 2, fontSize: 11 }}>{section.intent.slice(0, 80)}…</p>
            </div>
          </div>
          <span style={{ fontSize: 18, color: "var(--ink-3)" }}>{open ? "▴" : "▾"}</span>
        </button>

        {open && (
          <div style={{
            padding: "0 var(--s-5) var(--s-5)",
            display: "grid", gap: "var(--s-4)",
            borderTop: "1px solid var(--rule)",
            paddingTop: "var(--s-4)",
          }}>
            <Block title="🎯 מה זה" body={section.intent} />
            <ListBlock title="🛠️ איך משתמשים" items={section.howTo} />
            <ListBlock title="⚠️ למה כדאי לשים לב" items={section.watchFor} accent="#FB8C00" />
            {section.notes && <ListBlock title="💡 הערות" items={section.notes} accent="var(--ink-3)" />}

            <Link
              to={section.link}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: "var(--blue)",
                color: "#fff",
                padding: "8px 14px",
                borderRadius: 6,
                textDecoration: "none",
                fontSize: 13, fontWeight: 600,
                width: "fit-content",
              }}
            >
              פתח את העמוד ←
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

function Block({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="t-eyebrow">{title}</p>
      <p style={{ marginTop: 4, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>{body}</p>
    </div>
  );
}

function ListBlock({ title, items, accent }: { title: string; items: string[]; accent?: string }) {
  return (
    <div>
      <p className="t-eyebrow" style={{ color: accent }}>{title}</p>
      <ul style={{ marginTop: 4, paddingInlineStart: 20, color: "var(--ink)", fontSize: 13, lineHeight: 1.7 }}>
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  );
}
