/**
 * Ads Service — מייצר סט מודעות שיווקיות
 * Flow:
 * 1. buildPrompt1 → OpenAI → 10 טקסטי מודעות (JSON)
 * 2. generateCampaignStyle → campaign visual guide אחד לכל הקמפיין (cohesion)
 * 3. buildPrompt2 → OpenAI → nano prompt לכל מודעה (עם campaign style)
 * 4. Gemini Image → תמונה 1080x1080 לכל מודעה
 * 5. overlayLogo → sharp composites הלוגו האמיתי על כל מודעה (תמיד)
 * פנים של בעל עסק: ב-4 מתוך 10 מודעות (indices 3,5,7,9)
 */
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");
const sharp = require("sharp");
const { DB } = require("../../config/db");
const backblazeService = require("../backblaze.service");
const { formatBrandPalette, brandColorList } = require("../../utils/brand-palette");
const sessionService = require("./session.service");

const ADS_COL = "wow_ads";

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
const gemini = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';

// Indices (0-based) that will include the business owner's face
const FACE_AD_INDICES = new Set([3, 5, 7, 9]);

// ─── Prompt 1: 10 ad texts ────────────────────────────────────────────────

function buildPrompt1(input) {
  return `
תפקידך:
אתה קופירייטר לקמפיינים ממומנים בפייסבוק ובאינסטגרם.

אתה לא משרד פרסום.
אתה נשמע כמו בן אדם אמיתי.

המטרה שלך היא אחת:
לעצור גלילה במשפט פשוט שבעל העסק באמת היה אומר.

📥 נתונים להזנה:
איפיון עסק:
${input.businessProfileShort}

שירותים ומבצעים:
${input.servicesAndDeals}

🎯 המשימה:
ליצור 10 מללים קצרים למודעות.

🧱 מבנה קבוע לכל מודעה (חובה):
החזר מערך JSON בלבד של 10 אובייקטים, במבנה הבא:

{
"id": 1,
"type": "regular",
"headline": "",
"description": "",
"cta": ""
}

❗ פלט:
JSON תקני בלבד
בלי הסברים
בלי Markdown
`.trim();
}

// ─── Generate campaign visual style guide (once, applied to all ads) ──────

const generateCampaignStyle = async (brief) => {
  const colors = brief.preferredColors?.primary
    ? formatBrandPalette(brief.preferredColors)
    : 'brand-appropriate colors';

  const prompt = `You are an art director creating a 10-ad campaign for a ${brief.businessField} business called "${brief.businessName}".
Design style: ${brief.designStyle || 'modern'}
Brand colors: ${colors}
Target audience: ${brief.targetAudience?.join(', ') || 'general'}

Describe a CONSISTENT visual language for all 10 Instagram/Facebook ads (1080x1080 square).
In 3–5 sentences cover: background treatment, how to apply the brand colors, layout grid (where logo/headline/CTA appear), typography mood, and photography/illustration style.
This description will be included in EVERY ad image prompt to enforce visual cohesion across the campaign.
Return ONLY the visual language description — no intro, no bullets, no commentary.`;

  try {
    const r = await openai.responses.create({ model: OPENAI_MODEL, input: prompt });
    const text = (r.output_text || '').trim();
    if (text.length > 60) {
      console.log(`✦ [AdsStyle] Campaign style generated (${text.length} chars)`);
      return text;
    }
  } catch (err) {
    console.warn('[AdsStyle] Failed:', err instanceof Error ? err.message : String(err));
  }

  // Fallback: build a style from the brief data
  const primary = brief.preferredColors?.primary || '#1a1a1a';
  const accent = brief.preferredColors?.accent || '#c9a843';
  return `All 10 ads share a cohesive ${brief.designStyle || 'modern'} visual identity. Background uses a deep ${primary} tone with subtle texture or gradient. The brand accent color ${accent} highlights headlines and CTA buttons. Layout follows a consistent grid: brand logo pinned top-right, bold Hebrew headline centered in the upper third, supporting text below, and a prominent CTA button at the bottom. Photography is clean, professional, and emotionally warm.`;
};

// ─── Prompt 2: nano image prompt per ad (includes campaign style) ─────────

function buildPrompt2(input) {
  return `
You are a Creative Designer for paid Facebook & Instagram ads.
Write ONE single-line English prompt for Gemini Image to generate a final 1080x1080 Hebrew RTL Instagram ad.

MANDATORY LOGO RULE: A brand logo image is provided. The Gemini prompt you write MUST start with:
"Place the provided brand logo clearly and prominently in the top area of this design, without distortion."

The ad must display the exact copy word-for-word:
Headline: ${input.ad.headline}
Description: ${input.ad.description}
CTA: ${input.ad.cta}
Type: ${input.ad.type}

CAMPAIGN VISUAL DIRECTION — apply to every ad for cohesion:
${input.campaignStyle}

Services context: ${input.servicesAndDeals}
${input.colors ? `Brand colors: ${input.colors} — apply as described in the campaign direction` : ''}
${input.photoDesc ? `Scene reference: ${input.photoDesc} — use as the main visual background/context for this ad` : ''}
${input.hasFace ? `Business owner integration: A photo of the business owner is provided separately. FIRST design the full ad composition (background, colors, text layout, CTA). THEN naturally place the business owner within the scene — not as a floating portrait, but as an active participant in the visual story (e.g., presenting a product, working, welcoming clients).` : ''}

Rules:
- Output: ONE single-line Gemini prompt starting with the logo placement instruction
- No extra words beyond the provided ad copy
- RTL Hebrew layout, clear visual hierarchy, mobile readable
- Commercial quality, sharp and vivid
${input.userChangeRequest ? `\nCRITICAL USER CHANGE REQUEST (apply this above all else): ${input.userChangeRequest}` : ''}
`.trim();
}

// ─── GPT-4o Vision: analyze client photo for ad context ───────────────────

const analyzePhotoForAd = async (photoBuffer, businessField, businessName) => {
  const b64 = photoBuffer.toString('base64');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } },
        { type: 'text', text: `This photo belongs to a "${businessField}" business called "${businessName}". In ONE concise English sentence: what is shown in this photo and how should it be featured in a social media ad? Be specific about the visual content.` },
      ],
    }],
    max_tokens: 80,
  });
  return (response.choices[0]?.message?.content || '').replace(/\n/g, ' ').trim();
};

// ─── Generate Nano Prompt via OpenAI ──────────────────────────────────────

const generateNanoPrompt = async (prompt) => {
  const r = await openai.responses.create({ model: OPENAI_MODEL, input: prompt });
  return (r.output_text || '').replace(/\s+/g, ' ').trim();
};

// ─── Hard-composite the real logo onto an ad image with sharp ─────────────
// This guarantees the exact logo is ALWAYS present in the final ad,
// regardless of what Gemini generated.

const overlayLogo = async (adBuffer, logoBuffer) => {
  const AD_SIZE = 1080;
  const MAX_LOGO_W = 200;  // logo max width
  const PADDING = 24;      // from edges

  try {
    const logoResized = await sharp(logoBuffer)
      .resize(MAX_LOGO_W, undefined, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    const { width: lw = MAX_LOGO_W } = await sharp(logoResized).metadata();

    return sharp(adBuffer)
      .resize(AD_SIZE, AD_SIZE, { fit: 'cover' })
      .composite([{
        input: logoResized,
        top: PADDING,
        left: AD_SIZE - lw - PADDING,  // top-right corner (RTL convention)
      }])
      .png()
      .toBuffer();
  } catch (err) {
    console.warn('[AdsLogo] Overlay failed:', err instanceof Error ? err.message : String(err));
    return adBuffer;  // fallback: return original
  }
};

// ─── Overlay Hebrew text on ad image via SVG → Sharp composite ──────────
// Renders headline + CTA as crisp SVG text (proper RTL), composited on top.

const overlayText = async (adBuffer, ad, colors) => {
  const AD_SIZE = 1080;
  const headline = ad.headline || "";
  const cta = ad.cta || "";
  const desc = ad.description || "";
  if (!headline && !cta) return adBuffer;

  const primary = (colors && colors.primary) || "#ffffff";
  const accent = (colors && colors.accent) || "#c9a843";

  // Escape XML entities
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Build SVG overlay with RTL text
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AD_SIZE}" height="${AD_SIZE}" direction="rtl">
  <defs>
    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.7"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="botFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.75"/>
    </linearGradient>
  </defs>
  <!-- Top gradient for headline readability -->
  <rect x="0" y="0" width="${AD_SIZE}" height="380" fill="url(#topFade)"/>
  <!-- Bottom gradient for CTA -->
  <rect x="0" y="${AD_SIZE - 350}" width="${AD_SIZE}" height="350" fill="url(#botFade)"/>
  <!-- Headline -->
  <text x="${AD_SIZE / 2}" y="180" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="72" fill="white" direction="rtl" unicode-bidi="bidi-override">
    ${esc(headline.length > 30 ? headline.slice(0, 30) + "…" : headline)}
  </text>
  ${desc ? `<text x="${AD_SIZE / 2}" y="260" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="400" font-size="36" fill="rgba(255,255,255,0.9)" direction="rtl" unicode-bidi="bidi-override">
    ${esc(desc.length > 50 ? desc.slice(0, 50) + "…" : desc)}
  </text>` : ""}
  <!-- CTA button -->
  ${cta ? `<rect x="${(AD_SIZE - 400) / 2}" y="${AD_SIZE - 160}" width="400" height="80" rx="40" fill="${esc(accent)}"/>
  <text x="${AD_SIZE / 2}" y="${AD_SIZE - 108}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="36" fill="white" direction="rtl" unicode-bidi="bidi-override">
    ${esc(cta)}
  </text>` : ""}
</svg>`;

  try {
    const svgBuffer = Buffer.from(svg);
    return sharp(adBuffer)
      .resize(AD_SIZE, AD_SIZE, { fit: "cover" })
      .composite([{ input: svgBuffer, top: 0, left: 0 }])
      .png()
      .toBuffer();
  } catch (err) {
    console.warn("[AdsText] Overlay failed:", err instanceof Error ? err.message : String(err));
    return adBuffer;
  }
};

// ─── Generate Ad Image via Gemini ─────────────────────────────────────────
// Parts order: logo (brand identity) → face (person) → scene (context) → prompt

const generateAdImageBuffer = async (prompt, logoBuffer, sceneBuffer, faceBuffer) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const imageParts = [];
  if (logoBuffer) {
    imageParts.push({ inlineData: { mimeType: 'image/png', data: logoBuffer.toString('base64') } });
  }
  if (faceBuffer) {
    // Face before scene so Gemini anchors the person identity first
    imageParts.push({ inlineData: { mimeType: 'image/jpeg', data: faceBuffer.toString('base64') } });
  }
  if (sceneBuffer) {
    imageParts.push({ inlineData: { mimeType: 'image/jpeg', data: sceneBuffer.toString('base64') } });
  }

  const contents = imageParts.length > 0
    ? [{ role: 'user', parts: [...imageParts, { text: prompt }] }]
    : prompt;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await gemini.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents,
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          return Buffer.from(part.inlineData.data, 'base64');
        }
      }
      throw new Error('Gemini did not return image data');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[NanoBanana] attempt ${attempt}/3 failed: ${msg}`);
      if (attempt === 3) throw err;
      await sleep(500 * attempt * attempt);
    }
  }
  throw new Error('Unreachable');
};

// ─── Generate 10 ad texts ─────────────────────────────────────────────────

const generateAdsJson = async (prompt) => {
  const r = await openai.responses.create({ model: OPENAI_MODEL, input: prompt });

  let text = (r.output_text || '').trim();
  text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/m, '').trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) text = jsonMatch[0];

  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Prompt1 did not return valid JSON: ' + text.substring(0, 100)); }

  let ads = [];
  if (Array.isArray(data)) {
    ads = data;
  } else if (typeof data === 'object' && data !== null) {
    const obj = data;
    for (const key of ['ads', 'items', 'generatedAds', 'results', ...Object.keys(obj)]) {
      if (Array.isArray(obj[key])) { ads = obj[key]; break; }
    }
    if (ads.length === 0 && obj.headline) {
      ads = [obj];
    }
  }
  if (ads.length > 0 && ads.length < 10) {
    console.log(`[AdsJSON] Got ${ads.length} ads (expected 10)`);
  }
  return ads.slice(0, 10);
};

// ─── Save/Load ads data in Mongo ──────────────────────────────────────────

const saveAdsJson = async (sessionId, data) => {
  await DB.collection(ADS_COL).updateOne(
    { sessionId },
    { $set: { sessionId, ...data, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
};

const loadAdsJson = async (sessionId) => {
  const doc = await DB.collection(ADS_COL).findOne({ sessionId });
  return doc || null;
};

// ─── Helper: resolve a brief-stored asset URL to a buffer ─────────────────
// In the ported codebase, brief.logo / brief.photos / brief.facePhoto are
// either public URLs (Backblaze publicUrl) or legacy relative paths.
// For URLs, fetch via HTTP. For Backblaze-style "wow/..." paths, use download API.

const fetchAssetBuffer = async (ref) => {
  if (!ref) return null;
  try {
    if (/^https?:\/\//i.test(ref)) {
      const resp = await fetch(ref);
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    }
    // Backblaze path — strip leading slash if present
    const cleanPath = ref.replace(/^\/+/, '');
    const { buffer } = await backblazeService.downloadImageByPath(cleanPath);
    return buffer;
  } catch (err) {
    console.warn(`[Ads] fetchAssetBuffer failed for ${ref}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
};

// ─── Full Pipeline ─────────────────────────────────────────────────────────

const runAdsPipeline = async (sessionId, brief, onProgress) => {
  const log = (msg) => { console.log(`✦ [AdsPipeline] ${msg}`); onProgress?.(msg); };

  try {
    const session = await sessionService.getSession(sessionId);
    session.edits = session.edits || { texts: {}, images: {}, colors: {}, links: {}, hiddenSections: [] };
    session.edits.adsStatus = 'generating';
    await sessionService.updateSession(sessionId, { edits: session.edits });

    const fixHebrew = (s) => {
      if (!s || typeof s !== 'string') return s;
      if (s.includes('?????') || s.includes('????')) {
        try { return Buffer.from(s, 'latin1').toString('utf8'); } catch { return s; }
      }
      return s;
    };

    const services = fixHebrew(brief.services);
    const promotion = fixHebrew(brief.promotion || '');
    const about = fixHebrew(brief.about);
    const niche = fixHebrew(brief.businessNiche || '');
    const field = fixHebrew(brief.businessField);

    const businessProfileShort = `
Business Name: ${brief.businessName}
Field: ${field}${niche ? ` — ${niche}` : ''}
About: ${about}
Audience: ${brief.targetAudience?.join(', ') || 'general'}
Main Benefit: ${niche || about.substring(0, 80)}
Tone: professional
Platforms: Facebook + Instagram
${promotion ? `Promotion: ${promotion}` : ''}
`.trim();

    const servicesAndDeals = `Services:\n${services}\n\n${promotion ? `Deal/Price: ${promotion}` : 'No current deal'}`.trim();
    const figmaStyleHint = brief.designStyle || 'modern';
    const colors = brief.preferredColors?.primary
      ? brandColorList(brief.preferredColors).join(", ")
      : '';

    // Step 1: Generate 10 ad texts
    log('שלב 1: מייצר 10 טקסטי מודעות...');
    const p1 = buildPrompt1({ businessProfileShort, servicesAndDeals });
    const ads = await generateAdsJson(p1);
    log(`${ads.length} מודעות טקסט ✓`);

    // Step 2: Generate campaign style guide (once — for cohesion across all ads)
    log('שלב 2: מייצר campaign style guide לקוהזיה...');
    const campaignStyle = await generateCampaignStyle(brief);
    log(`Campaign style ✓: "${campaignStyle.substring(0, 80)}..."`);

    // Step 3: Load visual assets
    log('שלב 3: טוען נכסים ויזואליים (לוגו, תמונות, פנים)...');

    let logoBuffer = null;
    if (brief.logo) {
      logoBuffer = await fetchAssetBuffer(brief.logo);
      log(logoBuffer ? `לוגו נטען ✓ (${(logoBuffer.length / 1024).toFixed(0)}KB)` : '⚠️ לוגו לא נמצא');
    } else {
      log('אין לוגו — ממשיך ללא שכבת לוגו');
    }

    const photoBuffers = [];
    for (const photoUrl of (brief.photos || []).slice(0, 5)) {
      const buf = await fetchAssetBuffer(photoUrl);
      if (buf) { photoBuffers.push(buf); log(`תמונת לקוח נטענה ✓ (${(buf.length / 1024).toFixed(0)}KB)`); }
    }
    log(`${photoBuffers.length} תמונות לקוח זמינות`);

    let faceBuffer = null;
    if (brief.facePhoto) {
      faceBuffer = await fetchAssetBuffer(brief.facePhoto);
      log(faceBuffer ? `פנים בעל עסק נטענו ✓ — יוצג ב-${FACE_AD_INDICES.size} מודעות (${[...FACE_AD_INDICES].map(i => i + 1).join(',')})` : '⚠️ תמונת פנים לא נמצאה');
    }

    // Step 4: GPT-4o Vision — analyze each client photo once
    const photoDescs = [];
    if (photoBuffers.length > 0) {
      log('שלב 4: מנתח תמונות לקוח עם GPT-4o Vision...');
      for (let pi = 0; pi < photoBuffers.length; pi++) {
        try {
          const desc = await analyzePhotoForAd(photoBuffers[pi], field, brief.businessName);
          photoDescs.push(desc);
          log(`Vision תמונה ${pi + 1}: "${desc.substring(0, 70)}..."`);
        } catch (vErr) {
          const msg = vErr instanceof Error ? vErr.message : String(vErr);
          log(`Vision תמונה ${pi + 1} נכשלה: ${msg}`);
          photoDescs.push('');
        }
      }
    }

    // Step 5: Generate nano prompts (sequential)
    log('שלב 5: מייצר nano prompts לתמונות...');
    const nanoPrompts = [];
    for (let i = 0; i < ads.length; i++) {
      const ad = ads[i];
      const hasFace = FACE_AD_INDICES.has(i) && faceBuffer !== null;
      const hasPhoto = photoBuffers.length > 0;
      const photoIdx = i % Math.max(photoBuffers.length, 1);
      const photoDesc = hasPhoto ? photoDescs[photoIdx] : undefined;

      const p2 = buildPrompt2({
        ad,
        servicesAndDeals,
        figmaStyleHint,
        campaignStyle,
        colors,
        hasLogo: logoBuffer !== null,
        photoDesc,
        hasFace,
      });
      const nano = await generateNanoPrompt(p2);
      nanoPrompts.push(nano);
      const mode = hasFace ? '✦ פנים+scene' : hasPhoto ? 'scene only' : 'design only';
      log(`Prompt ${i + 1}/10 ✓ (${mode})`);
    }

    // Step 6: Gemini → 10 ad images (sequential)
    log('שלב 6: מייצר 10 תמונות מודעות עם Gemini...');

    const generatedAds = [];

    for (let i = 0; i < ads.length; i++) {
      const ad = ads[i];
      const nanoPrompt = nanoPrompts[i];
      const hasFace = FACE_AD_INDICES.has(i) && faceBuffer !== null;
      const hasPhoto = photoBuffers.length > 0;
      const photoIdx = i % Math.max(photoBuffers.length, 1);
      const sceneBuffer = hasPhoto ? photoBuffers[photoIdx] : null;
      const faceRef = hasFace ? faceBuffer : null;

      try {
        log(`מודעה ${i + 1}/10: מייצר (scene: ${sceneBuffer ? 'כן' : 'לא'}, פנים: ${faceRef ? 'כן' : 'לא'}, לוגו overlay: ${logoBuffer ? 'כן' : 'לא'})...`);

        let buffer = await generateAdImageBuffer(nanoPrompt, logoBuffer, sceneBuffer, faceRef);

        // Hard-composite the real logo on top — guarantees logo is always present
        if (logoBuffer) {
          buffer = await overlayLogo(buffer, logoBuffer);
          log(`   ✦ לוגו composited ✓`);
        }

        const filename = `ad_${i + 1}.png`;
        const upload = await backblazeService.uploadImage(
          `wow/ads/${sessionId}/${filename}`,
          buffer,
          'image/png',
        );

        generatedAds.push({
          ...ad,
          nanoPrompt,
          imageUrl: upload.publicUrl,
        });
        log(`מודעה ${i + 1} ✓ → ${filename}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`⚠️ מודעה ${i + 1} נכשלה: ${msg}`);
        generatedAds.push({ ...ad, nanoPrompt });
      }

      if (i < ads.length - 1) await new Promise(r => setTimeout(r, 1000));
    }

    await saveAdsJson(sessionId, {
      campaignId: sessionId,
      brief,
      servicesAndDeals,
      figmaStyleHint,
      campaignStyle,
      generatedAds,
    });

    const s2 = await sessionService.getSession(sessionId);
    s2.edits.adsStatus = 'ready';
    await sessionService.updateSession(sessionId, { edits: s2.edits });
    log('✅ פייפליין מודעות הושלם בהצלחה!');

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[AdsPipeline] Failed:', msg);
    try {
      const s = await sessionService.getSession(sessionId);
      s.edits.adsStatus = 'error';
      await sessionService.updateSession(sessionId, { edits: s.edits });
    } catch { /* */ }
  }
};

// ─── Regenerate single ad ─────────────────────────────────────────────────

const regenerateAd = async (sessionId, adId) => {
  const data = await loadAdsJson(sessionId);
  if (!data) return null;

  const ads = (data.generatedAds || data.ads || []);
  const ad = ads.find((a) => a.id === adId);
  if (!ad) return null;

  const brief = data.brief;

  let logoBuffer = null;
  if (brief?.logo) logoBuffer = await fetchAssetBuffer(brief.logo);

  const photoBuffers = [];
  for (const photoUrl of (brief?.photos || []).slice(0, 3)) {
    const buf = await fetchAssetBuffer(photoUrl);
    if (buf) photoBuffers.push(buf);
  }

  let faceBuffer = null;
  if (brief?.facePhoto) faceBuffer = await fetchAssetBuffer(brief.facePhoto);

  const campaignStyle = data.campaignStyle || '';
  const adIndex = ads.findIndex(a => a.id === adId);
  const hasFace = FACE_AD_INDICES.has(adIndex) && faceBuffer !== null;
  const sceneBuffer = photoBuffers[0] ?? null;

  const p2 = buildPrompt2({
    ad,
    servicesAndDeals: data.servicesAndDeals || brief?.services || '',
    figmaStyleHint: data.figmaStyleHint || brief?.designStyle || 'modern',
    campaignStyle,
    colors: brief?.preferredColors?.primary
      ? brandColorList(brief.preferredColors).join(", ")
      : '',
    hasLogo: logoBuffer !== null,
    hasFace,
  });

  const nanoPrompt = await generateNanoPrompt(p2);
  let buffer = await generateAdImageBuffer(nanoPrompt, logoBuffer, sceneBuffer, hasFace ? faceBuffer : null);
  if (logoBuffer) buffer = await overlayLogo(buffer, logoBuffer);

  const filename = `ad_${adId}.png`;
  const upload = await backblazeService.uploadImage(
    `wow/ads/${sessionId}/${filename}`,
    buffer,
    'image/png',
  );

  ad.nanoPrompt = nanoPrompt;
  ad.imageUrl = upload.publicUrl;
  ad.regeneratedAt = new Date().toISOString();

  await saveAdsJson(sessionId, data);
  return ad;
};

// ─── Regenerate all ads ───────────────────────────────────────────────────

const regenerateAllAds = async (sessionId) => {
  const data = await loadAdsJson(sessionId);
  if (!data) return [];

  const brief = data.brief;

  let logoBuffer = null;
  if (brief?.logo) logoBuffer = await fetchAssetBuffer(brief.logo);

  const photoBuffers = [];
  for (const photoUrl of (brief?.photos || []).slice(0, 5)) {
    const buf = await fetchAssetBuffer(photoUrl);
    if (buf) photoBuffers.push(buf);
  }

  let faceBuffer = null;
  if (brief?.facePhoto) faceBuffer = await fetchAssetBuffer(brief.facePhoto);

  const campaignStyle = data.campaignStyle || '';
  const ads = (data.generatedAds || data.ads || []);

  for (let i = 0; i < ads.length; i++) {
    try {
      const ad = ads[i];
      const hasFace = FACE_AD_INDICES.has(i) && faceBuffer !== null;
      const sceneBuffer = photoBuffers[i % Math.max(photoBuffers.length, 1)] ?? null;

      const p2 = buildPrompt2({
        ad,
        servicesAndDeals: data.servicesAndDeals || '',
        figmaStyleHint: data.figmaStyleHint || 'modern',
        campaignStyle,
        colors: brief?.preferredColors?.primary
          ? brandColorList(brief.preferredColors).join(", ")
          : '',
        hasLogo: logoBuffer !== null,
        hasFace,
      });

      const nanoPrompt = await generateNanoPrompt(p2);
      let buffer = await generateAdImageBuffer(nanoPrompt, logoBuffer, sceneBuffer, hasFace ? faceBuffer : null);
      if (logoBuffer) buffer = await overlayLogo(buffer, logoBuffer);

      const filename = `ad_${ad.id}.png`;
      const upload = await backblazeService.uploadImage(
        `wow/ads/${sessionId}/${filename}`,
        buffer,
        'image/png',
      );

      ad.nanoPrompt = nanoPrompt;
      ad.imageUrl = upload.publicUrl;
      ad.regeneratedAt = new Date().toISOString();
      console.log(`✦ [AdsRegen] מודעה ${i + 1} ✓ (פנים: ${hasFace ? 'כן' : 'לא'}, לוגו: ${logoBuffer ? 'כן' : 'לא'})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AdsRegen] Ad ${ads[i].id} failed: ${msg}`);
    }
    if (i < ads.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  await saveAdsJson(sessionId, data);
  return ads;
};

// ─── Edit ad with user text prompt ───────────────────────────────────────────

const editAdWithPrompt = async (sessionId, adId, userPrompt) => {
  const data = await loadAdsJson(sessionId);
  if (!data) return null;

  const ads = (data.generatedAds || data.ads || []);
  const ad = ads.find((a) => a.id === adId);
  if (!ad) return null;

  const brief = data.brief;

  let logoBuffer = null;
  if (brief?.logo) logoBuffer = await fetchAssetBuffer(brief.logo);

  const photoBuffers = [];
  for (const photoUrl of (brief?.photos || []).slice(0, 3)) {
    const buf = await fetchAssetBuffer(photoUrl);
    if (buf) photoBuffers.push(buf);
  }

  let faceBuffer = null;
  if (brief?.facePhoto) faceBuffer = await fetchAssetBuffer(brief.facePhoto);

  const campaignStyle = data.campaignStyle || '';
  const adIndex = ads.findIndex(a => a.id === adId);
  const hasFace = FACE_AD_INDICES.has(adIndex) && faceBuffer !== null;
  const sceneBuffer = photoBuffers[0] ?? null;

  const p2 = buildPrompt2({
    ad,
    servicesAndDeals: data.servicesAndDeals || brief?.services || '',
    figmaStyleHint: data.figmaStyleHint || brief?.designStyle || 'modern',
    campaignStyle,
    colors: brief?.preferredColors?.primary
      ? brandColorList(brief.preferredColors).join(", ")
      : '',
    hasLogo: logoBuffer !== null,
    hasFace,
    userChangeRequest: userPrompt,
  });

  const nanoPrompt = await generateNanoPrompt(p2);
  let buffer = await generateAdImageBuffer(nanoPrompt, logoBuffer, sceneBuffer, hasFace ? faceBuffer : null);
  if (logoBuffer) buffer = await overlayLogo(buffer, logoBuffer);

  const filename = `ad_${adId}.png`;
  const upload = await backblazeService.uploadImage(
    `wow/ads/${sessionId}/${filename}`,
    buffer,
    'image/png',
  );

  ad.nanoPrompt = nanoPrompt;
  ad.imageUrl = upload.publicUrl;
  ad.editedAt = new Date().toISOString();
  ad.lastUserPrompt = userPrompt;

  await saveAdsJson(sessionId, data);
  return ad;
};

module.exports = {
  runAdsPipeline,
  regenerateAd,
  regenerateAllAds,
  editAdWithPrompt,
  loadAdsJson,
};
