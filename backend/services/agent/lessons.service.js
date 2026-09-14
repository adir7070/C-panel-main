'use strict';

/**
 * lessons.service — the agent's LIVE learning memory (upgrade over the weekly
 * batch brain distill). Lessons are small, TYPED, durable rules mined from real
 * outcomes — a human takeover, a resolved escalation, or the nightly reflection
 * (reflection.service.js) — and injected into the system prompt so the agent
 * covers more on its own next time.
 *
 * Unlike the monolithic `agent_brain` playbook blob, lessons are structured:
 *   { kind: "policy"|"answer"|"phrasing"|"scope"|"escalation"|"pitfall",
 *     title, rule, priority(1-10), tags[], source{type,phone,ref},
 *     active, createdAt, usedCount, lastUsedAt }
 *
 * Injection strategy (prompt-cache friendly): ONE stable text block rendered
 * into the CACHEABLE brain segment — policies first, then by priority, within a
 * char budget. It changes only when lessons change (~daily), so the Anthropic
 * prompt cache stays hot between changes.
 *
 * SAFETY: distillation only READS chat history (append-only rule); money/legal
 * topics may only produce escalation/phrasing lessons — never "solve it yourself".
 */

const { getDB } = require("../../config/db");
const { getClient, MODELS } = require("./anthropic-client");

const col = () => getDB().collection("agent_lessons");

const KINDS = ["policy", "answer", "phrasing", "scope", "escalation", "pitfall"];
const TAGS = ["campaigns", "budget", "leads", "images", "tokens", "billing", "technical", "account", "content", "profile", "escalation", "general"];
const STABLE_BUDGET_CHARS = parseInt(process.env.AGENT_LESSONS_BUDGET, 10) || 1800;

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ active: 1, kind: 1, priority: -1 });
    await col().createIndex({ createdAt: -1 });
    indexed = true;
  } catch (e) { console.warn("[lessons] index ensure failed:", e.message); }
}

/* ── retrieval ──────────────────────────────────────────────────────────────── */

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = { text: null, at: 0 };

/** The stable lessons block for the cacheable system prompt (or null). */
async function getStableLessonsText(force = false) {
  if (!force && _cache.text !== null && (Date.now() - _cache.at) < CACHE_TTL_MS) return _cache.text || null;
  try {
    await ensureIndexes();
    const rows = await col().find({ active: { $ne: false } })
      .sort({ priority: -1, createdAt: -1 }).limit(60).toArray();
    if (!rows.length) { _cache = { text: "", at: Date.now() }; return null; }

    // policies always first (they are rules, not tips), then everything by priority
    const ordered = [...rows.filter(r => r.kind === "policy"), ...rows.filter(r => r.kind !== "policy")];
    const lines = [];
    let used = 0;
    const injectedIds = [];
    for (const r of ordered) {
      const line = `- [${r.kind}] ${r.rule}`;
      if (used + line.length > STABLE_BUDGET_CHARS) break;
      lines.push(line);
      used += line.length;
      injectedIds.push(r._id);
    }
    if (!lines.length) { _cache = { text: "", at: Date.now() }; return null; }

    // usage bookkeeping — once per cache refresh, fire-and-forget
    col().updateMany({ _id: { $in: injectedIds } }, { $inc: { usedCount: 1 }, $set: { lastUsedAt: new Date() } }).catch(() => {});

    const text = lines.join("\n");
    _cache = { text, at: Date.now() };
    return text;
  } catch (e) {
    console.warn("[lessons] getStableLessonsText failed:", e.message);
    return null;
  }
}

/* ── persistence ────────────────────────────────────────────────────────────── */

function normalizeLesson(l, source) {
  if (!l || typeof l.rule !== "string" || l.rule.trim().length < 15) return null;
  const kind = KINDS.includes(l.kind) ? l.kind : "answer";
  const tags = (Array.isArray(l.tags) ? l.tags : []).filter(t => TAGS.includes(t));
  return {
    kind,
    title: String(l.title || l.rule.slice(0, 60)).trim().slice(0, 120),
    rule: l.rule.trim().slice(0, 400),
    priority: Math.min(10, Math.max(1, parseInt(l.priority, 10) || 5)),
    tags: tags.length ? tags : ["general"],
    source: source || { type: "manual" },
    active: true,
    createdAt: new Date(),
    usedCount: 0,
    lastUsedAt: null,
  };
}

/** Insert lessons, skipping near-duplicate titles. Returns count saved. */
async function saveLessons(lessons, source) {
  await ensureIndexes();
  const docs = (lessons || []).map(l => normalizeLesson(l, source)).filter(Boolean);
  if (!docs.length) return 0;
  const existing = await col().find({ active: { $ne: false } }, { projection: { title: 1, rule: 1 } }).toArray();
  const norm = (s) => String(s || "").replace(/[^֐-׿a-z0-9]+/gi, "").toLowerCase();
  const seen = new Set(existing.map(e => norm(e.title)));
  let saved = 0;
  for (const d of docs) {
    const key = norm(d.title);
    if (seen.has(key)) continue;
    await col().insertOne(d);
    seen.add(key);
    saved++;
  }
  if (saved) _cache = { text: null, at: 0 };  // bust the stable-block cache
  return saved;
}

/* ── distillation from a real thread (takeover end / escalation resolved) ───── */

const roleLabel = (m) => {
  if (!m || m.kind === "system") return null;
  if (m.role === "user") return "לקוח";
  if (m.role === "assistant" && m.authorType === "human") return "מנהל אנושי";
  if (m.role === "assistant") return "AI";
  return null;
};

/* Bounded, sanitized transcript tail (binary-safe via chat.service.visibleText). */
function threadTranscript(doc, maxMsgs = 30, maxChars = 3500) {
  let visibleText = (t) => t;
  try { ({ visibleText } = require("./chat.service")); } catch (_) {}
  const msgs = (doc.messages || [])
    .filter(m => m && typeof m.text === "string" && m.text && roleLabel(m))
    .slice(-maxMsgs)
    .map(m => `${roleLabel(m)}: ${visibleText(m.text).replace(/\s+/g, " ").trim().slice(0, 300)}`);
  let out = msgs.join("\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}

const DISTILL_SYSTEM = `אתה מנוע הלמידה של סוכן ה-AI של Kliq (מנהל שיווק ללקוחות בעברית). מפיקים לקחים קטנים וברי-קיימא מתוצאה אמיתית (השתלטות מנהל אנושי / פנייה שנפתרה). כל לקח הוא כלל פעולה ממוקד שינחה את הסוכן בפעם הבאה.
חוקים קשיחים:
- לקח חייב להיות מעשי, ספציפי וקצר (משפט-שניים). לא כלליות ("תהיה אדיב").
- בנושאי כסף/חוזים/החזרים/ביטולים מותר להפיק רק לקחי escalation/phrasing (איך לזהות ולנסח) — לעולם לא לקח שמלמד את הסוכן לפתור אותם בעצמו או להבטיח משהו.
- אל תמציא — רק מה שנתמך בשיחה.
- אל תכפיל לקח קיים (רשימת כותרות קיימות מצורפת) — אם הנושא מכוסה, אל תחזיר אותו.
kinds: policy (כלל התנהגות מחייב), answer (איך לענות לסוג שאלה), phrasing (ניסוח/טון), scope (מה בתחום/מחוץ לתחום), escalation (מתי ואיך להסלים), pitfall (טעות שיש להימנע ממנה).
tags מותרים: ${TAGS.join(", ")}.
החזר JSON בלבד: {"lessons":[{"kind":"...","title":"...","rule":"...","priority":1-10,"tags":["..."]}]} — עד 3 לקחים, או {"lessons":[]} אם אין לקח אמיתי.`;

/**
 * distillLessons({ phone, reason, escalation }) → { saved }
 *   reason ∈ "takeover_end" | "escalation_resolved"
 * Reads the thread, asks Claude for typed lessons, saves non-duplicates.
 * Best-effort — never throws.
 */
async function distillLessons({ phone, reason = "takeover_end", escalation = null } = {}) {
  try {
    const doc = await getDB().collection("agent_chats").findOne(
      { phone: String(phone) }, { projection: { messages: { $slice: -40 }, humanTakeoverAt: 1 } });
    if (!doc) return { saved: 0, reason: "no thread" };
    const transcript = threadTranscript(doc);
    const humanLines = (transcript.match(/מנהל אנושי:/g) || []).length;
    if (!transcript || (reason === "takeover_end" && humanLines < 1)) return { saved: 0, reason: "no human replies" };

    const existing = await col().find({ active: { $ne: false } }, { projection: { title: 1 } })
      .sort({ createdAt: -1 }).limit(60).toArray();

    const parts = [
      `אירוע: ${reason === "escalation_resolved" ? "פנייה שהוסלמה נסגרה" : "מנהל אנושי סיים לטפל בשיחה והחזיר אותה ל-AI"}.`,
      escalation ? `פרטי הפנייה: קטגוריה=${escalation.category || "?"} | תקציר="${String(escalation.summary || "").slice(0, 200)}"` : "",
      `כותרות לקחים קיימים (אל תכפיל): ${existing.map(e => e.title).join(" | ") || "(אין)"}`,
      `השיחה (לקוח / AI / מנהל אנושי):\n${transcript}`,
    ].filter(Boolean).join("\n\n");

    const client = getClient();
    const resp = await client.messages.create({
      model: MODELS.loop, max_tokens: 800, system: DISTILL_SYSTEM,
      thinking: { type: "disabled" },  // JSON-utility call — keep max_tokens for the JSON, not thinking
      messages: [{ role: "user", content: parts }],
    });
    const txt = resp.content.filter(c => c.type === "text").map(c => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse((m ? m[0] : txt).replace(/,\s*([}\]])/g, "$1"));
    const saved = await saveLessons(parsed.lessons, { type: reason, phone: String(phone), ref: escalation?._id ? String(escalation._id) : null });
    if (saved) console.log(`[lessons] distilled ${saved} lesson(s) from ${reason} (${phone})`);
    return { saved };
  } catch (e) {
    console.warn("[lessons] distillLessons failed:", e.message);
    return { saved: 0, error: e.message };
  }
}

/** Admin/inspection listing. */
async function listLessons({ activeOnly = true, limit = 100 } = {}) {
  await ensureIndexes();
  const q = activeOnly ? { active: { $ne: false } } : {};
  return col().find(q).sort({ priority: -1, createdAt: -1 }).limit(limit).toArray();
}

/** Deactivate a bad lesson (never hard-delete — keep the audit). */
async function deactivateLesson(id) {
  const { ObjectId } = require("mongodb");
  await col().updateOne({ _id: new ObjectId(String(id)) }, { $set: { active: false, deactivatedAt: new Date() } });
  _cache = { text: null, at: 0 };
  return { ok: true };
}

module.exports = { getStableLessonsText, saveLessons, distillLessons, listLessons, deactivateLesson, TAGS, KINDS };
