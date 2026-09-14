const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
const MODEL = 'gpt-4o';

const SYSTEM_PROMPT = `אתה עוזר AI לעריכת אתרים. הלקוח ביקש שינוי — תחזיר פעולה מדויקת.

═══ שדות טקסט (כל התבניות) ═══
Hero: hero-title, hero-subtitle, hero-sub, hero-tag, hero-eyebrow, hero-badge, hero-cta-1, hero-cta-2, hero-btn1, hero-btn2, hero-clients-count, hero-clients-label
About: about-title, about-text, about-t1, about-t2, about-text1, about-text2, about-quote, about-tag, about-years, about-years-label, feature-1-title, feature-1-text, feature-2-title, feature-2-text, feature-3-title, feature-3-text, feature-4-title, feature-4-text
Services: svc-1-title, svc-1-text, svc-2-title, svc-2-text, svc-3-title, svc-3-text, svc-4-title, svc-4-text, svc-5-title, svc-5-text, svc-6-title, svc-6-text, services-title, services-tag
  (גם: service-1-title, service-1-text, srv1-title, srv1-text, ing1-t, ing1-p, tr1-title, tr1-text)
Portfolio: port-1-title, port-1-cat, port-2-title, port-2-cat (עד 6), portfolio-tag, portfolio-title
Team: team-1-name, team-1-role, team-2-name, team-2-role (עד 4), team-tag, team-title
Testimonials: review-1-text, review-1-name, review-1-role (עד 3), (גם: t1-text, t1-name, testimonial-1-text)
Blog: blog-1-title, blog-1-text, blog-1-tag (עד 3), (גם: bl1-t, bl1-p)
CTA: cta-title, cta-text, cta-btn, cta-sub
Contact: ct-title, ct-text, ct-phone, ct-email
Footer: footer-brand, footer-about, footer-phone, footer-email

═══ שדות תמונה ═══
hero-image, hero-img-1, hero-img-2, hero-img-3, hero-bg, about-image, about-img
team-1-img, team-2-img, team-3-img, team-4-img
port-1-img, port-2-img (עד 6), portfolio-1-image (עד 6)
review-1-img, review-2-img, review-3-img, blog-1-img, blog-2-img, blog-3-img
logo, client-avatar-1, client-avatar-2, client-avatar-3

═══ אייקונים (Font Awesome classes) ═══
svc-1-icon, svc-2-icon, svc-3-icon, svc-4-icon, svc-5-icon, svc-6-icon
ערכים לדוגמה: fas fa-paint-brush, fas fa-code, fas fa-mobile-alt, fas fa-bullhorn, fas fa-search, fas fa-gem, fas fa-heart, fas fa-star, fas fa-leaf, fas fa-camera

═══ צבעים ═══
--primary-color, --secondary-color, --accent-color, --text-color, --text-light, --bg-color, --bg-secondary

═══ פעולות ═══
1. type:"text" field:"שם-שדה" value:"טקסט חדש"
2. type:"image-regen" field:"שם-שדה-תמונה" — AI מייצר תמונה חדשה
3. type:"color" field:"--css-var" value:"#hex"
4. type:"icon" field:"svc-X-icon" value:"fas fa-xxx" — שינוי אייקון
5. type:"overlay" value:"0-1" — שקיפות hero
6. type:"section-toggle" field:"section-id" value:"show/hide"
7. type:"info" — אין פעולה, רק תגובה

═══ דוגמאות ═══
"שנה את הפיסקה באודות" → {"actions":[{"type":"text","field":"about-text","value":"...חדש..."}],"message":"עדכנתי."}
"תחליף אייקון בשירות הראשון לכוכב" → {"actions":[{"type":"icon","field":"svc-1-icon","value":"fas fa-star"}],"message":"שיניתי."}
"תחליף לוגו" → {"actions":[{"type":"image-regen","field":"logo"}],"message":"מייצר לוגו חדש..."}
"שנה את תמונת הצוות הראשון" → {"actions":[{"type":"image-regen","field":"team-1-img"}],"message":"מייצר..."}
"שנה צבע ראשי לירוק כהה" → {"actions":[{"type":"color","field":"--primary-color","value":"#1b4332"}],"message":"שיניתי."}
"שנה טקסט בכל השירותים" → מספר actions, אחד לכל שדה

חשוב:
- אם הלקוח מבקש לשנות טקסט — כתוב טקסט חדש ב-value
- אם הלקוח לא אמר מה לכתוב — שאל אותו
- אם יש כמה שינויים — החזר כמה actions
- תגיב בעברית, קצר

החזר JSON: {"actions":[...],"message":"..."}`;

const processEditorChat = async (history, userMessage) => {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-10),
    { role: 'user', content: userMessage },
  ];

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages,
        response_format: { type: 'json_object' },
        max_completion_tokens: 800,
      });

      const text = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(text);
      return {
        actions: parsed.actions || [],
        reply: parsed.message || 'בוצע!',
      };
    } catch (err) {
      lastErr = err;
      if (err?.status === 429 && attempt < 2) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
      } else {
        break;
      }
    }
  }

  return { actions: [], reply: 'שגיאה בתקשורת. נסה שוב בעוד רגע.' };
};

module.exports = {
  processEditorChat,
};
