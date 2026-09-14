const { DB } = require("../config/db");

/**
 * Initialize all database indexes
 * This function creates indexes for all collections to optimize query performance
 */
const initializeIndexes = async () => {
  try {
    console.log("🔧 [DB] Initializing database indexes...");

    // Payment lock rows + panel revenue ledger. Own try: an old duplicate
    // must not stop the rest of the index build (and vice versa).
    try {
      await require("../services/purchase-sync.service").ensurePaymentIndexes(require("../config/db").getDB());
      console.log("✅ [DB] Payment indexes created");
    } catch (e) {
      console.error("❌ [DB] Payment indexes:", e.message);
    }
    try {
      await require("../services/client-notify.service").ensureIndexes(require("../config/db").getDB());
      console.log("✅ [DB] Client notification indexes created");
    } catch (e) {
      console.error("❌ [DB] Client notification indexes:", e.message);
    }

    // Leads collection indexes
    await DB.collection("leads").createIndex({ page_id: 1 });
    await DB.collection("leads").createIndex({ phone: 1 });
    await DB.collection("leads").createIndex({ updated_at: -1 });
    await DB.collection("leads").createIndex({ page_id: 1, updated_at: -1 });
    await DB.collection("leads").createIndex({ status: 1 });
    await DB.collection("leads").createIndex({ account_id: 1 });
    console.log("✅ [DB] Leads indexes created");

    // Users collection indexes
    await DB.collection("users").createIndex({ phone: 1 }, { unique: true });
    await DB.collection("users").createIndex({ email: 1 });
    await DB.collection("users").createIndex({ lead_id: 1 });
    console.log("✅ [DB] Users indexes created");

    // Customers collection indexes
    await DB.collection("customers").createIndex({ phone: 1 });
    await DB.collection("customers").createIndex({ lead_id: 1 });
    await DB.collection("customers").createIndex({ created_at: -1 });
    console.log("✅ [DB] Customers indexes created");

    // Images collection indexes
    await DB.collection("images").createIndex({ createdAt: -1 });
    console.log("✅ [DB] Images indexes created");

    // Instagram jobs collection indexes
    await DB.collection("instagram_jobs").createIndex({ jobId: 1 }, { unique: true });
    await DB.collection("instagram_jobs").createIndex({ status: 1 });
    await DB.collection("instagram_jobs").createIndex({ created_at: -1 });
    console.log("✅ [DB] Instagram jobs indexes created");

    // Image batch jobs collection indexes
    await DB.collection("image_batch_jobs").createIndex({ jobId: 1 }, { unique: true });
    await DB.collection("image_batch_jobs").createIndex({ status: 1 });
    await DB.collection("image_batch_jobs").createIndex({ createdAt: -1 });
    console.log("✅ [DB] Image batch jobs indexes created");

    // Profiles collection indexes
    await DB.collection("profiles").createIndex({ phone: 1, pageId: 1 }, { unique: true });
    console.log("✅ [DB] Profiles indexes created");

    // Appointments collection indexes
    await DB.collection("appointments").createIndex({ scheduledStart: 1 });
    await DB.collection("appointments").createIndex({ customerPhone: 1 });
    await DB.collection("appointments").createIndex({ status: 1, scheduledStart: 1 });
    // מונע double-booking: רק פגישה active אחת לכל שעה
    await DB.collection("appointments").createIndex(
      { scheduledStart: 1 },
      {
        unique: true,
        partialFilterExpression: { status: "active" },
        name: "unique_active_scheduledStart",
      }
    );
    console.log("✅ [DB] Appointments indexes created");

    // Agent chats (internal agent-to-agent chat) collection indexes
    await DB.collection("agent_chats").createIndex({ participants: 1 });
    await DB.collection("agent_chats").createIndex({ updated_at: -1 });
    console.log("✅ [DB] Agent chats indexes created");

    // Client briefs collection indexes
    // Drop old pageId index if it exists (may have incompatible partialFilterExpression)
    try {
      await DB.collection("client_briefs").dropIndex("pageId_1");
    } catch (_) {
      // Index doesn't exist, that's fine
    }
    await DB.collection("client_briefs").createIndex(
      { pageId: 1 },
      { unique: true, partialFilterExpression: { pageId: { $exists: true, $type: "string" } } },
    );
    await DB.collection("client_briefs").createIndex({ phone: 1 });
    await DB.collection("client_briefs").createIndex({ updatedAt: -1 });
    console.log("✅ [DB] Client briefs indexes created");

    // WhatsApp sessions collection indexes
    await DB.collection("wa_sessions").createIndex({ phone: 1 }, { unique: true });
    await DB.collection("wa_sessions").createIndex({ session_id: 1 }, { unique: true });
    await DB.collection("wa_sessions").createIndex({ api_key: 1 }, { unique: true });
    // Drop the old broken sparse index (created without partialFilterExpression,
    // which failed because multiple documents have wa_phone: null).
    try {
      await DB.collection("wa_sessions").dropIndex("wa_phone_1");
    } catch (_) { /* doesn't exist — fine */ }
    // wa_phone is set only after a successful connection.
    // partialFilterExpression ensures only string values are indexed (null is skipped).
    await DB.collection("wa_sessions").createIndex(
      { wa_phone: 1 },
      {
        unique: true,
        partialFilterExpression: { wa_phone: { $type: "string" } },
        name: "wa_phone_unique_string",
      },
    );
    console.log("✅ [DB] WhatsApp sessions indexes created");

    // WhatsApp auth keys collection indexes
    await DB.collection("wa_auth_keys").createIndex(
      { session_id: 1, key_type: 1, key_id: 1 },
      { unique: true },
    );
    console.log("✅ [DB] WhatsApp auth keys indexes created");

    // SMS logs collection indexes
    await DB.collection("sms_logs").createIndex({ created_at: -1 });
    await DB.collection("sms_logs").createIndex({ phone: 1 });
    await DB.collection("sms_logs").createIndex({ success: 1 });
    console.log("✅ [DB] SMS logs indexes created");

    // User leads collection indexes (FB leads synced per advertiser phone)
    await DB.collection("user_leads").createIndex({ phone: 1 }, { unique: true });
    await DB.collection("user_leads").createIndex({ updatedAt: -1 });
    console.log("✅ [DB] User leads indexes created");

    // Willbox invoices collection indexes
    await DB.collection("willbox_invoices").createIndex({ phone: 1 });
    await DB.collection("willbox_invoices").createIndex({ created_at: -1 });
    await DB.collection("willbox_invoices").createIndex({ phone: 1, created_at: -1 });
    console.log("✅ [DB] Willbox invoices indexes created");

    // Coin transactions indexes
    await DB.collection("coin_transactions").createIndex({ phone: 1, created_at: -1 });
    console.log("✅ [DB] Coin transactions indexes created");

    // Action prices indexes
    await DB.collection("action_prices").createIndex({ action: 1 }, { unique: true });
    console.log("✅ [DB] Action prices indexes created");



    // Post generation jobs collection indexes
    await DB.collection("post_jobs").createIndex({ job_id: 1 }, { unique: true });
    // TTL: auto-delete post jobs after 24 hours
    await DB.collection("post_jobs").createIndex(
      { created_at: 1 },
      { expireAfterSeconds: 86400, name: "post_jobs_ttl" }
    );
    console.log("✅ [DB] Post generation jobs indexes created");

    // Campaign jobs collection indexes
    await DB.collection("campaign_jobs").createIndex({ job_id: 1 }, { unique: true });
    // TTL: auto-delete jobs after 24 hours (cleanup for uncollected results)
    await DB.collection("campaign_jobs").createIndex(
      { created_at: 1 },
      { expireAfterSeconds: 86400, name: "campaign_jobs_ttl" }
    );
    console.log("✅ [DB] Campaign jobs indexes created");

    // Ad briefs indexes
    await DB.collection("ad_briefs").createIndex({ phone: 1 });
    await DB.collection("ad_briefs").createIndex({ phone: 1, sessionId: 1 });
    await DB.collection("ad_briefs").createIndex({ updatedAt: -1 });
    console.log("✅ [DB] Ad briefs indexes created");

    // Ad plans indexes
    await DB.collection("ad_plans").createIndex({ phone: 1 });
    await DB.collection("ad_plans").createIndex({ phone: 1, sessionId: 1 });
    console.log("✅ [DB] Ad plans indexes created");

    // Ad sessions indexes
    await DB.collection("ad_sessions").createIndex({ phone: 1 });
    await DB.collection("ad_sessions").createIndex({ sessionId: 1 });
    await DB.collection("ad_sessions").createIndex({ createdAt: -1 });
    console.log("✅ [DB] Ad sessions indexes created");

    // Ad image jobs indexes
    await DB.collection("ad_image_jobs").createIndex({ phone: 1 });
    await DB.collection("ad_image_jobs").createIndex({ phone: 1, sessionId: 1 });
    await DB.collection("ad_image_jobs").createIndex({ createdAt: -1 });
    console.log("✅ [DB] Ad image jobs indexes created");

    // Ad creative jobs indexes
    await DB.collection("ad_creative_jobs").createIndex({ jobId: 1 }, { unique: true });
    console.log("✅ [DB] Ad creative jobs indexes created");

    // Posts indexes
    await DB.collection("posts").createIndex({ page_id: 1 });
    await DB.collection("posts").createIndex({ created_at: -1 });
    await DB.collection("posts").createIndex({ status: 1, page_id: 1 });
    console.log("✅ [DB] Posts indexes created");

    // Instagram posts indexes
    await DB.collection("instagram_posts").createIndex({ phone: 1 });
    await DB.collection("instagram_posts").createIndex(
      { phone: 1, postId: 1 },
      { unique: true, partialFilterExpression: { postId: { $type: "string" } } }
    );
    console.log("✅ [DB] Instagram posts indexes created");

    // Marketing weather cache indexes
    await DB.collection("marketing_weather_cache").createIndex({ service: 1, hour_bucket: 1 });
    console.log("✅ [DB] Marketing weather cache indexes created");

    // support_chats collection indexes
    await DB.collection("support_chats").createIndex({ phone: 1 });
    await DB.collection("support_chats").createIndex({ status: 1 });
    await DB.collection("support_chats").createIndex({ updated_at: -1 });
    await DB.collection("support_chats").createIndex({ name: 1 });
    await DB.collection("support_chats").createIndex({ fireberyName: 1 });
    console.log("✅ [DB] Support chats indexes created");

    // website_support_chats collection indexes
    await DB.collection("website_support_chats").createIndex({ phone: 1 });
    await DB.collection("website_support_chats").createIndex({ status: 1 });
    await DB.collection("website_support_chats").createIndex({ updated_at: -1 });
    await DB.collection("website_support_chats").createIndex({ name: 1 });
    console.log("✅ [DB] Website support chats indexes created");

    // lead_assignments — legacy distribution bookkeeping. Indexed by phone
    // so the listing
    // endpoint can dedupe in a single query, and by assignedTo so we can
    // show an admin "what each manager received" report quickly.
    await DB.collection("lead_assignments").createIndex({ phone: 1 });
    await DB.collection("lead_assignments").createIndex({ assignedTo: 1, assignedAt: -1 });
    console.log("✅ [DB] lead_assignments indexes created");

    // AI account-manager agent collections
    await DB.collection("agent_actions").createIndex({ agentRunId: 1, step: 1 });
    await DB.collection("agent_actions").createIndex({ clientPhone: 1, at: -1 });
    await DB.collection("agent_actions").createIndex({ status: 1, at: -1 });
    await DB.collection("agent_approvals").createIndex({ clientPhone: 1, status: 1, createdAt: -1 });
    await DB.collection("agent_approvals").createIndex({ status: 1, expiresAt: 1 });
    // Partial unique index — the agent_chats collection also holds internal
    // agent-to-agent docs (participants-based, phone:null); a plain unique build
    // fails on those duplicate nulls (E11000). Enforce uniqueness only over
    // string phones. Same name/opts as chat.service.js so it's idempotent.
    await DB.collection("agent_chats").createIndex(
      { phone: 1 },
      { unique: true, partialFilterExpression: { phone: { $type: "string" } }, name: "phone_unique_str" },
    );
    await DB.collection("agent_chats").createIndex({ updatedAt: -1 });
    await DB.collection("agent_proactive_state").createIndex({ phone: 1, kind: 1 });
    await DB.collection("agent_brain").createIndex({ active: 1, createdAt: -1 });
    await DB.collection("agent_escalations").createIndex({ clientPhone: 1, status: 1 });
    await DB.collection("agent_escalations").createIndex({ status: 1, createdAt: -1 });
    // live-learning: typed lessons + style-RAG vectors
    await DB.collection("agent_lessons").createIndex({ active: 1, kind: 1, priority: -1 });
    await DB.collection("agent_lessons").createIndex({ createdAt: -1 });
    await DB.collection("agent_style_vectors").createIndex({ key: 1 }, { unique: true });
    await DB.collection("agent_style_vectors").createIndex({ createdAt: -1 });
    await DB.collection("agent_client_memory").createIndex({ phone: 1 }, { unique: true });
    await DB.collection("agent_perf_snapshots").createIndex({ phone: 1, date: 1 }, { unique: true });
    await DB.collection("agent_perf_snapshots").createIndex({ date: -1 });
    await DB.collection("agent_quality_scores").createIndex({ at: -1 });
    console.log("✅ [DB] AI agent indexes created");

    console.log("✅ [DB] All database indexes initialized successfully");
  } catch (error) {
    console.error("❌ [DB] Error initializing indexes:", error.message);
    // Don't throw - let the app continue even if index creation fails
  }
};

module.exports = { initializeIndexes };
