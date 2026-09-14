'use strict';

/**
 * escalation.service — the agent's hand-off to a HUMAN manager for things it
 * can't/shouldn't resolve (cancellations, refunds, contractual claims, landing-
 * page fixes, an angry client, an explicit "talk to a human").
 *
 * The backbone is a PERSISTENT QUEUE (`agent_escalations`) that CPANEL lists —
 * so nothing is lost even if a push fails. On top, a best-effort heads-up goes
 * to the client's assigned manager (WhatsApp + SMS + CPANEL socket), reusing the
 * existing manager lookup. The CLIENT only sees a normal reply in the AI chat.
 */

const { getDB } = require("../../config/db");

const col = () => getDB().collection("agent_escalations");
const OPEN_WINDOW_MS = 12 * 60 * 60 * 1000; // fold repeats into one open ticket

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ clientPhone: 1, status: 1 });
    await col().createIndex({ status: 1, createdAt: -1 });
    indexed = true;
  } catch (e) { console.warn("[escalation] index ensure failed:", e.message); }
}

async function resolveBusinessName(phone) {
  try {
    const c = await getDB().collection("cpanel_clients").findOne({ phone: String(phone) }, { projection: { businessName: 1 } });
    if (c?.businessName) return c.businessName;
    const p = await getDB().collection("business_profiles").findOne({ phone: String(phone) }, { projection: { businessName: 1 } });
    return p?.businessName || null;
  } catch (_) { return null; }
}

/* Best-effort heads-up to the client's manager (never throws). */
async function alertManager(manager, { phone, businessName, category, summary }) {
  if (!manager?.phone) return;
  const msg = [
    "🔔 מנהל ה-AI העביר אליך פנייה מלקוח שדורשת טיפול אנושי",
    businessName ? `עסק: ${businessName}` : null,
    `טלפון לקוח: ${phone}`,
    `נושא: ${categoryLabel(category)}`,
    `"${summary}"`,
    "",
    "היכנס ל-CPANEL › פניות מהסוכן לטיפול.",
  ].filter(Boolean).join("\n");
  try { await require("../greenapi.service").sendMessage(manager.phone, msg); } catch (e) { console.warn("[escalation] WA failed:", e.message); }
  try { await require("../sms4free.service").sendSMS(manager.phone, msg); } catch (e) { console.warn("[escalation] SMS failed:", e.message); }
}

function categoryLabel(c) {
  return ({
    billing: "חיוב / תשלום / חשבונית",
    technical: "תקלה טכנית / באג באפליקציה",
    account: "מנוי / פרטי חשבון",
    cancellation: "בקשת ביטול / החזר כספי",
    dissatisfied: "חוסר שביעות רצון מהמודעות",
    landing_page: "תיקונים בדף נחיתה",
    complaint: "תלונה כללית",
    human_request: "ביקש לדבר עם נציג אנושי",
    other: "אחר",
  })[c] || c;
}

/**
 * createEscalation({ phone, category, summary, clientMessage }) → { escalationId }
 * Folds a repeat within 12h into the existing open ticket instead of duplicating.
 */
async function createEscalation({ phone, category, summary, clientMessage }) {
  await ensureIndexes();
  const now = new Date();
  const businessName = await resolveBusinessName(phone);

  let manager = null;
  try { manager = await require("../wow-manager-notify.service").findManagerPhoneForClient(phone); } catch (_) {}

  const existing = await col().findOne({ clientPhone: String(phone), status: "open", createdAt: { $gte: new Date(now.getTime() - OPEN_WINDOW_MS) } });
  const item = { category, summary, clientMessage: clientMessage || summary, at: now };

  if (existing) {
    await col().updateOne({ _id: existing._id }, { $push: { items: item }, $set: { updatedAt: now, lastCategory: category } });
    await alertManager(manager, { phone, businessName, category, summary });
    try { await require("./chat.service").flagNeedsHuman(phone); } catch (_) {}
    return { escalationId: existing._id.toString(), status: "open", added: true };
  }

  const doc = {
    clientPhone: String(phone),
    businessName,
    managerAgentId: manager?.agentId || null,
    managerPhone: manager?.phone || null,
    managerName: manager?.name || null,
    category, lastCategory: category, summary,
    items: [item],
    status: "open",
    createdAt: now, updatedAt: now,
    resolvedAt: null, resolvedBy: null,
  };
  const r = await col().insertOne(doc);
  await alertManager(manager, { phone, businessName, category, summary });
  // surface the client's AI thread in the manager takeover console
  try { await require("./chat.service").flagNeedsHuman(phone); } catch (_) {}
  console.log(`[escalation] opened ${r.insertedId} for ${phone} (${category})${manager?.phone ? ` → manager ${manager.phone}` : " (no manager)"}`);
  return { escalationId: r.insertedId.toString(), status: "open" };
}

/* Which human manager is the triage point for AI escalations. Configurable via
   admin_settings.escalationManagerName or AGENT_ESCALATION_MANAGER; default "נוי". */
async function resolveTriageManagerName() {
  try {
    const doc = await getDB().collection("admin_settings").findOne({}, { projection: { escalationManagerName: 1 } });
    if (doc?.escalationManagerName) return String(doc.escalationManagerName);
  } catch (_) {}
  return process.env.AGENT_ESCALATION_MANAGER || "נוי";
}

/**
 * forwardToManagerInbox({ escalationId, io }) — hand an escalation to a human
 * manager (default Noy) as a real CLIENT CONVERSATION in the WebApp support inbox
 * (`support_chats`), mirroring the proven appointment-injection pattern:
 *   upsert the chat (keyed by client phone) → assign it to the manager's station →
 *   push the escalation as a fromRole:"user" message (so it surfaces as unread +
 *   unanswered) → broadcast the live socket events → mark the escalation forwarded.
 *
 * If the manager isn't found as an `agents` doc, the conversation is still created
 * UNASSIGNED (visible to supervisors/admins) and a warning is returned.
 */
async function forwardToManagerInbox({ escalationId, io }) {
  const { ObjectId } = require("mongodb");
  const db = getDB();
  let _id; try { _id = new ObjectId(String(escalationId)); } catch { return { ok: false, error: "bad id" }; }

  const esc = await col().findOne({ _id });
  if (!esc) return { ok: false, error: "escalation not found" };

  const phone = String(esc.clientPhone);
  const managerName = await resolveTriageManagerName();
  const manager = await db.collection("agents").findOne({ name: managerName }, { projection: { _id: 1, name: 1, station: 1 } });
  const station = manager?.station || null;

  // representative text = category + the escalation summary (+ latest client line)
  const lastItem = Array.isArray(esc.items) && esc.items.length ? esc.items[esc.items.length - 1] : null;
  const clientLine = lastItem?.clientMessage && lastItem.clientMessage !== esc.summary ? `\n"${lastItem.clientMessage}"` : "";
  const text = `🤖 פנייה שהועברה ממנהל ה-AI (${categoryLabel(esc.lastCategory || esc.category)}):\n${esc.summary}${clientLine}`;

  const now = new Date();
  const existing = await db.collection("support_chats").findOne({ _id: phone });

  // upsert the conversation + route it to the manager's station
  const $set = { _id: phone, phone, status: "open", updated_at: now };
  if (esc.businessName && !existing?.name) $set.name = esc.businessName;
  if (station) { $set.station = station; $set.stations = [station]; }
  if (manager?._id) $set.accountManagerId = manager._id;

  const msg = { _id: Date.now(), userId: phone, text, type: "text", fromRole: "user", createdAt: now, agentOnly: false };

  await db.collection("support_chats").updateOne(
    { _id: phone },
    { $set, $push: { messages: msg }, ...(existing ? {} : { $setOnInsert: { created_at: now, agentInitiated: true } }) },
    { upsert: true },
  );

  // live delivery to the staff inbox (+ the client room), reusing the shared broadcast helper
  try {
    const { broadcast } = require("../../utils/broadcast");
    if (!existing) {
      const fresh = await db.collection("support_chats").findOne({ _id: phone });
      broadcast(io, "proactive_chat_created", "support_team", fresh);
    }
    broadcast(io, "receive_message", "support_team", { ...msg, station });
    broadcast(io, "receive_message", phone, msg);
  } catch (e) { console.warn("[escalation] forward broadcast failed:", e.message); }

  await col().updateOne({ _id }, { $set: {
    forwardedToInbox: true, forwardedAt: now,
    forwardedToAgentId: manager?._id || null, forwardedToManagerName: managerName,
  } });

  console.log(`[escalation] forwarded ${escalationId} → inbox for ${phone} (manager "${managerName}"${station ? `, station ${station}` : ", UNASSIGNED"})`);
  return {
    ok: true, chatId: phone, managerName, assigned: !!station,
    warning: manager ? (station ? null : `למנהלת "${managerName}" אין סטציה — הפנייה נכנסה כשיחה לא-משויכת (גלויה למנהלים/מפקחים).`)
                      : `לא נמצאה מנהלת בשם "${managerName}" במערכת המנהלים — הפנייה נכנסה כשיחה לא-משויכת. צור סוכן בשם "${managerName}" כדי לשייך אליה אוטומטית.`,
  };
}

async function listEscalations({ status, phone, limit } = {}) {
  const q = {};
  if (status) q.status = status;
  if (phone) q.clientPhone = String(phone);
  return col().find(q).sort({ createdAt: -1 }).limit(Math.min(parseInt(limit, 10) || 100, 500)).toArray();
}

const SLA_MS = 24 * 60 * 60 * 1000; // "no human response" alert threshold

/**
 * listEscalationsWithStatus — the CONTROL view: each escalation joined with the
 * client's agent_chats thread to derive a handling status (for oversight, not
 * action). Uses handling + humanTakeoverAt as a lightweight proxy (no message
 * scan). status ∈ resolved | human | stale | waiting.
 */
async function listEscalationsWithStatus(opts = {}) {
  const rows = await listEscalations(opts);
  if (!rows.length) return rows;
  const phones = [...new Set(rows.map(r => String(r.clientPhone)))];
  let byPhone = {};
  try {
    const threads = await getDB().collection("agent_chats")
      .find({ phone: { $in: phones } }, { projection: { phone: 1, handling: 1, handledBy: 1, humanTakeoverAt: 1, lastClientMsgAt: 1 } })
      .toArray();
    for (const t of threads) byPhone[String(t.phone)] = t;
  } catch (_) {}

  const now = Date.now();
  return rows.map(esc => {
    const th = byPhone[String(esc.clientPhone)];
    const raisedAt = new Date(esc.createdAt).getTime();
    const tookOverAt = th?.humanTakeoverAt ? new Date(th.humanTakeoverAt).getTime() : null;
    // a human engaged for THIS escalation: currently human-handled, or took over after it was raised
    const humanEngaged = !!th && (th.handling === "human" || (tookOverAt && tookOverAt >= raisedAt));
    let handlingStatus;
    if (esc.status === "resolved") handlingStatus = "resolved";
    else if (humanEngaged) handlingStatus = "human";
    else if (now - raisedAt > SLA_MS) handlingStatus = "stale";
    else handlingStatus = "waiting";
    return {
      ...esc,
      handlingStatus,
      handlingNow: th?.handling || "ai",
      handledByName: th?.handledBy?.name || null,   // the ACTUAL handler (not "forwarded-to")
      humanTakeoverAt: th?.humanTakeoverAt || null,
      responseMs: humanEngaged && tookOverAt && tookOverAt >= raisedAt ? (tookOverAt - raisedAt) : null,
      ageMs: now - raisedAt,
    };
  });
}

async function resolveEscalation(id, by = "manager") {
  const { ObjectId } = require("mongodb");
  let _id; try { _id = new ObjectId(String(id)); } catch { return { ok: false, error: "bad id" }; }
  await col().updateOne({ _id }, { $set: { status: "resolved", resolvedAt: new Date(), resolvedBy: by } });
  return { ok: true };
}

module.exports = { createEscalation, listEscalations, listEscalationsWithStatus, resolveEscalation, forwardToManagerInbox, ensureIndexes, categoryLabel };
