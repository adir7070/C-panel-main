// Deterministic strategy extraction from scored FB ads — zero AI calls.

const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
const BULLET_RE = /^[•\-\*✓✔►▸→]/m;

const PAIN_WORDS_HE = ["בעיה", "קשה", "עייפ", "כסף", "זמן", "מסובך", "לא מצליח", "נתקע", "חסר", "מאבד", "מתסכל", "לחץ", "פחד", "אבוד", "כואב", "עלות", "יקר"];
const BENEFIT_WORDS_HE = ["מהיר", "קל", "חוסך", "יעיל", "תוצאות", "שינוי", "הצלחה", "רווח", "פשוט", "אוטומט", "חכם", "חינם", "ניסיון", "מבטיח", "מוכח"];
const OFFER_PATTERNS_HE = [/₪[\d,]+/, /\d+%/, /חינם/, /ניסיון חינם/, /ללא עלות/, /מתנה/, /הנחה/];
const PROOF_PATTERNS_HE = [/לקוח/, /המלצ/, /ביקורת/, /עדות/, /\d+ אנשים/, /\d+ לקוח/, /מוכח/, /תוצאות/, /הצלחה/];

function extractHook(text) {
  if (!text) return null;
  const firstLine = text.split(/\n/)[0].trim();
  return firstLine.length > 5 ? firstLine : null;
}

function extractCTA(text) {
  if (!text) return null;
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last && last.length < 80 ? last : null;
}

function emojiDensity(text) {
  if (!text) return "low";
  const matches = text.match(EMOJI_RE) || [];
  const ratio = matches.length / Math.max(text.length / 100, 1);
  if (ratio > 4) return "high";
  if (ratio > 1.5) return "medium";
  return "low";
}

function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

function lineCount(text) {
  if (!text) return 0;
  return text.split(/\n/).filter((l) => l.trim()).length;
}

function dominantStructure(ads) {
  let beforeAfter = 0, testimonial = 0, offerFirst = 0;
  for (const ad of ads) {
    const body = ad?.creative?.object_story_spec?.link_data?.message || "";
    const lower = body.toLowerCase();
    if (/לפני|אחרי|before|after/.test(lower)) beforeAfter++;
    if (/אמר|ספר|לקוח|המלצ|review|said|told/.test(lower)) testimonial++;
    if (/₪|ש[״"]ח|% הנחה|חינם|free|discount/.test(lower)) offerFirst++;
  }
  const counts = [
    { key: "before_after", val: beforeAfter },
    { key: "testimonial", val: testimonial },
    { key: "offer_first", val: offerFirst },
  ];
  counts.sort((a, b) => b.val - a.val);
  return counts[0].val > 0 ? counts[0].key : "hook_problem_solution";
}

function extractWords(text, patterns) {
  if (!text) return [];
  return patterns.filter((w) => text.includes(w));
}

function extractPatterns(text, regexList) {
  if (!text) return [];
  return regexList
    .filter((re) => re.test(text))
    .map((re) => {
      const m = text.match(re);
      return m ? m[0] : null;
    })
    .filter(Boolean);
}

function classifyTone(allText) {
  if (!allText) return "unknown";
  const lower = allText.toLowerCase();
  const urgencyCount = (lower.match(/עכשיו|מהיר|אחרון|מוגבל|רק היום|מועד|דחוף/g) || []).length;
  const emotionCount = (lower.match(/אני|הרגשתי|חייתי|ידעתי|מרגיש|פחדתי|בכיתי|חלמתי/g) || []).length;
  const premiumCount = (lower.match(/פרמיום|יוקרה|בלעדי|מובחר|אקסקלוסיב/g) || []).length;
  const directCount = (lower.match(/קנה|הזמן|התקשר|שלח|לחץ|כנס|הירשם/g) || []).length;

  const scores = [
    { key: "urgent", val: urgencyCount },
    { key: "emotional", val: emotionCount },
    { key: "premium", val: premiumCount },
    { key: "direct", val: directCount },
  ];
  scores.sort((a, b) => b.val - a.val);
  return scores[0].val > 0 ? scores[0].key : "unknown";
}

/**
 * @param {Array} scoredAds - ads already scored and sorted by adScoring
 * @returns {Object} strategy context
 */
function buildStrategy(scoredAds) {
  const ads = scoredAds.filter((ad) => ad?.creative?.object_story_spec);

  const headlines = ads
    .map((ad) => ad?.creative?.object_story_spec?.link_data?.name || "")
    .filter(Boolean);

  const bodies = ads
    .map((ad) => ad?.creative?.object_story_spec?.link_data?.message || "")
    .filter(Boolean);

  const avgHeadlineWords =
    headlines.length > 0
      ? Math.round(headlines.reduce((sum, h) => sum + wordCount(h), 0) / headlines.length)
      : 6;

  const avgBodyLines =
    bodies.length > 0
      ? Math.round(bodies.reduce((sum, b) => sum + lineCount(b), 0) / bodies.length)
      : 5;

  const allBodyText = bodies.join("\n");
  const density = emojiDensity(allBodyText);
  const usesBullets = BULLET_RE.test(allBodyText);

  // Common openings — first line of each body
  const commonOpenings = ads
    .map((ad) => extractHook(ad?.creative?.object_story_spec?.link_data?.message || ""))
    .filter(Boolean)
    .slice(0, 5);

  // Common CTAs — last line or CTA type
  const commonCTAs = ads
    .map((ad) =>
      ad?.creative?.object_story_spec?.link_data?.call_to_action?.type ||
      extractCTA(ad?.creative?.object_story_spec?.link_data?.message || ""),
    )
    .filter(Boolean)
    .slice(0, 5);

  // Pain/benefit word extraction
  const painWords = [...new Set(
    bodies.flatMap((b) => extractWords(b, PAIN_WORDS_HE))
  )].slice(0, 8);

  const benefitWords = [...new Set(
    bodies.flatMap((b) => extractWords(b, BENEFIT_WORDS_HE))
  )].slice(0, 8);

  // Offer and proof patterns
  const offerPatterns = [...new Set(
    bodies.flatMap((b) => extractPatterns(b, OFFER_PATTERNS_HE))
  )].slice(0, 5);

  const proofPatterns = [...new Set(
    bodies.flatMap((b) => extractPatterns(b, PROOF_PATTERNS_HE))
  )].slice(0, 5);

  const tonePattern = classifyTone(allBodyText);

  // Top examples for copy reference
  const topExamples = ads.slice(0, 3).map((ad) => ({
    score: ad.score,
    hook: extractHook(ad?.creative?.object_story_spec?.link_data?.message || "") || "",
    bodyPreview: (ad?.creative?.object_story_spec?.link_data?.message || "").substring(0, 120),
    cta: ad?.creative?.object_story_spec?.link_data?.call_to_action?.type ||
      extractCTA(ad?.creative?.object_story_spec?.link_data?.message || "") || "",
  }));

  return {
    dominantStructure: dominantStructure(ads),
    avgHeadlineWords,
    avgBodyLines,
    emojiDensity: density,
    usesBullets,
    recurringHooks: commonOpenings,
    recurringCTAs: commonCTAs,
    copySignals: {
      commonOpenings,
      commonCTAs,
      painWords,
      benefitWords,
      offerPatterns,
      proofPatterns,
      tonePattern,
    },
    topExamples,
    topAds: ads.slice(0, 3).map((ad) => ({
      id: ad.id,
      score: ad.score,
      headline: ad?.creative?.object_story_spec?.link_data?.name || "",
      body: (ad?.creative?.object_story_spec?.link_data?.message || "").substring(0, 200),
      cta: ad?.creative?.object_story_spec?.link_data?.call_to_action?.type || "",
    })),
  };
}

module.exports = { buildStrategy };
