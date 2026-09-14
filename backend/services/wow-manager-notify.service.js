/**
 * Notify the account manager when a client responds (approve / reject) to
 * a WOW Ads / Organic / LP approval link. Sends WhatsApp + SMS in parallel
 * (best-effort — never throws into the caller's request flow) and emits a
 * Socket.io event so the cpanel UI refreshes in real time.
 *
 * Lookup chain: client phone → cpanel_clients.agentId → agents.phone
 */
const { getDB } = require("../config/db");

let cachedIo = null;
function setIo(io) { cachedIo = io; }

async function findManagerPhoneForClient(clientPhone) {
  if (!clientPhone) return null;
  try {
    const mapping = await getDB()
      .collection("cpanel_clients")
      .findOne({ phone: String(clientPhone) }, { projection: { agentId: 1 } });
    if (!mapping?.agentId) return null;
    const agent = await getDB()
      .collection("agents")
      .findOne({ _id: mapping.agentId }, { projection: { phone: 1, name: 1 } });
    if (!agent?.phone) return null;
    return { phone: String(agent.phone), name: agent.name || "", agentId: agent._id };
  } catch (err) {
    console.warn("[wow-notify] manager lookup failed:", err.message);
    return null;
  }
}

/**
 * Send manager-notification when client approves/rejects a WOW deliverable.
 *
 * @param {object} opts
 * @param {"ads"|"organic"|"lp"}  opts.kind        Which pipeline.
 * @param {"approved"|"rejected"} opts.decision
 * @param {string}                opts.clientPhone Client phone (used to find the manager).
 * @param {string}                [opts.businessName]
 * @param {string}                [opts.feedback]  Free-text feedback from the client (rejection only).
 * @param {string}                [opts.previewUrl] Link the manager can click to review.
 */
async function notifyManagerOfClientDecision({ kind, decision, clientPhone, businessName, feedback, previewUrl }) {
  const manager = await findManagerPhoneForClient(clientPhone);

  const kindLabel = kind === "ads" ? "המודעות" : kind === "organic" ? "הפוסטים האורגניים" : "דף הנחיתה";
  const head = decision === "approved"
    ? `✅ הלקוח אישר את ${kindLabel}`
    : `❗ הלקוח ביקש שינויים ב${kindLabel}`;
  const tail = previewUrl ? `\n\n🔗 ${previewUrl}` : "";
  const fbLine = feedback ? `\n\n📝 הערות הלקוח:\n"${feedback}"` : "";
  const businessLine = businessName ? `\nעסק: ${businessName}` : "";
  const phoneLine = clientPhone ? `\nטלפון לקוח: ${clientPhone}` : "";
  const message = `${head}${businessLine}${phoneLine}${fbLine}${tail}`;

  /* Real-time push to cpanel UI (the panel polls every ~3.5s anyway, but a
     direct emit lets the manager see the rejection card flip instantly). */
  if (cachedIo && manager?.agentId) {
    try {
      cachedIo.to(`am_${manager.agentId}`).emit("wow_client_response", {
        kind, decision, clientPhone, businessName, feedback, previewUrl,
        at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn("[wow-notify] socket emit failed:", err.message);
    }
  }

  if (!manager?.phone) {
    console.warn(`[wow-notify] no manager phone for client ${clientPhone} — skipping push`);
    return { sent: [], reason: "no manager phone" };
  }

  const sent = [];

  /* WhatsApp via Green API. */
  try {
    const greenApi = require("./greenapi.service");
    await greenApi.sendMessage(manager.phone, message);
    sent.push("whatsapp");
  } catch (err) {
    console.warn(`[wow-notify] WhatsApp to manager ${manager.phone} failed:`, err.message);
  }

  /* SMS fallback via SMS4Free. */
  try {
    const { sendSMS } = require("./sms4free.service");
    await sendSMS(manager.phone, message);
    sent.push("sms");
  } catch (err) {
    console.warn(`[wow-notify] SMS to manager ${manager.phone} failed:`, err.message);
  }

  console.log(`[wow-notify] ${kind}/${decision} → manager ${manager.phone} via [${sent.join(", ") || "none"}]`);
  return { sent, manager: { phone: manager.phone, name: manager.name } };
}

/**
 * Notify the account manager (and admins) when a client completes a package
 * purchase from the mobile app. Emits a real-time socket event so the cpanel
 * shows a celebratory popup, and sends WhatsApp + SMS to the assigned
 * manager (best-effort).
 *
 * @param {object} opts
 * @param {string} opts.clientPhone
 * @param {string} [opts.businessName]   Resolved by caller; we re-look up if
 *                                       missing so the popup is never empty.
 * @param {string} opts.packageName
 * @param {number} opts.amount           ILS, base amount client paid.
 * @param {number} opts.coinsGranted     Coins credited to the user.
 * @param {object} [opts.brief]          Optional brief captured by the
 *   mobile app for social-plan redemptions — { concept, importantInfo[],
 *   cta }. Surfaced in the manager popup payload and appended to the
 *   WhatsApp/SMS body so the manager sees the client's intent.
 */
async function notifyManagerOfPurchase({ clientPhone, businessName, packageName, amount, coinsGranted, brief = null }) {
  const manager = await findManagerPhoneForClient(clientPhone);

  /* Fall back to business_profiles if the caller didn't pass a name —
     mobile checkout doesn't always know it, and the popup is far more
     useful with the business name than a bare phone number. */
  let resolvedName = businessName || null;
  if (!resolvedName && clientPhone) {
    try {
      const bp = await getDB()
        .collection("business_profiles")
        .findOne({ phone: String(clientPhone) }, { projection: { businessName: 1 } });
      resolvedName = bp?.businessName || null;
    } catch (_e) { /* ignore — popup still works without it */ }
  }

  const payload = {
    phone:         String(clientPhone),
    businessName:  resolvedName,
    packageName:   packageName || "חבילה",
    amount:        Number(amount) || 0,
    coinsGranted:  Number(coinsGranted) || 0,
    brief:         brief || null,
    at:            new Date().toISOString(),
    managerAgentId: manager?.agentId ? String(manager.agentId) : null,
  };

  if (cachedIo) {
    try {
      /* Targeted popup to the assigned account manager (their cpanel
         tab will fire the cha-ching). */
      if (manager?.agentId) {
        cachedIo.to(`am_${manager.agentId}`).emit("cpanel_new_purchase", payload);
      }
      /* Admin-wide broadcast so anyone with the admin role logged in
         (and unassigned-client purchases) still sees the event. */
      cachedIo.emit("cpanel_new_purchase_admin", payload);
    } catch (err) {
      console.warn("[purchase-notify] socket emit failed:", err.message);
    }
  }

  if (!manager?.phone) {
    console.warn(`[purchase-notify] no manager phone for client ${clientPhone} — popup-only, no WA/SMS`);
    return { sent: [], reason: "no manager phone" };
  }

  /* Append the brief to the WA/SMS body when present — managers asked
     for it so they can react before opening cPanel. */
  const briefLines = payload.brief ? [
    "",
    "📝 בריף לקוח:",
    payload.brief.concept ? `קונספט: ${payload.brief.concept}` : null,
    Array.isArray(payload.brief.importantInfo) && payload.brief.importantInfo.length
      ? `מידע חשוב: ${payload.brief.importantInfo.join(", ")}` : null,
    payload.brief.cta ? `קריאה לפעולה: ${payload.brief.cta}` : null,
  ].filter(Boolean) : [];

  const lines = [
    `💰 לקוח רכש חבילה — ${payload.packageName}`,
    resolvedName ? `עסק: ${resolvedName}` : null,
    `טלפון לקוח: ${clientPhone}`,
    payload.amount ? `סכום: ₪${payload.amount.toLocaleString("he-IL")}` : null,
    payload.coinsGranted ? `מטבעות שנזקפו: ${payload.coinsGranted.toLocaleString("he-IL")}` : null,
    ...briefLines,
  ].filter(Boolean).join("\n");

  const sent = [];
  try {
    const greenApi = require("./greenapi.service");
    await greenApi.sendMessage(manager.phone, lines);
    sent.push("whatsapp");
  } catch (err) {
    console.warn(`[purchase-notify] WhatsApp to manager ${manager.phone} failed:`, err.message);
  }
  try {
    const { sendSMS } = require("./sms4free.service");
    await sendSMS(manager.phone, lines);
    sent.push("sms");
  } catch (err) {
    console.warn(`[purchase-notify] SMS to manager ${manager.phone} failed:`, err.message);
  }

  console.log(`[purchase-notify] ${clientPhone} → manager ${manager.phone} via [${sent.join(", ") || "none"}]`);
  return { sent, manager: { phone: manager.phone, name: manager.name } };
}

/**
 * Notify a manager that a new client picked them via the mobile
 * choose-your-manager screen. Pure socket push for the popup; no
 * WhatsApp/SMS by design — these come in fast and we don't want to
 * spam managers with messages for every onboarding tap.
 *
 * @param {object} opts
 * @param {string} opts.managerAgentId  Target manager's agent _id (string).
 * @param {string} opts.clientPhone
 * @param {string} [opts.businessName]  Resolved by the caller if known.
 */
function notifyManagerOfClientChose({ managerAgentId, clientPhone, businessName }) {
  if (!cachedIo || !managerAgentId) return;
  try {
    cachedIo.to(`am_${managerAgentId}`).emit("cpanel_client_chose_you", {
      phone:        String(clientPhone),
      businessName: businessName || null,
      chosenManagerId: String(managerAgentId),
      at:           new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[choose-notify] socket emit failed:", err.message);
  }
}

module.exports = { setIo, notifyManagerOfClientDecision, notifyManagerOfPurchase, notifyManagerOfClientChose, findManagerPhoneForClient };
