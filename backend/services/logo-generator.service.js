/**
 * Logo Generator — produces a richly-illustrated, square,
 * transparent-background PNG logo via OpenAI gpt-image-1 (the same
 * model ChatGPT uses for image generation). Uploads to Backblaze,
 * returns a public proxy URL.
 *
 * Switched from Gemini to OpenAI in May 2026 because Gemini biased
 * heavily toward minimalist wordmarks even when prompted for rich
 * multi-icon compositions; OpenAI's gpt-image-1 produces the
 * illustration-density target out of the box and renders Hebrew text
 * cleanly inside complex layouts.
 *
 * Two key behaviors:
 *   1. Output PNG has alpha=0 wherever the canvas was white — logo
 *      composites onto any background without a visible white box.
 *   2. The 3 colors the user picks are expanded into a 12-color palette
 *      (tints/shades + analogous hues + midpoint) before being sent so
 *      the result is multi-tone, not 2-color flat.
 *
 * Env:
 *   OpenAI_API_KEY        (already set — same as ads pipeline)
 *   OPENAI_IMAGE_MODEL    (optional override, default gpt-image-1)
 */
const { OpenAI } = require("openai");
const sharp = require("sharp");

const backblazeService = require("./backblaze.service");
const { uploadImage } = backblazeService;

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
/* Logos run on gpt-image-2 because its Hebrew letter rendering is
   noticeably more accurate than gpt-image-1 (gpt-image-1 was dropping
   characters and swapping ב/כ, ד/ר, etc. on wordmark text). The trade-
   off: gpt-image-2 does NOT support `background: "transparent"` — it
   returns 400 "Transparent background is not supported for this model".
   So we request the white background the prompt already demands and
   then run `makeBackgroundTransparent` to strip the white pixels in
   post-process — see generateLogoImage. */
/* Pin to the versioned snapshot (gpt-image-2-2026-04-21) rather than the
   floating "gpt-image-2" alias — the alias has historically resolved to
   different snapshots and we've been bitten by silent capability changes.
   The versioned name is the one we've measured Hebrew rendering against. */
const OPENAI_IMAGE_MODEL = process.env.OPENAI_LOGO_MODEL || "gpt-image-2-2026-04-21";
// Gemini (gemini-3-pro-image-preview) is PRIMARY for logos too; OpenAI is fallback.
const { generateImageBuffer: geminiGenerateImage, GEMINI_IMAGE_MODEL: GEMINI_IMG_MODEL } = require("./gemini-image-gen.service");

const STYLE_DIRECTION = {
  minimal:  "modern flat-vector branding — bold sans-serif wordmark in a single dark neutral color, one clean iconic shape in the primary brand color, generous negative space",
  modern:   "modern professional branding — bold sans-serif wordmark paired with ONE clean, memorable iconic mark; restrained corporate look, generous negative space",
  elegant:  "elegant luxury branding — refined lettering with ONE delicate thematic mark; understated, premium, restrained",
  playful:  "friendly rounded branding — soft rounded wordmark with ONE simple charming icon; clean and uncluttered",
  bold:     "bold high-contrast branding — thick condensed wordmark with ONE strong geometric mark; confident but restrained",
  monogram: "tight monogram of the initials inside one clean geometric badge; minimal, professional",
};

/* ── Color theory helpers ──────────────────────────────────────────── */

function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
function rgbToHex({ r, g, b }) {
  const t = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + t(r) + t(g) + t(b);
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}
function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if      (h <  60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/**
 * Expand 3 user-picked colors into a richer 12-color palette of visually
 * distinct shades, NOT just tints/shades of the same hue (which blend
 * together and read as the same color in the final logo). For each seed
 * we keep the original, plus a 25%-lighter tint, plus a 25%-darker shade.
 * Then we also derive analogous hues from the primary + secondary
 * (±28° hue shift) so OpenAI has genuinely different colors to mix in.
 * Result: a richer palette that produces multi-tone logos instead of
 * flat 2-color wordmarks.
 *
 * Falls back to the seeds alone if any input is malformed.
 */
function expandPalette(seeds) {
  const safe = (Array.isArray(seeds) ? seeds : []).filter(Boolean);
  if (safe.length === 0) return ["#1E3A8A", "#06B6D4", "#F59E0B"];
  const out = new Set();

  /* Each seed → original + tint + shade (3 each, for vertical contrast). */
  for (const hex of safe) {
    const rgb = hexToRgb(hex);
    if (!rgb) { out.add(hex); continue; }
    const hsl = rgbToHsl(rgb);
    out.add(rgbToHex(rgb));
    out.add(rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: Math.min(0.92, hsl.l + 0.25) })));
    out.add(rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: Math.max(0.08, hsl.l - 0.25) })));
  }

  /* Analogous-hue pulls on the first two seeds — these are visually
     DIFFERENT colors (not just brightness variations) so the final logo
     reads as multi-color instead of 3-tones-of-blue. */
  for (const hex of safe.slice(0, 2)) {
    const rgb = hexToRgb(hex);
    if (!rgb) continue;
    const hsl = rgbToHsl(rgb);
    out.add(rgbToHex(hslToRgb({ h: (hsl.h + 28) % 360, s: hsl.s, l: hsl.l })));
    out.add(rgbToHex(hslToRgb({ h: (hsl.h + 332) % 360, s: hsl.s, l: hsl.l })));
  }

  /* Midpoint between primary and secondary — bridges the gap so the
     transition between dominant brand colors looks intentional. */
  if (safe.length >= 2) {
    const a = hexToRgb(safe[0]);
    const b = hexToRgb(safe[1]);
    if (a && b) {
      out.add(rgbToHex({
        r: (a.r + b.r) / 2, g: (a.g + b.g) / 2, b: (a.b + b.b) / 2,
      }));
    }
  }
  return [...out];
}

function buildLogoPrompt({ businessName, tagline, style, colors, businessField, businessNiche, about }) {
  const styleHint = STYLE_DIRECTION[style] || STYLE_DIRECTION.modern;
  const palette = expandPalette(colors);
  const [primary, secondary, accent] = colors || [];
  const tag = tagline ? `Tagline below in much smaller weight: "${tagline}".` : "";
  const fieldHint = businessField
    ? `Business field/industry: "${businessField}". Choose ONE thematic iconic mark that visually represents this industry (e.g. travel → globe or airplane; restaurant → plate or chef hat; gym → dumbbell; hair salon → scissors or elegant hair silhouette; tech → circuit or arrow). ONE icon only — placed above or beside the wordmark, like a real corporate logo.`
    : `Choose ONE clean thematic iconic mark placed above or beside the wordmark — like a real corporate logo, not an illustrated scene.`;
  /* "About" block — anchors the icon choices to what the business actually
     does, not just its broad industry. Without this the model defaults to
     generic field tropes (every "אינסטלציה" gets the same wrench+pipe combo
     even if the niche is "תיקון דחוף 24/7" vs "התקנת מערכות יוקרה"). */
  const nicheLine = businessNiche ? `Specific niche: "${businessNiche}".` : "";
  const aboutBlock = about
    ? `BUSINESS CONTEXT (highest priority for icon selection): "${about}". ${nicheLine} Choose the single iconic mark specifically to mirror what THIS business does — derive it from the actual services / customers / setting described above, not from generic industry stereotypes. If it mentions a specific customer (e.g. "luxury homes"), the visual mood should match (premium shapes, not utilitarian).`
    : (businessNiche ? `Specific niche: "${businessNiche}". Tailor the icon choice to this niche, not just the broad industry.` : "");
  /* Hebrew wordmark accuracy block — copied from the wow-ads pipeline
     where the same model historically dropped/swapped letters on Hebrew
     copy (e.g. "אדיר טורס" rendered as "אירמורס"). Pinning the exact
     character sequence and banning similar-looking letter swaps is what
     stops the model from "creatively" cleaning up the word. */
  const isHebrewName = /[֐-׿]/.test(businessName);
  const hebrewLockBlock = isHebrewName
    ? `HEBREW WORDMARK — PIXEL-PERFECT RENDERING (HIGHEST PRIORITY, OVERRIDES EVERY OTHER VISUAL CHOICE):
The wordmark MUST read EXACTLY "${businessName}" character-by-character. Count the letters in the source — your output must have the same count, in the same order, with each character one of the standard Hebrew letters: א ב ג ד ה ו ז ח ט י כ ל מ נ ס ע פ צ ק ר ש ת + finals ך ם ן ף ץ. Spaces between words in the source MUST be preserved as visible word gaps in the wordmark.
NEVER swap similar Hebrew letters: ב↔כ, ד↔ר, ה↔ח, ו↔ז↔ן, ם↔ס, ע↔צ, ש↔ם.
NEVER add letters, NEVER drop letters, NEVER merge two words into one, NEVER split one word into two.
Use a CLEAN MODERN Hebrew sans-serif (Heebo / Assistant / Rubik / Ploni style). Bold weight, high-contrast. NO decorative, calligraphic, script, handwritten, distorted, or stylized typography — those break Hebrew character recognition.
Before drawing each letter, mentally compare it to the source character-by-character. If you cannot render a specific letter cleanly, redo the whole word — DO NOT ship half-rendered or substituted letters.`
    : "";
  return [
    `Design a clean, professional, minimal vector-style brand LOGO isolated on a PURE WHITE #FFFFFF square canvas.`,
    `The white background MUST be 100% pure flat white — NO patterns, NO gradients in the background, NO drop shadows, NO frame, NO mockup container — because we will programmatically remove the white pixels and use the logo on transparent backgrounds.`,
    `Wordmark text reads exactly "${businessName}". ${tag}`,
    hebrewLockBlock,
    styleHint + ".",
    fieldHint,
    aboutBlock,
    `Wordmark treatment: the wordmark must be FLAT single-color letters (or at most one subtle two-tone gradient applied uniformly to the WHOLE wordmark) — never different colors per letter, never rainbow lettering. Use the primary brand color or a dark neutral (charcoal/near-black) for maximum legibility.`,
    `RESTRAINED PALETTE (STRICT): use ONLY these brand colors — primary ${primary || palette[0]} (dominant, ~60-70% of colored areas), secondary ${secondary || palette[1]} (support, ~20-30%), accent ${accent || palette[2] || palette[1]} (small highlight ONLY, under 10%). Plus optionally one dark neutral for text. NOTHING ELSE.`,
    `A logo that uses more than these 3 brand colors + one neutral is REJECTED. No rainbow effects, no multi-color gradients across elements, no extra decorative colors. Professional corporate restraint — think Nike / Airbnb / Wolt level of color discipline.`,
    `NO decorative scatter: no stars/dots/leaves sprinkles, no dashed paths, no sun-ray fans, no swoosh collections. At most ONE subtle underline or geometric accent if the composition truly needs it.`,
    "Centered composition, generous padding inside the square, no photographic elements, no decorative background, no shadows. Vector flat-illustration style throughout (no realism, no 3D rendering).",
    "The logo must be the only graphic on the canvas. Do not add slogans, sample text, mockup frames, screenshots, or social-media containers.",
    "High resolution, crisp edges, looks great when shrunk to favicon size.",
  ].join(" ");
}

/**
 * Strip white background to alpha. Used by every logo run on the
 * gpt-image-2 path (which doesn't support `background: "transparent"`
 * natively, so the model returns the white background we prompted for
 * and we remove the white pixels here).
 *   - Pixels with R+G+B all > 245 → fully transparent
 *   - Pixels with R+G+B all > 225 → partially transparent (soft edge
 *     anti-aliasing, prevents visible white halo)
 * Logos with intentional white *inside* the design will lose those areas
 * — that's an acceptable tradeoff for "no background box" since true
 * inside-white is very rare in modern flat marks.
 */
async function makeBackgroundTransparent(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    const minChannel = Math.min(r, g, b);
    if (minChannel > 245) {
      out[i + 3] = 0;
    } else if (minChannel > 225) {
      /* Soft edge — fade alpha proportionally over the 225-245 band so
         anti-aliased edges blend into transparent backgrounds. */
      out[i + 3] = Math.round(((245 - minChannel) / 20) * 255);
    }
  }
  return sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer();
}

/**
 * Quality tradeoff:
 *   "high"   ≈ 25-40s per call — sharper edges, denser composition,
 *             better Hebrew letterforms
 *   "medium" ≈ 10-18s per call — comfortable headroom under Heroku's
 *             30s router timeout
 *   "low"    ≈ 6-10s, lower fidelity
 *
 * Default is "high" — the logo flow runs through the AWS box (no 30s
 * timeout) and the manager-facing UX wants the best logo on the first
 * try. Override via OPENAI_IMAGE_QUALITY=medium if running behind a
 * proxy that enforces shorter timeouts.
 */
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "high";

async function generateLogoImage(prompt) {
  /* PRIMARY: Gemini gemini-3-pro-image-preview. The prompt asks for a pure
     white background; we strip it to alpha in post (makeBackgroundTransparent)
     exactly as the OpenAI path does. On any Gemini error → OpenAI fallback. */
  try {
    const raw = await geminiGenerateImage(prompt, []);
    const normalized = await sharp(raw).resize(1024, 1024, { fit: "cover", position: "center" }).png().toBuffer();
    return makeBackgroundTransparent(normalized);
  } catch (gErr) {
    console.warn(`[logo] gemini ${GEMINI_IMG_MODEL} failed: ${gErr.message} — falling back to OpenAI ${OPENAI_IMAGE_MODEL}`);
    return generateLogoImageOpenAI(prompt, 1);
  }
}

async function generateLogoImageOpenAI(prompt, attempt = 1) {
  try {
    /* gpt-image-2 returns the logo on the pure white background we
       prompted for — it does not support `background: "transparent"`
       (400 from the API). We strip the white pixels in post-process via
       makeBackgroundTransparent: pixels with min(R,G,B) > 245 → fully
       transparent, 225-245 → soft alpha fade for clean anti-aliased
       edges. Intentional white *inside* the design (rare on modern flat
       marks) becomes transparent too — acceptable tradeoff for "no
       background box". */
    const resp = await openai.images.generate({
      model:   OPENAI_IMAGE_MODEL,
      prompt,
      n:       1,
      size:    "1024x1024",
      quality: OPENAI_IMAGE_QUALITY,
    });
    const b64 = resp?.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI returned no image data");
    const raw = Buffer.from(b64, "base64");
    /* Normalize to 1024x1024, then strip white background to alpha. */
    const normalized = await sharp(raw).resize(1024, 1024, { fit: "cover", position: "center" }).png().toBuffer();
    return makeBackgroundTransparent(normalized);
  } catch (err) {
    /* Surface OpenAI errors per attempt — without this an image API
       rejection (rate limit, content policy, model unavailable) was
       silent and the front-end timeout was the only signal we had
       that anything went wrong. */
    const apiErr = err?.response?.data?.error || err?.error;
    console.warn(`[logo] gpt-image attempt ${attempt} failed:`, apiErr ? JSON.stringify(apiErr) : err.message);
    if (attempt >= 3) throw err;
    await new Promise(r => setTimeout(r, [500, 2000][attempt - 1] || 1000));
    return generateLogoImageOpenAI(prompt, attempt + 1);
  }
}

/**
 * High-level: build prompt → generate image → upload → return proxy URL.
 *
 * @param {object} opts
 * @param {string} opts.phone         Client phone (used for B2 path partition)
 * @param {string} opts.businessName  Wordmark text
 * @param {string} [opts.tagline]     Optional sub-text
 * @param {string} [opts.style]       minimal | modern | elegant | playful | bold | monogram
 * @param {string[]} [opts.colors]    [primary, secondary, accent] — server expands to 9 tones
 * @returns {Promise<{ url: string, prompt: string, palette: string[] }>}
 */
async function generateLogoForClient({ phone, businessName, tagline, style, colors, businessField, businessNiche, about }) {
  if (!businessName || !businessName.trim()) {
    throw new Error("businessName required");
  }
  const prompt = buildLogoPrompt({ businessName: businessName.trim(), tagline, style, colors, businessField, businessNiche, about });
  const buf = await generateLogoImage(prompt);
  const fullPath = `client-logos/${phone}/logo_${Date.now()}.png`;
  await uploadImage(fullPath, buf, "image/png");
  const url = `/api/img?url=${encodeURIComponent(fullPath)}`;
  return { url, prompt, palette: expandPalette(colors) };
}

module.exports = { generateLogoForClient, expandPalette };
