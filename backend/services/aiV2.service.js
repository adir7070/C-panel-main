/**
 * V2-only AI service.
 * All V2 pipeline AI calls live here — ai.service.js is NOT touched.
 */
const { OpenAI } = require("openai");
const { estimateCost } = require("../utils/aiCostEstimator");
const { downloadImageAsBase64 } = require("../utils/mediaProxy");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

const MODEL_V2 = "gpt-4o";
const STRICT_JSON_SUFFIX = "\n\nCRITICAL: Return ONLY valid JSON matching the exact schema. No markdown, no explanation, no extra keys.";

// ─── Internal helper ──────────────────────────────────────────────────────────

async function callOpenAIJson({ messages, maxTokens, label, attempt = 1, requestId = "" }) {
  const completion = await openai.chat.completions.create({
    model: MODEL_V2,
    messages,
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
  });

  const raw = completion.choices[0].message.content || "";
  const u = completion.usage || {};
  const inputTokens = u.prompt_tokens || 0;
  const outputTokens = u.completion_tokens || 0;
  const costUsd = estimateCost(MODEL_V2, inputTokens, outputTokens);

  console.log(JSON.stringify({
    level: "INFO", requestId, step: label, attempt,
    inputTokens, outputTokens, costUsd,
    rawPreview: raw.substring(0, 200),
  }));

  if (!raw) throw new Error(`Empty response from OpenAI (${label})`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    throw Object.assign(
      new Error(`JSON parse failed (${label}): ${parseErr.message}`),
      { type: "parse_failure", raw: raw.substring(0, 100) },
    );
  }

  return { data: parsed, usage: { model: MODEL_V2, inputTokens, outputTokens, costUsd } };
}

// ─── AI Call #1 — Vision Analysis ────────────────────────────────────────────

/**
 * Analyzes an ad creative image using GPT-4o vision.
 * Retries once with a stricter prompt if schema validation fails.
 *
 * @param {string}   systemPrompt
 * @param {string}   userPrompt
 * @param {string}   imageUrl
 * @param {Function} validateFn   - (parsed) => { normalized, result: ZodSafeParseResult }
 * @param {string}   requestId
 * @returns {Promise<{ data: Object|null, usage: Object }>}
 */
exports.analyzeCreativeVision = async (systemPrompt, userPrompt, imageUrl, validateFn, requestId = "") => {
  // Download image to server first — OpenAI cannot access signed CDN URLs (fbcdn.net etc.)
  let inlineImageUrl = null;
  if (imageUrl) {
    console.log(JSON.stringify({ level: "INFO", requestId, step: "vision_proxy", event: "downloading", url: imageUrl.substring(0, 80) }));
    inlineImageUrl = await downloadImageAsBase64(imageUrl);
    console.log(JSON.stringify({ level: "INFO", requestId, step: "vision_proxy", event: "ready", bytes: Math.round(inlineImageUrl.length * 0.75) }));
  }

  const buildMessages = (strict) => [
    { role: "system", content: strict ? systemPrompt + STRICT_JSON_SUFFIX : systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: userPrompt },
        ...(inlineImageUrl ? [{ type: "image_url", image_url: { url: inlineImageUrl, detail: "high" } }] : []),
      ],
    },
  ];

  let retries = 0;
  const { data: parsed, usage } = await callOpenAIJson({
    messages: buildMessages(false), maxTokens: 800, label: "vision", attempt: 1, requestId,
  });

  if (!validateFn) return { data: parsed, usage: { ...usage, retries, fallbackUsed: false } };

  const { normalized, result } = validateFn(parsed);
  if (result.success) return { data: normalized, usage: { ...usage, retries, fallbackUsed: false } };

  console.warn(JSON.stringify({ level: "WARN", requestId, step: "vision", event: "validation_failed", issues: result.error.issues }));
  retries = 1;

  const { data: parsed2, usage: usage2 } = await callOpenAIJson({
    messages: buildMessages(true), maxTokens: 800, label: "vision", attempt: 2, requestId,
  });
  const mergedUsage = {
    model: MODEL_V2,
    inputTokens: usage.inputTokens + usage2.inputTokens,
    outputTokens: usage.outputTokens + usage2.outputTokens,
    costUsd: usage.costUsd + usage2.costUsd,
    retries,
  };

  const { normalized: normalized2, result: result2 } = validateFn(parsed2);
  if (result2.success) return { data: normalized2, usage: { ...mergedUsage, fallbackUsed: false } };

  console.error(JSON.stringify({ level: "ERROR", requestId, step: "vision", event: "retry_failed", issues: result2.error.issues }));
  return { data: null, usage: { ...mergedUsage, fallbackUsed: true } };
};

// ─── AI Call #2 — Copy Generation ────────────────────────────────────────────

/**
 * Generates 3 ad copy variations.
 * Retries once with a stricter prompt if schema validation fails.
 *
 * @param {string}   systemPrompt
 * @param {string}   userPrompt
 * @param {Function} validateFn   - (parsed) => { normalized, result: ZodSafeParseResult }
 * @param {string}   requestId
 * @returns {Promise<{ data: { variations: Array }|null, usage: Object }>}
 */
exports.generateAdCopyV2 = async (systemPrompt, userPrompt, validateFn, requestId = "") => {
  const buildMessages = (strict) => [
    { role: "system", content: strict ? systemPrompt + STRICT_JSON_SUFFIX : systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let retries = 0;
  const { data: parsed, usage } = await callOpenAIJson({
    messages: buildMessages(false), maxTokens: 2000, label: "copyV2", attempt: 1, requestId,
  });

  if (!validateFn) return { data: parsed, usage: { ...usage, retries, fallbackUsed: false } };

  const { normalized, result } = validateFn(parsed?.variations ?? parsed);
  if (result.success) return { data: { variations: normalized }, usage: { ...usage, retries, fallbackUsed: false } };

  console.warn(JSON.stringify({ level: "WARN", requestId, step: "copyV2", event: "validation_failed", issues: result.error.issues }));
  retries = 1;

  const { data: parsed2, usage: usage2 } = await callOpenAIJson({
    messages: buildMessages(true), maxTokens: 2000, label: "copyV2", attempt: 2, requestId,
  });
  const mergedUsage = {
    model: MODEL_V2,
    inputTokens: usage.inputTokens + usage2.inputTokens,
    outputTokens: usage.outputTokens + usage2.outputTokens,
    costUsd: usage.costUsd + usage2.costUsd,
    retries,
  };

  const { normalized: normalized2, result: result2 } = validateFn(parsed2?.variations ?? parsed2);
  if (result2.success) return { data: { variations: normalized2 }, usage: { ...mergedUsage, fallbackUsed: false } };

  console.error(JSON.stringify({ level: "ERROR", requestId, step: "copyV2", event: "retry_failed", issues: result2.error.issues }));
  return { data: null, usage: { ...mergedUsage, fallbackUsed: true } };
};
