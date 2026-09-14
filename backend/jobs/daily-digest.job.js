/**
 * Daily Digest cron — runs every hour on the hour.
 * For each agent whose schedule.enabled is true and schedule.hour
 * matches the current Asia/Jerusalem hour AND who hasn't had a digest
 * generated in the last 18 hours, this job:
 *   1. Builds the digest (buildDigestItems → OpenAI/Gemini)
 *   2. Stores the run (cpanel_digest_runs)
 *   3. Delivers the digest to every channel the agent picked
 *      (inapp / email / sms / whatsapp).
 *
 * Inapp delivery is implicit (the cpanel reads cpanel_digest_runs).
 * sms / whatsapp / email best-effort, with try/catch per channel so a
 * single broken channel doesn't block the others.
 */

const cron = require("node-cron");
const { getDB } = require("../config/db");

const TZ = "Asia/Jerusalem";
const FRESH_RUN_MS = 18 * 60 * 60 * 1000; // don't double-run within 18h

function nowJerusalem() {
  // Returns hour 0-23 in Jerusalem timezone, regardless of server tz
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    hour12: false,
  });
  return parseInt(fmt.format(new Date()), 10);
}

async function runDigestForAgent(agent, schedule) {
  const agentId = String(agent._id);
  const db = getDB();

  // Skip if a digest was already produced for this agent in the last FRESH_RUN_MS
  const last = await db.collection("cpanel_digest_runs")
    .find({ agentId }).sort({ generatedAt: -1 }).limit(1).next();
  if (last && Date.now() - new Date(last.generatedAt).getTime() < FRESH_RUN_MS) {
    return { skipped: "fresh-run-exists" };
  }

  const phones = (await db.collection("cpanel_clients")
    .find({ agentId }, { projection: { phone: 1 } })
    .toArray())
    .map(c => c.phone);

  // buildDigestItems lives in the controller; require it lazily so the
  // job doesn't pull in the whole controller chain at module load time.
  const { buildDigestItems } = require("../controllers/cpanel.controller");
  const items = typeof buildDigestItems === "function" ? await buildDigestItems(phones) : [];

  const generatedAt = new Date();
  await db.collection("cpanel_digest_runs").insertOne({ agentId, items, generatedAt });

  // Update schedule lastRunAt + nextRunAt
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + 1);
  await db.collection("cpanel_digest_schedule").updateOne(
    { agentId },
    { $set: { lastRunAt: generatedAt, nextRunAt: next, updatedAt: new Date() } },
    { upsert: true }
  );

  // ── Deliver via configured channels ────────────────────────────
  const channels = Array.isArray(schedule.channels) ? schedule.channels : ["inapp"];
  const summary = formatDigestForMessage(items, agent);
  const results = {};

  if (channels.includes("whatsapp") && agent.phone) {
    try {
      const greenApi = require("../services/greenapi.service");
      await greenApi.sendMessage(agent.phone, summary);
      results.whatsapp = "ok";
    } catch (e) {
      console.warn(`[Digest] WhatsApp failed for agent ${agentId}:`, e.message);
      results.whatsapp = `error: ${e.message}`;
    }
  }

  if (channels.includes("sms") && agent.phone) {
    try {
      const { sendSMS } = require("../services/sms4free.service");
      await sendSMS(agent.phone, summary);
      results.sms = "ok";
    } catch (e) {
      console.warn(`[Digest] SMS failed for agent ${agentId}:`, e.message);
      results.sms = `error: ${e.message}`;
    }
  }

  if (channels.includes("email") && agent.email) {
    try {
      const sendEmail = tryRequire("../services/email.service")?.sendEmail
                    || tryRequire("../services/mailer.service")?.sendEmail;
      if (sendEmail) {
        await sendEmail({
          to: agent.email,
          subject: `דייג'סט יומי — ${items.length} תובנות לטיפול`,
          text: summary,
        });
        results.email = "ok";
      } else {
        results.email = "no-email-service";
      }
    } catch (e) {
      console.warn(`[Digest] Email failed for agent ${agentId}:`, e.message);
      results.email = `error: ${e.message}`;
    }
  }

  return { items: items.length, channels: results };
}

function tryRequire(mod) {
  try { return require(mod); } catch { return null; }
}

function formatDigestForMessage(items, agent) {
  const greeting = `שלום ${agent.nickname || agent.name || ""}, דייג'סט יומי 📋`;
  if (!items.length) return `${greeting}\n\nאין פעולות דחופות היום. עבודה טובה!`;
  const lines = items.slice(0, 8).map((it, i) => {
    const sev = it.severity === "high" ? "🔴" : it.severity === "med" ? "🟠" : "🟢";
    const reason = (it.reason || "").substring(0, 80);
    return `${i + 1}. ${sev} ${it.clientName || it.clientPhone}: ${reason}`;
  });
  return `${greeting}\n\n${lines.join("\n")}\n\nכנס ל-cpanel לפעולות מלאות.`;
}

async function tick() {
  try {
    const db = getDB();
    const hour = nowJerusalem();

    const schedules = await db.collection("cpanel_digest_schedule")
      .find({ enabled: true, hour }).toArray();

    if (!schedules.length) return;
    console.log(`[Digest] tick — hour=${hour} JLM, ${schedules.length} schedule(s) match`);

    for (const sched of schedules) {
      try {
        /* Use agentIdQuery — the agents collection mixes UUID and ObjectId
           _ids, so a raw ObjectId-only lookup misses every UUID agent
           silently. */
        const agent = await db.collection("agents").findOne(agentIdQuery(sched.agentId));
        if (!agent) continue;
        const out = await runDigestForAgent(agent, sched);
        console.log(`[Digest] agent ${sched.agentId} →`, out);
      } catch (err) {
        console.warn(`[Digest] schedule ${sched.agentId} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Digest] tick error:", err.message);
  }
}

/* Mirror of admin.controller's agentIdQuery — kept local to avoid a circular
   require with the controller (which itself requires this jobs file later). */
function agentIdQuery(id) {
  try {
    const { ObjectId } = require("mongodb");
    const s = String(id);
    if (ObjectId.isValid(s) && s.length === 24) {
      return { $or: [{ _id: new ObjectId(s) }, { _id: s }] };
    }
    return { _id: s };
  } catch {
    return { _id: String(id) };
  }
}

module.exports = function startDailyDigestJob() {
  if (process.env.NODE_ENV !== "production") {
    console.log("[Digest] ⏭ dev environment — job not started");
    return;
  }
  // Run on the hour, every hour
  cron.schedule("0 * * * *", tick, { timezone: TZ });
  console.log(`[Digest] ✅ Daily-digest job started (every hour on the hour, ${TZ})`);
};
