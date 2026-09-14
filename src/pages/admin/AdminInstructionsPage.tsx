import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";

interface Section {
  id:        string;
  title:     string;
  emoji:     string;
  link:      string;
  intent:    string;        /* What this screen is FOR */
  howTo:     string[];      /* Step-by-step usage */
  watchFor:  string[];      /* Red flags / things to monitor */
  notes?:    string[];      /* Optional caveats */
}

const SECTIONS: Section[] = [
  {
    id: "dashboard",
    title: "דשבורד אדמין",
    emoji: "📊",
    link: "/admin",
    intent: "תמונת מצב יומית של כל העסק. מציג בכרטיסים את ההכנסות, מספר הלקוחות והמנהלים, ומגמת הכנסות ל-90 ימים.",
    howTo: [
      "פתח את הדף בתחילת היום — תקבל תמונה כללית של מצב העסק",
      "בדוק את התראות אדומות בראש הדף — לקוחות שדורשים טיפול דחוף",
      "גרף 90 ימים מציג מגמה — אם יש ירידה חדה, בדוק מה קרה באותם ימים",
      "טופ 10 מנהלים — מי הכוכבים החודש, מי לא הביא הכנסות",
    ],
    watchFor: [
      "ירידה חדה בהכנסות חודש מול חודש",
      "מנהלים בטופ-10 שכמעט לא מופיעים — סימן לבעיה",
      "התראות אדומות שלא נסגרות — מנהל שלא מטפל בלקוחות שלו",
    ],
  },
  {
    id: "clients",
    title: "כל הלקוחות",
    emoji: "📋",
    link: "/admin/clients",
    intent: "רשימה של כל הלקוחות במערכת מכל המנהלים. הכלי המרכזי לאיתור לקוח כשלא יודעים אצל איזה מנהל הוא יושב.",
    howTo: [
      "חיפוש מהיר: שם / טלפון / מנהל / חבילה",
      "שלושה פילטרים: לפי מנהל, לפי סטטוס חבילה, לפי רמה (Gold/VIP/...)",
      "לחיצה על שורה → דף הלקוח עם כל המידע + יכולות אדמין",
      "שורת הסטטוס בצבע בולט עם נקודה — מציגה איפה הלקוח נמצא בתהליך",
    ],
    watchFor: [
      "לקוחות במצב 'הלקוח החזיר תיקונים' (אדום) — דורש טיפול מיידי של המנהל",
      "לקוחות עם חבילה אבל ללא 'כרטיס שמור' — צפי בעיה בחיוב הבא",
      "לקוחות שלא היו פעילים זמן רב",
    ],
  },
  {
    id: "revenue",
    title: "הכנסות",
    emoji: "💰",
    link: "/admin/finance/revenue",
    intent: "ניתוח הכנסות לאורך זמן עם פילוחים לפי חבילה, מנהל, ורמת לקוח.",
    howTo: [
      "בחר טווח (3 / 6 / 12 / 24 חודשים) בכפתורים",
      "גרף עמודות מציג הכנסה לחודש — חודשים פחותים יזהו תקופות חלשות",
      "שלושה פאנלים בצד ימין: לפי חבילה, לפי מנהל, לפי רמה",
      "מד 'מגמה' מציג % שינוי החודש מול חודש שעבר — ירוק טוב, אדום בעייתי",
    ],
    watchFor: [
      "מגמה אדומה (יותר מ-10% ירידה) — חקור למה",
      "חבילה אחת שמייצרת רוב ההכנסות — סיכון אם תפסיק להימכר",
      "רוב ההכנסות מ-1-2 מנהלים — סיכון אם הם יעזבו",
    ],
  },
  {
    id: "integrations",
    title: "בריאות אינטגרציות",
    emoji: "🔌",
    link: "/admin/integrations",
    intent: "מצב חי של כל החיבורים החיצוניים — Cardcom, FB, WhatsApp, OpenAI, וכו'.",
    howTo: [
      "כרטיס לכל אינטגרציה — כל אחד מציג סטטוס: 🟢 פעיל / 🟡 התראה / 🔴 תקלה",
      "Cardcom — תאריך תשלום אחרון = הוכחה שה-webhook חי",
      "Backblaze — נפח שימוש החודש",
      "רענון אוטומטי כל 30 שניות",
    ],
    watchFor: [
      "אדום בכרטיס Cardcom — חסום הרכישות עד שיתוקן (תקלה ב-Cardcom = לקוחות לא יכולים לשלם)",
      "אדום ב-OpenAI/Gemini — AI לא מייצר",
      "MongoDB עם 'אין גישה ל-stats' — בעיה רצינית",
    ],
    notes: [
      "רוב הבדיקות לא קוראות לשירותי הצד השלישי — מסתכלות על ENV ועל פעילות אחרונה ב-DB",
      "תקלות ב-WhatsApp/SMS יתגלו רק בשליחה הבאה",
    ],
  },
  {
    id: "broadcasts",
    title: "הודעות רחבות",
    emoji: "📣",
    link: "/admin/broadcasts",
    intent: "שליחת הודעה לקבוצת לקוחות בבת אחת — לכל הלקוחות, לפי מנהל, לפי חבילה, לפי רמה.",
    howTo: [
      "1. בחר ערוץ: SMS או WhatsApp",
      "2. בחר קהל: כולם / לקוחות של מנהל / חבילה / רמה / רשימה ידנית",
      "3. הקלד טקסט",
      "4. לחץ 'תצוגה מקדימה' — מציג כמה אנשים יקבלו (חובה לפני שליחה)",
      "5. 'שלח עכשיו' — אישור פעם נוספת ושליחה בפועל",
      "היסטוריה למטה: מי שלח, למתי, לכמה אנשים, כמה הצליחו",
    ],
    watchFor: [
      "תצוגה מקדימה גבוהה מהמצופה — וודא שהפילטר נכון לפני שליחה",
      "כשלונות בהיסטוריה — מספרי טלפון לא חוקיים, או בעיית רשת",
    ],
    notes: [
      "תקרה: 500 מספרים לשליחה אחת",
      "כל שליחה נכתבת ל-audit log",
    ],
  },
  {
    id: "reports",
    title: "דוחות וייצוא",
    emoji: "📑",
    link: "/admin/reports",
    intent: "5 דוחות מוכנים מראש להורדה כ-CSV — לחשבונאות, HR, ביקורת, ומס.",
    howTo: [
      "בראש: שדות תאריך (שנה / מתאריך / עד תאריך) — נחוצים לחלק מהדוחות",
      "P&L חודשי — הכנסה/עמלות/רווח לחודש לכל השנה",
      "ביצועי מנהלים — הכנסה+עמלות פר מנהל לתקופה",
      "רשימת לקוחות — צילום מצב מלא (ללא תאריכים)",
      "דוח מע״מ — לפי תאריכים, מוכן להגשה למס הכנסה",
      "דוח פעילות — כל פעולת אדמין/מנהל ב-audit log",
    ],
    watchFor: [
      "דוח מע״מ בסוף החודש — חובה להגיש בזמן",
      "דוח פעילות בסוף הרבעון — לביקורת פנים",
    ],
  },
  {
    id: "users",
    title: "ניהול משתמשים",
    emoji: "🔑",
    link: "/admin/users",
    intent: "ניהול חשבונות מנהלי תיקים ואדמינים — יצירה, עריכה, נטרול, איפוס סיסמה, ניתוק כפוי.",
    howTo: [
      "כפתור '+ הוסף משתמש' — יצירת מנהל / supervisor / אדמין חדש",
      "ערוך שורה — שינוי שם, אימייל, תפקיד, או איפוס סיסמה",
      "'נטרל' — חשבון לא יוכל להתחבר. לא מוחק נתונים",
      "'נתק' — מנקה את ה-token הנוכחי שלו (יכפה התחברות מחדש בעת הפעולה הבאה)",
    ],
    watchFor: [
      "אזהרה צהובה כשבוחרים תפקיד 'אדמין' — תפקיד עם גישה מלאה",
      "אם חשוד לאיבוד סיסמה / פריצה — נטרל מיד וגם נתק",
    ],
    notes: [
      "סיסמה מינימום 6 תווים",
      "השדה 'שם משתמש' לא ניתן לשינוי בקלות (משמש לוגין)",
    ],
  },
  {
    id: "audit",
    title: "יומן ביקורת",
    emoji: "📜",
    link: "/admin/audit",
    intent: "תיעוד מלא של כל פעולה רגישה במערכת — מי, מתי, מה, ערך לפני/אחרי. כלי האחריותיות שלך.",
    howTo: [
      "טבלה עם תאריך / מבצע / פעולה / יעד / פרטים",
      "לחיצה על 'diff' בכל שורה מציגה את ה-JSON המלא של השינוי",
      "200 רשומות אחרונות מוצגות — מסונן לפי URL params (actor / action / from / to)",
    ],
    watchFor: [
      "פעולות 'force_status' / 'refund.create' / 'agent.create' — צריכות להיות נדירות ומוצדקות",
      "פעולות מאדמין באמצע הלילה — חשד לפעילות לא מורשית",
    ],
    notes: [
      "audit log לא ניתן למחיקה דרך ה-UI — רק דרך MongoDB ידנית",
      "החוק הישראלי דורש שמירה של 7 שנים על נתונים פיננסיים",
    ],
  },
];

export function AdminInstructionsPage() {
  const [search,    setSearch]    = useState("");
  const [openId,    setOpenId]    = useState<string | null>(null);

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
          eyebrow="ניהול ראשי"
          title="הוראות הפעלה"
          meta={`${SECTIONS.length} עמודי אדמין · מדריך שימוש לכל מסך`}
        />
      }
    >
      {/* Search */}
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

      {/* Quick TOC */}
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

      {/* Sections */}
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
