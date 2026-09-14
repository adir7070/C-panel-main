'use strict';

/**
 * auto-resolve — closes the loop on client requests that FAILED for a technical
 * reason (now fixed). For a given failure cluster (tool + error), it re-attempts
 * each affected client's original request THROUGH THE NORMAL AGENT LOOP — so the
 * safety chokepoint still applies: free/safe actions (image, answer, upload)
 * complete automatically; money actions (launch/budget) still surface an approval
 * card to the client. The client gets the result in their chat + a push.
 *
 * Human-in-the-loop trigger (CPANEL "פתור אוטומטית"); a human is never overridden
 * (threads currently handled by a manager are skipped).
 */

const { getDB } = require("../../config/db");
const { runAgent } = require("./loop");
const chat = require("./chat.service");

let notifyUser;
try { ({ notifyUser } = require("../push-notification.service")); } catch (_) { notifyUser = null; }

/* Reconstruct a natural directive for the agent from the failed tool + its args. */
function buildDirective(tool, args = {}) {
  const j = (o) => JSON.stringify(o || {}).slice(0, 220);
  switch (tool) {
    case "generate_ad_image":
      return `הלקוח ביקש קודם ליצור תמונת מודעה בקונספט: "${args.concept || ""}" והבקשה נכשלה מסיבה טכנית שכבר תוקנה. צור עכשיו את התמונה (generate_ad_image) ומסור ללקוח בהודעה קצרה שהתמונה שביקש מוכנה.`;
    case "launch_campaign":
      return `הלקוח ביקש קודם להשיק קמפיין והבקשה נכשלה טכנית (${j(args)}). נסה להשלים את ההשקה — היא תעבור אישור הלקוח כרגיל. עדכן את הלקוח.`;
    case "create_social_campaign":
      return `הלקוח ביקש ליצור קמפיין סושיאל שנכשל טכנית (${j(args)}). נסה להשלים ועדכן את הלקוח.`;
    case "update_ad_text":
      return `עדכון טקסט מודעה של הלקוח נכשל קודם (${j(args)}). נסה שוב אם עדיין רלוונטי, ועדכן את הלקוח.`;
    case "attach_image_to_service":
    case "add_to_gallery":
      return `שיוך/הוספת תמונה של הלקוח נכשל קודם. אם יש תמונה רלוונטית — השלם, אחרת עדכן את הלקוח בקצרה.`;
    default:
      return `בקשה קודמת של הלקוח (${tool}) נכשלה מסיבה טכנית שכבר תוקנה. השלם אותה עכשיו אם היא עדיין רלוונטית, ועדכן את הלקוח.`;
  }
}

/**
 * resolveCluster({ tool, errorPrefix, windowDays, limit })
 *   → { attempted, skipped, results: [{ phone, ok, skipped, reason }] }
 * Re-runs the latest failed request per affected client for this tool+error.
 */
async function resolveCluster({ tool, errorPrefix = "", windowDays = 7, limit = 25, cooldownHours = 0 } = {}) {
  if (!tool) return { error: "tool required" };
  const since = new Date(Date.now() - windowDays * 86400000);
  const q = { type: "tool_call", status: "failed", tool, at: { $gte: since } };
  if (errorPrefix) q["result.error"] = { $regex: "^" + errorPrefix.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") };

  const rows = await getDB().collection("agent_actions").find(q).sort({ at: -1 }).limit(500).toArray();
  // latest failed sample per client
  const byClient = {};
  for (const r of rows) { const p = String(r.clientPhone || ""); if (p && !byClient[p]) byClient[p] = r; }
  const clients = Object.keys(byClient).slice(0, limit);

  const results = [];
  for (const phone of clients) {
    try {
      const thread = await chat.getThread(phone);
      if (thread.handling === "human") { results.push({ phone, skipped: true, reason: "בטיפול אנושי" }); continue; }
      // autonomous runs pass cooldownHours: at most one auto-resolve message per
      // client per window (state in agent_proactive_state, kind "auto_resolve")
      if (cooldownHours > 0) {
        const state = await getDB().collection("agent_proactive_state")
          .findOne({ phone: String(phone), kind: "auto_resolve" });
        if (state?.lastSentAt && (Date.now() - new Date(state.lastSentAt).getTime()) < cooldownHours * 3600 * 1000) {
          results.push({ phone, skipped: true, reason: "cooldown" }); continue;
        }
      }
      const directive = buildDirective(tool, byClient[phone].args);
      await chat.setThinking(phone, true);
      const { text, actions } = await runAgent({ phone, userMessage: directive, mode: "chat", trigger: "auto_resolve" });
      await chat.appendMessage(phone, {
        role: "assistant", kind: "chat",
        text: text || "השלמתי את הבקשה שנכשלה קודם ✅",
        actions: (actions || []).filter(a => a.status === "awaiting_approval"),
      });
      await chat.setThinking(phone, false);
      if (notifyUser) { try { await notifyUser(phone, "מנהל ה-AI שלך", (text || "עדכון בפנייתך").slice(0, 120), { screen: "AIManager" }); } catch (_) {} }
      if (cooldownHours > 0) {
        await getDB().collection("agent_proactive_state").updateOne(
          { phone: String(phone), kind: "auto_resolve" },
          { $set: { lastSentAt: new Date() }, $inc: { count: 1 } }, { upsert: true });
      }
      results.push({ phone, ok: true });
    } catch (e) {
      await chat.setThinking(phone, false).catch(() => {});
      results.push({ phone, ok: false, reason: e.message });
    }
  }
  return {
    tool, attempted: results.filter(r => r.ok).length,
    skipped: results.filter(r => r.skipped).length,
    failed: results.filter(r => r.ok === false).length,
    results,
  };
}

/**
 * autoResolveRecent({ hours, maxClusters, dryRun }) — the AUTONOMOUS entry
 * (cron 10:05): failure clusters from the last `hours` get re-attempted without
 * anyone pressing the CPANEL button. Guards: fresh failures only, ≤maxClusters
 * per run, one auto-resolve message per client per 24h (cooldown), human-held
 * threads skipped (inherited from resolveCluster).
 */
async function autoResolveRecent({ hours = 24, maxClusters = 5, dryRun = false } = {}) {
  const { aggregateFailures } = require("./tech-report.service");
  const all = await aggregateFailures(Math.max(1, Math.ceil(hours / 24)));
  const cutoff = Date.now() - hours * 3600 * 1000;
  const clusters = all.filter(c => c.lastAt && new Date(c.lastAt).getTime() >= cutoff).slice(0, maxClusters);
  if (dryRun) return { dryRun: true, clusters: clusters.map(c => ({ tool: c.tool, count: c.count, clients: c.clientsAffected, errorSample: String(c.errorSample).slice(0, 80) })) };

  const summary = [];
  for (const c of clusters) {
    const out = await resolveCluster({ tool: c.tool, errorPrefix: c.errorSample, windowDays: 1, limit: 10, cooldownHours: 24 });
    summary.push({ tool: c.tool, attempted: out.attempted, skipped: out.skipped, failed: out.failed });
  }
  console.log(`[auto-resolve] autonomous run: ${clusters.length} cluster(s) → ${JSON.stringify(summary)}`);
  return { clusters: clusters.length, summary };
}

module.exports = { resolveCluster, autoResolveRecent };
