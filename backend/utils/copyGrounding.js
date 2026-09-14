/**
 * Copy Grounding — V2 Ad Creative Pipeline
 *
 * Validates that generated copy is grounded in the actual offer details,
 * and catches forbidden generic phrases before they reach the user.
 */

// Substring patterns — any text containing these substrings is rejected
const FORBIDDEN_PATTERNS = [
  "אל תפספס",      // covers אל תפספסו, אל תפספס
  "אל תחמיצ",      // covers אל תחמיצו, אל תחמיץ
  "לפרטים נוספים",
  "פנו אלינו",
  "הפתרון המושלם",
  "שירות מקצועי ואמין",
  "אנחנו כאן בשבילך",
  "מכירות נמוכות",
  "הדרך הנכונה להגדיל",
  "הכירו את השירות",
  "ליצור גלים",    // covers ליצור גלים בשוק
  "כל הפתרונות",
  "שדרוג שיווקי",
  "הזדמנות שלא תחזור",
  "העסק שלך מחכה",
  "הגיע הזמן ש",
];

// Keep old name as alias for backwards compatibility
const FORBIDDEN_PHRASES = FORBIDDEN_PATTERNS;

/**
 * Builds offer object from image creativeAnalysis (deterministic, no AI).
 * Video path gets offerExtracted from videoIntelligence directly.
 */
function extractOfferFromCreativeAnalysis(creativeAnalysis) {
  const ca = creativeAnalysis || {};
  const guidance = ca.copyGuidance || {};
  const psychology = ca.psychology || {};
  const story = ca.storyStructure || {};
  const surface = ca.surface || {};
  const audience = ca.audience || {};

  const allText = [
    ...(guidance.phrasesToUse || []),
    ...(surface.onScreenText || []),
    surface.spokenSummary || "",
    story.resolution || "",
  ].join(" ");

  const priceMatch = allText.match(/₪[\d,]+|[\d,]+\s*ש[״"'']ח|[\d,]+\s*שקל/);

  const DEADLINE_KWS = ["מחר", "היום בלבד", "רק היום", "נגמר", "מוגבל", "אחרון", "עד מחר"];
  const deadlineEvidence = (guidance.phrasesToUse || []).find(
    (p) => DEADLINE_KWS.some((kw) => p.includes(kw)),
  ) || "";

  return {
    mainOffer: surface.visibleProductOrService || "",
    includedItems: [],
    price: priceMatch ? priceMatch[0] : "",
    deadline: deadlineEvidence,
    targetCustomer: audience.specificAudience || "",
    primaryPromise: psychology.dreamOutcome || story.resolution || "",
    ctaFromVideo: guidance.ctaRecommendation || "",
    rawEvidence: (guidance.phrasesToUse || []).slice(0, 5),
  };
}

/**
 * Validates variations against the extracted offer.
 * Returns { passed, failures, forbiddenHits }.
 */
function validateCopyGrounding(variations, offerExtracted) {
  if (!Array.isArray(variations) || variations.length === 0) {
    return { passed: true, failures: [], forbiddenHits: [] };
  }

  const failures = [];
  const forbiddenHits = [];

  for (let i = 0; i < variations.length; i++) {
    const v = variations[i];
    const text = [v.hook, v.title, v.body, v.cta].join(" ");
    const textLower = text.toLowerCase();

    // Forbidden patterns (substring matching)
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (textLower.includes(pattern.toLowerCase())) {
        forbiddenHits.push({ variationIndex: i + 1, phrase: pattern });
        failures.push(`variation ${i + 1}: forbidden pattern "${pattern}"`);
      }
    }

    // Included items grounding — at least 2 items per variation (or all if fewer than 2)
    const items = offerExtracted?.includedItems;
    if (items?.length > 0) {
      const required = Math.min(2, items.length);
      const mentioned = items.filter((item) => textLower.includes(item.toLowerCase()));
      if (mentioned.length < required) {
        failures.push(
          `variation ${i + 1}: must mention ≥${required} of: ${items.join(", ")} (found ${mentioned.length})`,
        );
      }
    }
  }

  // Deadline grounding — at least 2 variations must contain it
  const deadline = offerExtracted?.deadline;
  if (deadline) {
    const count = variations.filter((v) =>
      [v.hook, v.title, v.body, v.cta].join(" ").toLowerCase().includes(deadline.toLowerCase()),
    ).length;
    if (count < 2) {
      failures.push(`deadline "${deadline}" in only ${count} variation(s), need ≥2`);
    }
  }

  // Price grounding — at least 1 variation must contain it
  const price = offerExtracted?.price;
  if (price) {
    const count = variations.filter((v) =>
      [v.hook, v.title, v.body, v.cta].join(" ").includes(price),
    ).length;
    if (count === 0) {
      failures.push(`price "${price}" not mentioned in any variation`);
    }
  }

  return { passed: failures.length === 0, failures, forbiddenHits };
}

/**
 * Builds the correction instruction appended to a retry copy prompt.
 */
function buildGroundingRetryInstruction(failures, offerExtracted) {
  const lines = [
    "== תיקון נדרש: הפלט הקודם נכשל בבדיקת grounding ==",
    "",
    "כשלים שחייב לתקן:",
    ...failures.map((f) => `• ${f}`),
    "",
    "חוקי חובה לניסיון הנוכחי:",
  ];

  const items = offerExtracted?.includedItems;
  if (items?.length > 0) {
    const required = Math.min(2, items.length);
    lines.push(`• כל ווריאציה חייבת להזכיר לפחות ${required} פריטים מתוך: ${items.join(", ")}`);
  }
  if (offerExtracted?.deadline) {
    lines.push(`• דדליין "${offerExtracted.deadline}" חייב להופיע בלפחות 2 ווריאציות`);
  }
  if (offerExtracted?.price) {
    lines.push(`• מחיר ${offerExtracted.price} חייב להופיע בלפחות ווריאציה אחת`);
  }
  lines.push("• ביטויים אסורים — ראה רשימה בהנחיות המערכת");
  lines.push("", "כתוב 3 ווריאציות חדשות לחלוטין עם פרטים קונקרטיים. החזר JSON בלבד.");

  return lines.join("\n");
}

module.exports = {
  FORBIDDEN_PATTERNS,
  FORBIDDEN_PHRASES, // alias
  extractOfferFromCreativeAnalysis,
  validateCopyGrounding,
  buildGroundingRetryInstruction,
};
