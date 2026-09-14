const { z } = require("zod");

// ─── Normalizers ──────────────────────────────────────────────────────────────

const ENUM_MAP = {
  // creativeFormat
  image: "image", video: "video", carousel: "carousel", unknown: "unknown",
  // creativeArchetype
  ugc_testimonial: "ugc_testimonial", "ugc testimonial": "ugc_testimonial",
  founder_story: "founder_story", "founder story": "founder_story",
  product_showcase: "product_showcase", "product showcase": "product_showcase",
  before_after: "before_after", "before after": "before_after",
  problem_solution: "problem_solution", "problem solution": "problem_solution",
  offer_ad: "offer_ad", "offer ad": "offer_ad",
  authority_expert: "authority_expert", "authority expert": "authority_expert",
  lifestyle_aspiration: "lifestyle_aspiration", "lifestyle aspiration": "lifestyle_aspiration",
  educational: "educational",
  // perceivedPriceLevel
  budget: "budget", mid: "mid", premium: "premium", luxury: "luxury",
  // brandArchetype
  expert: "expert", friend: "friend",
  premium_authority: "premium_authority", "premium authority": "premium_authority",
  local_business: "local_business", "local business": "local_business",
  transformer: "transformer", entertainer: "entertainer", caregiver: "caregiver",
  // communicationStyle
  soft: "soft", direct: "direct", aggressive: "aggressive",
  emotional: "emotional", casual: "casual",
  // trustLevel / marketSophistication / emojiDensity
  low: "low", medium: "medium", high: "high",
  // conversionDrivers
  fear: "fear", aspiration: "aspiration", status: "status",
  convenience: "convenience", trust: "trust", urgency: "urgency",
  curiosity: "curiosity", relief: "relief", belonging: "belonging", control: "control",
  // hookMechanism.type
  problem: "problem", question: "question",
  bold_claim: "bold_claim", "bold claim": "bold_claim",
  contrarian: "contrarian", secret: "secret", mistake: "mistake",
  social_proof: "social_proof", "social proof": "social_proof",
  offer: "offer", story: "story",
  // awarenessLevel
  unaware: "unaware",
  problem_aware: "problem_aware", "problem aware": "problem_aware",
  solution_aware: "solution_aware", "solution aware": "solution_aware",
  product_aware: "product_aware", "product aware": "product_aware",
  most_aware: "most_aware", "most aware": "most_aware",
  // languageStyle
  simple: "simple", street: "street", professional: "professional",
  young: "young", religious: "religious", local: "local",
  // tonePattern
  urgent: "urgent",
  // variation angles
  general: "general", identity: "identity",
  fear_relief: "fear_relief", "fear relief": "fear_relief",
  transformation: "transformation",
  offer_first: "offer_first", "offer first": "offer_first",
  // dominantStructure
  testimonial: "testimonial",
  hook_problem_solution: "hook_problem_solution", "hook problem solution": "hook_problem_solution",
};

function normalizeEnum(value) {
  if (typeof value !== "string") return value;
  return ENUM_MAP[value.toLowerCase().trim()] ?? value.toLowerCase().trim();
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => (typeof v === "string" ? v.trim() : String(v))).filter(Boolean);
}

function normalizeScore(val) {
  const n = Number(val);
  if (isNaN(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function normalizeCreativeAnalysis(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return {
    ...raw,
    creativeFormat: normalizeEnum(raw.creativeFormat),
    creativeArchetype: normalizeEnum(raw.creativeArchetype),
    surface: raw.surface
      ? { ...raw.surface, onScreenText: normalizeStringArray(raw.surface.onScreenText) }
      : undefined,
    positioning: raw.positioning
      ? {
          ...raw.positioning,
          perceivedPriceLevel: normalizeEnum(raw.positioning.perceivedPriceLevel),
          brandArchetype: normalizeEnum(raw.positioning.brandArchetype),
          communicationStyle: normalizeEnum(raw.positioning.communicationStyle),
          trustLevel: normalizeEnum(raw.positioning.trustLevel),
        }
      : undefined,
    conversionDrivers: raw.conversionDrivers
      ? {
          ...raw.conversionDrivers,
          primaryDriver: normalizeEnum(raw.conversionDrivers.primaryDriver),
          secondaryDriver: normalizeEnum(raw.conversionDrivers.secondaryDriver),
          urgencyStrength: normalizeScore(raw.conversionDrivers.urgencyStrength),
          trustStrength: normalizeScore(raw.conversionDrivers.trustStrength),
          desireStrength: normalizeScore(raw.conversionDrivers.desireStrength),
          painIntensity: normalizeScore(raw.conversionDrivers.painIntensity),
        }
      : undefined,
    hookMechanism: raw.hookMechanism
      ? { ...raw.hookMechanism, type: normalizeEnum(raw.hookMechanism.type) }
      : undefined,
    audience: raw.audience
      ? {
          ...raw.audience,
          awarenessLevel: normalizeEnum(raw.audience.awarenessLevel),
          marketSophistication: normalizeEnum(raw.audience.marketSophistication),
          languageStyle: normalizeEnum(raw.audience.languageStyle),
          painPoints: normalizeStringArray(raw.audience.painPoints),
          desires: normalizeStringArray(raw.audience.desires),
          objections: normalizeStringArray(raw.audience.objections),
        }
      : undefined,
    copyGuidance: raw.copyGuidance
      ? {
          ...raw.copyGuidance,
          recommendedAngles: normalizeStringArray(raw.copyGuidance.recommendedAngles),
          phrasesToUse: normalizeStringArray(raw.copyGuidance.phrasesToUse),
          phrasesToAvoid: normalizeStringArray(raw.copyGuidance.phrasesToAvoid),
        }
      : undefined,
  };
}

function normalizeVariations(raw) {
  if (!Array.isArray(raw)) return raw;
  return raw.map((v) => ({ ...v, angle: normalizeEnum(v.angle) }));
}

function normalizeStrategy(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return {
    ...raw,
    dominantStructure: normalizeEnum(raw.dominantStructure),
    emojiDensity: normalizeEnum(raw.emojiDensity),
    copySignals: raw.copySignals
      ? {
          ...raw.copySignals,
          commonOpenings: normalizeStringArray(raw.copySignals.commonOpenings),
          commonCTAs: normalizeStringArray(raw.copySignals.commonCTAs),
          painWords: normalizeStringArray(raw.copySignals.painWords),
          benefitWords: normalizeStringArray(raw.copySignals.benefitWords),
          offerPatterns: normalizeStringArray(raw.copySignals.offerPatterns),
          proofPatterns: normalizeStringArray(raw.copySignals.proofPatterns),
          tonePattern: normalizeEnum(raw.copySignals.tonePattern),
        }
      : undefined,
  };
}

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const str = () => z.string().optional().default("");
const requiredStr = () => z.string().min(1);   // critical fields — empty = retry
const strArr = () => z.array(z.string()).optional().default([]);
const score = () => z.number().min(1).max(10).optional().default(5);

const CreativeAnalysisSchema = z.object({
  creativeFormat: z.enum(["image", "video", "carousel", "unknown"]).optional().default("unknown"),
  creativeArchetype: z.enum([
    "ugc_testimonial", "founder_story", "product_showcase", "before_after",
    "problem_solution", "offer_ad", "authority_expert", "lifestyle_aspiration",
    "educational", "unknown",
  ]).optional().default("unknown"),

  surface: z.object({
    visualSummary: requiredStr(),
    spokenSummary: str(),
    onScreenText: strArr(),
    visibleProductOrService: str(),
    setting: str(),
    people: str(),
  }).optional().default({}),

  positioning: z.object({
    perceivedPriceLevel: z.enum(["budget", "mid", "premium", "luxury", "unknown"]).optional().default("unknown"),
    brandArchetype: z.enum(["expert", "friend", "premium_authority", "local_business", "transformer", "entertainer", "caregiver", "unknown"]).optional().default("unknown"),
    communicationStyle: z.enum(["soft", "direct", "aggressive", "premium", "educational", "emotional", "casual"]).optional().default("direct"),
    trustLevel: z.enum(["low", "medium", "high"]).optional().default("medium"),
    reasonToBelieve: str(),
  }).optional().default({}),

  psychology: z.object({
    corePain: requiredStr(),
    hiddenFear: str(),
    mainFrustration: str(),
    dreamOutcome: requiredStr(),
    desiredIdentity: str(),
    mainObjection: str(),
    beliefShiftNeeded: str(),
  }).optional().default({}),

  conversionDrivers: z.object({
    primaryDriver: z.enum(["fear", "aspiration", "status", "convenience", "trust", "urgency", "curiosity", "relief", "belonging", "control"]).optional().default("aspiration"),
    secondaryDriver: z.enum(["fear", "aspiration", "status", "convenience", "trust", "urgency", "curiosity", "relief", "belonging", "control"]).optional().default("trust"),
    urgencyStrength: score(),
    trustStrength: score(),
    desireStrength: score(),
    painIntensity: score(),
    curiosityGap: str(),
  }).optional().default({}),

  hookMechanism: z.object({
    type: z.enum(["problem", "question", "bold_claim", "contrarian", "before_after", "secret", "mistake", "social_proof", "offer", "story"]).optional().default("bold_claim"),
    specificHookIdea: requiredStr(),
    scrollStopper: str(),
  }).optional().default({}),

  storyStructure: z.object({
    openingPattern: str(),
    conflict: str(),
    turningPoint: str(),
    resolution: str(),
    ctaTransition: str(),
  }).optional().default({}),

  audience: z.object({
    specificAudience: requiredStr(),
    awarenessLevel: z.enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"]).optional().default("problem_aware"),
    marketSophistication: z.enum(["low", "medium", "high"]).optional().default("medium"),
    languageStyle: z.enum(["simple", "street", "premium", "professional", "emotional", "young", "religious", "local"]).optional().default("simple"),
    painPoints: strArr(),
    desires: strArr(),
    objections: strArr(),
  }).optional().default({}),

  copyGuidance: z.object({
    recommendedAngles: strArr(),
    phrasesToUse: strArr(),
    phrasesToAvoid: strArr(),
    toneInstructions: requiredStr(),
    ctaRecommendation: str(),
  }).optional().default({}),
});

const VariationSchema = z.object({
  angle: z.enum(["problem_solution", "social_proof", "urgency", "curiosity", "offer_first", "identity", "fear_relief", "transformation", "general"]),
  hook: z.string().min(3),
  title: z.string().min(3),
  body: z.string().min(10),
  cta: z.string().min(2),
  whyThisWorks: z.string().optional(),
});

const VariationsSchema = z.array(VariationSchema).min(1);

const StrategySchema = z.object({
  dominantStructure: z.enum(["before_after", "testimonial", "offer_first", "hook_problem_solution"]),
  emojiDensity: z.enum(["low", "medium", "high"]),
  usesBullets: z.boolean().optional(),
  copySignals: z.object({
    commonOpenings: z.array(z.string()).optional().default([]),
    commonCTAs: z.array(z.string()).optional().default([]),
    painWords: z.array(z.string()).optional().default([]),
    benefitWords: z.array(z.string()).optional().default([]),
    offerPatterns: z.array(z.string()).optional().default([]),
    proofPatterns: z.array(z.string()).optional().default([]),
    tonePattern: z.enum(["direct", "soft", "premium", "urgent", "emotional", "unknown"]).optional().default("unknown"),
  }).optional().default({}),
  topExamples: z.array(z.object({
    score: z.number(),
    hook: z.string(),
    bodyPreview: z.string(),
    cta: z.string(),
  })).optional().default([]),
});

// ─── Fallback Values ──────────────────────────────────────────────────────────

const FALLBACK_CREATIVE_ANALYSIS = {
  creativeFormat: "unknown",
  creativeArchetype: "unknown",
  surface: { visualSummary: "לא זמין", spokenSummary: "", onScreenText: [], visibleProductOrService: "", setting: "", people: "" },
  positioning: { perceivedPriceLevel: "unknown", brandArchetype: "unknown", communicationStyle: "direct", trustLevel: "medium", reasonToBelieve: "" },
  psychology: { corePain: "לא זמין", hiddenFear: "", mainFrustration: "", dreamOutcome: "לא זמין", desiredIdentity: "", mainObjection: "", beliefShiftNeeded: "" },
  conversionDrivers: { primaryDriver: "aspiration", secondaryDriver: "trust", urgencyStrength: 5, trustStrength: 5, desireStrength: 5, painIntensity: 5, curiosityGap: "" },
  hookMechanism: { type: "bold_claim", specificHookIdea: "הצג את היתרון הכי חזק של המוצר", scrollStopper: "" },
  storyStructure: { openingPattern: "", conflict: "", turningPoint: "", resolution: "", ctaTransition: "" },
  audience: { specificAudience: "קהל יעד כללי", awarenessLevel: "problem_aware", marketSophistication: "medium", languageStyle: "simple", painPoints: [], desires: [], objections: [] },
  copyGuidance: { recommendedAngles: [], phrasesToUse: [], phrasesToAvoid: [], toneInstructions: "ישיר, ברור, ממוקד בתועלת", ctaRecommendation: "צור קשר עכשיו" },
};

const FALLBACK_VARIATION = {
  angle: "general",
  hook: "יש משהו שרוב האנשים עוד לא גילו...",
  title: "תגלה את ההבדל בעצמך",
  body: "אלפי אנשים כבר עשו את השינוי. הגיע תורך לראות מה אפשרי.",
  cta: "לפרטים — לחץ כאן",
  whyThisWorks: "Fallback — curiosity + social proof hybrid",
};

const FALLBACK_STRATEGY = {
  dominantStructure: "hook_problem_solution",
  emojiDensity: "medium",
  usesBullets: false,
  copySignals: { commonOpenings: [], commonCTAs: [], painWords: [], benefitWords: [], offerPatterns: [], proofPatterns: [], tonePattern: "unknown" },
  topExamples: [],
};

// ─── Validators ───────────────────────────────────────────────────────────────

function validateCreativeAnalysis(raw) {
  const normalized = normalizeCreativeAnalysis(raw);
  const result = CreativeAnalysisSchema.safeParse(normalized);
  return { normalized, result };
}

function validateVariations(raw) {
  const normalized = normalizeVariations(raw);
  const result = VariationsSchema.safeParse(normalized);
  return { normalized, result };
}

function validateStrategy(raw) {
  const normalized = normalizeStrategy(raw);
  const result = StrategySchema.safeParse(normalized);
  return { normalized, result };
}

module.exports = {
  CreativeAnalysisSchema,
  VariationsSchema,
  StrategySchema,
  validateCreativeAnalysis,
  validateVariations,
  validateStrategy,
  FALLBACK_CREATIVE_ANALYSIS,
  FALLBACK_VARIATION,
  FALLBACK_STRATEGY,
};
