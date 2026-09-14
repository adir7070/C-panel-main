'use strict';

/**
 * context-depth — deterministic (no LLM) classifier that decides HOW MUCH
 * context to assemble for a run. A "תודה"/"בוקר טוב" doesn't need two live
 * Facebook API round-trips + style retrieval; a "מה מצב הקמפיינים" does.
 * Saves tokens, latency, and FB rate-limit budget on trivial turns.
 *
 *   light  — greetings/acks: skip live FB fetch + style-RAG (tools can still
 *            fetch live data if the model decides it needs it).
 *   medium — general chat: campaigns yes, 14-day leads trend no.
 *   deep   — data/action intents, proactive runs, vision runs: everything.
 *
 * SAFETY: never downgrade when the assistant just asked a question (the short
 * "כן" continues a data-bearing intent), or when an approval might be pending.
 */

const ACK_RE = /^(תודה( רבה)?|אוקי+י?|או קיי|סבבה|מעולה|נהדר|יופי|מגניב|היי+|שלום|הי|בוקר טוב|ערב טוב|צהריים טובים|לילה טוב|👍|🙏|❤️|חג שמח|שבת שלום|ביי|להתראות|בסדר( גמור)?|אחלה|וואו|תודה לך|כן|לא|אמן)[!.\s🙂😊👍🙏❤️]*$/;

const DEEP_RE = /(קמפיין|מודע|ליד|תקציב|ביצוע|מצב|דוח|נתונ|תמונ|פוסט|השק|סטטוס|כמה|טוקנ|קואצ|באנר|קריאייטיב|אתר|דף נחיתה|קהל|פרסום|תוצאות|הוצאה|עלות|analytics|לקדם|שיווק|סושיאל|אינסטגרם|פייסבוק|וידאו|סרטון)/;

/**
 * classifyDepth({ userMessage, history, mode, hasImage }) → "light"|"medium"|"deep"
 */
function classifyDepth({ userMessage, history = [], mode = "chat", hasImage = false } = {}) {
  if (mode !== "chat" || hasImage) return "deep";          // proactive/manager/vision → full context
  const msg = String(userMessage || "").trim();
  if (!msg) return "deep";

  if (DEEP_RE.test(msg)) return "deep";

  // the previous assistant turn asked something → this short reply carries intent
  const lastAssistant = [...history].reverse().find(m => m.role === "assistant");
  const lastAskedQuestion = typeof lastAssistant?.content === "string" && /\?\s*$/.test(lastAssistant.content.trim());

  if (msg.length <= 30 && ACK_RE.test(msg) && !lastAskedQuestion) return "light";
  return "medium";
}

module.exports = { classifyDepth };
