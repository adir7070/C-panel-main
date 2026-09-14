'use strict';

/**
 * proactive.service — turns a detected signal into a real, anti-spam-guarded
 * outreach in the client's AI thread.
 *
 * Per client: assemble context → detect signals → pick the top one → check the
 * anti-spam gates → run the agent in PROACTIVE mode (Claude drafts the message
 * grounded in the signal's real numbers) → post to agent_chats → push → record
 * cooldown. Any money action the draft proposes flows through the normal policy
 * chokepoint (auto / approval card).
 *
 * Anti-spam (agent_proactive_state):
 *   - per-kind cooldown: 7 days
 *   - global: at most 1 proactive message / 72h
 *   - suppress if a human messaged this client in the last 24h
 */

const { getDB } = require("../../config/db");
const signals = require("./signals.service");
const chat = require("./chat.service");
const { runAgent } = require("./loop");
const { assembleContext } = require("./context");

let notifyUser;
try { ({ notifyUser } = require("../push-notification.service")); } catch (_) { notifyUser = null; }

const stateCol = () => getDB().collection("agent_proactive_state");
const DAY = 86400000;
const KIND_COOLDOWN_MS = 7 * DAY;
const GLOBAL_COOLDOWN_MS = 3 * DAY;       // ≤1 proactive / 72h
const HUMAN_QUIET_MS = 1 * DAY;           // suppress if human active in last 24h

// Time-sensitive kinds run on their OWN track: a shorter per-kind cooldown, and
// exemption from the global 72h cap in BOTH directions — they aren't blocked by
// other proactive messages, and their own sends don't block other signals. A
// "new leads → follow up now" nudge must be same-day to matter (still gated by
// its own cooldown + the human-quiet rule).
const KIND_COOLDOWN_OVERRIDE_MS = {
  new_leads: (Number(process.env.AGENT_LEADS_NUDGE_HOURS) || 20) * 3600000,
};
const GLOBAL_CAP_EXEMPT = new Set(["new_leads"]);

/* Most recent content (ads/posts) the client received, for the no_content signal. */
async function getLastContentAt(phone) {
  const db = getDB();
  const probes = [
    ["wow_organic_ads_sessions", { phone }],
    ["ai_creation_orders", { phone }],
    ["post_jobs", { phone }],
  ];
  let latest = null;
  for (const [name, q] of probes) {
    try {
      const doc = await db.collection(name).find(q).sort({ createdAt: -1 }).limit(1).project({ createdAt: 1 }).next();
      const t = doc?.createdAt ? new Date(doc.createdAt).getTime() : null;
      if (t && (!latest || t > latest)) latest = t;
    } catch (_) {}
  }
  return latest ? new Date(latest) : null;
}

/* Was a human (manager) in the loop with this client recently? Then stay quiet. */
async function humanMessagedRecently(phone) {
  try {
    const doc = await getDB().collection("support_chats").findOne({ phone }, { projection: { updated_at: 1, messages: { $slice: -1 } } });
    if (!doc) return false;
    const lastMsgAt = doc.messages?.[0]?.createdAt || doc.messages?.[0]?.created_at || doc.updated_at;
    if (!lastMsgAt) return false;
    return (Date.now() - new Date(lastMsgAt).getTime()) < HUMAN_QUIET_MS;
  } catch (_) { return false; }
}

async function cooldownBlocks(phone, kind) {
  try {
    const rows = await stateCol().find({ phone: String(phone) }).toArray();
    const now = Date.now();
    const kindCooldown = KIND_COOLDOWN_OVERRIDE_MS[kind] || KIND_COOLDOWN_MS;
    const sameKind = rows.find(r => r.kind === kind);
    if (sameKind?.lastSentAt && (now - new Date(sameKind.lastSentAt).getTime()) < kindCooldown) {
      return `kind ${kind} in cooldown`;
    }
    // Global 72h cap: exempt kinds neither honor it nor count toward it (so a
    // time-sensitive nudge can't be starved by, or starve, the other signals).
    if (!GLOBAL_CAP_EXEMPT.has(kind)) {
      const lastAny = rows
        .filter(r => !GLOBAL_CAP_EXEMPT.has(r.kind))
        .reduce((mx, r) => Math.max(mx, r.lastSentAt ? new Date(r.lastSentAt).getTime() : 0), 0);
      if (lastAny && (now - lastAny) < GLOBAL_COOLDOWN_MS) return "global 72h cooldown";
    }
    return null;
  } catch (_) { return null; }
}

async function recordProactive(phone, kind) {
  try {
    await stateCol().updateOne(
      { phone: String(phone), kind },
      { $set: { lastSentAt: new Date() }, $inc: { count: 1 } },
      { upsert: true },
    );
  } catch (e) { console.warn("[proactive] recordProactive failed:", e.message); }
}

/**
 * runForClient(phone, { force, nowHour }) → { fired, sent, reason }
 *   force=true skips the cooldown + human-quiet gates (manual trigger/testing).
 */
async function runForClient(phone, { force = false, nowHour } = {}) {
  const ctx = await assembleContext(phone);
  if (ctx.view.performance?.campaignsError && !ctx.creds?.userToken) {
    return { fired: null, sent: false, reason: "no FB data for client" };
  }

  const hour = Number.isInteger(nowHour) ? nowHour : new Date().getHours();
  const lastContentAt = await getLastContentAt(phone);
  const detected = signals.detect(ctx.view, { nowHour: hour, lastContentAt });
  if (!detected.length) return { fired: null, sent: false, reason: "no signal" };

  const top = detected[0];

  if (!force) {
    if (await humanMessagedRecently(phone)) return { fired: top.kind, sent: false, reason: "human active in last 24h" };
    const blocked = await cooldownBlocks(phone, top.kind);
    if (blocked) return { fired: top.kind, sent: false, reason: blocked };
  }

  // Let Claude draft the outreach, grounded in the signal facts.
  let taskLine;
  if (top.kind === "no_campaign") {
    taskLine = top.data?.canLaunch
      ? `ללקוח אין אף קמפיין — עבור לגישה יועצת-מכירתית (סעיף "מכירות"). בהתבסס על פרופיל העסק (שירותים, קהל יעד, תחום) נסח הצעת קמפיין ראשון אחת, קונקרטית ומותאמת: מטרה (בד"כ לידים), המסר/הזווית העיקרית, תקציב יומי מוצע סביר להתחלה, וסוג הקריאייטיב (Kliq מייצר את התמונה והטקסט). הסבר את הערך במונחי הלקוח והזמן אותו להתחיל (בלי להזכיר טוקנים/עלויות — ההשקה כלולה במנוי). אל תשיק עכשיו — רק כשהלקוח יאשר תקרא ל-launch_campaign. בלי הבטחות מספריות.`
      : `ללקוח אין אף קמפיין וגם אין חיבור פייסבוק פעיל. נסח פנייה חמה שמסבירה את הערך של קמפיין ראשון ומזמינה אותו להתחיל, וציין שנעזור לו לחבר את חשבון הפייסבוק. אל תנסה להשיק בלי הרשאות.`;
  } else if (top.kind === "campaign_optimizable" && top.data?.campaignId) {
    // AUTONOMOUS OPTIMIZATION (user-approved): act, don't just suggest. Safe
    // writes execute (billed, transparent); pausing goes through the client's
    // approval card; money-spending changes stay client-approved as always.
    taskLine = `קרא ל-analyze_campaign עם campaignId=${top.data.campaignId} וזהה את המנצחת ואת החלשות לפי המספרים. **בצע בפועל, אל תסתפק בהצעה:** (1) אם יש עד 2 מודעות חלשות עם טקסט נחות — שכתב את הטקסט שלהן בסגנון המנצחת עם update_ad_text (מתבצע אוטומטית). (2) אם יש מודעה מבזבזת מובהקת (הוצאה ממשית, אפס לידים) — קרא ל-pause_ad; זה יפתח ללקוח כרטיס אישור. (3) סכם ללקוח: מה ניתחת, מה כבר בוצע, ומה ממתין לאישורו. אם הנתונים דלים או אין פער ברור — אל תבצע כלום, רק שתף את הניתוח. בסס הכל על המספרים שחזרו.`;
  } else if (top.kind === "new_leads") {
    taskLine = `נכנסו ללקוח ${top.data?.leadsToday} לידים חדשים היום. נסח נודג' קצר, אנרגטי וידידותי: בשר לו על הלידים החדשים, והדגש שכדאי לחזור אליהם **מהר** (בשעה-שעתיים הקרובות) — מהירות התגובה היא הגורם מספר 1 בסגירת לקוח. הצע עזרה קונקרטית אחת אם רלוונטי (רעיון קצר לפתיח שיחה/הודעת וואטסאפ, או להכין יחד תסריט מעקב). אל תמציא מספרים מעבר לנתון שקיבלת, בלי הבטחות. קצר ומעורר לפעולה.`;
  } else if (top.kind === "weekly_wins") {
    taskLine = `שבוע טוב ללקוח — נסח הודעת עדכון חמה, קצרה וחיובית שמשקפת לו את ההצלחה **במספרים האמיתיים שקיבלת** (כמה לידים השבוע, השינוי מהשבוע הקודם אם יש, ועלות ממוצעת לליד אם קיימת). שבח בכנות את מה שעובד וחזק את התחושה שהוא בידיים טובות. הצע צעד קדימה **אחד** להגדיל את ההצלחה (למשל: לשכפל את המודעה המנצחת עם duplicate_ad, או להעלות תקציב מדוד למנצח) — כהצעה, לא כלחץ, וכל פעולה כספית/מבנית תעבור אישור הלקוח. זו בניית אמון ושימור, לא מכירה. אל תמציא מספרים ואל תבטיח תוצאות עתידיות.`;
  } else {
    taskLine = `נסח הודעה יזומה קצרה, אישית ומקצועית ללקוח: מה זיהית (עם המספרים), למה זה חשוב, ומה אתה מציע לעשות.`;
  }
  const trigger = [
    `אירוע שזוהה אוטומטית במעקב אחרי הלקוח: ${top.summary}.`,
    `נתונים: ${JSON.stringify(top.data)}.`,
    taskLine,
    `אם יש פעולה כספית רלוונטית — הצע אותה (היא תעבור אישור הלקוח אם צריך). אל תמציא מספרים מעבר לנתונים שקיבלת.`,
  ].join(" ");

  // PRE-LAUNCH SAFETY: until the app build (with the AI-Manager tab) ships,
  // AGENT_PROACTIVE_PUSH is off → proactive only DRAFTS to agent_chats (read-only,
  // no auto-actions, no push), so we never ping clients who can't see the tab or
  // silently change live accounts. Flip AGENT_PROACTIVE_PUSH=true once the app is out.
  const live = process.env.AGENT_PROACTIVE_PUSH === "true";

  let reply, actions, suggestions;
  try {
    ({ text: reply, actions, suggestions } = await runAgent({ phone, userMessage: trigger, mode: "proactive", trigger: "proactive_cron", noWrites: !live }));
  } catch (e) {
    return { fired: top.kind, sent: false, reason: `agent error: ${e.message}` };
  }
  if (!reply) return { fired: top.kind, sent: false, reason: "empty draft" };

  await chat.postProactive(phone, reply, (actions || []).filter(a => a.status === "awaiting_approval"), suggestions || []);
  await recordProactive(phone, top.kind);

  if (live && notifyUser) {
    try {
      await notifyUser(phone, "מנהל ה-AI שלך", reply.slice(0, 120), { screen: "AIManager", kind: top.kind });
    } catch (e) { console.warn("[proactive] push failed:", e.message); }
  }

  return { fired: top.kind, sent: true, pushed: live, reason: live ? "sent" : "drafted (push gated pre-launch)", signals: detected.map(d => d.kind) };
}

/** Candidate clients for the proactive sweep: those with an active package. */
async function candidatePhones(limit = 200) {
  try {
    const rows = await getDB().collection("users")
      .find({ "activePackage.status": { $in: ["active", "scheduled", "completed"] } }, { projection: { phone: 1 } })
      .limit(limit).toArray();
    return rows.map(r => r.phone).filter(Boolean);
  } catch (e) { console.warn("[proactive] candidatePhones failed:", e.message); return []; }
}

module.exports = { runForClient, candidatePhones, getLastContentAt, humanMessagedRecently };
