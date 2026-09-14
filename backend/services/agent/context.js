'use strict';

/**
 * context.assembleContext(phone) — gathers the client's bounded, phone-keyed
 * corpus into the agent's working memory for a single run. No vector DB: the
 * per-client data is small and structured, so we assemble it directly.
 *
 * Returns a TWO-part object:
 *   { view, creds, campaigns, monthSpend }
 *   - `view`  : the model-safe snapshot rendered into the system prompt
 *               (NEVER contains tokens).
 *   - `creds` : resolved FB credentials, held by the loop for tool calls only.
 *   - `campaigns`/`monthSpend`: passed to the policy engine for budget math.
 */

const { getDB } = require("../../config/db");
const fbActions = require("../fb-actions.service");
const cpanel = require("../../controllers/cpanel.controller");

/* Coins/tokens are a HIDDEN backend usage-control quota under the subscription
   model — the agent must NEVER see or mention them to the client. So the coin
   balance, buyable token packages, and per-action coin costs are deliberately
   NOT assembled into the view. Actions are "included in the subscription"; the
   billing engine still debits coins silently (services/agent/billing.service). */

const safeNum = (v) => (Number.isFinite(v) ? v : 0);

/**
 * assembleContext(phone, { depth }) — depth ∈ "light"|"medium"|"deep" (default deep).
 *   light  = skip live FB entirely (greeting/ack turns; tools still fetch on demand)
 *   medium = campaigns yes, 14-day leads trend no
 *   deep   = everything
 */
async function assembleContext(phone, { depth = "deep" } = {}) {
  const db = getDB();

  // structured client data (parallel, each guarded)
  const [profileDoc, userDoc, cpanelDoc, recentActions, creds, clientMemory] = await Promise.all([
    db.collection("business_profiles").findOne({ phone }).catch(() => null),
    db.collection("users").findOne({ phone }, { projection: { activePackage: 1, name: 1 } }).catch(() => null),
    db.collection("cpanel_clients").findOne({ phone }, { projection: { managerName: 1, tier: 1, businessName: 1 } }).catch(() => null),
    db.collection("agent_actions").find({ clientPhone: String(phone), status: { $in: ["executed", "awaiting_approval"] } })
      .sort({ at: -1 }).limit(8).toArray().catch(() => []),
    cpanel.getClientFbCredentials(phone).catch(() => null),
    require("./client-memory.service").getFacts(phone).catch(() => []),
  ]);

  // live FB performance (guarded — never throws). Depth prunes the expensive
  // FB round-trips on trivial turns; the model's READ tools can still fetch live.
  let campaigns = [], campaignsError = null, leads = { total: 0, trend: [], days: 14 };
  let perfSkipped = false;
  if (!creds?.userToken) {
    campaignsError = "FB credentials not available for this client";
  } else if (depth === "light") {
    perfSkipped = true;
    campaignsError = "לא נטען (הודעה קצרה) — אם צריך נתוני קמפיינים, קרא ל-get_performance";
  } else {
    const jobs = [fbActions.getCampaigns(creds)];
    if (depth === "deep") jobs.push(fbActions.getLeadsTrend(creds, 14));
    const [cRes, lRes] = await Promise.allSettled(jobs);
    if (cRes.status === "fulfilled") { campaigns = cRes.value.campaigns || []; campaignsError = cRes.value.error || null; }
    else campaignsError = cRes.reason?.message || "campaigns fetch failed";
    if (lRes?.status === "fulfilled") leads = lRes.value;
  }

  const monthSpend = (leads.trend || []).reduce((s, d) => s + safeNum(d.spend), 0);
  const activeCount = campaigns.filter(c => /ACTIVE/i.test(c.effectiveStatus || c.status || "")).length;

  // sanitized profile (the same fields the organic pipeline uses)
  const profile = profileDoc ? {
    businessName: profileDoc.businessName || cpanelDoc?.businessName || null,
    businessField: profileDoc.categoryKey || null,
    about: profileDoc.about || "",
    services: (profileDoc.services || []).map(s => `${s.title}${s.description ? ` — ${s.description}` : ""}`).filter(Boolean),
    // id+title refs so the agent can attach an uploaded image to a specific service
    serviceRefs: (profileDoc.services || []).filter(s => s?.id && s?.title).map(s => ({ id: s.id, title: s.title })),
    targetAudience: Array.isArray(profileDoc.targetAudience) ? profileDoc.targetAudience : [],
    preferredColors: profileDoc.preferredColors || null,
    designStyle: profileDoc.designStyle || null,
    hasLogo: !!profileDoc.logoUrl,
  } : null;

  // Internal Kliq benchmark for the client's field (pooled CPL from our own
  // snapshots) — calibrates the agent's judgment. Cached 1h; null when pools
  // are too small. Skipped on light turns (no performance data to compare).
  let benchmark = null;
  if (depth !== "light") {
    benchmark = await require("./benchmarks.service").getBenchmark(profile?.businessField).catch(() => null);
  }

  const view = {
    phone,
    clientName: userDoc?.name || cpanelDoc?.businessName || profile?.businessName || null,
    manager: cpanelDoc?.managerName || null,
    tier: cpanelDoc?.tier || null,
    profile,
    clientMemory,   // long-term learned facts about this client (client-memory.service)
    account: {
      // NO coin fields here — coins are hidden from the agent under the
      // subscription model (see note at top of file).
      package: userDoc?.activePackage ? {
        name: userDoc.activePackage.name || userDoc.activePackage.packageKey || null,
        status: userDoc.activePackage.status || null,
      } : null,
    },
    benchmark,      // internal pooled CPL benchmark (field + overall), or null
    performance: {
      skipped: perfSkipped,
      activeCampaigns: activeCount,
      totalCampaigns: campaigns.length,
      campaigns: campaigns.map(c => ({
        id: c.id, name: c.name, status: c.effectiveStatus || c.status,
        dailyBudget: c.dailyBudget, spendToday: c.spendToday, leadsToday: c.leadsToday,
        ctr: c.ctr != null ? Number(c.ctr.toFixed(2)) : null, objective: c.objective,
      })),
      campaignsError,
      leads14d: { total: leads.total, byDay: leads.trend },
      spend14d: Number(monthSpend.toFixed(2)),
    },
    recentAgentActions: recentActions.map(a => ({
      at: a.at, tool: a.tool, status: a.status, decision: a.policyDecision, summary: a.result?.summary || null,
    })),
  };

  return { view, creds, campaigns, monthSpend };
}

module.exports = { assembleContext };
