/**
 * gemini-image-gen.service.js — the single Gemini image-generation entrypoint.
 *
 * Replaces the per-pipeline OpenAI Images calls (gpt-image-2). Ad / organic /
 * brief images now go through generateImageBuffer(), which calls
 * gemini-3-pro-image-preview (env GEMINI_IMAGE_MODEL) via @google/genai.
 *
 * Reference images (client scene photos + brand logo) are passed as inlineData
 * parts — client photos FIRST, logo LAST — matching the ordering the old OpenAI
 * `refs` array used (images.edit). Throws on API error / no-image so callers can
 * fall back to the OpenAI path.
 */
const { GoogleGenAI } = require("@google/genai");
const sharp = require("sharp");

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";

/* Lazy client — never construct at module load (a missing key would throw and
   crash every requiring service at startup). Built on first use; a missing key
   then throws inside generateImageBuffer, which the callers catch and fall back
   to OpenAI. */
let _gemini = null;
function client() {
  if (!_gemini) {
    _gemini = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY });
  }
  return _gemini;
}

async function mimeOf(buf) {
  try { const m = await sharp(buf).metadata(); return m.format === "png" ? "image/png" : "image/jpeg"; }
  catch { return "image/jpeg"; }
}

/**
 * Generate a 1:1 ad image with Gemini.
 * @param {string} prompt        the single-line image prompt
 * @param {Buffer[]} refBuffers  reference images (scene photos first, logo last)
 * @returns {Promise<Buffer>}    the generated image bytes
 */
async function generateImageBuffer(prompt, refBuffers = []) {
  const parts = [];
  for (const buf of (refBuffers || [])) {
    if (!buf || !buf.length) continue;
    parts.push({ inlineData: { mimeType: await mimeOf(buf), data: buf.toString("base64") } });
  }
  parts.push({ text: String(prompt || "") });
  const resp = await client().models.generateContent({
    model: GEMINI_IMAGE_MODEL,
    contents: [{ role: "user", parts }],
  });
  const respParts = resp?.candidates?.[0]?.content?.parts || [];
  const imgPart = respParts.find(p => p.inlineData?.data);
  if (!imgPart) throw new Error("Gemini returned no image data");
  return Buffer.from(imgPart.inlineData.data, "base64");
}

module.exports = { generateImageBuffer, GEMINI_IMAGE_MODEL };
