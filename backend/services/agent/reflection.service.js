'use strict';

/**
 * reflection.service — the agent's nightly SELF-REFLECTION. Once a day (cron in
 * account-manager.cron.js) it looks back at yesterday's conversations, labels
 * each thread's OUTCOME in code (resolved / takeover / escalated / abandoned),
 * and asks Claude to mine durable lessons + pitfalls from the failures — which
 * land in the typed lesson store (lessons.service) and flow into every future
 * system prompt. This closes the learning loop WITHOUT any human retraining.
 *
 * Read-only over chat history (append-only rule); writes only agent_lessons.
 */

const { getDB } = require("../../config/db");
const { getClient, MODELS } = require("./anthropic-client");
const lessons = require("./lessons.service");

const MAX_THREADS = parseInt(process.env.AGENT_REFLECTION_MAX_THREADS, 10) || 8;

const roleLabel = (m) => {
  if (!m || m.kind === "system") return null;
  if (m.role === "user") return "לקוח";
  if (m.role === "assistant" && m.authorType === "human") return "מנהל אנושי";
  if (m.role === "assistant") return "AI";
  return null;
};

function transcriptTail(doc, maxMsgs = 18, maxChars = 2200) {
  let visibleText = (t) => t;
  try { ({ visibleText } = require("./chat.service")); } catch (_) {}
  const msgs = (doc.messages || [])
    .filter(m => m && typeof m.text === "string" && m.text && roleLabel(m))
    .slice(-maxMsgs)
    .map(m => `${roleLabel(m)}: ${visibleText(m.text).replace(/\s+/g, " ").trim().slice(0, 250)}`);
  let out = msgs.join("\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}

/* Code-side outcome labeling — deterministic, no LLM. */
function classifyOutcome(doc, { escalatedPhones, since }) {
  const msgs = doc.messages || [];
  const last = [...msgs].reverse().find(m => m && m.kind !== "system" && (m.role === "user" || m.role === "assistant"));
  if (doc.humanTakeoverAt && new Date(doc.humanTakeoverAt) >= since) return "takeover";
  if (escalatedPhones.has(String(doc.phone))) return "escalated";
  if (last && last.role === "assistant" && /\?\s*$/.test(String(last.text || "")) &&
      (Date.now() - new Date(last.createdAt || 0).getTime()) > 6 * 3600 * 1000) return "abandoned";
  return "handled";
}

const REFLECT_SYSTEM = `אתה מנוע הרפלקציה הלילי של סוכן ה-AI של Kliq (מנהל שיווק בעברית). לפניך שיחות מהיממה האחרונה, כל אחת עם תווית תוצאה: handled (טופלה), takeover (מנהל אנושי נאלץ להשתלט), escalated (הוסלמה), abandoned (הלקוח נטש אחרי שאלה של ה-AI).
מטרתך: למצוא דפוסים שחוזרים בכשלים (takeover/escalated/abandoned) ולהפיק לקחים ברי-קיימא שישפרו את הסוכן מחר.
חוקים קשיחים:
- לקח = כלל פעולה ספציפי וקצר. לא כלליות.
- בנושאי כסף/חוזים/החזרים — רק לקחי escalation/phrasing; לעולם לא "לפתור לבד".
- אל תכפיל לקח קיים (רשימת כותרות מצורפת).
- אם אין דפוס אמיתי — החזר רשימה ריקה. עדיף אפס לקחים מאשר לקח מומצא.
kinds: policy/answer/phrasing/scope/escalation/pitfall. tags: ${lessons.TAGS.join(", ")}.
החזר JSON בלבד: {"lessons":[{"kind":"...","title":"...","rule":"...","priority":1-10,"tags":["..."]}]} — עד 4.`;

/**
 * reflect({ hours }) → { threads, outcomes, saved }
 * Mines lessons from the last `hours` of conversations. Best-effort.
 */
async function reflect({ hours = 26 } = {}) {
  try {
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const db = getDB();

    const [threads, escalations] = await Promise.all([
      db.collection("agent_chats")
        .find({ updatedAt: { $gte: since }, "messages.1": { $exists: true } },
          { projection: { phone: 1, humanTakeoverAt: 1, messages: { $slice: -20 } } })
        .sort({ updatedAt: -1 }).limit(MAX_THREADS * 3).toArray(),
      db.collection("agent_escalations").find({ createdAt: { $gte: since } }, { projection: { phone: 1 } }).toArray(),
    ]);
    if (!threads.length) return { threads: 0, saved: 0 };

    const escalatedPhones = new Set(escalations.map(e => String(e.phone)));
    const labeled = threads
      .map(t => ({ t, outcome: classifyOutcome(t, { escalatedPhones, since }) }))
      // failures first — that's where the lessons are; pad with handled for contrast
      .sort((a, b) => (a.outcome === "handled" ? 1 : 0) - (b.outcome === "handled" ? 1 : 0))
      .slice(0, MAX_THREADS);

    const outcomes = labeled.reduce((acc, { outcome }) => { acc[outcome] = (acc[outcome] || 0) + 1; return acc; }, {});
    // nothing failed → nothing to learn tonight
    if (!labeled.some(l => l.outcome !== "handled")) return { threads: labeled.length, outcomes, saved: 0 };

    const existing = await lessons.listLessons({ limit: 60 });
    const body = [
      `כותרות לקחים קיימים (אל תכפיל): ${existing.map(e => e.title).join(" | ") || "(אין)"}`,
      ...labeled.map(({ t, outcome }, i) =>
        `=== שיחה ${i + 1} | תוצאה: ${outcome} ===\n${transcriptTail(t)}`),
    ].join("\n\n");

    const client = getClient();
    const resp = await client.messages.create({
      model: MODELS.loop, max_tokens: 1200, system: REFLECT_SYSTEM,
      thinking: { type: "disabled" },  // JSON-utility call — keep max_tokens for the JSON, not thinking
      messages: [{ role: "user", content: body }],
    });
    const txt = resp.content.filter(c => c.type === "text").map(c => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse((m ? m[0] : txt).replace(/,\s*([}\]])/g, "$1"));
    const saved = await lessons.saveLessons(parsed.lessons, { type: "reflection" });
    console.log(`[reflection] ${labeled.length} threads (${JSON.stringify(outcomes)}) → ${saved} lesson(s) saved`);
    return { threads: labeled.length, outcomes, saved };
  } catch (e) {
    console.warn("[reflection] failed:", e.message);
    return { error: e.message, saved: 0 };
  }
}

module.exports = { reflect };
