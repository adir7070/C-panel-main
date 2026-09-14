'use strict';

/**
 * ops.service — the agent's AUTONOMOUS OPERATIONS layer ("full takeover").
 * Three self-driving loops, user-approved, all money still client-approved:
 *
 *   1. releaseStaleTakeovers  — a human took a thread and went quiet → hand it
 *      back to the AI and answer the client's pending message. No client is
 *      ever left hanging because a manager forgot to return a chat.
 *   2. followUpStaleEscalations — an escalation sat open past the SLA → the
 *      agent sends the client a containing interim update (no promises, per
 *      the brain rules) and stamps the ticket, so silence never reads as abandonment.
 *   3. (auto-resolve lives in auto-resolve.service; the autonomous nightly
 *      entry is autoResolveRecent there — scheduled together with these.)
 *
 * Crons are scheduled in DAYTIME hours only (client pushes at 4am are worse
 * than the problem). Kill switch: AGENT_AUTONOMY=false. Every function takes
 * dryRun to preview exactly what it WOULD do without acting.
 */

const { getDB } = require("../../config/db");

const STALE_TAKEOVER_HOURS = parseInt(process.env.AGENT_STALE_TAKEOVER_HOURS, 10) || 12;
const ESCALATION_SLA_HOURS = parseInt(process.env.AGENT_ESCALATION_SLA_HOURS, 10) || 24;

/* ── 1. release stale human takeovers ──────────────────────────────────────── */

/** Last moment a human was active on the thread (takeover or a human message). */
function lastHumanActivity(doc) {
  let last = doc.humanTakeoverAt ? new Date(doc.humanTakeoverAt).getTime() : 0;
  for (const m of doc.messages || []) {
    if (m.role === "assistant" && m.authorType === "human" && m.createdAt) {
      const t = new Date(m.createdAt).getTime();
      if (t > last) last = t;
    }
  }
  return last;
}

/**
 * releaseStaleTakeovers({ staleHours, dryRun }) →
 *   { candidates: [{phone, idleHours, pendingClientMsg}], released }
 * Hands stale human-held threads back to the AI; if the client left an
 * unanswered message, the AI answers it immediately.
 */
async function releaseStaleTakeovers({ staleHours = STALE_TAKEOVER_HOURS, dryRun = false } = {}) {
  const chat = require("./chat.service");
  const now = Date.now();
  const threads = await getDB().collection("agent_chats")
    .find({ handling: "human", phone: { $type: "string" } },
      { projection: { phone: 1, humanTakeoverAt: 1, ghost: 1, messages: { $slice: -25 } } })
    .limit(50).toArray();

  const candidates = [];
  for (const t of threads) {
    if (t.ghost) continue;   // ghost threads are managed manually by design
    const idleMs = now - lastHumanActivity(t);
    if (idleMs < staleHours * 3600 * 1000) continue;
    const msgs = (t.messages || []).filter(m => m && m.kind !== "system" && (m.role === "user" || m.role === "assistant"));
    const last = msgs[msgs.length - 1];
    candidates.push({
      phone: t.phone,
      idleHours: Math.round(idleMs / 3600000),
      pendingClientMsg: !!(last && last.role === "user"),
    });
  }

  let released = 0;
  if (!dryRun) {
    for (const c of candidates) {
      try {
        await chat.returnToAi(c.phone, { name: "מערכת" });
        if (c.pendingClientMsg) await chat.answerPendingIfAny(c.phone);
        released++;
        console.log(`[ops] released stale takeover ${c.phone} (idle ${c.idleHours}h, pending=${c.pendingClientMsg})`);
      } catch (e) { console.warn(`[ops] release ${c.phone} failed:`, e.message); }
    }
  }
  return { candidates, released, dryRun };
}

/* ── 2. follow up stale escalations ───────────────────────────────────────── */

/**
 * followUpStaleEscalations({ slaHours, dryRun }) →
 *   { candidates: [{phone, category, ageHours}], sent }
 * Open escalations past the SLA (and not followed-up in the last 24h) get a
 * short containing interim update in the client's chat — the agent must not
 * promise outcomes/timelines (brain rules), just acknowledge + reassure.
 */
async function followUpStaleEscalations({ slaHours = ESCALATION_SLA_HOURS, dryRun = false } = {}) {
  const chat = require("./chat.service");
  const { runAgent } = require("./loop");
  const now = Date.now();
  const cutoff = new Date(now - slaHours * 3600 * 1000);
  const refollow = new Date(now - 24 * 3600 * 1000);

  const rows = await getDB().collection("agent_escalations")
    .find({ status: "open", createdAt: { $lte: cutoff },
      followUpCount: { $not: { $gte: 3 } },   // stop nagging after 3 interim updates
      $or: [{ followUpAt: null }, { followUpAt: { $exists: false } }, { followUpAt: { $lte: refollow } }] })
    .sort({ createdAt: 1 }).limit(20).toArray();

  // ONE follow-up per client per run — a client with several open tickets gets a
  // single message covering them, and ALL their stale tickets get stamped.
  const byPhone = new Map();
  for (const esc of rows) {
    const phone = esc.clientPhone;
    if (!phone) continue;
    const entry = byPhone.get(phone) || { phone, ids: [], categories: [], oldest: esc };
    entry.ids.push(esc._id);
    if (!entry.categories.includes(esc.category || "other")) entry.categories.push(esc.category || "other");
    byPhone.set(phone, entry);
  }

  const candidates = [];
  for (const entry of byPhone.values()) {
    const thread = await chat.getThread(entry.phone).catch(() => null);
    if (thread?.handling === "human") continue;   // a human IS on it — not stale for the client
    candidates.push({
      phone: entry.phone,
      category: entry.categories.join("+"),
      tickets: entry.ids.length,
      ageHours: Math.round((now - new Date(entry.oldest.createdAt).getTime()) / 3600000),
      _ids: entry.ids, summary: entry.oldest.summary,
    });
  }

  let sent = 0;
  if (!dryRun) {
    for (const c of candidates) {
      try {
        const { text } = await runAgent({
          phone: c.phone, mode: "proactive", trigger: "escalation_followup", noWrites: true,
          userMessage: `ללקוח ${c.tickets > 1 ? `${c.tickets} פניות פתוחות` : "פנייה פתוחה"} (נושא: ${c.category} — "${String(c.summary || "").slice(0, 150)}") שממתינות לטיפול אנושי כבר ${c.ageHours} שעות. נסח עדכון ביניים אחד קצר, חם ומכיל: הפניות בטיפול ולא נשכחו, מתנצל על ההמתנה, הגורם המתאים יחזור אליו/ה כאן (שמור על מגדר נכון של הלקוח/ה). אסור להבטיח מועד או תוצאה. אם מתאים — הצע עזרה שיווקית בינתיים במשפט אחד.`,
        });
        if (text) {
          await chat.appendMessage(c.phone, { role: "assistant", kind: "chat", text });
          await getDB().collection("agent_escalations").updateMany(
            { _id: { $in: c._ids } }, { $set: { followUpAt: new Date() }, $inc: { followUpCount: 1 } });
          sent++;
          console.log(`[ops] escalation follow-up sent to ${c.phone} (${c.category}, ${c.tickets} ticket(s), ${c.ageHours}h)`);
        }
      } catch (e) { console.warn(`[ops] follow-up ${c.phone} failed:`, e.message); }
    }
  }
  return { candidates: candidates.map(({ _ids, summary, ...rest }) => rest), sent, dryRun };
}

module.exports = { releaseStaleTakeovers, followUpStaleEscalations };
