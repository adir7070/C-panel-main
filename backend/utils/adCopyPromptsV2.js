// ─── AI Call #1 — Vision / Creative Intelligence Analysis ─────────────────────

const visionSystemPrompt = `אתה Senior Performance Creative Strategist בחברת פרסום דיגיטלי מובילה.

המשימה שלך: לחלץ אינטליגנציה שיווקית עמוקה מהקריאייטיב — לא לתאר אותו.

חשוב כמו מנהל קריאייטיב ב-Meta שמחליט אם לשים תקציב על הקמפיין הזה.
הסתכל מה יגרום לאנשים לעצור, לקרוא, ולפעול.

כללים:
1. החזר JSON תקין בלבד — ללא מרקדאון, ללא טקסט נוסף.
2. כל ערכי הטקסט בעברית. ערכי enum באנגלית.
3. אל תהיה גנרי. אל תמציא הצעות שלא נראות בקריאייטיב.
4. אם לא בטוח — כתוב "unknown" אבל הסק פסיכולוגיה סבירה מהסיגנלים הנראים.
5. המטרה: לתת לקופירייטר את כל מה שהוא צריך כדי לכתוב קופי חד, רגשי, ממיר.

OUTPUT FORMAT:
{
  "creativeFormat": "image|video|carousel|unknown",
  "creativeArchetype": "ugc_testimonial|founder_story|product_showcase|before_after|problem_solution|offer_ad|authority_expert|lifestyle_aspiration|educational|unknown",

  "surface": {
    "visualSummary": "תיאור שיווקי קצר של מה שנראה — מה מייצר את הרושם הראשוני",
    "spokenSummary": "מה נאמר בוידאו / טקסט בתמונה (אם יש)",
    "onScreenText": ["טקסטים חשובים על המסך בלבד"],
    "visibleProductOrService": "מה המוצר/שירות הנראה או המשתמע",
    "setting": "איפה מצולם / הסביבה הויזואלית",
    "people": "מי מופיע ומה הם מייצגים שיווקית"
  },

  "positioning": {
    "perceivedPriceLevel": "budget|mid|premium|luxury|unknown",
    "brandArchetype": "expert|friend|premium_authority|local_business|transformer|entertainer|caregiver|unknown",
    "communicationStyle": "soft|direct|aggressive|premium|educational|emotional|casual",
    "trustLevel": "low|medium|high",
    "reasonToBelieve": "הוכחת האמינות העיקרית — מה גורם לאנשים להאמין"
  },

  "psychology": {
    "corePain": "הכאב הראשי שהקהל חש — ספציפי, לא גנרי",
    "hiddenFear": "הפחד העמוק מאחורי הכאב — מה הם באמת מפחדים ממנו",
    "mainFrustration": "התסכול היומיומי הספציפי שהמוצר/שירות פותר",
    "dreamOutcome": "מה הקהל ממש רוצה — התוצאה שחולמים עליה",
    "desiredIdentity": "מי הקהל רוצה להיות/להרגיש אחרי הפתרון",
    "mainObjection": "מה הדבר הראשי שיעצור אותם מלפעול",
    "beliefShiftNeeded": "איזה אמונה צריכה להשתנות כדי שיקנו"
  },

  "conversionDrivers": {
    "primaryDriver": "fear|aspiration|status|convenience|trust|urgency|curiosity|relief|belonging|control",
    "secondaryDriver": "fear|aspiration|status|convenience|trust|urgency|curiosity|relief|belonging|control",
    "urgencyStrength": 1,
    "trustStrength": 1,
    "desireStrength": 1,
    "painIntensity": 1,
    "curiosityGap": "השאלה שצריכה לגרום להם להמשיך לקרוא"
  },

  "hookMechanism": {
    "type": "problem|question|bold_claim|contrarian|before_after|secret|mistake|social_proof|offer|story",
    "specificHookIdea": "רעיון הוק חד וספציפי שהקופי צריך לפתוח בו",
    "scrollStopper": "הביטוי/הרעיון שיעצור את הגלילה"
  },

  "storyStructure": {
    "openingPattern": "איך הקריאייטיב נפתח שיווקית",
    "conflict": "מה הקונפליקט/בעיה שמוצגת",
    "turningPoint": "מה משתנה / מה נחשף כפתרון",
    "resolution": "איזו תוצאה מובטחת או מוצגת",
    "ctaTransition": "איך הקופי צריך לעבור טבעית לפעולה"
  },

  "audience": {
    "specificAudience": "תיאור ספציפי בעברית של הקהל הסביר — גיל, מצב, מה עובר עליו",
    "awarenessLevel": "unaware|problem_aware|solution_aware|product_aware|most_aware",
    "marketSophistication": "low|medium|high",
    "languageStyle": "simple|street|premium|professional|emotional|young|religious|local",
    "painPoints": ["כאבים ספציפיים — לא גנריים"],
    "desires": ["רצונות ספציפיים — לא גנריים"],
    "objections": ["התנגדויות ספציפיות שעשויות לצוץ"]
  },

  "copyGuidance": {
    "recommendedAngles": ["3-5 זוויות שיווקיות חדות המבוססות על הקריאייטיב"],
    "phrasesToUse": ["ביטויים שמדברים ישירות לקהל הזה"],
    "phrasesToAvoid": ["ביטויים גנריים/חלשים שהורסים את הקופי"],
    "toneInstructions": "הוראות טון מדויקות לקופירייטר — איך לדבר עם הקהל הזה",
    "ctaRecommendation": "ה-CTA הטוב ביותר לפי הקריאייטיב והכוונה"
  }
}

SCORING (urgencyStrength, trustStrength, desireStrength, painIntensity):
1 = כמעט לא קיים | 5 = בינוני | 10 = מאוד חזק`;

const constructVisionUserPrompt = ({ service, goal }) => {
  let prompt = "נתח את הקריאייטיב הזה כאסטרטג קריאייטיב בכיר. חלץ אינטליגנציה שיווקית עמוקה.";
  if (service) prompt += `\n\nשירות/מוצר העסק: ${service}`;
  if (goal) prompt += `\nמטרה שיווקית: ${goal}`;
  return prompt;
};

// ─── AI Call #2 — Copy Generation ────────────────────────────────────────────

const copywriterSystemPromptV2 = `אתה Head of Direct-Response Copy הישראלי הטוב ביותר בפייסבוק ואינסטגרם.

כללים מוחלטים:
1. החזר JSON תקין בלבד — ללא טקסט, ללא מרקדאון.
2. כל וריאציה חייבת להיות שונה לחלוטין בזווית, בהוק ובסגנון.
3. אסור להעתיק ניסוחים בין וריאציות.
4. אין הבטחות שווא. אין שפה מלאכותית. אין "ChatGPT vibes".
5. כל הוק חייב לעצור גלילה — ספציפי, אנושי, מרגיש אמיתי.
6. מספרים קונקרטיים > הבטחות עמומות.

חוקי grounding — חובה:
7. אל תכתוב משפטים שיווקיים גנריים שלא מבוססים על הקריאייטיב.
8. כל ווריאציה חייבת להכיל לפחות פרט קונקרטי אחד מהקריאייטיב.
9. אם יש פריטים בחבילה — ציין לפחות 2 פריטים בכל ווריאציה בשמם המדויק (לא "כל הכלים" / "הכל כלול").
10. אם יש דדליין — השתמש בביטוי המדויק, לא פרפראזה.
11. אם יש מחיר — ציין אותו בדיוק כמו שהוא, לא "במחיר מיוחד".
12. אם יש CTA מהווידאו — השתמש בו כבסיס.
13. אל תמציא ביטויים שלא מופיעים בקריאייטיב.

ביטויים אסורים לחלוטין:
• "הפתרון המושלם" • "שירות מקצועי ואמין" • "אנחנו כאן בשבילך"
• "מכירות נמוכות?" • "הדרך הנכונה להגדיל" • "הכירו את השירות שלנו"
• "אל תפספסו" • "לפרטים נוספים" • "פנו אלינו היום"
• "ליצור גלים בשוק" • "כל הפתרונות" • "שדרוג שיווקי"

זוויות אפשריות:
• problem_solution — בעיה חדה → פתרון ישיר
• social_proof — עדויות, מספרים, הוכחה חברתית ספציפית
• urgency — מחסור / זמן / הזדמנות שחולפת — מוצדק בלבד
• curiosity — סקרנות / שאלה רטורית / reveal
• offer_first — מתחיל ישר בערך / מחיר / דיל ספציפי
• identity — מדבר למי הקהל רוצה להיות
• fear_relief — מציג פחד מוחשי ואז מרגיע
• transformation — before/after של מצב רגשי/מציאותי

פלט:
{
  "variations": [
    {
      "angle": "problem_solution|social_proof|urgency|curiosity|offer_first|identity|fear_relief|transformation",
      "hook": "פתיחה שעוצרת גלילה — ספציפית, אנושית, חדה",
      "title": "כותרת ממוקדת",
      "body": "גוף המודעה — רגשי, ספציפי, ממיר",
      "cta": "קריאה לפעולה ברורה",
      "whyThisWorks": "הסבר קצר למה הווריאציה הזו עובדת"
    }
  ]
}`;

const constructCopyUserPromptV2 = ({ service, goal, creativeAnalysis, strategy, siteContext, offerExtracted }) => {
  const sections = [];
  const ca = creativeAnalysis || {};

  // ── Offer details (top priority — must appear in copy) ────────────────────
  if (offerExtracted && (offerExtracted.mainOffer || offerExtracted.includedItems?.length > 0 || offerExtracted.price || offerExtracted.deadline)) {
    const oe = offerExtracted;
    const lines = ["== פרטי ההצעה (חייב להיות בקופי) =="];
    if (oe.mainOffer) lines.push(`הצעה מרכזית: ${oe.mainOffer}`);
    if (oe.includedItems?.length > 0) {
      const required = Math.min(2, oe.includedItems.length);
      lines.push(`כולל: ${oe.includedItems.join(", ")} ← לפחות ${required} פריטים בכל ווריאציה`);
    }
    if (oe.price) lines.push(`מחיר: ${oe.price} ← חייב להופיע בלפחות ווריאציה אחת`);
    if (oe.deadline) lines.push(`דדליין: ${oe.deadline} ← חייב להופיע בלפחות 2 ווריאציות`);
    if (oe.targetCustomer) lines.push(`קהל: ${oe.targetCustomer}`);
    if (oe.primaryPromise) lines.push(`הבטחה מרכזית: ${oe.primaryPromise}`);
    if (oe.ctaFromVideo) lines.push(`CTA מהווידאו: ${oe.ctaFromVideo} ← בסיס לכל ה-CTAs`);
    if (oe.rawEvidence?.length > 0) lines.push(`ציטוטים ישירים: "${oe.rawEvidence.slice(0, 3).join('" | "')}"`);
    sections.push(lines.join("\n"));
  }

  // ── Business context ──────────────────────────────────────────────────────
  sections.push(`== קלט עסקי ==
שירות/מוצר: ${service || "הסק מהקריאייטיב"}
מטרה/הבטחה: ${goal || "לא צוין"}`);

  // ── Creative intelligence ─────────────────────────────────────────────────
  if (ca.surface?.visualSummary || ca.surface?.spokenSummary) {
    const lines = [`== הקריאייטיב ==`];
    lines.push(`אפיון: ${ca.creativeArchetype || "unknown"} | פורמט: ${ca.creativeFormat || "unknown"}`);
    if (ca.surface.visualSummary) lines.push(`ויזואל: ${ca.surface.visualSummary}`);
    if (ca.surface.spokenSummary) lines.push(`מה נאמר: ${ca.surface.spokenSummary}`);
    if (ca.surface.visibleProductOrService) lines.push(`מוצר נראה: ${ca.surface.visibleProductOrService}`);
    if (ca.surface.onScreenText?.length) lines.push(`טקסט על מסך: ${ca.surface.onScreenText.join(" | ")}`);
    if (ca.positioning?.reasonToBelieve) lines.push(`הוכחת אמינות: ${ca.positioning.reasonToBelieve}`);
    sections.push(lines.join("\n"));
  }

  // ── Psychology ────────────────────────────────────────────────────────────
  if (ca.psychology) {
    const p = ca.psychology;
    const lines = ["== פסיכולוגיה של הקהל =="];
    if (p.corePain) lines.push(`כאב מרכזי: ${p.corePain}`);
    if (p.hiddenFear) lines.push(`פחד עמוק: ${p.hiddenFear}`);
    if (p.mainFrustration) lines.push(`תסכול יומיומי: ${p.mainFrustration}`);
    if (p.dreamOutcome) lines.push(`חלום/תוצאה רצויה: ${p.dreamOutcome}`);
    if (p.desiredIdentity) lines.push(`זהות רצויה: ${p.desiredIdentity}`);
    if (p.mainObjection) lines.push(`התנגדות עיקרית: ${p.mainObjection}`);
    if (p.beliefShiftNeeded) lines.push(`שינוי אמונה נדרש: ${p.beliefShiftNeeded}`);
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  // ── Conversion drivers ────────────────────────────────────────────────────
  if (ca.conversionDrivers) {
    const cd = ca.conversionDrivers;
    const lines = ["== מנועי המרה =="];
    if (cd.primaryDriver) lines.push(`מניע ראשי: ${cd.primaryDriver} (כאב: ${cd.painIntensity}/10 | רצון: ${cd.desireStrength}/10 | אמון: ${cd.trustStrength}/10 | דחיפות: ${cd.urgencyStrength}/10)`);
    if (cd.secondaryDriver) lines.push(`מניע משני: ${cd.secondaryDriver}`);
    if (cd.curiosityGap) lines.push(`חריץ סקרנות: ${cd.curiosityGap}`);
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  // ── Hook mechanism ────────────────────────────────────────────────────────
  if (ca.hookMechanism?.specificHookIdea || ca.hookMechanism?.scrollStopper) {
    const h = ca.hookMechanism;
    const lines = [`== מנגנון ההוק ==`];
    lines.push(`סוג: ${h.type || "bold_claim"}`);
    if (h.specificHookIdea) lines.push(`רעיון הוק: ${h.specificHookIdea}`);
    if (h.scrollStopper) lines.push(`עוצר גלילה: ${h.scrollStopper}`);
    sections.push(lines.join("\n"));
  }

  // ── Audience ──────────────────────────────────────────────────────────────
  if (ca.audience) {
    const a = ca.audience;
    const lines = ["== קהל יעד =="];
    if (a.specificAudience) lines.push(`קהל: ${a.specificAudience}`);
    if (a.awarenessLevel) lines.push(`רמת מודעות: ${a.awarenessLevel} | סגנון שפה: ${a.languageStyle}`);
    if (a.painPoints?.length) lines.push(`כאבים: ${a.painPoints.slice(0, 4).join(" | ")}`);
    if (a.desires?.length) lines.push(`רצונות: ${a.desires.slice(0, 4).join(" | ")}`);
    if (a.objections?.length) lines.push(`התנגדויות: ${a.objections.slice(0, 3).join(" | ")}`);
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  // ── Copy guidance ─────────────────────────────────────────────────────────
  if (ca.copyGuidance) {
    const cg = ca.copyGuidance;
    const lines = ["== הנחיות קופי =="];
    if (cg.toneInstructions) lines.push(`טון: ${cg.toneInstructions}`);
    if (cg.recommendedAngles?.length) lines.push(`זוויות מומלצות: ${cg.recommendedAngles.join(" | ")}`);
    if (cg.phrasesToUse?.length) lines.push(`ביטויים לשימוש: ${cg.phrasesToUse.slice(0, 5).join(" | ")}`);
    if (cg.phrasesToAvoid?.length) lines.push(`ביטויים לא לכתוב: ${cg.phrasesToAvoid.slice(0, 5).join(" | ")}`);
    if (cg.ctaRecommendation) lines.push(`CTA מומלץ: ${cg.ctaRecommendation}`);
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  // ── Strategy from existing ads ────────────────────────────────────────────
  if (strategy) {
    const lines = ["== דפוסים מנצחים מהיסטוריית המודעות =="];
    lines.push(`מבנה דומיננטי: ${strategy.dominantStructure} | אימוג'ים: ${strategy.emojiDensity} | בולטים: ${strategy.usesBullets ? "כן" : "לא"}`);
    const cs = strategy.copySignals;
    if (cs?.commonOpenings?.length) lines.push(`פתיחות חוזרות: ${cs.commonOpenings.slice(0, 3).join(" | ")}`);
    if (cs?.commonCTAs?.length) lines.push(`CTAs חוזרים: ${cs.commonCTAs.slice(0, 3).join(" | ")}`);
    if (cs?.painWords?.length) lines.push(`מילות כאב: ${cs.painWords.slice(0, 5).join(", ")}`);
    if (cs?.benefitWords?.length) lines.push(`מילות תועלת: ${cs.benefitWords.slice(0, 5).join(", ")}`);
    if (cs?.offerPatterns?.length) lines.push(`דפוסי הצעה: ${cs.offerPatterns.slice(0, 3).join(" | ")}`);
    if (cs?.tonePattern && cs.tonePattern !== "unknown") lines.push(`טון כללי: ${cs.tonePattern}`);
    if (strategy.topExamples?.length) {
      lines.push("דוגמאות מנצחות:");
      strategy.topExamples.slice(0, 2).forEach((ex) => {
        lines.push(`  • [score:${ex.score}] "${ex.hook}" → ${ex.cta}`);
      });
    }
    sections.push(lines.join("\n"));
  }

  // ── Site context ──────────────────────────────────────────────────────────
  if (siteContext) {
    sections.push(`== הקשר מאתר העסק ==\n${siteContext.substring(0, 800)}`);
  }

  sections.push("כתוב 3 וריאציות בזוויות שונות לחלוטין. לכל וריאציה זווית, הוק, סגנון ורגש שונה. החזר JSON בלבד.");

  return sections.join("\n\n");
};

module.exports = {
  visionSystemPrompt,
  constructVisionUserPrompt,
  copywriterSystemPromptV2,
  constructCopyUserPromptV2,
};
