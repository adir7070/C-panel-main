const OpenAI = require("openai");
const { formatBrandPalette } = require("../../utils/brand-palette");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const TONE_MAP = {
  'editorial': 'טון מגזיני, חד, אלגנטי. משפטים קצרים ומדויקים כמו Vogue.',
  'neo-brutalism': 'טון ישיר, חצוף, אנרגטי. בלי פלאפים — ישר לעניין.',
  'glassmorphism': 'טון טכנולוגי, עתידני, נקי. מילים מדויקות כמו מוצר SaaS.',
  'organic': 'טון חם, אנושי, אדמתי. מילים שמרגישות כמו שיחה על כוס תה.',
  'cyberpunk': 'טון אגרסיבי, עתידני, טכני. משפטים חדים כמו קוד.',
  'classic': 'טון יוקרתי, דרמטי, בלעדי. כל מילה משדרת פרמיום.',
  'noir': 'טון דרמטי, מינימלי, מסתורי. משפטים קצרים עם משקל.',
  'solarpunk': 'טון אופטימי, ירוק, חזוני. מילים שמשדרות תקווה ועתיד.',
  'japandi': 'טון שקט, מדיטטיבי, מאופק. פחות מילים, יותר משמעות.',
  'minimalist': 'טון ישיר ונקי. כל מילה מיותרת — מחוקה.',
  'grunge': 'טון גולמי, רחוב, אותנטי. בלי ליטוש — כתיבה אמיתית.',
  'art-deco': 'טון מלכותי, אלגנטי, סימטרי. כל משפט כמו חריטה בזהב.',
  'retro-70s': 'טון חמים, נוסטלגי, כייפי. הרגשה של שיחה בין חברים.',
  'mindful-gradient': 'טון רגוע, מעמיק, אמפתי. מילים שנושקות את הנפש.',
  'modern': 'טון מקצועי, עדכני, בטוח. ברור ומשכנע.',
};

const generateWebsiteContent = async (brief) => {
  const servicesList = brief.services.split(/[,،\n]/).map(s => s.trim()).filter(Boolean);
  const audience = brief.targetAudience?.join(', ') || 'כללי';

  const ds = brief.designStyle || '';
  const toneKey = Object.keys(TONE_MAP).find(k => ds.includes(k)) || '';
  const toneDirective = TONE_MAP[toneKey] || 'טון מקצועי, משכנע, ומותאם לתחום.';

  const prompt = `אתה קופירייטר מקצועי ברמה עולמית שעובד בסטודיו WOW באיטליה. צור תוכן עשיר ומעמיק לדף נחיתה.

## טון הכתיבה (חובה לשמור):
${toneDirective}
${ds ? `הדף מעוצב בסגנון "${ds}" — הטקסט חייב להרגיש כחלק מהעיצוב, לא כמודבק עליו.` : ''}

## העסק:
- שם: "${brief.businessName}"
- תחום: ${brief.businessField}
${brief.businessNiche ? `- התמחות ספציפית: ${brief.businessNiche}` : ''}
- תיאור: ${brief.about}
- שירותים שהלקוח הזין: ${brief.services}
- קהל יעד: ${audience}
${brief.promotion ? `- מבצע: ${brief.promotion}` : ''}
${brief.address ? `- כתובת: ${brief.address}` : ''}

## חשוב מאוד — קרא בעיון:
- כל מילה בדף חייבת להיות על "${brief.businessField}" ועל "${brief.businessNiche || brief.businessField}"
- heroTitle חייב להיות על התחום הספציפי — לא כותרת עסקית גנרית. אם התחום הוא "טיפוח ויופי" הכותרת חייבת לדבר על יופי, פינוק, טיפוח. אם התחום הוא "גינון" — על גינות, טבע, ירוק.
- השירותים חייבים להתבסס על מה שהלקוח הזין: "${brief.services}"
- אל תמציא שירותים שלא קשורים לתחום
- אם הלקוח נתן פחות מ-6 שירותים — הרחב מהתחום שלו, לא ממשהו אחר
- תוכן עשיר ומעמיק — כל תיאור חייב להיות מפורט, לא שטחי
- ⛔ אסור בשום מצב לכתוב כותרות גנריות כמו "הובלת חדשנות" או "מצוינות עסקית" — הכותרות חייבות להיות ספציפיות לתחום!

## החזר JSON:
{
  "heroTag": "תיאור קצר של העסק (3-5 מילים)",
  "heroTitle": "כותרת WOW (עם <br> לשבירת שורה, שים <span class=\\"text-accent\\"> על מילה אחת חזקה)",
  "heroSubtitle": "2 משפטים שמסבירים את הערך הייחודי ולמה לבחור בך",
  "heroCta1": "טקסט כפתור ראשי (2-3 מילים)",
  "heroCta2": "טקסט כפתור משני (2-3 מילים)",
  "heroClientsCount": "מספר+",
  "heroClientsLabel": "תיאור קצר",

  "aboutTag": "כותרת קטנה לסקשן אודות",
  "aboutTitle": "כותרת אודות (שים <span class=\\"text-accent\\"> על מילה אחת)",
  "aboutText": "3-4 פסקאות עשירות ומעמיקות — סיפור הקמת העסק, הגישה המקצועית הייחודית, הערכים המנחים, מה מייחד אותם מכל המתחרים, ולמה לקוחות בוחרים בהם שוב ושוב. לפחות 160 מילה. כל פסקה בשורה חדשה ב-HTML עם <br><br> ביניהן.",
  "aboutYears": "מספר+",
  "aboutYearsLabel": "שנות ניסיון / לקוחות מרוצים",
  "features": [
    {"title": "יתרון 1", "text": "3-4 משפטים מפורטים שמסבירים את היתרון, כיצד הוא מתבטא בפועל ומה הלקוח מרגיש"},
    {"title": "יתרון 2", "text": "3-4 משפטים מפורטים"},
    {"title": "יתרון 3", "text": "3-4 משפטים מפורטים"},
    {"title": "יתרון 4", "text": "3-4 משפטים מפורטים"}
  ],

  "services": [
    {"title": "שם שירות מהרשימה של הלקוח", "text": "תיאור מקצועי ומעמיק — 4-5 משפטים שמסבירים בדיוק מה כולל השירות, איך הוא מתבצע, למי מתאים, מה התוצאה שהלקוח יקבל ומה הופך אותו לטוב ביותר בתחום", "icon": "fas fa-xxx (Font Awesome icon שמתאים)"},
    ... (6 שירותים — בהתבסס על מה שהלקוח הזין)
  ],

  "portfolioTabs": ["הכל", "קטגוריה 1", "קטגוריה 2", "קטגוריה 3"],

  "portfolio": [
    {"title": "שם פרויקט/עבודה שמתאים לתחום", "category": "אחת מהקטגוריות למעלה"},
    ... (6 פריטים)
  ],

  "testimonials": [
    {"name": "שם ישראלי", "text": "המלצה אותנטית ומפורטת — 4-5 משפטים שמתארים את המצב לפני, מה עשה העסק, התוצאה המדויקת ולמה ממליצים בחום", "role": "תיאור מדויק (גיל/מקצוע/מצב)", "rating": 5},
    ... (7 המלצות — חובה לייצר בדיוק 7, כל אחת שונה מהאחרת בסגנון ובתוכן)
  ],

  "blog": [
    {"title": "כותרת מאמר שרלוונטי לתחום", "text": "תקציר מפתה — 3-4 משפטים שמסבירים מה הקורא ילמד, מדוע זה חשוב ומה יצא לו מקריאת המאמר", "tag": "קטגוריה", "meta": "15 מרץ, 2026 • 5 דקות קריאה"},
    ... (3 מאמרים)
  ],

  "sectionServicesIntro": "2-3 משפטי מבוא לסקשן השירותים — מסבירים את הגישה הכוללת ואת הפילוסופיה של העסק בתחום",
  "sectionCatalogIntro": "2-3 משפטי מבוא לגלריה/קטלוג — מסבירים מה מוצג ולמה כדאי לבחון",
  "sectionTestimonialsIntro": "2 משפטי מבוא להמלצות — כמה לקוחות מרוצים, מה אומרים עליהם",

  "ctaTitle": "כותרת CTA חזקה<br><span style=\\"color:#fff\\">משפט שני שמחזק</span>",
  "ctaText": "3-4 משפטים שמעודדים פעולה, מסבירים מה יקרה אחרי הקליק ומה הלקוח מקבל",
  "ctaBtn": "טקסט כפתור (2-3 מילים)",

  "contactTitle": "כותרת לסקשן צור קשר",
  "contactText": "2-3 משפטים שמזמינים ליצור קשר ומסבירים מה קורה אחרי שפונים",

  "footerAbout": "3 משפטים על העסק לפוטר — תיאור קצר, ערכים, הבטחה ללקוח",

  "designBrief": {
    "heroLayout": "THINK: what hero layout best fits '${ds}' style for a '${brief.businessField}' business? Describe the exact layout structure. DO NOT copy examples — create one that's perfect for THIS specific business and style.",
    "colorMood": "THINK: what color mood fits '${ds}' style? The client's brand palette: ${formatBrandPalette(brief.preferredColors) || 'not set'}. Describe how these colors should FEEL on the page.",
    "typographyStyle": "THINK: what typography fits '${ds}'? Describe heading font style + weight + size feel, and body text style. Be specific.",
    "sectionContrast": "THINK: what background pattern creates visual rhythm? Describe which sections are light, which are dark, which have color. CRITICAL: ensure text is ALWAYS readable (dark text on light bg, light text on dark bg). Never same-color text on same-color bg.",
    "imageStyle": "THINK: what photography style fits '${brief.businessField}' + '${ds}'? Describe the lighting, mood, subjects, color treatment. Be specific to THIS business.",
    "decorativeElements": "THINK: what decorative elements fit '${ds}'? Describe specific SVG shapes, lines, patterns that match the style. NOT generic — specific to this design language.",
    "animationMood": "THINK: what animation speed and style fits '${ds}'? Fast/slow? Bouncy/smooth? Dramatic/subtle?",
    "uniqueTwist": "THINK: what ONE unique visual element would make someone screenshot this page? Something specific that makes this page unforgettable. NOT generic — tied to '${brief.businessField}' + '${ds}'."
  }
}

CRITICAL RULES FOR designBrief:
- DO NOT copy the field descriptions as your answers. Those are instructions, not templates.
- Each field must contain YOUR original creative thinking for THIS specific business + style combo.
- The designBrief will be sent directly to a web designer — write it like creative direction.
- Write designBrief values in English for the designer.

JSON only, Hebrew for content, English for designBrief. No markdown.`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    max_completion_tokens: 8000,
  });

  const text = response.choices[0]?.message?.content || '{}';
  return JSON.parse(text);
};

/**
 * מזריק תוכן AI לתוך HTML — תומך בכל התבניות + פורמט ישן ופורמט חדש
 */
const injectAiContent = ($, content) => {
  if (!content) return;

  // Normalize — handle old format keys (backward compatibility)
  const c = content;

  // ═══ Hero ═══
  const heroTag = c.heroTag || c.heroEyebrow || '';
  const heroTitle = c.heroTitle || '';
  const heroSub = c.heroSubtitle || c.heroSub || '';
  const cta1 = c.heroCta1 || c.heroBtn1 || '';
  const cta2 = c.heroCta2 || c.heroBtn2 || '';

  if (heroTag) {
    $('[data-inject="hero-tag"], [data-inject="hero-eyebrow"], [data-inject="hero-badge"]').html(heroTag);
  }
  if (heroTitle) {
    $('[data-inject="hero-title"]').html(heroTitle.replace(/\\n/g, '<br>'));
  }
  if (heroSub) {
    $('[data-inject="hero-subtitle"], [data-inject="hero-sub"]').html(heroSub);
  }
  if (cta1) {
    $('[data-inject="hero-cta-1"], [data-inject="hero-btn1"], [data-inject="hero-cta-primary"], [data-inject="nav-cta"]').html(cta1);
  }
  if (cta2) {
    $('[data-inject="hero-cta-2"], [data-inject="hero-btn2"], [data-inject="hero-cta-secondary"]').html(cta2);
  }
  if (c.heroClientsCount) {
    $('[data-inject="hero-clients-count"]').html(c.heroClientsCount);
  }
  if (c.heroClientsLabel) {
    $('[data-inject="hero-clients-label"]').html(c.heroClientsLabel);
  }

  // ═══ About ═══
  const aboutTag = c.aboutTag || '';
  const aboutTitle = c.aboutTitle || '';
  const aboutText = c.aboutText || c.aboutText1 || '';
  const aboutText2 = c.aboutText2 || '';
  const aboutQuote = c.aboutQuote || '';

  if (aboutTag) $('[data-inject="about-tag"]').html(aboutTag);
  if (aboutTitle) $('[data-inject="about-title"]').html(aboutTitle.replace(/\\n/g, '<br>'));
  if (aboutText) $('[data-inject="about-text"], [data-inject="about-t1"], [data-inject="about-text1"]').html(aboutText);
  if (aboutText2) $('[data-inject="about-t2"], [data-inject="about-text2"]').html(aboutText2);
  if (aboutQuote) $('[data-inject="about-quote"]').html(aboutQuote);
  if (c.aboutYears) $('[data-inject="about-years"], [data-inject="about-exp-number"]').html(c.aboutYears);
  if (c.aboutYearsLabel) $('[data-inject="about-years-label"], [data-inject="about-exp-text"]').html(c.aboutYearsLabel);
  if (c.features?.length) {
    c.features.forEach((f, i) => {
      const n = i + 1;
      $(`[data-inject="feature-${n}-title"]`).html(f.title);
      $(`[data-inject="feature-${n}-text"]`).html(f.text);
    });
  }

  // ═══ Services — inject titles, texts, and icons ═══
  // Handle both new array format and old serviceDescriptions object
  let servicesList = c.services || [];
  if (!servicesList.length && c.serviceDescriptions) {
    servicesList = Object.entries(c.serviceDescriptions).map(([title, text]) => ({
      title,
      text,
      icon: '',
    }));
  }
  if (servicesList.length) {
    servicesList.forEach((svc, i) => {
      const n = i + 1;
      // Showcase template keys
      $(`[data-inject="svc-${n}-title"]`).html(svc.title);
      $(`[data-inject="svc-${n}-text"]`).html(svc.text);
      if (svc.icon) {
        $(`[data-inject="svc-${n}-icon"]`).attr('class', svc.icon);
      }
      // Other template keys
      $(`[data-inject="service-${n}-title"]`).html(svc.title);
      $(`[data-inject="service-${n}-text"]`).html(svc.text);
      // Cosmetics/facial template keys
      $(`[data-inject="srv${n}-title"]`).html(svc.title);
      $(`[data-inject="srv${n}-text"]`).html(svc.text);
      $(`[data-inject="ing${n}-t"]`).html(svc.title);
      $(`[data-inject="ing${n}-p"]`).html(svc.text);
      $(`[data-inject="tr${n}-title"]`).html(svc.title);
      $(`[data-inject="tr${n}-text"]`).html(svc.text);
      // Footer service links
      $(`[data-inject="footer-s${n}"]`).html(svc.title);
      $(`[data-inject="footer-service-${n}"]`).html(svc.title);
    });
    // Hide unused footer service rows
    for (let i = servicesList.length + 1; i <= 6; i++) {
      $(`[data-inject="footer-s${i}"]`).parent().attr('style', 'display:none');
      $(`[data-inject="footer-service-${i}"]`).parent().attr('style', 'display:none');
    }
  }

  // ═══ Portfolio Tabs ═══
  if (c.portfolioTabs?.length) {
    const tabKeys = ['filter-all', 'filter-design', 'filter-dev', 'filter-brand'];
    c.portfolioTabs.forEach((label, i) => {
      if (tabKeys[i]) $(`[data-inject="${tabKeys[i]}"]`).html(label);
    });
  }

  // ═══ Portfolio Items ═══
  if (c.portfolio?.length) {
    c.portfolio.forEach((p, i) => {
      const n = i + 1;
      $(`[data-inject="port-${n}-title"]`).html(p.title);
      $(`[data-inject="port-${n}-cat"]`).html(p.category);
      $(`[data-inject="portfolio-${n}-title"]`).html(p.title);
      $(`[data-inject="portfolio-${n}-category"]`).html(p.category);
    });
  }

  // ═══ Testimonials ═══
  if (c.testimonials?.length) {
    c.testimonials.forEach((t, i) => {
      const n = i + 1;
      // Showcase template keys
      $(`[data-inject="review-${n}-text"]`).html(`"${t.text}"`);
      $(`[data-inject="review-${n}-name"]`).html(t.name);
      $(`[data-inject="review-${n}-role"]`).html(t.role);
      // Other template keys
      $(`[data-inject="t${n}-text"]`).html(`"${t.text}"`);
      $(`[data-inject="t${n}-name"]`).html(t.name);
      $(`[data-inject="t${n}-role"]`).html(t.role);
      $(`[data-inject="testimonial-${n}-text"]`).html(`"${t.text}"`);
      $(`[data-inject="testimonial-${n}-name"]`).html(t.name);
      $(`[data-inject="testimonial-${n}-role"]`).html(t.role);
    });
  }

  // ═══ Blog ═══
  const blogItems = c.blog || c.blogPosts || [];
  if (blogItems.length) {
    blogItems.forEach((b, i) => {
      const n = i + 1;
      $(`[data-inject="blog-${n}-title"]`).html(b.title);
      $(`[data-inject="blog-${n}-text"]`).html(b.text);
      $(`[data-inject="blog-${n}-tag"]`).html(b.tag);
      $(`[data-inject="blog-${n}-meta"]`).html(b.meta);
      // Other templates
      $(`[data-inject="bl${n}-t"]`).html(b.title);
      $(`[data-inject="bl${n}-p"]`).html(b.text);
      $(`[data-inject="bl${n}-cat"]`).html(b.tag);
    });
  }

  // ═══ CTA ═══
  const ctaTitle = c.ctaTitle || '';
  const ctaText = c.ctaText || c.ctaSubtitle || '';
  const ctaBtn = c.ctaBtn || c.ctaButton || '';
  if (ctaTitle) $('[data-inject="cta-title"]').html(ctaTitle.replace(/\\n/g, '<br>'));
  if (ctaText) $('[data-inject="cta-text"], [data-inject="cta-sub"], [data-inject="cta-subtitle"]').html(ctaText);
  if (ctaBtn) $('[data-inject="cta-btn"]').html(ctaBtn);

  // ═══ Contact ═══
  if (c.contactTitle) $('[data-inject="ct-title"]').html(c.contactTitle.replace(/\\n/g, '<br>'));
  if (c.contactText) $('[data-inject="ct-text"]').html(c.contactText);

  // ═══ Footer ═══
  if (c.footerAbout) {
    $('[data-inject="footer-about"], [data-inject="footer-description"]').html(c.footerAbout);
  }
};

module.exports = {
  generateWebsiteContent,
  injectAiContent,
};
