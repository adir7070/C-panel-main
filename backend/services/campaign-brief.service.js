/**
 * Campaign Brief — Image Generation Service (v3)
 *
 * Flow per item:
 *   1. generateCampaignStyleAnchor() — OpenAI, once per brief
 *   2. generateAdContent()           — OpenAI, Hebrew ad text per item/slide
 *   3. buildGeminiNanoPrompt()       — OpenAI, English 7-layer Gemini prompt
 *   4. generateImage()               — Gemini 1080×1080 (logo attached as image, integrated by Gemini)
 *   5. squarize                      — Sharp post-processing
 *   6. uploadImage()                 — Backblaze B2
 *   7. $set purchasedPackages.$.images — MongoDB
 *
 * Carousel: each slide gets its own generateAdContent() call with slide role context.
 * Logo: fetched from business_profiles.logoUrl, passed to Gemini as image — integrated naturally.
 */

const sharp         = require("sharp");
const { OpenAI }    = require("openai");
const { GoogleGenAI } = require("@google/genai");
const { getDB }     = require("../config/db");
const { uploadImage, downloadImageByPath } = require("./backblaze.service");
const { SYSTEM_PROMPT: CAMPAIGN_SYSTEM_PROMPT } = require("../utils/prompts/campaign-images");
const fbAds         = require("./facebook-ads.service");
/* WOW Ads art-direction layer — REUSED (exported), not copied. */
const { generateCreativeDirection, formatCreativeDirection, reviewGeneratedAd } = require("./wow-ads-direction.service");
/* WOW Ads image-quality pipeline, copied into a self-contained module so the
   mobile path can borrow CPANEL "WOW Ads" image quality without importing
   from (or modifying) any wow-ads* file. */
const adq           = require("./campaign-brief-quality");
const creationProgress = require("./creation-progress.service");

const SERVER_BASE_URL = process.env.BASE_URL || "https://iconiq-b19bf9d01fab.herokuapp.com";

/* Feature flag — routes mobile brief image generation through the WOW Ads
   HQ pipeline (gpt-image-2 multi-stage: analysis → direction → nano-prompt →
   vision review). Default ON: the mobile app talks to the AWS server, whose
   env lives in a shared file that the deploy can't edit from git, so we
   default to HQ in code and keep an explicit kill-switch (MOBILE_ADS_HQ=false)
   for the Gemini path. If the HQ setup throws (e.g. no OpenAI key on a given
   server) the code falls back to Gemini cleanly — see generateBriefImages. */
const MOBILE_ADS_HQ = process.env.MOBILE_ADS_HQ !== "false";
/* Vision review threshold — HQ ads scoring below this get ONE auto-retry
   with the reviewer's retryInstruction injected back into the prompt. */
const REVIEW_PASS_SCORE = parseInt(process.env.MOBILE_ADS_PASS_SCORE || "82", 10);

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
// OpenAI-primary text with Gemini fallback (out-of-credit resilience):
const { chatComplete } = require("./text-gen.service");
const gemini = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });

const OPENAI_MODEL       = process.env.OPENAI_ADS_MODEL   || "gpt-4o";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";
const USERS_COL          = "users";
const AD_SIZE            = 1080;
const CAROUSEL_SLIDES    = 4;

// ─── Campaign type context ────────────────────────────────────────────────────

const CAMPAIGN_TYPE_CONTEXT = {
  whatsapp: { label: "קמפיין וואטסאפ",      intent: "drive WhatsApp conversations", cta_hint: "Send WhatsApp message CTA" },
  traffic:  { label: "קמפיין תנועה לאתר",   intent: "drive website traffic",         cta_hint: "Visit website / Learn more CTA" },
  leads:    { label: "קמפיין לידים",         intent: "collect lead form submissions",  cta_hint: "Leave details / Sign up CTA" },
};

// ─── Carousel slide roles (narrative 4-beat structure) ───────────────────────

const SLIDE_ROLES = [
  "HOOK — most dramatic, surprising, scroll-stopping. Stand-alone image. Dominant headline only.",
  "CONTEXT — show the problem or the before-state. Person in the relatable situation, emotional.",
  "SOLUTION BRIDGE — service in action, transformation moment, aspirational energy.",
  "PROOF + CTA — result, social proof energy (satisfied person, milestone), strong CTA with urgency.",
];

// ─── Logo fetching ───────────────────────────────────────────────────────────

async function fetchLogoBuffer(phone) {
  try {
    const bp = await getDB()
      .collection("business_profiles")
      .findOne({ phone }, { projection: { logoUrl: 1 } });
    const logoUrl = bp?.logoUrl;
    if (!logoUrl || String(logoUrl).startsWith("data:")) return null;

    const proxyMatch = logoUrl.match(/\/api\/img\?url=([^&]+)/);
    if (proxyMatch) {
      const path = decodeURIComponent(proxyMatch[1]);
      const { buffer } = await downloadImageByPath(path);
      return buffer;
    }
    if (/^https?:\/\//i.test(logoUrl)) {
      const resp = await fetch(logoUrl);
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    }
    const { buffer } = await downloadImageByPath(logoUrl.replace(/^\/+/, ""));
    return buffer;
  } catch (err) {
    console.warn("[CampaignBrief] logo fetch failed:", err.message);
    return null;
  }
}

// ─── Sharp: squarize to 1080×1080 ────────────────────────────────────────────

async function squareizePreservingText(rawBuffer) {
  const meta  = await sharp(rawBuffer).metadata();
  const w     = meta.width  || AD_SIZE;
  const h     = meta.height || AD_SIZE;
  const ratio = w / h;

  if (ratio > 0.95 && ratio < 1.05) {
    return sharp(rawBuffer).resize(AD_SIZE, AD_SIZE, { fit: "fill" }).png().toBuffer();
  }
  // Cover-crop handles all realistic Gemini outputs (4:3, 16:9, 9:16, etc.)
  // Text is protected by 10% margin instruction so center-crop is always safe
  return sharp(rawBuffer).resize(AD_SIZE, AD_SIZE, { fit: "cover", position: "center" }).png().toBuffer();
}

// ─── Sharp: strip uniform logo background ────────────────────────────────────

async function removeUniformBackground(logoBuffer) {
  try {
    const { data, info } = await sharp(logoBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (channels < 4 || width < 4 || height < 4) return logoBuffer;

    const pix = (x, y) => {
      const i = (y * width + x) * channels;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };

    const samples = [
      pix(0, 0), pix(width - 1, 0), pix(0, height - 1), pix(width - 1, height - 1),
      pix(Math.floor(width / 2), 0), pix(Math.floor(width / 2), height - 1),
      pix(0, Math.floor(height / 2)), pix(width - 1, Math.floor(height / 2)),
    ];
    if (samples.some(s => s[3] < 250)) {
      console.log("[CampaignBrief] logo already has alpha — skip background removal");
      return logoBuffer;
    }

    let maxDist = 0;
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const d = Math.abs(samples[i][0] - samples[j][0])
                + Math.abs(samples[i][1] - samples[j][1])
                + Math.abs(samples[i][2] - samples[j][2]);
        if (d > maxDist) maxDist = d;
      }
    }
    if (maxDist > 90) {
      const nearWhiteCount = samples.filter(s => s[0] >= 235 && s[1] >= 235 && s[2] >= 235).length;
      if (nearWhiteCount >= 5) {
        console.log(`[CampaignBrief] logo non-uniform (maxDist=${maxDist}) but ${nearWhiteCount}/8 samples near-white — stripping pure white`);
        const out = Buffer.from(data);
        const HARD_W = 60;
        const SOFT_W = 160;
        for (let i = 0; i < out.length; i += channels) {
          const dist = Math.abs(out[i] - 255) + Math.abs(out[i + 1] - 255) + Math.abs(out[i + 2] - 255);
          if (dist <= HARD_W) out[i + 3] = 0;
          else if (dist < SOFT_W) out[i + 3] = Math.round(((dist - HARD_W) / (SOFT_W - HARD_W)) * out[i + 3]);
        }
        return sharp(out, { raw: { width, height, channels } }).png().toBuffer();
      }
      console.log(`[CampaignBrief] logo edges genuinely non-uniform (maxDist=${maxDist}) — keep as-is`);
      return logoBuffer;
    }

    const bgR = Math.round(samples.reduce((a, s) => a + s[0], 0) / samples.length);
    const bgG = Math.round(samples.reduce((a, s) => a + s[1], 0) / samples.length);
    const bgB = Math.round(samples.reduce((a, s) => a + s[2], 0) / samples.length);
    console.log(`[CampaignBrief] removing logo background rgb(${bgR},${bgG},${bgB}) — maxDist=${maxDist}`);

    const HARD = 70;
    const SOFT = 180;
    const out = Buffer.from(data);
    const removeColor = (r, g, b) => {
      for (let i = 0; i < out.length; i += channels) {
        if (out[i + 3] === 0) continue;
        const dist = Math.abs(out[i] - r) + Math.abs(out[i + 1] - g) + Math.abs(out[i + 2] - b);
        if (dist <= HARD) {
          out[i + 3] = 0;
        } else if (dist < SOFT) {
          out[i + 3] = Math.round(((dist - HARD) / (SOFT - HARD)) * out[i + 3]);
        }
      }
    };
    removeColor(bgR, bgG, bgB);

    const ix = Math.max(1, Math.floor(width  * 0.08));
    const iy = Math.max(1, Math.floor(height * 0.08));
    const pixOut = (x, y) => {
      const i = (y * width + x) * channels;
      return [out[i], out[i + 1], out[i + 2], out[i + 3]];
    };
    const insetSamples = [
      pixOut(ix, iy), pixOut(width - 1 - ix, iy),
      pixOut(ix, height - 1 - iy), pixOut(width - 1 - ix, height - 1 - iy),
      pixOut(Math.floor(width / 2), iy), pixOut(Math.floor(width / 2), height - 1 - iy),
      pixOut(ix, Math.floor(height / 2)), pixOut(width - 1 - ix, Math.floor(height / 2)),
    ];
    const insetOpaque = insetSamples.filter(s => s[3] > 200);
    if (insetOpaque.length >= 6) {
      let maxDist2 = 0;
      for (let i = 0; i < insetOpaque.length; i++) {
        for (let j = i + 1; j < insetOpaque.length; j++) {
          const d = Math.abs(insetOpaque[i][0] - insetOpaque[j][0])
                  + Math.abs(insetOpaque[i][1] - insetOpaque[j][1])
                  + Math.abs(insetOpaque[i][2] - insetOpaque[j][2]);
          if (d > maxDist2) maxDist2 = d;
        }
      }
      if (maxDist2 < 60) {
        const ringR = Math.round(insetOpaque.reduce((a, s) => a + s[0], 0) / insetOpaque.length);
        const ringG = Math.round(insetOpaque.reduce((a, s) => a + s[1], 0) / insetOpaque.length);
        const ringB = Math.round(insetOpaque.reduce((a, s) => a + s[2], 0) / insetOpaque.length);

        const cx = Math.floor(width / 2);
        const cy = Math.floor(height / 2);
        const centerSamples = [];
        for (let dy = -10; dy <= 10; dy += 5) {
          for (let dx = -10; dx <= 10; dx += 5) {
            const sx = Math.max(0, Math.min(width  - 1, cx + dx));
            const sy = Math.max(0, Math.min(height - 1, cy + dy));
            centerSamples.push(pixOut(sx, sy));
          }
        }
        const centerR = Math.round(centerSamples.reduce((a, s) => a + s[0], 0) / centerSamples.length);
        const centerG = Math.round(centerSamples.reduce((a, s) => a + s[1], 0) / centerSamples.length);
        const centerB = Math.round(centerSamples.reduce((a, s) => a + s[2], 0) / centerSamples.length);
        const centerDist = Math.abs(centerR - ringR) + Math.abs(centerG - ringG) + Math.abs(centerB - ringB);

        const ringIsNearWhite = ringR > 235 && ringG > 235 && ringB > 235;
        if (centerDist > 80 || ringIsNearWhite) {
          const why = ringIsNearWhite
            ? `near-white override (centerDist=${centerDist})`
            : `centerDist=${centerDist}`;
          console.log(`[CampaignBrief] pass 2: removing inner card rgb(${ringR},${ringG},${ringB}) — ${why}`);
          removeColor(ringR, ringG, ringB);
        } else {
          console.log(`[CampaignBrief] pass 2: ring matches logo center (centerDist=${centerDist}) — skip to protect content`);
        }
      } else {
        console.log(`[CampaignBrief] pass 2: inset ring not uniform (maxDist=${maxDist2}) — no second pass needed`);
      }
    }

    return sharp(out, { raw: { width, height, channels } }).png().toBuffer();
  } catch (err) {
    console.warn("[CampaignBrief] removeUniformBackground failed, using original:", err.message);
    return logoBuffer;
  }
}

// ─── Sharp: stamp logo top-right ─────────────────────────────────────────────

async function compositeLogoTopRight(adBuffer, logoBuffer) {
  if (!logoBuffer) return adBuffer;
  try {
    const edgePad     = 28;
    const targetLogoW = Math.round(AD_SIZE * 0.12);

    const keyed = await removeUniformBackground(logoBuffer);
    const sized = await sharp(keyed)
      .resize(targetLogoW, targetLogoW, { fit: "inside", withoutEnlargement: false })
      .png().toBuffer();
    const meta  = await sharp(sized).metadata();
    const logoW = meta.width  || targetLogoW;

    const logoLeft = AD_SIZE - logoW - edgePad;
    const logoTop  = edgePad;

    return sharp(adBuffer)
      .composite([{ input: sized, top: logoTop, left: logoLeft }])
      .png().toBuffer();
  } catch (err) {
    console.warn("[CampaignBrief] logo composite failed:", err.message);
    return adBuffer;
  }
}

// ─── Step 1: Campaign Style Anchor — once per brief ──────────────────────────

async function generateCampaignStyleAnchor(briefData) {
  const { services, campaignType, review } = briefData;
  const servicesTitles = (services ?? []).map(s => s.title).join(", ") || "שירות כללי";
  const ctxLabel       = CAMPAIGN_TYPE_CONTEXT[campaignType]?.label || campaignType || "קמפיין";

  const prompt = `You are an Art Director designing a unified visual campaign for a Hebrew RTL Instagram/Facebook ad set.

Campaign type: ${ctxLabel}
Services offered: ${servicesTitles}
CTA: ${review?.ctaText || "דברו איתי"}

Define a CONSISTENT visual language for ALL ads in this campaign.
Return a JSON object with these exact keys — no other text:

{
  "lighting": "one sentence: lighting style, temperature, direction, mood",
  "palette": "primary color + accent color + neutral, and how they interact",
  "photography": "camera lens, aperture, shot style (lifestyle/product/portrait), composition rule",
  "mood": "emotional atmosphere in 5–8 words",
  "signature": "one unique visual element repeated in every ad",
  "negative": "what to always avoid in this campaign",
  "cta_color": "one warm hex color for the CTA button (e.g. #E85D04 orange, #C0392B red, #D4A017 amber)"
}`;

  try {
    const res = await chatComplete({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are an expert art director. Return only valid JSON." },
        { role: "user",   content: prompt },
      ],
    });
    const raw = JSON.parse(res.choices[0]?.message?.content || "{}");
    console.log("[CampaignBrief] 🎨 Style anchor:", raw.mood, "| CTA color:", raw.cta_color);
    return raw;
  } catch {
    return {
      lighting:    "warm golden hour side-lighting, 5600K, soft rim light from right",
      palette:     "cream whites with deep navy accent, warm gold highlights",
      photography: "85mm f/2.0, medium lifestyle shot, rule-of-thirds",
      mood:        "aspirational yet authentic, Mediterranean warmth",
      signature:   "soft warm bokeh in background, subtle vignette",
      negative:    "no harsh flash, no sterile white backgrounds, no generic stock imagery",
      cta_color:   "#E85D04",
    };
  }
}

// ─── Step 2: Hebrew Ad Content — per item / per slide ────────────────────────

async function generateAdContent({ itemIndex, postCount, briefData, styleAnchor, slideRole = null, slideIndex = null }) {
  const { campaignType, services, postDescriptions, review } = briefData;
  const isCarousel     = itemIndex >= postCount;
  const itemLabel      = isCarousel ? `קרוסלה ${itemIndex - postCount + 1}` : `פוסט ${itemIndex + 1}`;
  const servicesTitles = (services ?? []).map(s => s.title).join(", ") || "שירות כללי";
  const userIdea       = postDescriptions?.[itemIndex] || "";
  const ctaText        = review?.ctaText || "דברו איתי";
  const contactInfo    = (review?.contactInfo ?? []).join(", ");
  const ctxType        = CAMPAIGN_TYPE_CONTEXT[campaignType] || {};

  // For carousel slides without a user description, use all available descriptions as context
  const allDescriptions = Object.values(postDescriptions ?? {}).filter(Boolean).join(" | ");
  const contextIdea = userIdea || (allDescriptions ? `הקשר הקמפיין: ${allDescriptions}` : "");

  const slideCtx = slideRole
    ? `\n• תפקיד הסלייד בקרוסלה (סלייד ${(slideIndex ?? 0) + 1}/4): ${slideRole}`
    : "";

  const userPrompt = `
אתה קופירייטר ישראלי לקמפיינים ממומנים בפייסבוק / אינסטגרם.

📋 נתוני הקמפיין:
• שירותים: ${servicesTitles}
• סוג קמפיין: ${ctxType.label || campaignType}
• מטרת הקמפיין: ${ctxType.intent || "המרה"}
• CTA שנבחר: ${ctaText}
• מידע שצריך להופיע: ${contactInfo || "לפי שיקול דעתך"}
• רעיון / הקשר ל${itemLabel}: ${contextIdea || "אין — בחר זווית חזקה בעצמך בהתאם לשירות"}${slideCtx}

🎯 המשימה:
צור טקסטי מודעה אחת ל-${itemLabel} — ספציפי לשירות "${servicesTitles}".

📐 חוקים:
1. בחר טריגר פסיכולוגי אחד: הזדהות / פחד מהחמצה / שדרוג עצמי / ביטחון / פתרון מיידי / הוכחה חברתית
2. בחר סוג Hook: Confession / Confrontation / Relatable truth / Pattern interrupt / Micro story / Bold claim
3. הכותרת חייבת להכיל: מצב יומיומי ספציפי לשירות, תגובה רגשית, OR רגע ספציפי (Real Moment Rule)
4. מבנה: HOOK → PROMISE → PROOF → CTA
5. אסור: "מקצועי", "איכותי", "שירות", "פתרון", "מבצע", "מדהים" — קלישאות נכשלות
6. אסור בהחלט: אמוג'י, סימני ציטוט (׳ ״), קווים נטויים — כולן לא יוצאות טוב בתמונה
7. CTA: 1–3 מילים בלבד, ${ctxType.cta_hint || ""}

החזר JSON בלבד:
{
  "headline": "כותרת 2–5 מילים (עברית, מדוברת, Hook אמיתי, ללא אמוג'י)",
  "subheadline": "תת-כותרת 4–8 מילים (מחדדת את ההבטחה)",
  "proof_line": "שורת בידול 3–7 מילים (ניסיון / ליווי / מיקום / תוצאה)",
  "cta": "1–3 מילים, ללא אמוג'י",
  "trigger": "שם הטריגר שנבחר",
  "hook_type": "סוג ה-Hook שנבחר"
}`;

  const res = await chatComplete({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CAMPAIGN_SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
  });

  const content = JSON.parse(res.choices[0]?.message?.content || "{}");
  // Strip any emojis that slipped through
  const strip = (s) => (s || "").replace(/[\u{1F300}-\u{1FFFF}]|[☀-⟿]/gu, "").trim();
  return {
    headline:    strip(content.headline),
    subheadline: strip(content.subheadline),
    proof_line:  strip(content.proof_line),
    cta:         strip(content.cta),
    trigger:     content.trigger,
    hook_type:   content.hook_type,
  };
}

// ─── Step 3: English Gemini Nano Prompt — 7-layer narrative ─────────────────

async function buildGeminiNanoPrompt({ adContent, isCarousel, slideIndex, slideRole, styleAnchor, briefData }) {
  const { campaignType, services } = briefData;
  const servicesTitles = (services ?? []).map(s => s.title).join(", ") || "service";
  const ctxType        = CAMPAIGN_TYPE_CONTEXT[campaignType] || {};
  const ctaColor       = styleAnchor.cta_color || "#E85D04";

  const anchor = [
    styleAnchor.lighting,
    styleAnchor.palette,
    styleAnchor.photography,
    `mood: ${styleAnchor.mood}`,
    `signature element: ${styleAnchor.signature}`,
    `avoid: ${styleAnchor.negative}`,
  ].join(" | ");

  const slideCtx = isCarousel && slideRole
    ? `\nCARROUSEL SLIDE ${(slideIndex ?? 0) + 1}/${CAROUSEL_SLIDES} — Role: ${slideRole}. ONE full-bleed scene (not a grid). Visual energy connects to next slide via right-edge color fade.`
    : "";

  const userPrompt = `You are a Creative Director writing a Gemini image generation prompt for a Facebook/Instagram ad.
The final image must be a COMPLETE, READY-TO-RUN Meta ad — not just a background.

HEBREW TEXT TO RENDER ON THE IMAGE (exact strings, render as-is):
• HEADLINE (largest, dominant visual element): "${adContent.headline}"
• SUBHEADLINE (medium weight, below headline): "${adContent.subheadline}"
• PROOF LINE (small text): "${adContent.proof_line}"
• CTA BUTTON (solid rounded pill, color ${ctaColor}): "${adContent.cta}"

Service: ${servicesTitles}
Campaign intent: ${ctxType.intent || "conversion"}
Psychological trigger: ${adContent.trigger}${slideCtx}

VISUAL DIRECTION (campaign-wide anchor — apply to every prompt):
${anchor}

MANDATORY RULES:
1. Write ONE single-line English narrative prompt (no newlines, no quotes, no commentary)
2. 7-layer structure: [SHOT TYPE] of [SUBJECT+EXPRESSION], [ENVIRONMENT]. Lit by [LIGHTING]. [CAMERA SPECS]. [STYLE]. [MOOD].
3. Embed Hebrew text rendering instructions:
   - headline "${adContent.headline}" — largest boldest text, thumb-stopping dominant element
   - subheadline "${adContent.subheadline}" — medium weight below headline
   - proof line "${adContent.proof_line}" — small text
   - CTA button "${adContent.cta}" — solid rounded pill filled with ${ctaColor}, white text, strong contrast, no emojis
4. All text in modern clean bold Hebrew RTL sans-serif, high contrast against the background
5. Text zone: place all text on a semi-transparent dark overlay strip OR dedicated flat-color band — ensure legibility
6. TEXT-SAFE ZONE: all text elements must stay within the central 80% of the canvas (10% padding from every edge)
7. If a logo image is attached as the last image, tell Gemini: תשלב את הלוגו בצורה טבעית ובלי רקע בפינה העליונה-ימנית של המודעה
8. Commercial photography quality — NOT illustration, NOT poster, NOT generic stock
9. Direct eye contact with camera if a person is in the shot — maximum thumb-stop power
10. FULL-BLEED 1080×1080 — fills every edge, no inner frames, no borders`;

  const res = await chatComplete({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "You output a single-line English Gemini prompt only. No quotes, no newlines, no commentary. Maximum 220 words." },
      { role: "user",   content: userPrompt },
    ],
  });

  return (res.choices[0]?.message?.content || "").trim().replace(/[\r\n]+/g, " ");
}

// ─── Step 4: Gemini image generation ─────────────────────────────────────────

async function generateImage(nanoPrompt, logoBuffer = null, attempt = 1) {
  try {
    const parts = [];
    let prompt = nanoPrompt;
    if (logoBuffer) {
      const meta = await sharp(logoBuffer).metadata();
      const mime = meta.format === "png" ? "image/png" : "image/jpeg";
      parts.push({ inlineData: { mimeType: mime, data: logoBuffer.toString("base64") } });
      prompt += " [The LAST image before this text is the brand LOGO. תשלב את הלוגו בצורה טבעית ובלי רקע בפינה העליונה-ימנית של המודעה.]";
    }
    parts.push({ text: prompt });
    const resp = await gemini.models.generateContent({
      model:    GEMINI_IMAGE_MODEL,
      contents: [{ role: "user", parts }],
    });
    const respParts = resp?.candidates?.[0]?.content?.parts || [];
    const imgPart   = respParts.find(p => p.inlineData?.data);
    if (!imgPart) throw new Error("Gemini returned no image data");
    return Buffer.from(imgPart.inlineData.data, "base64");
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise(r => setTimeout(r, 1000 * attempt * attempt));
    return generateImage(nanoPrompt, logoBuffer, attempt + 1);
  }
}

// ─── Step 5: Post-process — squarize + logo ───────────────────────────────────

async function finalizeImage(rawBuffer) {
  return squareizePreservingText(rawBuffer);
}

// ─── Generate single post image ───────────────────────────────────────────────

async function generatePostImage({ itemIndex, postCount, briefData, styleAnchor, logoBuffer, phone, purchasedAt }) {
  const adContent  = await generateAdContent({ itemIndex, postCount, briefData, styleAnchor });
  const nanoPrompt = await buildGeminiNanoPrompt({ adContent, isCarousel: false, styleAnchor, briefData });
  const raw        = await generateImage(nanoPrompt, logoBuffer);
  const buf        = await finalizeImage(raw);
  const b2Path     = `campaign-brief/${phone}/${purchasedAt}/item_${itemIndex}.png`;
  await uploadImage(b2Path, buf, "image/png");

  return { imageUrl: `/api/img?url=${encodeURIComponent(b2Path)}`, adContent, nanoPrompt };
}

// ─── Carousel: generate all 4 slide adContents in ONE call ───────────────────
// Single OpenAI call ensures all slides share the same theme, service, CTA.

async function generateCarouselAdContents({ itemIndex, postCount, briefData }) {
  const { campaignType, services, postDescriptions, review } = briefData;
  const servicesTitles  = (services ?? []).map(s => s.title).join(", ") || "שירות כללי";
  const userIdea        = postDescriptions?.[itemIndex] || "";
  const allDescriptions = Object.values(postDescriptions ?? {}).filter(Boolean).join(" | ");
  const contextIdea     = userIdea || (allDescriptions ? `הקשר הקמפיין: ${allDescriptions}` : "");
  const ctaText         = review?.ctaText || "דברו איתי";
  const contactInfo     = (review?.contactInfo ?? []).join(", ");
  const ctxType         = CAMPAIGN_TYPE_CONTEXT[campaignType] || {};

  const userPrompt = `
אתה קופירייטר ישראלי לקמפיינים ממומנים בפייסבוק / אינסטגרם.

📋 נתוני הקמפיין:
• שירותים: ${servicesTitles}
• סוג קמפיין: ${ctxType.label || campaignType}
• מטרת הקמפיין: ${ctxType.intent || "המרה"}
• CTA שנבחר: ${ctaText}
• מידע שצריך להופיע: ${contactInfo || "לפי שיקול דעתך"}
• רעיון / הקשר לקרוסלה: ${contextIdea || "אין — בחר זווית חזקה בהתאם לשירות"}

🎯 המשימה:
צור טקסטי קרוסלה של 4 סליידים — כולם על אותו נושא, אותו שירות, אותו CTA.
כל סלייד מותאם לתפקידו בנרטיב, אבל ההקשר המרכזי חייב להיות זהה בכולם.

תפקידי הסליידים:
1. HOOK — כותרת דרמטית, עוצרת גלילה, עומדת לבד
2. CONTEXT — מציגה את הבעיה / מצב לפני
3. SOLUTION BRIDGE — השירות בפעולה, רגע השינוי
4. PROOF + CTA — תוצאה / הוכחה חברתית + קריאה לפעולה דחופה

📐 חוקים לכל 4 הסליידים:
1. אסור בהחלט: אמוג'י, סימני ציטוט (׳ ״), קווים נטויים
2. CTA זהה בכל הסליידים: "${ctaText}"
3. כל הסליידים על אותו שירות — אסור לשנות נושא בין הסליידים
4. אסור: "מקצועי", "איכותי", "שירות", "פתרון", "מבצע", "מדהים"

החזר JSON בלבד:
{
  "slides": [
    { "headline": "...", "subheadline": "...", "proof_line": "...", "cta": "...", "trigger": "...", "hook_type": "..." },
    { "headline": "...", "subheadline": "...", "proof_line": "...", "cta": "...", "trigger": "...", "hook_type": "..." },
    { "headline": "...", "subheadline": "...", "proof_line": "...", "cta": "...", "trigger": "...", "hook_type": "..." },
    { "headline": "...", "subheadline": "...", "proof_line": "...", "cta": "...", "trigger": "...", "hook_type": "..." }
  ]
}`;

  const res = await chatComplete({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CAMPAIGN_SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
  });

  const parsed = JSON.parse(res.choices[0]?.message?.content || "{}");
  const strip  = (s) => (s || "").replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, "").trim();

  return (parsed.slides || []).slice(0, CAROUSEL_SLIDES).map(s => ({
    headline:    strip(s.headline),
    subheadline: strip(s.subheadline),
    proof_line:  strip(s.proof_line),
    cta:         strip(s.cta),
    trigger:     s.trigger,
    hook_type:   s.hook_type,
  }));
}

// ─── Generate carousel — unified theme, per-slide image ──────────────────────

async function generateCarouselImages({ itemIndex, postCount, briefData, styleAnchor, logoBuffer, phone, purchasedAt }) {
  const slideContents = await generateCarouselAdContents({ itemIndex, postCount, briefData });
  const slides = [];

  for (let s = 0; s < CAROUSEL_SLIDES; s++) {
    try {
      const adContent  = slideContents[s] || slideContents[0];
      const nanoPrompt = await buildGeminiNanoPrompt({
        adContent,
        isCarousel:  true,
        slideIndex:  s,
        slideRole:   SLIDE_ROLES[s],
        styleAnchor,
        briefData,
      });
      const raw    = await generateImage(nanoPrompt, logoBuffer);
      const buf    = await finalizeImage(raw);
      const b2Path = `campaign-brief/${phone}/${purchasedAt}/item_${itemIndex}_slide_${s + 1}.png`;
      await uploadImage(b2Path, buf, "image/png");
      slides.push({
        id:        s + 1,
        role:      SLIDE_ROLES[s].split(" — ")[0],
        imageUrl:  `/api/img?url=${encodeURIComponent(b2Path)}`,
        adContent,
        nanoPrompt,
      });
    } catch (err) {
      console.error(`[CampaignBrief] carousel item ${itemIndex} slide ${s + 1} failed:`, err.message);
      slides.push({ id: s + 1, error: err.message });
    }
  }

  // Return the HOOK slide's adContent as the carousel summary
  const summaryContent = slides.find(s => s.adContent)?.adContent ?? {};
  return { adContent: summaryContent, slides };
}

// ═══════════════════════════════════════════════════════════════════════════
// HQ PIPELINE (WOW Ads quality) — gated behind MOBILE_ADS_HQ
// ═══════════════════════════════════════════════════════════════════════════

// ─── Build a WOW-Ads-shaped brief from this phone's business_profile ─────────
// Mirrors buildBriefForClient in controllers/wow-ads.controller.js (~line 96),
// then merges the mobile briefData (campaignType / postDescriptions / review).
// Also fetches up to 5 client photo Buffers + the logo Buffer via the quality
// module's fetchAssetBuffer so the analysis + image-edit steps have real bytes.

async function buildBrief(phone, briefData) {
  const profile = await getDB().collection("business_profiles").findOne({ phone });

  const services = (profile?.services || [])
    .map(s => `${s.title}${s.description ? ` — ${s.description}` : ""}${s.price ? ` (${s.price})` : ""}`)
    .join("; ");

  // Accept any non-empty string ref — including data: URLs (fetchAssetBuffer decodes them directly).
  const isValidAssetRef = (u) => typeof u === "string" && u.length > 0;
  const safeLogo = isValidAssetRef(profile?.logoUrl) ? profile.logoUrl : null;
  // Read BOTH images[] and the legacy generalImages[] (where the iOS app
  // stored uploads), deduped — a photo reaches the pipeline regardless of
  // which field holds it. Additive: never drops a ref that worked before.
  const seenImg = new Set();
  const galleryImages = [
    ...(Array.isArray(profile?.images) ? profile.images : []),
    ...(Array.isArray(profile?.generalImages) ? profile.generalImages : []),
  ].filter(u => isValidAssetRef(u) && !seenImg.has(u) && seenImg.add(u));
  const serviceImages = (profile?.services || [])
    .map(s => (isValidAssetRef(s.imageUrl) ? s.imageUrl
              : (Array.isArray(s.images) ? s.images.find(isValidAssetRef) : null)))
    .filter(isValidAssetRef);
  const safeImages    = [...galleryImages, ...serviceImages];

  const brief = {
    businessName:     profile?.businessName || "",
    businessField:    profile?.categoryKey  || "",
    businessNiche:    Array.isArray(profile?.subCategoryKeys) ? profile.subCategoryKeys.join(", ") : "",
    about:            profile?.about || "",
    services,
    phone,
    promotion:        profile?.promotion || "",
    designStyle:      profile?.designStyle,
    targetAudience:   Array.isArray(profile?.targetAudience) ? profile.targetAudience : [],
    preferredColors:  profile?.preferredColors || null,
    logo:             safeLogo,
    images:           safeImages,
    includePhoneInAds:   profile?.includePhoneInAds   === true,
    includeAddressInAds: profile?.includeAddressInAds === true,
    businessPhone:       profile?.businessPhone || "",
    address:             profile?.address       || "",
    // Merge mobile-campaign context so HQ ctx + copy stay campaign-aware.
    campaignType:     briefData.campaignType || "leads",
    postDescriptions: briefData.postDescriptions || {},
    review:           briefData.review || {},
  };

  // Fetch real bytes: logo + up to 5 reference photos.
  const logoBuffer = brief.logo ? await adq.fetchAssetBuffer(brief.logo) : null;
  const imageBuffers = [];
  for (const url of safeImages.slice(0, 5)) {
    const buf = await adq.fetchAssetBuffer(url);
    if (buf) imageBuffers.push(buf);
  }

  return { brief, logoBuffer, imageBuffers };
}

// ─── HQ: build the ctx object buildNanoPromptPrompt expects ──────────────────
// Mirrors how runAdsPipeline builds ctx in wow-ads.service.js (~lines 1069-1091).
// heroOnly is forced false — the mobile path keeps the model painting the whole
// ad (renderer-OFF default), matching campaign-brief-quality's copied prompt.

function buildHqCtx({ brief, analysis, logoBuffer, imageBuffers }) {
  const ctxType = CAMPAIGN_TYPE_CONTEXT[brief.campaignType] || {};
  const servicesAndDeals = [
    brief.services && `שירותים: ${brief.services}`,
    ctxType.intent && `מטרת הקמפיין: ${ctxType.intent}`,
    brief.promotion && `מבצע נוכחי: ${brief.promotion}`,
  ].filter(Boolean).join("\n") || (brief.services || "");

  return {
    designStyle:     brief.designStyle,
    preferredColors: brief.preferredColors,
    hasLogo:         logoBuffer !== null,
    hasScene:        imageBuffers.length > 0,
    imageCount:      imageBuffers.length,
    servicesAndDeals,
    nanoPromptTips:  analysis.nanoPromptTips,
    geminiTips:      analysis.geminiTips,
    includePhoneInAds:   brief.includePhoneInAds   === true,
    includeAddressInAds: brief.includeAddressInAds === true,
    businessPhone:       brief.businessPhone || "",
    address:             brief.address       || "",
    heroOnly:        false,
  };
}

// ─── HQ: generate ONE finished ad image buffer for an ad object ──────────────
// direction → nano-prompt → image → vision review (+ one retry). Returns the
// finalized (already-squarized) buffer ready to upload.

async function generateHqImageBuffer({ ad, ctx, brief, itemIndex, total, logoBuffer, imageBuffers }) {
  const direction = await generateCreativeDirection({ brief, ad, index: itemIndex, totalCount: total });
  const prompt    = await adq.generateNanoPrompt(ad, ctx, direction);

  let { buffer } = await adq.generateAdImageBuffer(prompt, logoBuffer, imageBuffers);

  // Vision review — fails soft (null) so a flaky review never blocks shipping.
  const review = await reviewGeneratedAd({ imageBuffer: buffer, ad, brief });
  if (review && !review.approve && review.score < REVIEW_PASS_SCORE && review.retryInstruction) {
    console.log(`[CampaignBrief:HQ] ${ad.id} scored ${review.score} — retrying once with reviewer fix`);
    try {
      const retryPrompt = `${prompt}\n\nFIX: ${review.retryInstruction}`;
      const retry = await adq.generateAdImageBuffer(retryPrompt, logoBuffer, imageBuffers);
      const retryReview = await reviewGeneratedAd({ imageBuffer: retry.buffer, ad, brief });
      // Keep whichever scored higher.
      if (retryReview && (retryReview.score ?? 0) > (review.score ?? 0)) {
        buffer = retry.buffer;
      }
    } catch (retryErr) {
      console.warn(`[CampaignBrief:HQ] ${ad.id} retry failed: ${retryErr.message} — keeping first attempt`);
    }
  }
  return buffer;
}

// ─── HQ: single post image (mirrors generatePostImage shape) ─────────────────

async function generateHqPostImage({ itemIndex, postCount, total, briefData, hq, phone, purchasedAt }) {
  const adContent = await generateAdContent({ itemIndex, postCount, briefData, styleAnchor: null });
  const ad = {
    id:          `m${itemIndex}`,
    headline:    adContent.headline,
    description: adContent.subheadline || adContent.proof_line,
    cta:         adContent.cta,
    type:        "regular",
  };

  let buffer = await generateHqImageBuffer({
    ad, ctx: hq.ctx, brief: hq.brief, itemIndex, total,
    logoBuffer: hq.logoBuffer, imageBuffers: hq.imageBuffers,
  });
  // generateAdImageBuffer already returns a squarized AD_SIZE buffer.
  // Composite the brand logo top-right (mirrors WOW Ads' deterministic stamp).
  buffer = await compositeLogoTopRight(buffer, hq.logoBuffer);

  const b2Path = `campaign-brief/${phone}/${purchasedAt}/item_${itemIndex}.png`;
  await uploadImage(b2Path, buffer, "image/png");

  return { imageUrl: `/api/img?url=${encodeURIComponent(b2Path)}`, adContent };
}

// ─── HQ: carousel — N slides reusing the same per-slide HQ approach ──────────

async function generateHqCarouselImages({ itemIndex, postCount, total, briefData, hq, phone, purchasedAt }) {
  const slideContents = await generateCarouselAdContents({ itemIndex, postCount, briefData });
  const slides = [];

  for (let s = 0; s < CAROUSEL_SLIDES; s++) {
    try {
      const adContent = slideContents[s] || slideContents[0];
      const ad = {
        id:           `m${itemIndex}s${s + 1}`,
        headline:     adContent.headline,
        description:  adContent.subheadline || adContent.proof_line,
        cta:          adContent.cta,
        type:         "regular",
        _slideContext: SLIDE_ROLES[s] || `Slide ${s + 1} of ${CAROUSEL_SLIDES}.`,
      };
      let buffer = await generateHqImageBuffer({
        ad, ctx: hq.ctx, brief: hq.brief, itemIndex, total,
        logoBuffer: hq.logoBuffer, imageBuffers: hq.imageBuffers,
      });
      buffer = await compositeLogoTopRight(buffer, hq.logoBuffer);
      const b2Path = `campaign-brief/${phone}/${purchasedAt}/item_${itemIndex}_slide_${s + 1}.png`;
      await uploadImage(b2Path, buffer, "image/png");
      slides.push({
        id:       s + 1,
        role:     SLIDE_ROLES[s].split(" — ")[0],
        imageUrl: `/api/img?url=${encodeURIComponent(b2Path)}`,
        adContent,
      });
    } catch (err) {
      console.error(`[CampaignBrief:HQ] carousel item ${itemIndex} slide ${s + 1} failed:`, err.message);
      slides.push({ id: s + 1, error: err.message });
    }
  }

  const summaryContent = slides.find(s => s.adContent)?.adContent ?? {};
  return { adContent: summaryContent, slides };
}

// ─── Main entry — called in background after brief is saved ──────────────────

async function generateBriefImages(phone, purchasedAt, briefData) {
  const postCount = briefData.package?.postCount     ?? 0;
  const carCount  = briefData.package?.carouselCount ?? 0;
  const total     = postCount + carCount;

  console.log(`[CampaignBrief] 🎬 starting ${total} items for ${phone}`);

  // Home-screen progress circle: setup + one unit per ad item + finalize.
  const progressLabel =
    briefData.package?.name || CAMPAIGN_TYPE_CONTEXT[briefData.campaignType]?.label || "קמפיין";
  const progressId = await creationProgress.startJob({
    phone, kind: "campaign", total: total + 2, refId: purchasedAt, label: progressLabel,
  });

  try {
  const [styleAnchor, logoBuffer] = await Promise.all([
    generateCampaignStyleAnchor(briefData),
    fetchLogoBuffer(phone),
  ]);

  console.log(`[CampaignBrief] logo: ${logoBuffer ? "✅ found" : "⚠️ not found"}`);

  /* HQ setup — when MOBILE_ADS_HQ is on, load the WOW-Ads-shaped brief +
     reference photo buffers + run business analysis ONCE, then pass the
     shared ctx down to every item. Falls back to the Gemini path silently
     if HQ setup throws (e.g. missing profile). */
  let hq = null;
  if (MOBILE_ADS_HQ) {
    try {
      const { brief, logoBuffer: hqLogo, imageBuffers } = await buildBrief(phone, briefData);
      const analysis = await adq.analyzeBusinessForAds(brief, hqLogo, imageBuffers);
      console.log(`[CampaignBrief:HQ] enabled — scenes=${imageBuffers.length}, nanoTips=${analysis.nanoPromptTips.length}, geminiTips=${analysis.geminiTips.length}`);
      const ctx = buildHqCtx({ brief, analysis, logoBuffer: hqLogo, imageBuffers });
      hq = { brief, ctx, logoBuffer: hqLogo, imageBuffers };
    } catch (err) {
      console.error(`[CampaignBrief:HQ] setup failed — falling back to Gemini path:`, err.message);
      hq = null;
    }
  }

  await creationProgress.setProgress(progressId, 1);

  const images = [];

  for (let i = 0; i < total; i++) {
    const isCarousel = i >= postCount;
    const itemLabel  = isCarousel ? `קרוסלה ${i - postCount + 1}` : `פוסט ${i + 1}`;

    try {
      if (isCarousel) {
        const { adContent, slides } = hq
          ? await generateHqCarouselImages({
              itemIndex: i, postCount, total, briefData, hq, phone, purchasedAt,
            })
          : await generateCarouselImages({
              itemIndex: i, postCount, briefData, styleAnchor, logoBuffer, phone, purchasedAt,
            });
        const item = {
          index:       i,
          type:        "carousel",
          label:       itemLabel,
          description: briefData.postDescriptions?.[i] ?? "",
          adContent,
          slides,
        };
        images.push(item);
        await getDB().collection(USERS_COL).updateOne(
          { phone, "purchasedPackages.purchasedAt": purchasedAt },
          { $push: { "purchasedPackages.$.images": item } }
        );
      } else if (hq) {
        const { imageUrl, adContent } = await generateHqPostImage({
          itemIndex: i, postCount, total, briefData, hq, phone, purchasedAt,
        });
        const item = {
          index:       i,
          type:        "post",
          label:       itemLabel,
          description: briefData.postDescriptions?.[i] ?? "",
          adContent,
          imageUrl,
        };
        images.push(item);
        await getDB().collection(USERS_COL).updateOne(
          { phone, "purchasedPackages.purchasedAt": purchasedAt },
          { $push: { "purchasedPackages.$.images": item } }
        );
      } else {
        const { imageUrl, adContent, nanoPrompt } = await generatePostImage({
          itemIndex: i, postCount, briefData, styleAnchor, logoBuffer, phone, purchasedAt,
        });
        const item = {
          index:       i,
          type:        "post",
          label:       itemLabel,
          description: briefData.postDescriptions?.[i] ?? "",
          adContent,
          imageUrl,
          nanoPrompt,
        };
        images.push(item);
        await getDB().collection(USERS_COL).updateOne(
          { phone, "purchasedPackages.purchasedAt": purchasedAt },
          { $push: { "purchasedPackages.$.images": item } }
        );
      }
      console.log(`[CampaignBrief] ✅ ${itemLabel} done (${i + 1}/${total})`);
    } catch (err) {
      console.error(`[CampaignBrief] ❌ ${itemLabel} failed:`, err.message);
      const errItem = { index: i, type: isCarousel ? "carousel" : "post", label: itemLabel, error: err.message };
      images.push(errItem);
      await getDB().collection(USERS_COL).updateOne(
        { phone, "purchasedPackages.purchasedAt": purchasedAt },
        { $push: { "purchasedPackages.$.images": errItem } }
      ).catch(() => {});
    }
    await creationProgress.setProgress(progressId, i + 2);
  }

  await getDB().collection(USERS_COL).updateOne(
    { phone, "purchasedPackages.purchasedAt": purchasedAt },
    { $set: { "purchasedPackages.$.status": "images_ready" } }
  );

  // Creatives exist → the creation is done from the user's view (FB injection
  // below is a separate step). Mark failed only if not a single image succeeded.
  if (images.some(img => !img.error)) {
    await creationProgress.completeJob(progressId);
  } else {
    await creationProgress.failJob(progressId, "generation produced no images");
  }

  console.log(`[CampaignBrief] 🏁 images done — ${images.length} items saved for ${phone}`);

  // ── Inject ads into Facebook ────────────────────────────────────────────────
  try {
    const fbResult = await injectCampaignToFacebook(phone, briefData, images, purchasedAt);
    if (fbResult) {
      await getDB().collection(USERS_COL).updateOne(
        { phone, "purchasedPackages.purchasedAt": purchasedAt },
        {
          $set: {
            "purchasedPackages.$.facebookCampaignId": fbResult.campaignId,
            "purchasedPackages.$.facebookAdsetId":   fbResult.adsetId,
            "purchasedPackages.$.facebookAdIds":     fbResult.adIds,
            "purchasedPackages.$.facebookAdErrors":  fbResult.adErrors || [],
            "purchasedPackages.$.status":            "campaign_live",
          },
        }
      );
      console.log(`[CampaignBrief] 🚀 campaign live: ${fbResult.campaignId} (${fbResult.adIds.length} ads, ${fbResult.adErrors?.length || 0} errors)`);
    }
  } catch (err) {
    console.error(`[CampaignBrief] ❌ Facebook injection failed for ${phone}:`, err.message);
    // Status stays "images_ready" — images are saved, campaign creation failed
  }
  } catch (err) {
    // Unexpected failure in setup / generation loop — surface it on the circle.
    console.error(`[CampaignBrief] ❌ generateBriefImages failed for ${phone}:`, err.message);
    await creationProgress.failJob(progressId, err.message);
    throw err;
  }
}

// ─── Facebook campaign + adset + ads injection ───────────────────────────────

async function injectCampaignToFacebook(phone, briefData, images, purchasedAt) {
  // Lazy-require to avoid circular deps at module load time
  const { getClientFbCredentials, getPageAccessToken } = require("../controllers/cpanel.controller");

  // Prefer FB creds the app sent in the brief (mobile clients carry their own
  // tokens) — fall back to the Fireberry/users lookup for CPANEL-managed clients.
  const payloadCreds = briefData.fbCreds || null;
  const creds = (payloadCreds?.userToken && payloadCreds?.pageId && payloadCreds?.adAccountId)
    ? payloadCreds
    : await getClientFbCredentials(phone);
  if (!creds?.userToken || !creds?.pageId || !creds?.adAccountId) {
    console.warn(`[CampaignBrief] ⚠️ no FB credentials for ${phone} — skipping FB injection`);
    return null;
  }

  const { userToken, pageId, adAccountId } = creds;
  const actId      = String(adAccountId).startsWith("act_") ? adAccountId : `act_${adAccountId}`;
  // Use the app-supplied page token if present; else derive it from the user token.
  const pageToken  = creds.pageToken || await getPageAccessToken(userToken, pageId);
  if (!pageToken) {
    console.warn(`[CampaignBrief] ⚠️ could not get page token for ${phone} — skipping FB injection`);
    return null;
  }

  // Client name + website from business profile
  const bp = await getDB()
    .collection("business_profiles")
    .findOne({ phone }, { projection: { businessName: 1, websiteUrl: 1 } });
  const clientName = bp?.businessName || phone;
  const websiteUrl = bp?.websiteUrl  || "https://iconiqmedia.co.il";

  const campaignType = briefData.campaignType || "leads";
  const campaignName = `${clientName} - ${Date.now()}`;

  console.log(`[CampaignBrief] 📢 creating FB campaign "${campaignName}" type=${campaignType}`);

  // 1. Campaign (CBO, ACTIVE, 20 ILS/day)
  const campaignId = await fbAds.createCampaign(userToken, actId, campaignName, campaignType);

  // 2. Ad set (ACTIVE, no budget — CBO handles it)
  const adsetId = await fbAds.createAdSet(userToken, actId, campaignId, pageId, campaignType);

  // 3. Lead form — one shared form per leads campaign
  let formId = null;
  if (campaignType === "leads") {
    formId = await fbAds.createLeadForm(pageToken, pageId, `Form-${campaignName}`);
  }

  // 4. Inject each post image as a PAUSED ad
  const adIds = [];
  const adErrors = [];
  const postImages = images.filter(img => !img.error && img.type === "post" && img.imageUrl && img.adContent);

  console.log(`[CampaignBrief] 📌 ${postImages.length} post images to inject (total images=${images.length})`);
  console.log(`[CampaignBrief] 📌 campaignType=${campaignType} formId=${formId} adsetId=${adsetId} actId=${actId}`);

  for (const img of postImages) {
    try {
      // Build absolute public URL for Facebook to fetch
      const publicUrl = `${SERVER_BASE_URL}${img.imageUrl}`;
      console.log(`[CampaignBrief] 🔄 uploading image for ${img.label}: ${publicUrl}`);
      const imageHash = await fbAds.uploadAdImage(userToken, actId, publicUrl);
      console.log(`[CampaignBrief] ✅ image hash: ${imageHash}`);

      let creativeId;
      if (campaignType === "leads" && formId) {
        console.log(`[CampaignBrief] 🔄 creating leads creative for ${img.label} websiteUrl=${websiteUrl}`);
        creativeId = await fbAds.createLeadsCreative(userToken, pageId, actId, imageHash, img.adContent, formId, websiteUrl);
      } else {
        console.log(`[CampaignBrief] 🔄 creating traffic creative for ${img.label} websiteUrl=${websiteUrl}`);
        creativeId = await fbAds.createTrafficCreative(userToken, pageId, actId, imageHash, img.adContent, websiteUrl);
      }
      console.log(`[CampaignBrief] ✅ creative: ${creativeId}`);

      const adId = await fbAds.createAd(
        userToken, actId, adsetId, creativeId,
        `Ad-${img.label || img.index}-${purchasedAt}`
      );
      adIds.push(adId);
      console.log(`[CampaignBrief] ✅ ad created: ${adId} for ${img.label}`);
    } catch (adErr) {
      const errMsg = adErr.message;
      console.error(`[CampaignBrief] ❌ ad injection failed for ${img.label}: ${errMsg}`);
      adErrors.push({ label: img.label, error: errMsg });
    }
  }

  if (adErrors.length > 0) {
    console.error(`[CampaignBrief] ❌ INJECTION SUMMARY: ${adIds.length} ok, ${adErrors.length} failed:`, JSON.stringify(adErrors));
  }

  return { campaignId, adsetId, formId, adIds, adErrors };
}

module.exports = { generateBriefImages };
