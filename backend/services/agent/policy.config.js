'use strict';

/**
 * policy.config — the tunable safety rules for the AI account-manager agent.
 * Pure data, no logic (logic lives in policy.engine.js). Override any value via
 * env so prod can be tightened without a deploy.
 *
 * Money is in ILS. "auto" = execute immediately; "approval" = queue an
 * agent_approval card for the client/manager; "block" = never (hard cap).
 */

const num = (envKey, def) => {
  const v = parseFloat(process.env[envKey]);
  return Number.isFinite(v) ? v : def;
};

module.exports = {
  /* Global kill switch is read live from admin_settings.agentEnabled by the
     engine; this is the default when the doc/field is missing. */
  defaultEnabled: process.env.AGENT_ENABLED !== "false",

  /* FULL AUTONOMY — the agent is the SOLE operator of the business (no staff to
     clear an approval queue). When on, the engine collapses every "approval"
     decision to "auto" (the agent executes it itself). HARD BLOCKS still apply
     — spend caps, the rate-limit ceiling and the kill switch are safety fuses,
     NOT approvals, and continue to protect the business. Opt out with
     AGENT_FULL_AUTONOMY=false. */
  fullAutonomy: process.env.AGENT_FULL_AUTONOMY !== "false",

  budget: {
    /* A daily-budget INCREASE up to this % of the current budget auto-executes;
       above it needs approval. */
    autoIncreasePct: num("AGENT_BUDGET_AUTO_PCT", 30),
    /* Any resulting daily budget above this (ILS) needs approval regardless of %. */
    approvalAboveDaily: num("AGENT_BUDGET_APPROVAL_DAILY", 200),
    /* HARD CAPS — never crossed, even with approval-at-propose; re-checked at execute. */
    hardDailyCap: num("AGENT_HARD_DAILY_CAP", 500),
    hardMonthlyCap: num("AGENT_HARD_MONTHLY_CAP", 8000),
    /* A budget DECREASE is always safe (auto). */
  },

  /* Per-tool default classification. The engine may upgrade (never downgrade)
     a decision based on budget math / caps / rate limits. */
  toolClass: {
    // reads — always allowed
    get_performance:      "auto",
    get_leads_trend:      "auto",
    get_campaign_ads:     "auto",
    get_business_profile: "auto",
    get_account_status:   "auto",
    analyze_landing_page: "auto",
    search_targeting:     "auto",
    // writes — safe
    update_ad_text:       "auto",
    update_ad_link:       "auto",
    update_ad_image:      "auto",
    generate_ad_image:    "auto",      // create a fresh AI image on request (billed, not FB-rate-limited)
    edit_ad_image:        "auto",      // turn a client-uploaded photo into a branded ad (billed, not FB-rate-limited)
    remember_client_fact: "auto",      // save a durable client fact to long-term memory (free, not FB)
    add_to_gallery:       "auto",      // file a client-uploaded image → gallery (free, not FB)
    attach_image_to_service: "auto",   // file a client-uploaded image → a service (free, not FB)
    update_profile:       "auto",      // fill the client characterization in chat (free, not FB)
    add_service:          "auto",
    set_logo:             "auto",
    send_message_to_client: "auto",
    update_budget:        "auto",      // engine re-classifies via budget math
    resume_campaign:      "approval",
    // writes — sensitive
    pause_campaign:       "approval",
    pause_ad:             "approval",
    duplicate_ad:         "approval",   // clones a winning ad — structural, client sees it
    update_audience:      "approval",
    delete_ad:            "approval",
    launch_campaign:      "approval",
    create_social_campaign: "approval",
  },

  rateLimits: {
    /* Runaway-loop fuse (NOT an approval gate): high enough not to throttle a
       fully-autonomous operator, low enough to stop a stuck loop. */
    maxWritesPerClientPerDay: num("AGENT_MAX_WRITES_DAY", 50),
    minMinutesBetweenSameCampaign: num("AGENT_MIN_MINUTES_SAME_CAMPAIGN", 30),
  },

  /* Tools that move/affect money — used by the engine for the caps + rate path. */
  writeTools: [
    "update_budget", "update_ad_text", "pause_campaign", "resume_campaign",
    "pause_ad", "duplicate_ad", "update_audience", "delete_ad", "launch_campaign", "create_social_campaign",
  ],
  budgetTools: ["update_budget", "launch_campaign"],
};
