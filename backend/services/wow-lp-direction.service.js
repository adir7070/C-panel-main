/**
 * WOW Landing Page — Art Direction layer for hero/section images.
 *
 * Mirrors the Director pattern from wow-ads-direction.service.js but
 * adapted for Gemini-rendered editorial photographs that fill section
 * backgrounds and feature blocks in a landing page (no text on image,
 * no logo on image, no SVG decorations — pure photography).
 *
 * Why: the previous string-template approach (buildImagePromptFromKey
 * in wow-lp-v2.service.js) produced generic stock-looking shots because
 * it couldn't reason about THIS business specifically — every section
 * got essentially the same aesthetic block with only the slot purpose
 * varying. The Director step lets gpt-4o (or whichever model) think
 * about the business + the section purpose first and emit a structured
 * design plan that the formatter turns into a Gemini-ready prompt.
 *
 * Public API:
 *   generateLpImageDirection({ brief, slotKey, slotDescription })
 *     → JSON design plan or null on failure (caller falls back to the
 *       old string template — never blocks the pipeline).
 *   formatLpImageDirection({ direction, brief, slotKey, slotDescription })
 *     → final Gemini-ready prompt string.
 */

const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
const DIRECTOR_MODEL = process.env.OPENAI_LP_DIRECTOR_MODEL || "gpt-4o";

/* Version stamp — bump when DIRECTOR_SYSTEM or the JSON shape changes
   meaningfully so historical sessions stay segmentable by prompt version. */
const LP_DIRECTOR_VERSION = "v1.0";

const DIRECTOR_SYSTEM = `You are a senior Israeli editorial photographer and art director.

Your job: build a structured design plan for ONE photograph that will fill a section of a Hebrew landing page. A downstream formatter will translate your plan into a Gemini image prompt — you do NOT write the final prompt.

Return valid JSON only — no prose, no markdown, no code fences.

CRITICAL — every photograph MUST be unmistakably about THIS specific business:
- Its industry, its actual services, its physical environment.
- Generic "office workspace", "happy person at laptop", "team meeting around table" = FAILURE.
- If the business is in tourism — show the SPECIFIC destinations and travel style this business actually sells (read its services/about: e.g. European old-town streets, Alpine peaks, Greek-island coastlines, tropical resorts, cruise decks, safaris). Use Israeli landscapes ONLY when the business explicitly sells domestic tours inside Israel. NEVER default to desert/camel scenery unless the brief says so.
- If the business is a bakery — show real warm bread, dough being shaped, flour-dusted hands, ceramic plates with steam.
- If the business is a clinic — show the actual treatment moment, soft natural light, no sterile hospital aesthetic unless that IS the brand.

Output JSON shape (every field required):
{
  "conceptName": "short label for the concept (e.g. 'morning bakery warmth')",
  "mainSubject": "the focal element of the photo, described in business-specific terms — a specific product, person performing a specific task, or specific environment of THIS business",
  "businessScene": "ONE-sentence description of the EXACT scene, with concrete Israeli/Hebrew-market context where relevant",
  "supportingElements": "props, background details, atmosphere — concrete things in frame that reinforce the business identity",
  "mood": "the emotional register — one of: warm-intimate, calm-premium, vibrant-energetic, quiet-confident, grand-aspirational, playful-light, raw-authentic",
  "colorPalette": "named palette anchored on the brand's primary colors plus complementary tones — describe the dominant tones the image should land on",
  "lighting": "the light direction & quality — golden-hour warm, soft window light, dramatic studio rim, overcast diffused, blue-hour, etc.",
  "cameraStyle": "lens + shot type, chosen for DRAMA — favor bold, characterful choices: a low-angle hero shot that makes the subject monumental, a sweeping ultra-wide 18-24mm establishing shot, an intimate 85mm compression, an overhead flat-lay, or a slight dutch-tilt for energy. Avoid safe eye-level snapshots.",
  "composition": "framing strategy — lean into bold, dynamic framing: strong leading diagonals, deep foreground layering, a single striking focal point, rule of thirds, intentional negative space. MUST account for the slot purpose (hero = wide cinematic establishing; service close-up = tight and tactile; testimonial bg = soft/atmospheric).",
  "production": "quality reference — Vogue / Monocle / Conde Nast Traveler / Architectural Digest / Magnum / The New York Times Magazine",
  "avoid": ["array of 2-4 specific failure modes for THIS shot — not generic warnings. Examples: 'empty corporate office shot', 'forced smile directly at camera', 'stock-photo handshake', 'flat lighting under fluorescent ceiling tubes'"]
}

Industry → scene cheat-sheet (use as starting point, not as a hard rule):
- Bakery / café / pastry → warm bread on textured wood, flour-dusted hands shaping dough, ceramic plates with rising steam, morning sunlight through window
- Hair / beauty salon → close-up of professional hands working with care, soft natural light, real client (not posed)
- Spa / wellness → quiet candle-lit corner, hands during massage, warm towels, organic textures
- Restaurant → plated dish on textured table, glass softly in focus, natural window light, hands reaching in mid-bite
- Tour / travel agency → the SPECIFIC destinations this business sells (read services/about) — e.g. European old-town streets, Alpine peaks, Greek-island coastline, tropical resort, cruise deck — with people small in frame. Match the actual offering; do NOT default to generic desert/camel scenery. Israeli landscapes only for domestic-Israel tour operators.
- Dental / medical clinic → minimalist treatment moment, gentle natural light, no clinical sterility
- Coaching / mentoring / consulting → portrait of the coach in their actual workspace, warm direct gaze, deep focus on personality
- Construction / aluminum / contractor → workers in real action with their tools, industrial Israeli context (kibbutz / urban site / desert), strong daylight
- Pet shop / vet / grooming → real interaction with the animal, soft natural light, owner's hands or worker's hands prominent
- Fashion / boutique → editorial product flat-lay or model in soft natural light, premium textures
- Tech / SaaS / app → laptop/phone in real human use context (cafe, home office), screen prominently in focus, hands on keyboard
- Real estate / interior design → architectural light streaming through window, vignette of one styled corner, no wide-angle distortion

Hard rules:
- mainSubject and businessScene MUST be about THIS business — never generic.
- cameraStyle and composition MUST be BOLD and dramatic — every shot should feel like a magazine cover, never a flat eye-level snapshot.
- mood and lighting MUST match the brand's intended emotion (from the brief's designStyle field if present).
- composition MUST account for the slot purpose described in the user message.
- If brand colors are supplied in the brief, colorPalette MUST anchor on them.
- avoid list must be SPECIFIC — not "avoid bad photos"; instead "avoid the laptop-on-white-desk corporate cliche".
- For ANY food shown: KOSHER ONLY. No meat+dairy combinations, no pork, no shellfish, no eel/catfish. When unclear, render parve (vegetables, grains, fish with fins+scales, fruit).`;

/* Sanity defaults so the formatter never crashes on a partial Director
   response — gpt-4o occasionally drops a field. Empty string is signal
   to the formatter to omit the line rather than print "undefined". */
const DIRECTION_DEFAULTS = {
  conceptName:        "",
  mainSubject:        "",
  businessScene:      "",
  supportingElements: "",
  mood:               "calm-premium",
  colorPalette:       "",
  lighting:           "soft natural daylight",
  cameraStyle:        "35mm environmental shot, shallow depth of field",
  composition:        "rule of thirds with intentional negative space",
  production:         "Vogue / Monocle editorial quality",
  avoid:              [],
};

async function generateLpImageDirection({ brief, slotKey, slotDescription }) {
  const briefForDirector = {
    businessName:    brief?.businessName    || "",
    industry:        brief?.industry        || brief?.businessField || brief?.categoryKey || "",
    niche:           brief?.businessNiche   || "",
    about:           String(brief?.about    || "").slice(0, 600),
    services:        String(brief?.services || "").slice(0, 600),
    targetAudience:  brief?.targetAudience  || "",
    designStyle:     brief?.designStyle     || "",
    preferredColors: brief?.preferredColors || null,
  };

  try {
    const completion = await openai.chat.completions.create({
      model: DIRECTOR_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DIRECTOR_SYSTEM },
        {
          role: "user",
          content: `Business brief:
${JSON.stringify(briefForDirector, null, 2)}

Page slot you are directing this photo for:
- slot key:         ${slotKey}
- slot purpose:     ${slotDescription || "(not specified — infer from the slot key)"}

Pick a direction that makes THIS photo unmistakably about THIS business — never generic.
Return only the JSON.`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    return {
      conceptName:        parsed.conceptName        || DIRECTION_DEFAULTS.conceptName,
      mainSubject:        parsed.mainSubject        || DIRECTION_DEFAULTS.mainSubject,
      businessScene:      parsed.businessScene      || DIRECTION_DEFAULTS.businessScene,
      supportingElements: parsed.supportingElements || DIRECTION_DEFAULTS.supportingElements,
      mood:               parsed.mood               || DIRECTION_DEFAULTS.mood,
      colorPalette:       parsed.colorPalette       || DIRECTION_DEFAULTS.colorPalette,
      lighting:           parsed.lighting           || DIRECTION_DEFAULTS.lighting,
      cameraStyle:        parsed.cameraStyle        || DIRECTION_DEFAULTS.cameraStyle,
      composition:        parsed.composition        || DIRECTION_DEFAULTS.composition,
      production:         parsed.production         || DIRECTION_DEFAULTS.production,
      avoid:              Array.isArray(parsed.avoid) ? parsed.avoid.slice(0, 5) : DIRECTION_DEFAULTS.avoid,
      version:            LP_DIRECTOR_VERSION,
    };
  } catch (err) {
    console.warn(`[wow-lp:director] slot ${slotKey} direction failed: ${err.message}`);
    return null;
  }
}

/* Build the final Gemini prompt from a Director plan + business context.
   Business context is repeated up top so Gemini doesn't drift — it
   follows whatever the prompt LEADS with. */
function formatLpImageDirection({ direction, brief, slotKey, slotDescription }) {
  if (!direction) return null;

  const name      = brief?.businessName || "";
  const industry  = brief?.industry || brief?.businessField || brief?.categoryKey || "";
  const services  = String(brief?.services || "").slice(0, 240);
  const about     = String(brief?.about    || "").slice(0, 240);
  const colors    = brief?.preferredColors
    ? Object.values(brief.preferredColors).filter(Boolean).join(", ")
    : "";

  const line = (label, value) => value ? `- ${label}: ${value}` : null;

  return [
    `Editorial-grade commercial photograph${name ? ` for the Israeli business "${name}"` : ""}${industry ? ` — ${industry}` : ""}.`,
    "",
    "BUSINESS CONTEXT (the photo MUST reflect this — never drift to generic stock):",
    line("What this business does", services),
    line("About",                   about),
    line("Brand colors to anchor palette on", colors),
    "",
    `PAGE SLOT: ${slotKey.toLowerCase().replace(/_/g, " ")}${slotDescription ? ` — ${slotDescription}` : ""}`,
    "",
    direction.conceptName ? `CONCEPT: ${direction.conceptName}` : null,
    "",
    line("Main subject",                  direction.mainSubject),
    line("Business scene",                direction.businessScene),
    line("Supporting elements in frame",  direction.supportingElements),
    line("Mood / emotional register",     direction.mood),
    line("Color palette",                 direction.colorPalette),
    line("Lighting",                      direction.lighting),
    line("Camera style",                  direction.cameraStyle),
    line("Composition",                   direction.composition),
    line("Production quality reference",  direction.production),
    "",
    "CAMERA & ANGLE — BE BOLD: shoot from a dramatic, intentional angle (low-angle hero, sweeping ultra-wide establishing, dynamic diagonal, slight dutch tilt, or intimate compressed close-up). This must read like a magazine cover, NEVER a flat eye-level snapshot.",
    "",
    direction.avoid?.length
      ? `STRICTLY AVOID for this shot:\n${direction.avoid.map(a => `- ${a}`).join("\n")}`
      : null,
    "",
    `GLOBAL AVOID (always):
- Flat / on-camera flash lighting. Boring eye-level snapshot angles.
- Stock-photo aesthetic (forced smiles, fake-corporate, cliché poses, handshakes).
- Cluttered backgrounds, blown-out skies, over-saturation.
- Plastic-looking skin, uncanny-valley faces, AI artifacts (extra fingers).
- Generic stock-website environments (the dated PowerPoint look).
- Non-kosher food: no meat+dairy together, no pork, no shellfish, no eel/catfish. When in doubt, render parve.`,
    "",
    "ABSOLUTE RULE — ZERO TEXT: this is a pure photograph for a website background. Render NO text, letters, words, numbers, signage, captions, watermarks, logos, brand marks, or UI of any kind anywhere in the image. Any sign naturally in the scene must be blank or out of focus.",
    "",
    "Image format: clean photograph, no borders, no frames, no UI chrome. Subject occupies 60-70% of the frame.",
  ].filter(s => s !== null).join("\n");
}

module.exports = {
  generateLpImageDirection,
  formatLpImageDirection,
  LP_DIRECTOR_VERSION,
};
