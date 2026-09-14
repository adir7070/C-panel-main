/**
 * WOW Ads — Art Direction + Quality Review layer
 *
 * Sits between the text-generation step and the image-generation step
 * of runAdsPipeline (services/wow-ads.service.js). Two responsibilities:
 *
 *   1. generateCreativeDirection({ brief, ad, index, totalCount })
 *      → returns a structured JSON "design plan" per ad (visualType,
 *        layoutType, color palette, typography, mainSubject, etc.)
 *        so each ad in a batch gets a DIFFERENT visual language
 *        instead of all 10 landing on the same split layout.
 *
 *   2. reviewGeneratedAd({ imageBuffer, ad, brief })
 *      → vision-based quality review of a generated PNG. Returns
 *        { score, approve, issues[], retryInstruction }. The pipeline
 *        uses this to decide whether to retry an ad once with a
 *        targeted fix instruction injected back into the prompt.
 *
 * Both functions use gpt-4o and JSON mode. They fail soft — on error
 * they return null so the pipeline ships a best-effort image rather
 * than blowing up.
 */

const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
// OpenAI-primary text with Gemini fallback (out-of-credit resilience):
const { chatComplete } = require("./text-gen.service");
const DIRECTOR_MODEL = process.env.OPENAI_ADS_MODEL    || "gpt-4o";
const REVIEW_MODEL   = process.env.OPENAI_REVIEW_MODEL || "gpt-4o";

/* Version stamp for the Creative Director prompt + output schema. Bump
   this whenever DIRECTOR_SYSTEM, the layout pool, or the JSON shape
   changes meaningfully. Stored on every direction object so admin KPIs
   can segment "ads created under v1.0" vs "v1.1" and tell whether a
   prompt revision actually improved scores.
   v1.1 — added decorations[] + dividerShape after KLIQ 51-example audit.
   v1.2 — added panelLayoutType + structured featurePills (icon+title)
          to feed the deterministic SVG layout renderer. The Director now
          plans both the model-rendered hero AND the code-rendered panel. */
const CREATIVE_DIRECTION_VERSION = "v1.2";
/* Version stamp for the Quality Reviewer rubric. Same rationale — when
   you tighten or loosen the scoring rubric, bump this so historical
   scores stay comparable to the version they were graded under.
   v1.1 — added hard-deduct rules for low-contrast text and ghost text
          in negative space after the פסגת הצל invisible-headline session. */
const REVIEW_VERSION = "v1.1";

/* Variety pool the director picks from. Listing them inline in the
   prompt nudges gpt-4o to spread the batch across distinct languages
   instead of defaulting to "luxury editorial split" every time. */
const LAYOUT_POOL = [
  "luxury editorial split",
  "bold typographic poster",
  "photo dominant commercial ad",
  "center product hero",
  "dark premium cinematic",
  "minimal clean SaaS",
  "playful colorful retail",
  "warm lifestyle brand",
  "industrial Israeli premium",
  "app UI focused composition",
];

const VISUAL_TYPE_POOL = [
  "luxury", "clean", "dark", "playful", "industrial",
  "food", "beauty", "tech", "local-business", "app-ui",
];

/* The 5 panel shapes the deterministic SVG renderer supports. Director
   MUST pick from this exact list when the renderer is enabled — picking
   anything else means the renderer falls back to the default shape. */
const PANEL_LAYOUT_POOL = [
  "curved-split-left-text",
  "diagonal-left-panel",
  "soft-blob-left-panel",
  "arch-left-panel",
  "bottom-heavy-editorial",
];

/* Icon vocabulary the renderer ships with — Director must pick from
   this list for featurePills[].icon so the renderer can draw them. */
const PILL_ICON_POOL = [
  "quality", "service", "custom", "shield", "calendar", "flag",
  "diamond", "star", "paw", "heart", "tooth", "wheat", "flower",
  "gear", "mountain", "plane", "suitcase", "sparkle", "brush",
  "bolt", "hanger", "dress", "measure", "factory", "pergola",
  "headset", "smile",
];

const COPY_WEIGHT_HINTS = {
  low:    "Use only headline, short CTA, and 2 small badges.",
  medium: "Use headline, one supporting line, CTA, and 3 feature pills.",
  high:   "Use headline, supporting text, CTA, 3 features, and one small badge.",
};

const DIRECTOR_SYSTEM = `You are a senior Israeli advertising art director.

Return valid JSON only — no prose, no markdown, no code fences.

Your job is to create a UNIQUE visual direction for ONE Hebrew social media ad inside a batch.
You do NOT write the final image prompt — you describe the design plan that a downstream
prompt-writer will translate into an image prompt.

Output JSON shape (every field required):
{
  "conceptName": "short label for this direction",
  "visualType": "one of: luxury, clean, dark, playful, industrial, food, beauty, tech, local-business, app-ui",
  "layoutType": "one of the layout pool entries OR a brand-new layout you invent that fits the business",
  "businessScene": "one-sentence description of the exact scene to depict",
  "visualStyle": "shot/illustration language — editorial photography, neon cinematic, magazine spread, etc.",
  "colorPalette": "named palette using the brand colors as anchors — e.g. 'soft cream + brand cyan accent + dark charcoal'",
  "logoTreatment": "where the logo sits + how it integrates (top-left card / embossed on product / minimal corner mark / etc.)",
  "hebrewTransliteration": "the Hebrew phonetic spelling of the brand name that will sit next to the logo — REQUIRED, no exceptions, even for English brands (e.g. 'Luna Bake' → 'לונה בייק', 'Smile Craft' → 'סמייל קראפט', 'RideOn' → 'רייידאון'). If the business profile already contains a Hebrew name, use it verbatim.",
  "mainSubject": "the focal element — a smiling owner, a product on a plinth, a UI screen mockup, an empty serene space, etc.",
  "background": "what fills the rest of the canvas — store interior, abstract gradient, lifestyle scene, etc.",
  "typographyStyle": "heading weight + family direction — 'ultra-bold display serif', 'condensed industrial sans', 'soft humanist sans', etc.",
  "headlineAccentWord": "the EXACT one or two-word Hebrew sub-string from the headline that gets visual emphasis (color, underline, brush highlight). Pick the emotional anchor word. Must literally appear in the headline string.",
  "decorations": ["array of 2-4 industry-specific decorative elements that scatter around the brand panel — small line-art motifs that signal what kind of business this is. Examples: pet shop → ['paw prints', 'heart', 'bone outline']; dental → ['sparkle', 'tooth outline']; bakery → ['wheat sprig', 'small flower', 'sparkle']; bike shop → ['gear stroke', 'mountain silhouette', 'angled speed line']; aluminum/industrial → ['hexagon stroke', 'diagonal hatch']. NEVER use emoji — these are vector line-art ornaments drawn into the design."],
  "dividerShape": "the shape of the visual divider between brand panel and subject scene — one of: 'soft organic curve' (beauty/food/family-friendly), 'angled geometric diagonal' (sport/industrial/tech), 'scalloped wavy frame' (playful/retail/kids), 'arched gateway' (luxury/wellness), 'sharp triangular cut' (cinematic/dark/automotive), 'no divider — photo dominant' (clinical/minimal/SaaS). Pick the shape that matches visualType's mood.",
  "panelLayoutType": "the EXACT panel-shape ID for the deterministic SVG renderer — one of: 'curved-split-left-text' (default soft S-curve, beauty/food/lifestyle), 'diagonal-left-panel' (sharp angled cut, sport/industrial/tech), 'soft-blob-left-panel' (organic blob, playful/kids/retail), 'arch-left-panel' (gateway arch, luxury/wellness), 'bottom-heavy-editorial' (photo fills top, panel along the bottom — for product hero / cinematic shots). MUST be one of these exact strings; the renderer ignores anything else.",
  "featurePills": ["array of 0-3 objects, EACH shaped as {\"icon\": \"<icon-id>\", \"title\": \"<Hebrew label 1-3 words>\"}. The icon MUST be one of the vector icon IDs the renderer supports: 'quality', 'service', 'custom', 'shield', 'calendar', 'flag', 'diamond', 'star', 'paw', 'heart', 'tooth', 'wheat', 'flower', 'gear', 'mountain', 'plane', 'suitcase', 'sparkle', 'brush', 'bolt', 'hanger', 'dress', 'measure', 'factory', 'pergola', 'headset', 'smile'. Pick the icon that matches the business type AND the pill's specific claim. Empty array means no pills."],
  "cameraStyle": "if photographic: shot specs — '35mm environmental portrait, deep focus, warm key' or 'flat-lay overhead, soft daylight' etc.",
  "copyWeight": "low | medium | high — how much text density goes onto the canvas",
  "avoid": ["array of 2-4 specific failure modes to keep out of THIS ad — what would make it look generic or wrong"]
}

Layout-variety pool (pick from these or invent a new one that fits):
${LAYOUT_POOL.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}

Visual-type pool:
${VISUAL_TYPE_POOL.join(", ")}

Industry → decoration cheat-sheet (use these motifs when the business matches):
- Pet shop / grooming → paw prints, heart, bone outline, dog/cat silhouette
- Dental / medical → sparkle, tooth outline, plus-sign, gentle leaf
- Bakery / café / food → wheat sprig, small flower, steam swirl, heart, croissant outline
- Bike / sport / outdoor → gear stroke, mountain silhouette, angled speed line, lightning
- Beauty / nails / spa → sparkle, soft botanical leaf, flower, brush stroke
- Aluminum / construction / industrial → hexagon stroke, diagonal hatch, blueprint corner mark
- Travel / leisure → palm leaf, airplane dotted-line, sun rays, suitcase outline
- Tech / SaaS → dotted grid, small UI window, abstract geometric shape, subtle code bracket
- Fashion / boutique → soft floral, hanging tag silhouette, brush stroke, dotted curve
- Kids / toys → star, balloon, smile, doodle squiggle

Hard rules:
- Every ad in a batch must feel visually DIFFERENT from the others. Do not always use split layout.
- Choose the design language that matches the BUSINESS (food → appetite-driven warm; tech → sharp modern UI; kids → colorful playful; beauty → clean feminine premium; construction/aluminum → strong Israeli industrial; luxury → premium editorial).
- Hebrew text must stay clear and readable in the layout you pick — no script/calligraphy/handwriting fonts.
- The design must work as 1:1 square for Facebook/Instagram.
- copyWeight should match the layout — bold typographic poster = high; minimal clean SaaS = low; photo-dominant commercial = medium.
- featurePills must be objects with both icon (from the icon pool) and title (short Hebrew label, 1-3 words). OR empty array if the layout doesn't need them.
- panelLayoutType MUST be exactly one of the 5 strings listed in its schema — anything else is silently ignored by the renderer and the default 'curved-split-left-text' is used.
- hebrewTransliteration is MANDATORY for every ad — never leave blank. The logo must always sit next to or under a Hebrew rendering of the brand name.
- headlineAccentWord MUST be a substring that literally appears in the ad's headline — do not invent a word that isn't in the source copy.
- decorations must be SPECIFIC to the business type — do not return generic shapes like "circles" or "dots"; use the cheat-sheet above as a starting point.
- dividerShape MUST match visualType's mood — never pair "dark cinematic" with "soft organic curve" or "playful retail" with "sharp triangular cut".
- Avoid list must be SPECIFIC — not "avoid bad design"; instead "avoid stock-image food photography that looks like a hotel buffet" or "avoid generic person-on-white-background".`;

async function generateCreativeDirection({ brief, ad, index, totalCount = 10 }) {
  try {
    // Non-Hebrew ads: override the system prompt's Hebrew-specific field rules
    // (transliteration, Hebrew accent word / pill labels) via the user message.
    const { getLang, isHebrew } = require("./ad-languages.service");
    const _L = getLang(brief?.language);
    const langOverride = isHebrew(brief?.language) ? "" : `
LANGUAGE OVERRIDE — this ad's copy is in ${_L.name} (${_L.script} script, ${_L.dir === "rtl" ? "right-to-left" : "left-to-right"}), NOT Hebrew:
- headlineAccentWord: pick the emphasis word from the ${_L.name} headline above (a literal substring of it) — NOT Hebrew.
- featurePills[].title: write each label in ${_L.name} — NOT Hebrew.
- hebrewTransliteration: set it to the brand name exactly as written (do NOT transliterate to Hebrew).
- All on-image text will be rendered in ${_L.name} with ${_L.dir === "rtl" ? "RTL" : "LTR"} flow.
`;
    const completion = await chatComplete({
      model: DIRECTOR_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DIRECTOR_SYSTEM },
        {
          role: "user",
          content: `Business brief:
${JSON.stringify({
  name:            brief.businessName,
  field:           brief.businessField,
  niche:           brief.businessNiche,
  about:           brief.about,
  services:        brief.services,
  targetAudience:  brief.targetAudience,
  designStyle:     brief.designStyle,
  preferredColors: brief.preferredColors,
  promotion:       brief.promotion,
}, null, 2)}

Ad copy (already written — do not change, just design around it):
${JSON.stringify({
  id:          ad.id,
  headline:    ad.headline,
  description: ad.description,
  cta:         ad.cta,
  type:        ad.type,
}, null, 2)}

This is ad ${index + 1} of ${totalCount} in the same batch.${langOverride}
Pick a visual direction that is DISTINCT from the typical "split layout with person on the right" — unless that specific ad genuinely calls for it.
Return only the JSON.`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    /* Sanity-fill missing fields so downstream code can rely on shape.
       For v1.1 new fields (hebrewTransliteration / headlineAccentWord /
       decorations / dividerShape) we fall back to safe neutral values
       when the Director omits them — but we DO NOT silently invent
       Hebrew transliterations (would risk swapping letters). An empty
       string is honest signal; the prompt step warns the image model. */
    return {
      conceptName:    parsed.conceptName    || `direction-${ad.id}`,
      visualType:     parsed.visualType     || "clean",
      layoutType:     parsed.layoutType     || LAYOUT_POOL[index % LAYOUT_POOL.length],
      businessScene:  parsed.businessScene  || "",
      visualStyle:    parsed.visualStyle    || "premium commercial photography",
      colorPalette:   parsed.colorPalette   || "",
      logoTreatment:  parsed.logoTreatment  || "top-left brand mark with Hebrew transliteration alongside",
      hebrewTransliteration: parsed.hebrewTransliteration || "",
      mainSubject:    parsed.mainSubject    || "",
      background:     parsed.background     || "",
      typographyStyle: parsed.typographyStyle || "ultra-bold modern Hebrew sans-serif (Heebo/Assistant/Rubik)",
      headlineAccentWord: parsed.headlineAccentWord || "",
      decorations:    Array.isArray(parsed.decorations) ? parsed.decorations.slice(0, 5) : [],
      dividerShape:   parsed.dividerShape   || "soft organic curve",
      panelLayoutType: PANEL_LAYOUT_POOL.includes(parsed.panelLayoutType)
        ? parsed.panelLayoutType
        : PANEL_LAYOUT_POOL[index % PANEL_LAYOUT_POOL.length],
      /* Normalize featurePills to { icon, title } objects. Tolerates the
         legacy schema where pills were plain strings — gives them a
         neutral icon so the renderer still draws something sensible. */
      featurePills:   Array.isArray(parsed.featurePills) ? parsed.featurePills.slice(0, 4).map(p => {
        if (typeof p === "string") return { icon: "quality", title: p };
        const icon = PILL_ICON_POOL.includes(p?.icon) ? p.icon : "quality";
        const title = (p?.title || p?.label || "").toString().trim();
        return { icon, title };
      }).filter(p => p.title) : [],
      cameraStyle:    parsed.cameraStyle    || "",
      copyWeight:     ["low", "medium", "high"].includes(parsed.copyWeight) ? parsed.copyWeight : "medium",
      avoid:          Array.isArray(parsed.avoid) ? parsed.avoid.slice(0, 5) : [],
      version:        CREATIVE_DIRECTION_VERSION,
    };
  } catch (err) {
    console.warn(`[wow-ads:director] ad ${ad?.id} direction failed:`, err.message);
    return null;
  }
}

/* Format a creative direction object as a prompt-ready block. */
function formatCreativeDirection(direction) {
  if (!direction) return "";
  const copyHint = COPY_WEIGHT_HINTS[direction.copyWeight] || COPY_WEIGHT_HINTS.medium;
  const pills = direction.featurePills?.length
    ? direction.featurePills.map(p => {
        if (typeof p === "string") return `"${p}"`;
        return `"${p.title}" (icon: ${p.icon})`;
      }).join(", ")
    : "(no feature pills in this layout)";
  const decorations = direction.decorations?.length
    ? direction.decorations.map(d => `"${d}"`).join(", ")
    : "(no specific decorative motifs — keep minimal)";
  const translitNote = direction.hebrewTransliteration
    ? `"${direction.hebrewTransliteration}" — render this Hebrew text directly beside or under the brand mark`
    : "(no Hebrew transliteration supplied — render the brand mark from the reference and place the brand's natural Hebrew name beside it if known)";
  const accentNote = direction.headlineAccentWord
    ? `"${direction.headlineAccentWord}" — give this word visual emphasis (color, underline, brush highlight, or rendered in the brand accent color)`
    : "(no accent word supplied — pick the most emotionally weighted word of the headline yourself and emphasize it)";
  const avoid = direction.avoid?.length
    ? direction.avoid.map(a => `- ${a}`).join("\n")
    : "- (no specific avoidances)";
  return `CREATIVE DIRECTION FOR THIS AD (follow exactly — every field is a constraint, not a suggestion):
- Concept: ${direction.conceptName}
- Visual type: ${direction.visualType}
- Layout: ${direction.layoutType}
- Business scene: ${direction.businessScene}
- Visual style: ${direction.visualStyle}
- Color palette: ${direction.colorPalette}
- Logo treatment: ${direction.logoTreatment}
- Hebrew transliteration beside logo: ${translitNote}
- Main subject: ${direction.mainSubject}
- Background: ${direction.background}
- Typography: ${direction.typographyStyle}
- Headline accent word: ${accentNote}
- Industry-specific decorations (scatter these as small line-art motifs around the brand panel): ${decorations}
- Divider shape between brand panel and subject scene: ${direction.dividerShape}
- Camera style: ${direction.cameraStyle}
- Feature pills (Hebrew labels to render, exactly these): ${pills}
- Copy weight: ${direction.copyWeight} — ${copyHint}

AVOID for this specific ad:
${avoid}`;
}

const REVIEW_SYSTEM = `You are a strict Israeli creative director reviewing a generated Hebrew social media ad image.

Return valid JSON only:
{
  "score": 0-100,
  "approve": true | false,
  "issues": ["short specific list of what's wrong, empty array if perfect"],
  "retryInstruction": "if approve is false, a SHORT, SPECIFIC, ACTIONABLE instruction that will be appended to the next image-generation prompt to fix the worst issues. Empty string if approve is true."
}

Scoring rubric (deduct from 100):
- Headline / description / CTA / feature labels rendered in LOW CONTRAST against their background (pale text on pale background, washed out, hard to read at a glance): -30 per occurrence. This is the #1 failure mode — be strict.
- Ghost text, duplicate-but-faint text, or model-generated brand text floating in negative space behind the designed layout: -25 per occurrence
- Hebrew text readability problems (gibberish, missing letters, wrong direction, swapped letters): -30 per occurrence
- Logo wrong (recolored, distorted, missing from the brand panel, painted as a designed overlay outside the panel): -15 (NOTE: a small organic brand logo on a worker's uniform, equipment, or shop sign inside the photo is GOOD — do NOT deduct for that)
- Subject not photoreal when it should be (cartoon/CGI/plastic look): -20
- Duplicated headline / CTA / pill label (same text appears twice as actual rendered text — not the same word echoed in body copy): -25 per occurrence
- Visual hierarchy weak (no clear headline focal point): -10
- CTA unclear or missing: -15
- Layout overcrowded or empty: -10
- Anatomy errors (extra fingers, melted faces): -25
- Hex codes / color swatches / palette legend visible on canvas: -20

approve = true only if score >= 82 AND no -25-or-worse issue is present.
retryInstruction must be one short paragraph the next prompt can use verbatim. For contrast failures, the instruction must name the specific element ("the headline text", "the description", "the feature pill labels") and the fix ("render in dark navy / brand's darkest color, not pastel").`;

async function reviewGeneratedAd({ imageBuffer, ad, brief }) {
  try {
    // Language-aware review — the "wrong direction" deduction must not punish
    // correct LTR text when the ad is in an LTR language.
    const { getLang, isHebrew } = require("./ad-languages.service");
    const _L = getLang(brief?.language);
    const _langNote = isHebrew(brief?.language)
      ? "Expected Hebrew copy in this ad:"
      : `Expected copy is in ${_L.name} (${_L.script} script, written ${_L.dir === "rtl" ? "right-to-left" : "left-to-right"}). The "wrong direction" deduction applies ONLY relative to ${_L.name}'s natural direction — do NOT penalize correct ${_L.dir === "rtl" ? "RTL" : "LTR"} ${_L.name} text. Expected copy in this ad:`;
    const base64 = imageBuffer.toString("base64");
    const completion = await chatComplete({
      model: REVIEW_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: REVIEW_SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Business: ${brief.businessName || "(unnamed)"} — ${brief.businessField || ""}
${_langNote}
Headline: "${ad.headline}"
Description: "${ad.description}"
CTA: "${ad.cta}"

Review the attached image strictly. Return JSON only.`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${base64}` },
            },
          ],
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return {
      score:            typeof parsed.score === "number" ? parsed.score : 0,
      approve:          parsed.approve === true,
      issues:           Array.isArray(parsed.issues) ? parsed.issues : [],
      retryInstruction: typeof parsed.retryInstruction === "string" ? parsed.retryInstruction : "",
      reviewVersion:    REVIEW_VERSION,
    };
  } catch (err) {
    console.warn(`[wow-ads:review] ad ${ad?.id} review failed:`, err.message);
    return null;
  }
}

module.exports = {
  generateCreativeDirection,
  formatCreativeDirection,
  reviewGeneratedAd,
  LAYOUT_POOL,
  VISUAL_TYPE_POOL,
  CREATIVE_DIRECTION_VERSION,
  REVIEW_VERSION,
};
