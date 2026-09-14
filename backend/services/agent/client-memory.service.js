'use strict';

/**
 * client-memory.service — the agent's LONG-TERM MEMORY of each client as a
 * person/business. Structured data (profile, campaigns, coins) is assembled
 * live per run; this holds what's NOT derivable from data: durable facts the
 * client stated — preferences ("מעדיף תמונות בלי טקסט"), working context
 * ("אשתו מנהלת את החשבון"), decisions ("סירב לוובינר — לא להציע שוב"),
 * communication style. One doc per phone, bounded, rendered into the context
 * prompt so the agent KNOWS the client, not just their numbers.
 *
 * Facts get in two ways:
 *   ACTIVE  — the agent calls the remember_client_fact tool mid-conversation.
 *   PASSIVE — nightly sweep distills facts from recent threads (cron 03:30).
 *
 * SAFETY: facts must be things the client stated (never inferred sensitive
 * data); no payment/credentials; no live marketing metrics (those come from
 * the structured context and go stale). Read-only over chat history.
 */

const { getDB } = require("../../config/db");
const { getClient, MODELS } = require("./anthropic-client");

const col = () => getDB().collection("agent_client_memory");

const CATEGORIES = ["העדפות", "עסק", "תקשורת", "החלטות", "אישי"];
const MAX_ACTIVE_FACTS = 30;
const RENDER_BUDGET_CHARS = 900;

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ phone: 1 }, { unique: true });
    indexed = true;
  } catch (e) { console.warn("[client-memory] index ensure failed:", e.message); }
}

const factId = () => "f_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ── write ──────────────────────────────────────────────────────────────────── */

/** Add one fact (agent tool / distill). Near-duplicate texts are skipped. */
async function addFact(phone, { fact, category = "העדפות", source = "agent" }) {
  await ensureIndexes();
  const text = String(fact || "").trim().slice(0, 200);
  if (text.length < 5) return { ok: false, error: "עובדה קצרה/ריקה מדי" };
  const cat = CATEGORIES.includes(category) ? category : "העדפות";

  const doc = await col().findOne({ phone: String(phone) });
  const norm = (s) => String(s).replace(/[^֐-׿a-z0-9]+/gi, "").toLowerCase();
  const existing = (doc?.facts || []).filter(f => f.active !== false);
  if (existing.some(f => norm(f.fact) === norm(text))) return { ok: true, duplicate: true };

  const f = { id: factId(), fact: text, category: cat, source, active: true, createdAt: new Date() };
  await col().updateOne(
    { phone: String(phone) },
    { $push: { facts: f }, $set: { updatedAt: new Date() } },
    { upsert: true },
  );
  // bounded memory — retire the oldest active fact beyond the cap (never delete)
  if (existing.length + 1 > MAX_ACTIVE_FACTS) {
    const oldest = existing.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    if (oldest) await deactivateFact(phone, oldest.id);
  }
  return { ok: true, id: f.id };
}

async function deactivateFact(phone, id) {
  await col().updateOne(
    { phone: String(phone), "facts.id": id },
    { $set: { "facts.$.active": false, "facts.$.deactivatedAt": new Date(), updatedAt: new Date() } },
  );
  return { ok: true };
}

/* ── read ───────────────────────────────────────────────────────────────────── */

/** Active facts for the context prompt (bounded chars, newest last). */
async function getFacts(phone) {
  try {
    const doc = await col().findOne({ phone: String(phone) }, { projection: { facts: 1 } });
    const active = (doc?.facts || []).filter(f => f.active !== false);
    const lines = [];
    let used = 0;
    for (const f of active) {
      const line = `[${f.category}] ${f.fact}`;
      if (used + line.length > RENDER_BUDGET_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    return lines;
  } catch (_) { return []; }
}

/** Full doc for the admin/console view. */
async function getMemoryDoc(phone) {
  return col().findOne({ phone: String(phone) });
}

/* ── passive distillation ───────────────────────────────────────────────────── */

const roleLabel = (m) => {
  if (!m || m.kind === "system") return null;
  if (m.role === "user") return "לקוח";
  if (m.role === "assistant" && m.authorType === "human") return "מנהל";
  if (m.role === "assistant") return "AI";
  return null;
};

const DISTILL_SYSTEM = `אתה מנוע הזיכרון של סוכן ה-AI של Kliq. מהשיחה מחלצים עובדות קבועות על הלקוח שיעזרו לסוכן להכיר אותו בשיחות הבאות.
חוקים קשיחים:
- רק מה שהלקוח אמר במפורש או שעולה חד-משמעית מדבריו. לא ניחושים.
- עובדה = קבועה לאורך זמן. אסור נתוני שיווק חיים (לידים/תקציב/יתרה — יש לסוכן בזמן אמת), אסור פרטי תשלום/סיסמאות, אסור מידע רגיש (בריאות/פוליטיקה).
- דוגמאות טובות: "מעדיף תמונות בלי טקסט עליהן", "אשתו רותם מנהלת את החשבון בפועל", "סירב פעמיים להצעת וובינר — לא להציע שוב", "עונה בעיקר בערב", "טון מועדף: קצר ולעניין".
- אל תכפיל עובדה קיימת (רשימה מצורפת). אם עובדה קיימת כבר לא נכונה — החזר את ה-id שלה ב-outdatedIds.
categories: ${CATEGORIES.join(" / ")}.
החזר JSON בלבד: {"facts":[{"fact":"...","category":"..."}],"outdatedIds":["..."]} — עד 4 עובדות, או רשימות ריקות.`;

/**
 * distillFacts(phone) — mine durable client facts from the recent thread.
 * Best-effort; skips when the thread is too thin.
 */
async function distillFacts(phone) {
  try {
    const thread = await getDB().collection("agent_chats").findOne(
      { phone: String(phone) }, { projection: { messages: { $slice: -30 } } });
    const msgs = (thread?.messages || []).filter(m => m && typeof m.text === "string" && m.text && roleLabel(m));
    const clientMsgs = msgs.filter(m => m.role === "user").length;
    if (clientMsgs < 2) return { saved: 0, reason: "thread too thin" };

    let visibleText = (t) => t;
    try { ({ visibleText } = require("./chat.service")); } catch (_) {}
    const transcript = msgs.map(m => `${roleLabel(m)}: ${visibleText(m.text).replace(/\s+/g, " ").trim().slice(0, 250)}`).join("\n").slice(-3000);

    const doc = await col().findOne({ phone: String(phone) }, { projection: { facts: 1 } });
    const existing = (doc?.facts || []).filter(f => f.active !== false);

    const client = getClient();
    const resp = await client.messages.create({
      model: MODELS.loop, max_tokens: 600, system: DISTILL_SYSTEM,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: `עובדות קיימות:\n${existing.map(f => `${f.id}: [${f.category}] ${f.fact}`).join("\n") || "(אין)"}\n\nהשיחה:\n${transcript}` }],
    });
    const txt = resp.content.filter(c => c.type === "text").map(c => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse((m ? m[0] : txt).replace(/,\s*([}\]])/g, "$1"));

    let saved = 0;
    for (const f of (parsed.facts || []).slice(0, 4)) {
      const r = await addFact(phone, { fact: f.fact, category: f.category, source: "distill" });
      if (r.ok && !r.duplicate) saved++;
    }
    for (const id of (parsed.outdatedIds || [])) {
      if (existing.some(f => f.id === id)) await deactivateFact(phone, id);
    }
    if (saved) console.log(`[client-memory] ${phone}: +${saved} fact(s)`);
    return { saved };
  } catch (e) {
    console.warn("[client-memory] distillFacts failed:", e.message);
    return { saved: 0, error: e.message };
  }
}

/** Nightly sweep — distill facts for every thread active in the window. */
async function sweep({ hours = 26, limit = 15 } = {}) {
  try {
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const threads = await getDB().collection("agent_chats")
      .find({ updatedAt: { $gte: since }, phone: { $type: "string" }, "messages.3": { $exists: true } },
        { projection: { phone: 1 } })
      .sort({ updatedAt: -1 }).limit(limit).toArray();
    let total = 0;
    for (const t of threads) {
      const { saved } = await distillFacts(t.phone);
      total += saved || 0;
    }
    console.log(`[client-memory] sweep: ${threads.length} thread(s) → ${total} fact(s)`);
    return { threads: threads.length, saved: total };
  } catch (e) {
    console.warn("[client-memory] sweep failed:", e.message);
    return { error: e.message };
  }
}

module.exports = { addFact, deactivateFact, getFacts, getMemoryDoc, distillFacts, sweep, CATEGORIES };
