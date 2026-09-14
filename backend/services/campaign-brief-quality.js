/**
 * Campaign Brief — QUALITY pipeline helpers (mobile app HQ path)
 *
 * Copied/adapted from services/wow-ads.service.js (the CPANEL WOW Ads
 * pipeline). Kept independent so the mobile pipeline can evolve without
 * touching WOW Ads.
 *
 * The prompt strings (BUSINESS_ANALYST_SYSTEM, buildNanoPromptPrompt with
 * its 9 IRON LAWS, MANDATORY BRAND COLORS block, HEBREW PIXEL-PERFECT
 * block, etc.) are copied VERBATIM from wow-ads.service.js — the exact
 * wording is the quality secret and must not be paraphrased or shortened.
 *
 * Self-contained public surface:
 *   - analyzeBusinessForAds(brief, logoBuffer, imageBuffers) → { nanoPromptTips, geminiTips }
 *   - generateNanoPrompt(ad, ctx, direction)                 → single-line English image prompt
 *   - generateAdImageBuffer(prompt, logoBuffer, imageBuffers)→ { buffer, modelUsed, fallbackUsed }
 *   - buildNanoPromptPrompt(ad, ctx, direction)              → the meta-prompt (exported for reuse)
 *   - fetchAssetBuffer(ref)                                  → Buffer | null
 *
 * NOTE ON squareizePreservingText / finalized buffers:
 *   WOW Ads' generateAdImageBuffer ALWAYS runs squareizePreservingText on
 *   the raw model output before returning (see tryModel → squareizePreservingText).
 *   So the returned buffer is ALREADY a finalized AD_SIZE×AD_SIZE square PNG.
 *   We replicate that exactly here: squareizePreservingText is copied into
 *   this module and generateAdImageBuffer returns the squarized buffer. The
 *   caller should NOT squarize again (it's already square).
 *
 * formatCreativeDirection / formatBrandPalette are REQUIRED, not copied:
 *   - formatBrandPalette comes from utils/brand-palette.js (shared util).
 *   - formatCreativeDirection comes from ./wow-ads-direction.service (it is
 *     exported there; requiring it does NOT modify any wow-ads file).
 */

const { OpenAI, toFile } = require("openai");
const sharp           = require("sharp");
const backblazeService = require("./backblaze.service");
const { formatBrandPalette } = require("../utils/brand-palette");
const { formatCreativeDirection } = require("./wow-ads-direction.service");

const AD_SIZE = 1080; // square output enforced regardless of what the image model returns

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
// OpenAI-primary text with Gemini fallback (out-of-credit resilience):
const { chatComplete } = require("./text-gen.service");
// Gemini (gemini-3-pro-image-preview) is the PRIMARY image model; OpenAI is fallback.
const { generateImageBuffer: geminiGenerateImage, GEMINI_IMAGE_MODEL: GEMINI_IMG_MODEL } = require("./gemini-image-gen.service");

const OPENAI_MODEL                = process.env.OPENAI_ADS_MODEL            || "gpt-4o";
const OPENAI_IMAGE_MODEL          = process.env.OPENAI_IMAGE_MODEL          || "gpt-image-2";
const OPENAI_FALLBACK_IMAGE_MODEL = process.env.OPENAI_FALLBACK_IMAGE_MODEL || "gpt-image-2";
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "high";
const OPENAI_IMAGE_SIZE  = process.env.OPENAI_IMAGE_SIZE  || "1024x1024";

/* ────────────────────────────────────────────────────────────────────
   PROMPTS
   ──────────────────────────────────────────────────────────────────── */

/**
 * Detect "go vibrant" hints in the brief's color note. When the brief says
 * things like "צבעוני / משוגע / חי / תוסס / קיצי / vibrant / tropical /
 * neon / pop", we inject an explicit saturated palette directive so Gemini
 * doesn't fall back to muted neutrals (its default). CampaignMaster pattern.
 */
const VIBRANT_HINTS = ["צבעוני", "משוגע", "חי", "תוסס", "קיצי", "tropical", "vibrant", "bright", "pop", "neon"];
function vibrantOverride(rawNote) {
  if (!rawNote) return null;
  const lc = String(rawNote).toLowerCase();
  if (!VIBRANT_HINTS.some(w => lc.includes(w))) return null;
  return `Brand color direction: VIBRANT TROPICAL POP — saturated bright palette (sunset orange #FF6B35, citrus yellow #FFD23F, electric turquoise #06D6A0, hot pink #FF4D9D, sky blue #4CC9F0). High color contrast, bold blocks of color, NOT muted or beige. Think summer beach poster, juice-stand graphics, neon retro signage. The ad should LOOK joyful at a glance.`;
}

/* Maps the renderer's panelLayoutType to a description of where the
   model should LEAVE EMPTY SPACE so the SVG renderer can paint the
   brand panel on top without clashing with the photo subject. */
const HERO_NEGATIVE_SPACE_HINT = {
  "curved-split-left-text": "Leave the LEFT 50-55% of the canvas as clean negative space (soft, low-contrast, suitable for text overlay) — keep the photographic subject confined to the RIGHT half.",
  "diagonal-left-panel":    "Leave the LEFT 50% of the canvas as clean negative space — the subject lives on the RIGHT side and the composition should naturally tilt the eye rightward.",
  "soft-blob-left-panel":   "Leave the LEFT 50% of the canvas as soft uncluttered space — the subject lives on the RIGHT side.",
  "arch-left-panel":        "Leave the LEFT 50% of the canvas as quiet bright space — the subject lives on the RIGHT, ideally framed by a natural arch shape if possible.",
  "bottom-heavy-editorial": "The subject + scene fills the TOP 65% of the canvas. Leave the BOTTOM 35% as clean low-contrast negative space — the SVG renderer will paint a brand panel + CTA + 3 pills along the bottom.",
};

function buildNanoPromptPrompt(ad, ctx, direction = null) {
  const palette = formatBrandPalette(ctx.preferredColors, {
    defaults: { primary: "#1E3A8A", secondary: "#06B6D4", accent: "#10B981" },
  });
  /* Vibrant override wins over the hex palette if the design-style note
     screams "go bright". Otherwise the regular palette is used as-is. */
  const vibrant = vibrantOverride(ctx.designStyle) || vibrantOverride(ctx.colorHint);
  /* Brand colors are MANDATORY — phrased as imperative rules, not
     suggestions. Gemini was treating "Brand colors: X — use these in
     the ad design" as a soft hint and defaulting to muted neutrals.
     Listing the colors as forbidden-to-deviate fixes that. */
  const colorNote = vibrant
    ? vibrant
    : (palette
      ? `MANDATORY BRAND COLORS — the brand's palette is ${palette}. EVERY visible color element (background, headline color, body text color, CTA button fill, decorative shapes, gradients, accent details) MUST be drawn from this exact palette. DO NOT introduce other hues. DO NOT default to beige, taupe, off-white, or generic muted neutrals when the brand colors above are vivid. If a passage of the design needs a neutral, use the darkest or lightest brand color, not an invented gray.
CRITICAL — these hex codes are INSTRUCTIONS for YOU, not content to render. NEVER draw the hex strings (#F4F4F4, etc.), NEVER draw color swatches, NEVER draw a row of color chips, NEVER draw a brand-palette legend or design-spec bar anywhere on the canvas. The hex values are invisible to the viewer — they only tell you what colors to USE in the photo, text, and CTA.`
      : "Use professional brand-friendly colors with strong contrast.");

  const logoNote = ctx.hasLogo
    ? `LOGO: The brand logo image is the LAST attached reference. Reproduce the EXACT logo mark and brand name from the reference image (do NOT redesign it). Place it in the UPPER-LEFT of the canvas inside the brand panel — and append the brand's Hebrew transliteration name directly beside or under the logo (e.g. "Luna Bake | לונה בייק", "Smile Craft | סמייל קראפט", "PlayBox | פלייבוקס") in a clean Hebrew sans-serif.`
    : "";

  const sceneNote = ctx.hasScene
    ? `Reference photos of the actual business are attached. Use them as the source of truth for the SUBJECT scene that occupies the RIGHT half of the canvas — reproduce the actual space, products, decor, lighting, and people from those photos. Do NOT invent a generic or stock scene. The attached photos ARE this business.
IRON LAW — SINGLE UNIFIED SUBJECT: The right-half subject is ONE coherent moment in ONE place at ONE time of day. NEVER stitch multiple reference photos into a collage. If multiple references are attached, pick ONE as the anchor scene and ignore the others.`
    : "";
  const analysisBlock = ctx.nanoPromptTips?.length
    ? `\nBUSINESS ANALYSIS — APPLY THESE TIPS WHEN WRITING THE GEMINI PROMPT:\n${ctx.nanoPromptTips.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "";
  const geminiTipsBlock = ctx.geminiTips?.length
    ? `\n\nBUSINESS VISUAL TIPS FOR GEMINI (include these in the generated prompt):\n${ctx.geminiTips.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "";
  const userChangeNote = ctx.userChangeRequest
    ? `\nCRITICAL USER CHANGE REQUEST (apply this above all else, even if it contradicts the rules below): ${ctx.userChangeRequest}`
    : "";
  const slideNote = ad._slideContext
    ? `\nCAROUSEL SLIDE CONTEXT — render a SINGLE full-bleed scene (NEVER a 2×2 panel grid). ${ad._slideContext}`
    : "";

  /* If the upstream user-change-request injects "CRITICAL RETRY FIX" copy,
     it overrides this. Otherwise the direction block is the source of truth
     for layout/typography/scene — replaces the old hardcoded split-layout
     section so every ad in a batch can have a different visual language. */
  const directionBlock = direction
    ? `\n\n${formatCreativeDirection(direction)}`
    : "";

  /* Hero-only mode — when the deterministic SVG renderer is active, the
     model paints ONLY the photographic hero scene. All text/logo/CTA/pills
     are rendered downstream in code, so asking the model to draw them too
     would produce duplicate-and-misaligned chaos. Returns a fully different
     prompt focused on scene + negative space. */
  if (ctx.heroOnly) {
    const layoutHint = HERO_NEGATIVE_SPACE_HINT[direction?.panelLayoutType]
      || HERO_NEGATIVE_SPACE_HINT["curved-split-left-text"];
    return `You are a Creative Designer for paid Facebook & Instagram ads.
Write ONE single-line English prompt for OpenAI's image API to generate the HERO PHOTO for a Hebrew RTL Instagram ad. A downstream SVG renderer will paint the brand logo, headline, description, CTA, and 3 feature pills onto the resulting image — your job is to produce a clean photographic background that LEAVES ROOM for those elements without competing with them.

Business: ${ctx.servicesAndDeals}
${colorNote}
${sceneNote}${analysisBlock}${geminiTipsBlock}${userChangeNote}${slideNote}${directionBlock}

═══════ HERO-ONLY MODE — IRON LAWS ═══════
🚫 IRON LAW #1 — NO TEXT IN THE IMAGE: Do NOT render any Hebrew letters, Latin letters, numerals, signs, posters, menus, chalkboards with text, or labeled products. NO headline, NO description, NO CTA button, NO words anywhere in the output. The image is a pure photographic background.
🚫 IRON LAW #2 — LOGO ONLY AS ORGANIC IN-SCENE ELEMENT: The brand logo is provided as a reference SO THAT you can show it where it naturally belongs in the real business — on workers' uniforms, on a shop sign behind the counter, embroidered on an apron, printed on equipment, etched on a glass door, painted on a vehicle. This kind of organic integration is DESIRABLE and elevates the ad's authenticity. STRICTLY FORBIDDEN: any rendered logo OUTSIDE the photographic scene — no logo overlaid on negative space, no logo on a designed card or badge, no large "brand mark + transliteration" graphic block, no logo in a corner watermark, no logo with text appearing in empty canvas areas. The deterministic SVG renderer paints the brand-panel logo separately; if you add a designed logo card the two will collide.
🚫 IRON LAW #3 — NO UI / NO DESIGN ELEMENTS: NO buttons, NO icons, NO feature pills, NO badges, NO scrollbars, NO graphic dividers — none of those exist in the source photo. The output looks like a real photograph, not an Instagram template.
🚫 IRON LAW #4 — NEGATIVE SPACE FOR THE PANEL: ${layoutHint}
🚫 IRON LAW #5 — PHOTOREAL SUBJECT: The output MUST look like a professional photograph shot on a real camera (Getty/Magnum editorial quality). NO cartoon, illustrated, painted, CGI, 3D render, Pixar-style, cel-shaded, plastic skin, anime, vector art, flat-design. Real humans, real places, real light.
🚫 IRON LAW #6 — HUMAN ANATOMY: Every person in frame has EXACTLY 1 head, 1 neck, 2 arms, 2 hands with 5 fingers each, 2 legs, 2 feet. Faces symmetric, natural features. ANY anatomical error = failed ad.
🚫 IRON LAW #7 — KOSHER FOOD ONLY (ISRAELI MARKET): All food and drink shown in the image MUST be kosher. STRICTLY FORBIDDEN: meat + dairy together in any frame, on any plate, on any table, or in any product (no cheeseburger, no meat pizza with cheese, no chicken in cream sauce, no bacon with cheese, no meat lasagna with cheese, no meat sandwich with cheese slice, no carpaccio with parmesan, no milk/yogurt drink served alongside meat). Also forbidden: pork in any form (no bacon, ham, prosciutto, salami with pork, pepperoni, pulled pork), shellfish (no shrimp, lobster, crab, calamari, octopus, mussels), eel, catfish. If a meat dish appears, dairy MUST NOT appear in the same frame; if a dairy dish appears, meat MUST NOT appear in the same frame. When in doubt, render parve (neither meat nor dairy: vegetables, grains, fish with fins+scales, fruit) or pick a clearly-dairy or clearly-meat scene and keep it pure.
═══════════════════════════════════════════

Visual rules:
- Use the brand's color palette as the dominant tonal mood of the photo (soft cream + brand cyan, warm amber + dark charcoal, etc.). The negative-space side of the photo should naturally land in a tone that text in the brand's darkest color will read against (light area for dark text, dark area for light text).
- Lighting: warm key + soft fill, color-graded to harmonize with the brand colors. Deep focus across the subject — no DOF blur.
- Composition: 1:1 square (1024×1024), the subject occupies the side opposite to the panel negative space.
- The viewer should feel they're inside the actual business — shop / clinic / studio / kitchen / showroom — with rich material detail (wood grain, fabric weave, ceramic glaze, skin texture). NOT a smooth plasticky surface anywhere.

Output ONE single-line English prompt, no quotes, no \\n, no extra prose.`;
  }

  /* Contact-info block — only rendered when the manager opted in on
     the characterization form. Phrased as a mandatory render so the
     image model doesn't silently swallow it; we want the actual
     phone/address string to appear on the creative. */
  const contactInfoBlock = (() => {
    const lines = [];
    if (ctx.includePhoneInAds && ctx.businessPhone) {
      lines.push(`CONTACT PHONE — MANDATORY: Display the phone number "${ctx.businessPhone}" prominently on the ad (typically next to the CTA, or as a small footer badge). Use the same clean Hebrew sans-serif as the rest of the copy. The exact digits must render character-by-character — do NOT swap digits, do NOT shorten, do NOT translate to words.`);
    }
    if (ctx.includeAddressInAds && ctx.address) {
      lines.push(`CONTACT ADDRESS — MANDATORY: Display the address "${ctx.address}" prominently on the ad (typically as a small footer line, optionally with a 📍 location-pin icon). Render the Hebrew text verbatim — do NOT translate, do NOT abbreviate.`);
    }
    return lines.length ? `\n\n${lines.join("\n\n")}` : "";
  })();

  return `You are a Creative Designer for paid Facebook & Instagram ads.
Write ONE single-line English prompt for OpenAI's image API to generate a final 1080×1080 Hebrew RTL Instagram ad.

The ad must display the EXACT copy word-for-word:
Headline: "${ad.headline}"
Description: "${ad.description}"
CTA button: "${ad.cta}"
Ad type: ${ad.type}

Design style: ${ctx.designStyle || "modern"}
Services context: ${ctx.servicesAndDeals}
${colorNote}
${logoNote}
${sceneNote}${analysisBlock}${geminiTipsBlock}${userChangeNote}${slideNote}${directionBlock}${contactInfoBlock}

═══════ PREMIUM AD QUALITY BAR ═══════
Target output: a polished agency-level finished creative. Premium commercial advertising quality, strong visual hierarchy, crisp typography, clean spacing, high-end composition, realistic subject, polished lighting, professional branding. NOT a generic AI-image template. The viewer should believe this came from a top Tel Aviv brand studio.

Layout: FOLLOW THE CREATIVE DIRECTION ABOVE EXACTLY. Do NOT default to the same split layout used by every other ad in the batch. The direction's layoutType is the source of truth — if it says "bold typographic poster", build a typographic poster; if it says "center product hero", center the product; if it says "dark premium cinematic", go dark cinematic. Variety across the batch is mandatory.

═══════ HEBREW TEXT — PIXEL-PERFECT RENDERING ═══════
All copy is in HEBREW (right-to-left). The model frequently swaps similar Hebrew letters or invents words — these are the #1 and #2 failure modes.

IRON-CLAD CONTRACT — render ONLY what is written in the source copy above:
• The EXACT character sequence for headline / description / CTA is fixed. Do not add a word. Do not remove a word. Do not substitute a word. Do not "fix" spelling. Do not "improve" wording.
• Each Hebrew letter MUST be a recognizable letter from the standard Hebrew alphabet (א, ב, ג, ד, ה, ו, ז, ח, ט, י, כ, ל, מ, נ, ס, ע, פ, צ, ק, ר, ש, ת + finals ך, ם, ן, ף, ץ). NO invented glyphs. NO half-letters. NO Latin letters inside Hebrew words.
• Do NOT swap similar-looking letters: ב/כ, ד/ר, ה/ח, ו/ז/ן, ם/ס, ע/צ, ש/ם.
• Before drawing each Hebrew word, mentally compare character-by-character to the source. If even ONE character differs — DROP THE ENTIRE WORD and leave a space where it would have gone. Half-rendered or wrong-character Hebrew is far worse than missing text.
• If the rendered string would not be a real Hebrew word found in everyday spoken Hebrew → drop it. Better blank than gibberish.
• Use a CLEAN, MODERN Hebrew sans-serif font (Heebo / Assistant / Rubik style). Bold, high-contrast.
• NO decorative, calligraphic, script, handwritten, distorted, or stylized typography — these break Hebrew character recognition.
• Maintain proper RTL flow: text reads right-to-left, words spaced naturally.
• ALL text elements MUST flow strictly RIGHT-TO-LEFT. Within the left brand panel, headlines and body text are right-aligned to the panel's right inner edge (the edge nearest the subject scene). NEVER render Hebrew text flowing left-to-right under any circumstance.
═══════════════════════════════════════════════════════

IRON LAWS (auto-fail conditions — independent of which layout the direction picks):
- 🚫 IRON LAW #1 — FOLLOW THE DIRECTION: The CREATIVE DIRECTION block above is the single source of truth for layout, scene, color treatment, typography, decorations, dividerShape, and copy weight. Do NOT substitute a generic split-layout or your default template if the direction names a different layoutType. Implement EVERY direction field exactly.
- 🚫 IRON LAW #2 — LOGO + HEBREW TRANSLITERATION TOGETHER: Reproduce the brand logo's EXACT mark and colors from the attached logo reference image, AND render the Hebrew transliteration directly beside or under it (the direction supplies the exact Hebrew text — use it verbatim character-by-character). Pattern examples seen in premium reference ads: "Luna Bake | לונה בייק", "Smile Craft | סמייל קראפט", "PAWS & CO | אהבה. טיפול. משפחה.", "RideOn | רייידאון". A bare Latin logo with NO Hebrew rendering beside it = FAILED. Logo+transliteration appear EXACTLY ONCE as one combined brand mark.
- 🚫 IRON LAW #3 — HEADLINE ACCENT WORD: The direction names ONE specific word from the headline (headlineAccentWord) that MUST receive visual emphasis — either rendered in the brand accent color, OR underlined with a brush-style highlight in the accent color, OR wrapped in a colored highlight shape. The rest of the headline stays in the brand's darkest color. A headline rendered entirely in one flat color with no accent = FAILED.
- 🚫 IRON LAW #4 — INDUSTRY-SPECIFIC DECORATIONS: Scatter the decoration motifs named in the direction (paw prints for pet shops, sparkles for dental, wheat sprigs for bakeries, gear strokes for bike shops, etc.) around the brand panel as small line-art elements in the brand accent color. They are what makes the ad feel native to its industry instead of generic. Empty decoration arrays are allowed only for the most minimalist layouts ("minimal clean SaaS" / "no divider — photo dominant").
- 🚫 IRON LAW #5 — PHOTOREAL SUBJECT: When the direction calls for a photographic subject (person, product, space) it MUST look like a professional photograph (Getty/Magnum editorial quality). STRICTLY FORBIDDEN for the photographic subject: cartoon, illustrated, painted, CGI, 3D render, Pixar-style, cel-shaded, plastic skin, anime, vector art, flat-design avatars. Decorative vector elements (sparkles, line-art icons, badges, brand ornaments — see IRON LAW #4) are allowed alongside a photoreal subject — but the subject itself must be photographic.
- 🚫 IRON LAW #6 — HUMAN ANATOMY: Every person in frame has EXACTLY 1 head, 1 neck, 2 arms, 2 hands with 5 fingers each, 2 legs, 2 feet. Faces symmetric, natural features. NO duplicated body parts, NO floating limbs, NO conjoined figures, NO melted features. ANY anatomical error = failed ad.
- 🚫 IRON LAW #7 — EACH TEXT ELEMENT RENDERS EXACTLY ONCE: The headline appears ONE time. The description appears ONE time (or is omitted entirely if direction.copyWeight is "low"). The CTA button appears ONE time. Each feature-pill label appears ONE time. NEVER duplicate, mirror, repeat, or echo any text element.
- 🚫 IRON LAW #8 — NO HEX CODES OR DESIGN-SPEC ARTIFACTS ON CANVAS: The brand-color hex codes given to you are INSTRUCTIONS for which colors to USE, not content to render. NEVER draw the hex strings (#F4F4F4, etc.), NEVER draw a row of color swatches, NEVER draw a palette legend or design-spec bar anywhere on the canvas.
- 🚫 IRON LAW #9 — KOSHER FOOD ONLY (ISRAELI MARKET): All food and drink shown in the image MUST be kosher. STRICTLY FORBIDDEN: meat + dairy together in any frame, on any plate, on any table, or in any product (no cheeseburger, no meat pizza with cheese, no chicken in cream sauce, no bacon with cheese, no meat lasagna with cheese, no meat sandwich with cheese slice, no carpaccio with parmesan, no milk/yogurt drink served alongside meat). Also forbidden: pork in any form (no bacon, ham, prosciutto, salami with pork, pepperoni, pulled pork), shellfish (no shrimp, lobster, crab, calamari, octopus, mussels), eel, catfish. If a meat dish appears, dairy MUST NOT appear in the same frame; if a dairy dish appears, meat MUST NOT appear in the same frame. When in doubt, render parve (neither meat nor dairy: vegetables, grains, fish with fins+scales, fruit) or pick a clearly-dairy or clearly-meat scene and keep it pure.

Output rules:
- Output ONE single-line English prompt, no quotes, no \\n, no extra prose.

Direction-agnostic constraints (apply regardless of layoutType):
- CTA must be clear and visually distinct (button, badge, or strong typographic treatment per the direction).
- Visual hierarchy: the eye should land on ONE primary element first (usually the headline), then the subject, then the CTA. Avoid competing focal points.
- Do not overcrowd: prefer generous negative space over packed text and decoration.
- NO thin horizontal divider lines as decoration (no <hr> lines, no thin gold rule lines under titles). Use spacing, ornaments, color blocks, or curves for separation.
- Aspirational feel: looks premium and on-brand — like a real campaign from a top Tel Aviv brand studio, not a stock template.

ABSOLUTE LAYOUT CONSTRAINTS:
- The canvas is an EXACT 1:1 square — 1080×1080 only. No portrait or landscape output.
- LOGO + transliteration: TOPMOST PIXEL sits at least 5% below the top edge.
- HEADLINE: the headline is the design's hero — it MAY extend to 2-3% from the inner edge of its enclosing zone (panel inner edge or canvas edge if no panel). Headlines clipped at the edge are a failure; headlines that confidently fill their column to a 2-3% margin are correct. The premium reference ads (KLIQ output) intentionally let the headline crowd the panel edge for visual impact — do the same.
- DESCRIPTION / BODY text: sits at least 5% inset from each enclosing edge.
- CTA button + feature-pill labels: sit at least 6% inset from each canvas edge — these must never crowd the edge.
- No text character may touch or bleed OFF any canvas edge under any circumstance.
- If text doesn't fit — REDUCE FONT SIZE before pushing text toward edges, and never let characters get clipped.

═══════ MATERIAL & DETAIL REINFORCEMENT ═══════
- RICH MATERIAL DETAIL: visible textures (wood grain, fabric weave, metal sheen, ceramic glaze, skin texture). NOT a smooth plasticky surface anywhere on the photographic subject.
- SPECIFIC OVER GENERIC: a particular ceramic vase with morning light catching its rim, NOT "some flowers". A specific brand of polish bottle reflecting the salon light, NOT "skincare products".
- The viewer should be able to scan the subject and discover small detailed objects (a pair of glasses on the counter, a folded towel, a half-burnt candle). Reward repeat viewing.`;
}

/* ────────────────────────────────────────────────────────────────────
   AI HELPERS
   ──────────────────────────────────────────────────────────────────── */

const BUSINESS_ANALYST_SYSTEM = `You are a precision visual marketing analyst. Your output feeds directly into AI image generation — every wrong detail produces a wrong image that fails the client.

You receive: a business profile (services, vehicles, capacity, style) + optional logo + optional reference photos.

YOUR PRIMARY JOB: Read every service detail with surgical precision and translate it into exact visual instructions. Generic tips destroy the ad. Wrong visuals (wrong vehicle, wrong room, wrong scale) make the client look unprofessional.

Return ONLY valid JSON:
{
  "nanoPromptTips": ["...", "...", "..."],
  "geminiTips": ["...", "...", "..."]
}

━━━ SERVICE PRECISION — THE MOST IMPORTANT RULE ━━━
Before writing any tip, extract the EXACT physical details of every service:
- Transport business: What is the EXACT vehicle type? Minibus (8 seats) ≠ bus (50 seats) ≠ sedan ≠ van. If the profile says "minibus for 8 passengers" — tips must say "minibus, approximately 8 seats" and EXPLICITLY PROHIBIT a full-size bus, coach, or minivan unless that is what is described.
- Beauty/wellness: Is it one operator or a full salon? 1 chair or 20? Nail bar or full spa? Be exact.
- Food: Specific dishes? Hummus spot ≠ restaurant ≠ bakery. Name the exact food.
- Retail: What exact products? Small boutique ≠ large store.
- Always ask: what would the image AI default to if given no guidance? THAT is what you must correct with explicit "do NOT show X, show Y instead."

━━━ nanoPromptTips (for the GPT that writes the Gemini prompt) ━━━
Tips that guide SCENE CHOICE and COMPOSITION:
1. The EXACT physical setting: where does this service happen? Describe it precisely.
2. The EXACT subject: what vehicle / space / product / person appears? Be hyper-specific (e.g., "a silver Mercedes Vito minibus, seats ~8 passengers" not "a vehicle").
3. The EXACT wrong visual to avoid: what would the AI default to that is wrong for this business? State it explicitly.
4. The target customer: who is in the scene, what are they doing, what emotion do they show?
5. The unique visual angle: one specific composition or moment that belongs only to this business.

━━━ geminiTips (passed verbatim into the Gemini image generation prompt) ━━━
Tips that control RENDERING QUALITY and ACCURACY:
1. Exact vehicle/product/space specification with size, color, model if known from profile or photos.
2. The scene setting: time of day, location, weather/light that suits this business.
3. The people: who, how many, what they wear, what they are doing — be cinematic and specific.
4. Any unique visual from the reference photos (specific decor color, logo on vehicle, uniform color).
5. What must be EXCLUDED: name the wrong visual explicitly (e.g., "NOT a full-size bus or coach — only a compact minibus").
6. The emotional quality: what should the viewer FEEL looking at this image? Warm? Excited? Reassured?

Rules:
- Minimum 4 tips per list, maximum 6
- Every tip is 100% specific to THIS business — zero generic marketing language
- If reference photos provided: base visual tips on exactly what you see in them
- English only
- The wrong-visual prohibition tip is MANDATORY whenever the AI could default to the wrong scale/type`;

async function analyzeBusinessForAds(brief, logoBuffer, imageBuffers) {
  try {
    const imageContent = [];
    if (logoBuffer) {
      imageContent.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${logoBuffer.toString("base64")}` },
      });
    }
    for (const buf of imageBuffers) {
      imageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
      });
    }
    const textContent = {
      type: "text",
      text: `Business profile:\n${JSON.stringify({
        businessName:    brief.businessName,
        businessField:   brief.businessField,
        businessNiche:   brief.businessNiche,
        about:           brief.about,
        services:        brief.services,
        targetAudience:  brief.targetAudience,
        designStyle:     brief.designStyle,
        preferredColors: brief.preferredColors,
        promotion:       brief.promotion,
      }, null, 2)}`,
    };

    const completion = await chatComplete({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: BUSINESS_ANALYST_SYSTEM },
        { role: "user",   content: [textContent, ...imageContent] },
      ],
    });

    const raw    = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return {
      nanoPromptTips: Array.isArray(parsed.nanoPromptTips) ? parsed.nanoPromptTips.slice(0, 6) : [],
      geminiTips:     Array.isArray(parsed.geminiTips)     ? parsed.geminiTips.slice(0, 6)     : [],
    };
  } catch (err) {
    console.warn("[campaign-brief-quality] analyzeBusinessForAds failed — continuing without tips:", err.message);
    return { nanoPromptTips: [], geminiTips: [] };
  }
}

async function generateNanoPrompt(ad, ctx, direction = null) {
  const completion = await chatComplete({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "You output a single-line English prompt only. No quotes, no newlines, no commentary." },
      { role: "user",   content: buildNanoPromptPrompt(ad, ctx, direction) },
    ],
  });
  return (completion.choices[0]?.message?.content || "").trim().replace(/[\r\n]+/g, " ");
}

/* Resolve a stored asset (proxy URL, full URL, or B2 path) to a Buffer. */
async function fetchAssetBuffer(ref) {
  if (!ref || typeof ref !== "string") return null;
  try {
    // data: URL — decode base64 directly, no HTTP needed
    if (ref.startsWith("data:")) {
      const commaIdx = ref.indexOf(",");
      if (commaIdx === -1) return null;
      return Buffer.from(ref.slice(commaIdx + 1), "base64");
    }
    // Proxy URL like https://.../api/img?url=<b2-path>  → download direct from B2
    const proxyMatch = ref.match(/\/api\/img\?url=([^&]+)/);
    if (proxyMatch) {
      const path = decodeURIComponent(proxyMatch[1]);
      const { buffer } = await backblazeService.downloadImageByPath(path);
      return buffer;
    }
    if (/^https?:\/\//i.test(ref)) {
      const resp = await fetch(ref);
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    }
    // Plain B2 path
    const cleanPath = ref.replace(/^\/+/, "");
    const { buffer } = await backblazeService.downloadImageByPath(cleanPath);
    return buffer;
  } catch (err) {
    console.warn(`[campaign-brief-quality] fetchAssetBuffer failed for ${ref.substring(0, 80)}:`, err.message);
    return null;
  }
}

/**
 * Squareize a model-generated image to AD_SIZE×AD_SIZE.
 *
 * Strategy:
 *   1. Within ±2% of square → simple resize-fill (negligible stretch).
 *   2. Anything else → resize-fit with blurred-extended background. The
 *      generated image fits ENTIRELY inside the canvas (`fit: "inside"`),
 *      preserving every pixel of text/composition. A copy of itself,
 *      enlarged and blurred, fills the surrounding canvas so the result
 *      still reads as full-bleed.
 *
 * Copied verbatim from wow-ads.service.js (renderer-OFF default path).
 */
async function squareizePreservingText(rawBuffer) {
  const meta = await sharp(rawBuffer).metadata();
  const w = meta.width  || AD_SIZE;
  const h = meta.height || AD_SIZE;
  const ratio = w / h;

  /* Already square (within ±2%) — straight fill. */
  if (ratio > 0.98 && ratio < 1.02) {
    return sharp(rawBuffer).resize(AD_SIZE, AD_SIZE, { fit: "fill" }).png().toBuffer();
  }

  /* Off-square — never crop. Fit the whole image inside the canvas
     and synthesize a blurred-enlarged background so the edges still
     feel cinematic instead of dead-white. */
  const background = await sharp(rawBuffer)
    .resize(AD_SIZE, AD_SIZE, { fit: "cover", position: "center" })
    .blur(48)
    .modulate({ brightness: 0.9 })
    .toBuffer();
  const foreground = await sharp(rawBuffer)
    .resize(AD_SIZE, AD_SIZE, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  return sharp(background)
    .composite([{ input: foreground, gravity: "center" }])
    .png()
    .toBuffer();
}

function detectMime(buf) {
  if (!buf || buf.length < 4) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[4] === 0x57) return "image/webp";
  return "image/jpeg";
}

/**
 * Single OpenAI image-generation call. Uses the OpenAI SDK's default
 * timeout (10 minutes). When reference images exist (logo + client photos)
 * we use images.edit; otherwise images.generate.
 */
async function callImageModel({ model, prompt, refs }) {
  const params = {
    model,
    prompt,
    quality: OPENAI_IMAGE_QUALITY,
    size: OPENAI_IMAGE_SIZE,
  };
  const resp = refs.length > 0
    ? await openai.images.edit({ ...params, image: refs })
    : await openai.images.generate(params);
  const b64 = resp?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${model} returned no image data`);
  return Buffer.from(b64, "base64");
}

/**
 * Generate a single 1080×1080 ad image.
 *
 * Model cascade (OpenAI only):
 *   - Primary:  OPENAI_IMAGE_MODEL          (default: gpt-image-2)
 *   - Fallback: OPENAI_FALLBACK_IMAGE_MODEL (default: gpt-image-2)
 *
 * Each model gets up to 3 attempts with backoff before falling through.
 * Logo + client photos are passed as references via openai.images.edit so
 * the model can integrate them naturally into the scene. Logo is added LAST
 * so the prompt's "the last reference image is the brand logo" hint binds.
 *
 * RETURNS a FINALIZED (already squarized AD_SIZE×AD_SIZE) PNG buffer — same
 * behavior as WOW Ads (tryModel runs squareizePreservingText). Callers must
 * NOT squarize again.
 */
async function generateAdImageBuffer(prompt, logoBuffer = null, imageBuffers = []) {
  /* Build the OpenAI File array — client photos first, logo last so the
     prompt's "the last reference image is the brand logo" hint binds. */
  const refs = [];
  for (let i = 0; i < imageBuffers.length; i++) {
    const buf = imageBuffers[i];
    refs.push(await toFile(buf, `ref-${i + 1}.png`, { type: detectMime(buf) }));
  }
  if (logoBuffer) {
    refs.push(await toFile(logoBuffer, "logo.png", { type: detectMime(logoBuffer) }));
  }

  const promptLen = prompt?.length ?? 0;
  const promptHead = (prompt || "").slice(0, 240).replace(/\s+/g, " ");
  const promptTail = promptLen > 480 ? (prompt || "").slice(-200).replace(/\s+/g, " ") : "";
  console.log(`[campaign-brief-quality] prompt size=${promptLen} head="${promptHead}"${promptTail ? ` tail="${promptTail}"` : ""}`);

  const mode = refs.length > 0 ? "EDIT" : "GENERATE";
  const refInfo = refs.length > 0
    ? `${imageBuffers.length} client photo(s)${logoBuffer ? " + logo" : ""}`
    : "text-only";

  /* 3 attempts per model with backoff — transient OpenAI hiccups (slow
     responses, 5xx) recover on retry; the OpenAI SDK's default 10-min
     per-call timeout catches hung calls. */
  async function tryModel(model) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[campaign-brief-quality] ${model} ${mode} (${refInfo}) — attempt ${attempt}`);
        const raw = await callImageModel({ model, prompt, refs });
        return await squareizePreservingText(raw);
      } catch (err) {
        const wait = [800, 2400, 5200][attempt - 1] || 1500;
        console.warn(`[campaign-brief-quality] ${model} attempt ${attempt} failed: ${err.message}`);
        if (attempt >= 3) throw err;
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  /* PRIMARY: Gemini gemini-3-pro-image-preview (client photos + logo as refs);
     the OpenAI gpt-image-2 cascade is the fallback if Gemini errors/has outage. */
  const geminiRefs = [...imageBuffers, ...(logoBuffer ? [logoBuffer] : [])];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[campaign-brief-quality] gemini ${GEMINI_IMG_MODEL} ${mode} (${refInfo}) — attempt ${attempt}`);
      const raw = await geminiGenerateImage(prompt, geminiRefs);
      const buffer = await squareizePreservingText(raw);
      return { buffer, modelUsed: GEMINI_IMG_MODEL, fallbackUsed: false };
    } catch (err) {
      console.warn(`[campaign-brief-quality] gemini attempt ${attempt} failed: ${err.message}`);
      if (attempt >= 3) break;
      await new Promise(r => setTimeout(r, [800, 2400, 5200][attempt - 1] || 1500));
    }
  }
  console.warn(`[campaign-brief-quality] Gemini exhausted — falling back to OpenAI ${OPENAI_IMAGE_MODEL}`);
  try {
    const buffer = await tryModel(OPENAI_IMAGE_MODEL);
    return { buffer, modelUsed: OPENAI_IMAGE_MODEL, fallbackUsed: true };
  } catch (primaryErr) {
    console.warn(`[campaign-brief-quality] OpenAI ${OPENAI_IMAGE_MODEL} exhausted — falling back to ${OPENAI_FALLBACK_IMAGE_MODEL}`);
    const buffer = await tryModel(OPENAI_FALLBACK_IMAGE_MODEL);
    return { buffer, modelUsed: OPENAI_FALLBACK_IMAGE_MODEL, fallbackUsed: true };
  }
}

module.exports = {
  analyzeBusinessForAds,
  generateNanoPrompt,
  generateAdImageBuffer,
  buildNanoPromptPrompt,
  fetchAssetBuffer,
};
