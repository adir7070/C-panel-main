import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export const GENERATED_DIR = path.join(ROOT, "generated");
fs.mkdirSync(GENERATED_DIR, { recursive: true });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_TEXT_MODEL = process.env.GEMINI_HTML_MODEL || "gemini-2.5-pro";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

/* campaign.md is read verbatim and used as the Gemini system prompt —
   editing that file (the actual creative spec) changes generation
   behavior without touching this code. Same idea for the two small
   ad-copy prompt templates. */
const CAMPAIGN_PROMPT = fs.readFileSync(path.join(ROOT, "campaign.md"), "utf8");
const AD_COPY_SYSTEM_TPL = fs.readFileSync(path.join(__dirname, "prompts", "ad-copy-system.md"), "utf8");
const AD_COPY_USER_TPL = fs.readFileSync(path.join(__dirname, "prompts", "ad-copy-user.md"), "utf8");

function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}

function businessProfileShort(answers) {
  const bp = answers?.businessProfile || {};
  const lines = [
    bp.businessName && `שם עסק: ${bp.businessName}`,
    bp.categoryKey && `תחום: ${bp.categoryKey}`,
    bp.subCategoryKeys?.length && `נישה: ${bp.subCategoryKeys.join(", ")}`,
    bp.about && `על העסק: ${bp.about}`,
    bp.targetAudience?.length && `קהל יעד: ${bp.targetAudience.join(", ")}`,
  ].filter(Boolean);
  return lines.join("\n") || "אין מידע נוסף על העסק.";
}

function servicesAndDeals(answers) {
  const bp = answers?.businessProfile || {};
  const services = (bp.services || []).map(s => s?.name || s?.title).filter(Boolean).join(", ");
  const promo = bp.promotion || null;
  return `שירותים: ${services || "לא צוינו שירותים ספציפיים"}\nמבצע נוכחי: ${promo || "ללא מבצע פעיל"}`;
}

/* ── Stage 1 — ad copy (OpenAI) ─────────────────────────────────────── */
async function generateAdCopy(answers, numAds) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY חסר בקובץ .env — נדרש לשלב כתיבת הטקסטים למודעות");
  }
  const hasPromotion = Boolean(answers?.businessProfile?.promotion);
  const system = fill(AD_COPY_SYSTEM_TPL, { count: numAds });
  const user = fill(AD_COPY_USER_TPL, {
    businessProfileShort: businessProfileShort(answers),
    servicesAndDeals: servicesAndDeals(answers),
    count: numAds,
    hasPromotion: hasPromotion ? "יש מבצע פעיל." : "אין מבצע פעיל כרגע.",
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`שלב כתיבת המודעות נכשל: OpenAI HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI לא החזיר תוכן לשלב כתיבת המודעות");
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error("OpenAI החזיר JSON לא תקין לשלב כתיבת המודעות"); }
  const ads = Array.isArray(parsed?.ads) ? parsed.ads : [];
  if (ads.length === 0) throw new Error("OpenAI החזיר מערך מודעות ריק");
  return ads.slice(0, numAds);
}

/* ── Stage 2 — per-ad Gemini image prompt, built from campaign.md ────── */
async function fetchAsBase64(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = r.headers.get("content-type") || "image/png";
    return { mime, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

async function buildImagePrompts({ ads, answers, logoUrl, avatarUrl, brandColors, numAds, fileNames }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY חסר בקובץ .env — נדרש לשלב בניית פרומפט התמונה");
  }
  const adsForPrompt = ads.map(a => ({
    title: a.headline,
    body: a.description,
    cta: a.cta,
    address: a.address || "",
    image_design: a.image_design || "",
  }));

  const userPayload = {
    ADS: adsForPrompt,
    ANSWERS: answers,
    LOGO: logoUrl || null,
    AVATAR: avatarUrl || null,
    BRAND_COLORS: brandColors || null,
    NUM_ADS: numAds,
    FILE_NAMES: fileNames,
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CAMPAIGN_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `נתוני קלט בפועל (JSON):\n${JSON.stringify(userPayload)}` }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) throw new Error(`שלב בניית פרומפט התמונה נכשל: Gemini HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("") ?? "";
  let arr;
  try { arr = JSON.parse(text); } catch { throw new Error("Gemini לא החזיר JSON תקין לשלב בניית הפרומפטים"); }
  if (!Array.isArray(arr)) throw new Error("Gemini לא החזיר מערך לשלב בניית הפרומפטים");
  return arr;
}

/* ── Stage 3 — actual image generation (Gemini image model) ──────────── */
async function generateImage(prompt, logoUrl) {
  const parts = [{ text: prompt }];
  if (logoUrl) {
    const logo = await fetchAsBase64(logoUrl);
    if (logo) parts.push({ inlineData: { mimeType: logo.mime, data: logo.data } });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }] }),
    }
  );
  if (!res.ok) throw new Error(`יצירת התמונה נכשלה: Gemini HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const imgPart = json?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  return imgPart ? Buffer.from(imgPart.inlineData.data, "base64") : null;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Runs the full local ad-generation pipeline (replaces the old Make.com
 * webhook): OpenAI writes the ad copy, then campaign.md (read verbatim)
 * drives Gemini to build one image prompt per ad and generate the image.
 * Images are saved under /generated and served statically by server.js.
 */
export async function generateLocalAds({ answers, logoUrl, avatarUrl, brandColors, numAds }) {
  const n = Math.max(1, Math.min(20, Number(numAds) || 1));
  const fileNames = Array.from({ length: n }, () => `${crypto.randomUUID()}.png`);

  const adCopy = await generateAdCopy(answers, n);
  const prompts = await buildImagePrompts({ ads: adCopy, answers, logoUrl, avatarUrl, brandColors, numAds: n, fileNames });

  return mapWithConcurrency(prompts, 3, async (spec, i) => {
    let imageUrl = "";
    try {
      const buf = await generateImage(spec.prompt, logoUrl);
      if (buf) {
        const fileName = fileNames[i] || `${crypto.randomUUID()}.png`;
        fs.writeFileSync(path.join(GENERATED_DIR, fileName), buf);
        imageUrl = `/generated/${fileName}`;
      }
    } catch (err) {
      console.error(`[local-ads] image generation failed for ad ${i}:`, err.message);
    }
    return {
      prompt: spec.prompt,
      title: spec.title,
      body: spec.body,
      cta: spec.cta,
      address: spec.address ?? "",
      imageUrl,
    };
  });
}
