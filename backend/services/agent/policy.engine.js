'use strict';

/**
 * policy.engine — the SINGLE safety chokepoint. Every write tool the agent
 * wants to run is classified here BEFORE it touches Facebook:
 *   decision ∈ "auto" (run now) | "approval" (queue a card) | "block" (refuse).
 *
 * Rules can only ESCALATE severity (auto → approval → block), never relax —
 * so a permissive per-tool default can still be forced to approval/block by
 * budget math, hard caps, the kill switch, or rate limits.
 */

const { getDB } = require("../../config/db");
const cfg = require("./policy.config");

const ORDER = { auto: 0, approval: 1, block: 2 };
const escalate = (a, b) => (ORDER[b] > ORDER[a] ? b : a);

/* Kill switch — live from admin_settings.agentEnabled (default from config). */
async function isAgentEnabled() {
  try {
    const doc = await getDB().collection("admin_settings").findOne({}, { projection: { agentEnabled: 1 } });
    if (doc && typeof doc.agentEnabled === "boolean") return doc.agentEnabled;
  } catch (_) { /* fall through to default */ }
  return cfg.defaultEnabled;
}

/* Rate state for a client (+ optional campaign), from the executed-write audit. */
async function rateState(phone, campaignId) {
  const out = { writesToday: 0, lastSameCampaignAt: null };
  if (!phone) return out;
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const col = getDB().collection("agent_actions");
    out.writesToday = await col.countDocuments({
      clientPhone: String(phone), type: "tool_call", status: "executed",
      tool: { $in: cfg.writeTools }, at: { $gte: start },
    });
    if (campaignId) {
      const last = await col.find({
        clientPhone: String(phone), type: "tool_call", status: "executed",
        "args.campaignId": String(campaignId),
      }).sort({ at: -1 }).limit(1).toArray();
      out.lastSameCampaignAt = last[0]?.at || null;
    }
  } catch (e) {
    console.warn("[policy] rateState failed:", e.message);
  }
  return out;
}

const minutesSince = (d) => (Date.now() - new Date(d).getTime()) / 60000;

/**
 * classify(toolName, args, ctx) → { decision, reasons[] }
 *   ctx: { phone, campaigns?: [{id,dailyBudget}], monthSpend?: number }
 */
async function classify(toolName, args = {}, ctx = {}) {
  const reasons = [];

  if (!(await isAgentEnabled())) {
    return { decision: "block", reasons: ["AGENT DISABLED — global kill switch is off"] };
  }

  let decision = cfg.toolClass[toolName] || "approval";

  // ── budget-affecting tools: % math + hard caps ──
  if (cfg.budgetTools.includes(toolName)) {
    const newDaily = parseFloat(args.dailyBudgetIls ?? args.dailyBudget);
    if (!Number.isFinite(newDaily) || newDaily <= 0) {
      reasons.push("invalid or missing daily budget");
      decision = escalate(decision, "approval");
    } else {
      if (newDaily > cfg.budget.hardDailyCap) {
        return { decision: "block", reasons: [`daily budget ${newDaily}₪ exceeds HARD daily cap ${cfg.budget.hardDailyCap}₪`] };
      }
      if (Number.isFinite(ctx.monthSpend) && (ctx.monthSpend + newDaily) > cfg.budget.hardMonthlyCap) {
        return { decision: "block", reasons: [`would exceed HARD monthly cap ${cfg.budget.hardMonthlyCap}₪ (spent ${Math.round(ctx.monthSpend)}₪)`] };
      }
      if (newDaily > cfg.budget.approvalAboveDaily) {
        decision = escalate(decision, "approval");
        reasons.push(`daily budget ${newDaily}₪ above approval threshold ${cfg.budget.approvalAboveDaily}₪`);
      }
      const camp = (ctx.campaigns || []).find(c => String(c.id) === String(args.campaignId));
      const current = camp?.dailyBudget;
      if (current == null) {
        decision = escalate(decision, "approval");
        reasons.push("current budget unknown — requires approval");
      } else if (current > 0) {
        const pct = ((newDaily - current) / current) * 100;
        if (pct > cfg.budget.autoIncreasePct) {
          decision = escalate(decision, "approval");
          reasons.push(`budget increase ${pct.toFixed(0)}% exceeds auto limit ${cfg.budget.autoIncreasePct}%`);
        } else if (pct <= 0) {
          reasons.push(`budget decrease ${pct.toFixed(0)}% — safe`);
        } else {
          reasons.push(`budget increase ${pct.toFixed(0)}% within auto limit`);
        }
      }
    }
  }

  // ── rate limits for ALL write tools ──
  if (cfg.writeTools.includes(toolName)) {
    const { writesToday, lastSameCampaignAt } = await rateState(ctx.phone, args.campaignId);
    if (writesToday >= cfg.rateLimits.maxWritesPerClientPerDay) {
      return { decision: "block", reasons: [`rate limit: ${writesToday} writes already today (max ${cfg.rateLimits.maxWritesPerClientPerDay})`] };
    }
    if (lastSameCampaignAt && minutesSince(lastSameCampaignAt) < cfg.rateLimits.minMinutesBetweenSameCampaign) {
      decision = escalate(decision, "approval");
      reasons.push(`only ${Math.round(minutesSince(lastSameCampaignAt))}m since last change to this campaign (min ${cfg.rateLimits.minMinutesBetweenSameCampaign}m)`);
    }
  }

  /* ── FULL-AUTONOMY MODE ──────────────────────────────────────────────
     The agent is the sole operator (no staff to clear an approval queue), so a
     queued "approval" would stall forever. Collapse any "approval" → "auto":
     the agent executes it itself. HARD BLOCKS above (spend caps, rate-limit
     ceiling, kill switch) already returned early and are UNAFFECTED — those are
     safety fuses, not approvals, and continue to protect the business. */
  if (cfg.fullAutonomy && decision === "approval") {
    reasons.push("full-autonomy: sole operator — auto-executing (hard caps + rate fuse + kill switch still apply)");
    decision = "auto";
  }

  if (!reasons.length) reasons.push(`default policy for ${toolName}: ${decision}`);
  return { decision, reasons };
}

module.exports = { classify, isAgentEnabled, rateState };
