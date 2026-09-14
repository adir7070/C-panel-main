/**
 * text-gen.service.js — provider-resilient chat/text generation.
 *
 * Drop-in replacement for `openai.chat.completions.create(params)`:
 *   const { chatComplete } = require("./text-gen.service");
 *   const completion = await chatComplete({ model, messages, response_format, ... });
 *   const text = completion.choices[0].message.content;   // ← unchanged
 *
 * PRIMARY: OpenAI (unchanged — same params, same quality). If OpenAI returns a
 * quota / out-of-credit error (429 insufficient_quota), we FALL BACK to Gemini
 * so ad generation completes with ZERO OpenAI credit. The OpenAI message shape
 * `{ choices:[{ message:{ content } }] }` is reconstructed from the Gemini
 * response so no caller has to change how it reads the result.
 *
 * Supports the shapes our pipelines actually use:
 *   - string content
 *   - array content with { type:"text", text } and { type:"image_url", image_url:{ url:"data:...;base64,..." } } (vision)
 *   - response_format:{ type:"json_object" }  → Gemini responseMimeType application/json
 *   - system role → Gemini systemInstruction
 *   - temperature / max_tokens
 *
 * If Gemini ALSO fails, the ORIGINAL OpenAI error is re-thrown so the callers'
 * credit-parking logic (isQuotaError → "waiting_credits") still triggers.
 */
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

/* Lazy Gemini client — never construct at module load (a missing key would
   throw and crash every requiring service at startup). */
let _gemini = null;
function gem() {
  if (!_gemini) _gemini = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY });
  return _gemini;
}

/* Mirror of the pipelines' quota detector (wow-ads.service.js). */
function isQuotaError(err) {
  const status = err?.status || err?.response?.status;
  const msg  = (err?.message || err?.response?.data?.error?.message || "").toLowerCase();
  const code = (err?.code || err?.response?.data?.error?.code || "").toLowerCase();
  return status === 429 || code === "insufficient_quota" ||
    /insufficient_quota|exceeded your current quota|current quota|billing hard limit/i.test(msg);
}

/* One OpenAI content value (string | part[]) → Gemini parts[]. */
function toGeminiParts(content) {
  if (content == null) return [{ text: "" }];
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p === "string") { parts.push({ text: p }); continue; }
    if (p.type === "image_url" || p.image_url) {
      const url = p.image_url?.url || "";
      const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      continue;
    }
    if (p.type === "text" || typeof p.text === "string") { parts.push({ text: p.text ?? "" }); continue; }
    parts.push({ text: typeof p === "object" ? JSON.stringify(p) : String(p) });
  }
  return parts.length ? parts : [{ text: "" }];
}

async function geminiChat(params) {
  const msgs = Array.isArray(params.messages) ? params.messages : [];
  const wantJson = params.response_format?.type === "json_object";

  const systemText = msgs
    .filter(m => m.role === "system")
    .map(m => toGeminiParts(m.content).map(p => p.text).filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");

  const contents = msgs
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: toGeminiParts(m.content) }));

  const config = {};
  if (systemText) config.systemInstruction = systemText;
  if (wantJson) config.responseMimeType = "application/json";
  if (typeof params.temperature === "number") config.temperature = params.temperature;
  if (params.max_tokens) config.maxOutputTokens = params.max_tokens;

  const resp = await gem().models.generateContent({ model: GEMINI_TEXT_MODEL, contents, config });

  let text = (resp?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text).filter(Boolean).join("")
    || (typeof resp?.text === "string" ? resp.text : "")
    || "";
  if (wantJson) text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  return { choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], _provider: "gemini" };
}

/**
 * OpenAI-primary chat completion with a Gemini fallback on out-of-credit.
 * @param {object} params  identical to openai.chat.completions.create params
 * @returns {Promise<{choices:[{message:{content:string}}]}>}
 */
async function chatComplete(params) {
  try {
    return await openai.chat.completions.create(params);
  } catch (err) {
    if (!isQuotaError(err)) throw err; // real (non-credit) error → surface it unchanged
    console.warn(`[text-gen] OpenAI out of credit — falling back to Gemini ${GEMINI_TEXT_MODEL}`);
    try {
      return await geminiChat(params);
    } catch (gErr) {
      console.error(`[text-gen] Gemini text fallback also failed: ${gErr.message} — re-throwing original OpenAI error`);
      throw err; // preserve credit-parking (callers' isQuotaError still matches)
    }
  }
}

module.exports = { chatComplete, geminiChat, isQuotaError, GEMINI_TEXT_MODEL };
