'use strict';

/**
 * account-manager.cron — the PROACTIVE heartbeat of the AI account manager.
 * Hourly (Asia/Jerusalem) it sweeps active clients, detects performance signals,
 * and — through the anti-spam gates — reaches out in the client's AI thread.
 *
 * DEFAULT-OFF: gated by AGENT_PROACTIVE_ENABLED === "true" so it never fires
 * before the app's AI-Manager tab ships (mirrors the social-autopublish flag
 * pattern). The global kill switch (admin_settings.agentEnabled) also stops it.
 */

const cron = require("node-cron");
const proactive = require("../services/agent/proactive.service");
const policy = require("../services/agent/policy.engine");

const PROACTIVE_ON = process.env.AGENT_PROACTIVE_ENABLED === "true";
const AUTODISTILL_ON = process.env.AGENT_BRAIN_AUTODISTILL !== "false"; // default ON
const BATCH = parseInt(process.env.AGENT_PROACTIVE_BATCH, 10) || 3;   // FB-rate-friendly fan-out
const MAX_CLIENTS = parseInt(process.env.AGENT_PROACTIVE_MAX, 10) || 200;

let running = false;

/** Run one sweep over candidate clients. Exported for manual/admin trigger. */
async function runProactiveSweep({ force = false } = {}) {
  if (running) { console.log("[AcctMgrCron] sweep already running — skip"); return { skipped: true }; }
  running = true;
  const started = Date.now();
  const summary = { scanned: 0, sent: 0, fired: 0, byReason: {} };
  try {
    if (!(await policy.isAgentEnabled())) {
      console.log("[AcctMgrCron] agent disabled (kill switch) — skip sweep");
      return { skipped: true, reason: "kill switch" };
    }
    const phones = await proactive.candidatePhones(MAX_CLIENTS);
    console.log(`[AcctMgrCron] sweep over ${phones.length} client(s)`);

    for (let i = 0; i < phones.length; i += BATCH) {
      const slice = phones.slice(i, i + BATCH);
      const results = await Promise.allSettled(slice.map(p => proactive.runForClient(p, { force })));
      results.forEach((r, idx) => {
        summary.scanned++;
        if (r.status === "fulfilled") {
          const v = r.value;
          if (v.fired) summary.fired++;
          if (v.sent) summary.sent++;
          summary.byReason[v.reason] = (summary.byReason[v.reason] || 0) + 1;
          if (v.sent) console.log(`[AcctMgrCron] ✉️  ${slice[idx]} → ${v.fired} (${v.reason})`);
        } else {
          summary.byReason["error"] = (summary.byReason["error"] || 0) + 1;
          console.warn(`[AcctMgrCron] ${slice[idx]} error: ${r.reason?.message || r.reason}`);
        }
      });
    }
    console.log(`[AcctMgrCron] done in ${Math.round((Date.now() - started) / 1000)}s:`, JSON.stringify(summary));
    return summary;
  } catch (e) {
    console.error("[AcctMgrCron] sweep failed:", e.message);
    return { error: e.message, ...summary };
  } finally {
    running = false;
  }
}

/* Re-distill the brain from the latest manager conversations (shadow learning). */
async function runBrainDistill() {
  try {
    const { distillPlaybook } = require("../jobs/distill-playbook.job");
    const out = await distillPlaybook({ dryRun: false });
    console.log("[AcctMgrCron] brain re-distilled:", JSON.stringify(out.version ? { version: out.version, stats: out.stats } : out));
    return out;
  } catch (e) {
    console.error("[AcctMgrCron] brain distill failed:", e.message);
    return { error: e.message };
  }
}

function startAccountManagerCron() {
  if (PROACTIVE_ON) {
    cron.schedule("0 * * * *", () => { runProactiveSweep().catch(e => console.error("[AcctMgrCron]", e.message)); },
      { timezone: "Asia/Jerusalem" });
    console.log("✅ [AcctMgrCron] proactive sweep scheduled (hourly, Asia/Jerusalem)");
  } else {
    console.log("⏸️  [AcctMgrCron] proactive disabled (AGENT_PROACTIVE_ENABLED!=='true') — not scheduling sweep");
  }

  if (AUTODISTILL_ON) {
    // weekly — Sunday 04:00 Israel time, off-peak
    cron.schedule("0 4 * * 0", () => { runBrainDistill().catch(e => console.error("[AcctMgrCron]", e.message)); },
      { timezone: "Asia/Jerusalem" });
    console.log("✅ [AcctMgrCron] weekly brain re-distillation scheduled (Sun 04:00, Asia/Jerusalem)");
  }

  // NIGHTLY SELF-LEARNING (default ON, kill via AGENT_REFLECTION=false):
  //   03:20 — reflection: mine typed lessons from yesterday's failed/escalated
  //            conversations (reflection.service → agent_lessons → system prompt).
  //   03:40 — style-RAG index refresh: embed new real manager replies so the
  //            agent keeps matching the humans' live voice (style-rag.service).
  if (process.env.AGENT_REFLECTION !== "false") {
    cron.schedule("20 3 * * *", () => {
      require("../services/agent/reflection.service").reflect()
        .catch(e => console.error("[AcctMgrCron] reflection:", e.message));
    }, { timezone: "Asia/Jerusalem" });
    cron.schedule("40 3 * * *", () => {
      require("../services/agent/style-rag.service").buildIndex()
        .catch(e => console.error("[AcctMgrCron] style-rag:", e.message));
    }, { timezone: "Asia/Jerusalem" });
    //   03:30 — client-memory sweep: distill durable per-client facts from the
    //            day's conversations (client-memory.service → agent_client_memory).
    cron.schedule("30 3 * * *", () => {
      require("../services/agent/client-memory.service").sweep()
        .catch(e => console.error("[AcctMgrCron] client-memory:", e.message));
    }, { timezone: "Asia/Jerusalem" });
    //   03:50 — quality judge: an Opus judge scores yesterday's real replies;
    //            failures become live lessons + a daily quality-trend doc.
    cron.schedule("50 3 * * *", () => {
      require("../services/agent/quality-judge.service").judge()
        .catch(e => console.error("[AcctMgrCron] quality-judge:", e.message));
    }, { timezone: "Asia/Jerusalem" });
    console.log("✅ [AcctMgrCron] nightly reflection (03:20) + client-memory (03:30) + style-index (03:40) + quality-judge (03:50) scheduled");
  }

  // AUTONOMOUS OPERATIONS (user-approved "full takeover"; kill: AGENT_AUTONOMY=false).
  // Deliberately DAYTIME-only — these send client-facing messages/pushes.
  if (process.env.AGENT_AUTONOMY !== "false") {
    //   hourly 08-21 at :15 — release stale human takeovers + answer pending msgs
    cron.schedule("15 8-21 * * *", () => {
      require("../services/agent/ops.service").releaseStaleTakeovers()
        .catch(e => console.error("[AcctMgrCron] stale-takeovers:", e.message));
    }, { timezone: "Asia/Jerusalem" });
    //   10:25 + 16:25 — containing interim updates on escalations past the SLA
    cron.schedule("25 10,16 * * *", () => {
      require("../services/agent/ops.service").followUpStaleEscalations()
        .catch(e => console.error("[AcctMgrCron] escalation-followups:", e.message));
    }, { timezone: "Asia/Jerusalem" });
    //   10:05 — autonomously re-attempt yesterday's failed client requests
    cron.schedule("5 10 * * *", () => {
      require("../services/agent/auto-resolve.service").autoResolveRecent()
        .catch(e => console.error("[AcctMgrCron] auto-resolve:", e.message));
    }, { timezone: "Asia/Jerusalem" });
    console.log("✅ [AcctMgrCron] autonomy: stale-takeover release (hourly 08-21) + escalation follow-ups (10:25,16:25) + auto-resolve (10:05) scheduled");
  }
}

module.exports = { startAccountManagerCron, runProactiveSweep, runBrainDistill };
