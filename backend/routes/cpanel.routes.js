const express = require("express");
const router = express.Router();
const c        = require("../controllers/cpanel.controller");
const productsStatus = require("../controllers/products-status.controller");
const adminCtrl = require("../controllers/admin.controller");
const wowAds      = require("../controllers/wow-ads.controller");
const wowOrganic  = require("../controllers/wow-organic-ads.controller");
const wowLp       = require("../controllers/wow-lp.controller");
const meetingsCtrl = require("../controllers/cpanel-meetings.controller");
const personalPkgCtrl = require("../controllers/personal-packages.controller");
const fbConnect = require("../controllers/fb-connect.controller");
const fbGate = require("../middlewares/fb-gate.middleware");

// Payment webhook — no auth (called by Cardcom)
router.post("/payment-notify",           c.paymentNotify);
router.post("/payment-confirm-personal", personalPkgCtrl.paymentConfirm);

// Cardcom iframe success/error redirect page — no auth (Cardcom redirects here)
router.get("/payment-iframe-result", c.paymentIframeResult);

// Public — called by the mobile app without auth
router.get ("/meetings/available", meetingsCtrl.getAvailableSlots);
router.post("/meetings",           meetingsCtrl.createMeeting);

// All other routes require account_manager/admin auth
router.use(c.authMiddleware);

/* Per-client ownership gate — fires on every /clients/:phone/... route
   (including the bare GET /clients/:phone). Admins bypass; account
   managers get 403 + "not_your_client" if the phone isn't in their book. */
router.use("/clients/:phone", c.requireClientAccess);

/* Webinar monitoring tab — participants list + their profiles/ads (agent-auth) */
router.get("/webinar/participants", require("../controllers/webinar-grant.controller").participants);

router.get("/clients",           c.getClients);
router.get("/managed-clients",   c.getManagedClients);
router.get("/unmanaged-chats",   c.getUnmanagedChats);
router.post("/clients/add", c.addClient);
/* Webinar onboarding — Mongo-only client creation (no Fireberry; survives 60-concurrent load) */
router.post("/clients/webinar-register", require("../controllers/webinar-grant.controller").webinarRegister);
/* Manager claims a client owned by another manager. Auth-gated by
   authMiddleware above; requireClientAccess explicitly lets /claim
   through since the caller is not yet the owner. */
router.post("/clients/:phone/claim", c.claimClient);
router.get("/clients/:phone", c.getClientDetail);
/* Recovery endpoint — lists raw Backblaze files in the per-phone upload
   folder. Used to find images uploaded by the iOS app when the upload
   succeeded but the URL was never written back to business_profiles
   (the file:// logoUrl bug). Manager-only; output is JSON of proxy URLs. */
router.get("/clients/:phone/uploaded-files", c.listClientUploadedFiles);
/* "✨ הרחב עם AI" button on the Characterization tab — takes the
   manager's current free-text about and OpenAI-rewrites it as a
   richer description for downstream pipelines. */
router.post("/clients/:phone/expand-about", c.expandAboutWithAI);
router.post("/clients/:phone/spellcheck", c.spellcheckTexts);
/* "✨ הוסף שירותים עם AI" button on the שירותים panel — drafts 3
   tailored services from the businessName + about. */
router.post("/clients/:phone/suggest-services", c.suggestServicesWithAI);
router.get("/clients/:phone/campaigns", fbGate, c.getClientCampaigns);
router.get("/clients/:phone/leads", fbGate, c.getClientLeads);
router.post("/clients/:phone/budget", fbGate, c.updateClientBudget);
router.post("/clients/:phone/campaign-status", fbGate, c.toggleCampaignStatus);

// Aggregated campaigns across all clients (global view)
router.get("/campaigns", fbGate, c.getAllCampaigns);

// Per-campaign ad management (Meta Ads)
router.get(   "/clients/:phone/campaigns/:campaignId/ads",     fbGate, c.getCampaignAds);
router.put(   "/clients/:phone/campaigns/:campaignId/budget",  fbGate, c.updateCampaignBudget);
router.put(   "/clients/:phone/ads/:adId",                     fbGate, c.updateAd);
router.delete("/clients/:phone/ads/:adId",                     fbGate, c.deleteAd);
router.put(   "/clients/:phone/adsets/:adSetId/audience",      fbGate, c.updateAdAudience);
/* Proxy to FB Graph /search for cities / regions / countries / interests
   / languages. Drives the autocomplete on the C-panel audience editor
   so user-typed strings can be resolved to FB's real targeting keys. */
router.get(   "/clients/:phone/fb-targeting/search",             fbGate, c.searchFbTargeting);
router.post("/clients/:phone/payment-link", c.sendPaymentLink);
router.post("/clients/:phone/package-payment-link", c.sendPackagePaymentLink);
router.post("/clients/:phone/package-charge-iframe", c.initiatePackageChargeIframe);
router.post("/clients/:phone/redeem-social-package", c.redeemSocialPackage);
router.get("/clients/:phone/fb-assets", fbGate, c.getClientFbAssets);
router.get("/clients/:phone/fb-token-status", fbGate, c.getClientFbTokenStatus);
router.get("/clients/:phone/fb-debug",        c.getClientFbDebug);
router.get("/clients/:phone/fb-account-health", fbGate, c.getClientFbAccountHealth);
router.get("/clients/:phone/fb-user-token", fbGate, c.getClientFbUserToken);
router.post("/clients/:phone/fb-attach-card", fbGate, c.attachFbCreditCard);
router.put("/clients/:phone/credentials", c.updateClientCredentials);
router.get("/clients/:phone/app-data", c.getAppData);
router.get("/clients/:phone/fb-live-status", fbGate, c.getClientFbLiveStatus);
router.get("/clients/:phone/calendar", c.getClientCalendar);
router.patch("/clients/:phone/reschedule-creative", c.rescheduleCreative);
router.post("/clients/:phone/calendar-event/delete", c.cancelCalendarEvent);
router.post("/clients/:phone/calendar-upload", c.calendarImageUploadMw, c.calendarScheduleUpload);
router.post("/clients/:phone/campaign-special/upload-image", c.campaignSpecialImageUploadMw, c.uploadCampaignSpecialImage);
router.get("/clients/:phone/presence", c.getClientPresence);
router.get("/clients/:phone/activity", c.getClientActivity);
router.get("/clients/:phone/messages", c.getMessages);
router.post("/clients/:phone/notify-push", c.notifyClientPush);
router.get("/clients/:phone/wa-clicks", require("../controllers/wa-clicks.controller").listForClient);
router.get("/clients/:phone/characterization", c.getCharacterization);
router.put("/clients/:phone/characterization", c.updateCharacterization);
router.post("/clients/:phone/characterization/complete", c.completeCharacterization);
// ── Facebook automation connect (via Postify API) ──────────────────────
router.post("/clients/:phone/fb-connect/start",                    fbGate, fbConnect.startFbConnect);
router.get( "/clients/:phone/fb-connect/:sessionId/stream",        fbGate, fbConnect.streamFbConnect);
router.get( "/clients/:phone/fb-connect/:sessionId/setup-stream",  fbGate, fbConnect.streamSetup);
router.post("/clients/:phone/fb-connect/:sessionId/pick-method",   fbGate, fbConnect.pickMethod);
router.post("/clients/:phone/fb-connect/:sessionId/code",          fbGate, fbConnect.submitCode);
router.post("/clients/:phone/fb-connect/result",                   fbGate, fbConnect.saveFbResult);
router.get( "/clients/:phone/fb-status",                           fbGate, fbConnect.getFbStatus);
router.get("/stats",            c.getStats);
router.get("/account-managers", c.getAccountManagers);

// ── Extended endpoints ──────────────────────────────────────────────

// FB Lead Forms & Leads
router.get("/clients/:phone/fb-lead-forms",              fbGate, c.getClientFbLeadForms);
router.get("/clients/:phone/fb-leads",                   fbGate, c.getClientFbLeads);
router.post("/clients/:phone/fb-leads/:leadId/follow-up",   fbGate, c.markFbLeadFollowedUp);
router.post("/clients/:phone/fb-leads/:leadId/followed-up", fbGate, c.markFbLeadFollowedUp);

// Pipeline (Kanban)
router.get("/pipeline",          c.getPipeline);
router.put("/pipeline/stage",    c.updatePipelineStage); // legacy (body.phone)
router.put("/pipeline/:phone",   c.updatePipelineStage); // canonical (RESTful)

// Dashboard
router.get("/dashboard", c.getDashboard);

// AI
router.post("/ai/suggest-replies",           c.aiSuggestReplies);
router.post("/ai/summarize-chat",            c.aiSummarizeChat);
router.post("/ai/daily-digest/run",          c.aiRunDigestNow);
router.get("/ai/daily-digest",               c.getDailyDigest);
router.get("/ai/daily-digest/schedule",      c.getDigestSchedule);
router.put("/ai/daily-digest/schedule",      c.setDigestSchedule);

// Broadcast
router.get("/broadcast/templates", c.getBroadcastTemplates);
router.get("/broadcast/history",   c.getBroadcastHistory);
router.post("/broadcast",          c.sendBroadcast);

// Client files (Backblaze)
router.get("/clients/:phone/files",            c.getClientFiles);
router.get("/clients/:phone/files/upload-url", c.getClientFileUploadUrl);
router.delete("/clients/:phone/files/:fileKey", c.deleteClientFile);

// Direct charge (CardCom saved token)
router.post("/clients/:phone/charge", c.chargeClient);

// CPanel Appointments
router.get("/appointments",         c.getCpanelAppointments);
router.post("/appointments",        c.createCpanelAppointment);
router.put("/appointments/:id",     c.updateCpanelAppointment);
router.delete("/appointments/:id",  c.deleteCpanelAppointment);

// Wallet (commissions ledger for the account manager)
router.get("/wallet", c.getWallet);
router.post("/wallet/commissions/:id/mark-paid", c.markCommissionPaid);

// Products catalog — read-only feed for the BillingTab
router.get("/products", c.listProducts);

// Per-product lifecycle (status independent of package status). Type is
// one of "ads" | "organic" | "lp"; each session moves through the 9-stage
// productStatus flow on its own.
router.get ("/clients/:phone/products/status",                productsStatus.getProductStatuses);
router.put ("/clients/:phone/products/:type/status",          productsStatus.updateProductStatus);
router.post("/clients/:phone/products/:type/send-to-client",  productsStatus.sendProductToClient);

// Consolidated product reviews — one SMS, all approved products
router.post("/clients/:phone/products/send-for-approval", c.sendProductsForApproval);
router.get ("/clients/:phone/products/latest-review",     c.getLatestProductReview);
router.get ("/reviews",                                   c.listProductReviews);

// Per-client wallet snapshot + tier setter (GOLD/VIP/PRO/PLUS/SILVER/REGULAR)
router.get("/clients/:phone/wallet", c.getClientWallet);
router.put("/clients/:phone/tier",   c.setClientTier);

// Active package — drives "מוצרים" tab gating. Self-heals from
// cpanel_pending_purchases if the read finds the user paid but has no
// users.activePackage (covers customers who paid before paymentNotify
// learned to write activePackage).
/* ── Personal catalog (per-agent, per-client) ───────────────────────── */
router.get   ("/clients/:phone/personal-catalog",             personalPkgCtrl.list);
router.post  ("/clients/:phone/personal-catalog",             personalPkgCtrl.create);
router.patch ("/clients/:phone/personal-catalog/:id",         personalPkgCtrl.update);
router.delete("/clients/:phone/personal-catalog/:id",         personalPkgCtrl.remove);
router.post  ("/clients/:phone/personal-catalog/:id/charge-iframe", personalPkgCtrl.chargePersonalIframe);
router.post  ("/clients/:phone/personal-catalog/:id/confirm-payment", personalPkgCtrl.confirmPayment);
router.post  ("/clients/:phone/personal-catalog/confirm-open-charges", personalPkgCtrl.confirmOpenCharges);
/* One-shot migration for customers who purchased before expandBundles
   shipped — re-runs the bundle expansion on their stored activePackage
   and purchasedPackages history. Idempotent. */
router.post  ("/clients/:phone/personal-catalog/repair", (req, res) => {
  req.body = { ...(req.body || {}), phone: req.params.phone };
  return personalPkgCtrl.repairActivePackage(req, res);
});
/* Raw diagnostic dump — returns activePackage + source personal package
   docs side-by-side so we can debug "package is empty in UI" issues. */
router.get   ("/clients/:phone/personal-catalog/diagnose", personalPkgCtrl.diagnoseClientPackages);
/* Infer kind+items map for admin-created catalog products that follow
   the "<base>_<count>" naming convention. One-shot bootstrap so the
   bundle expansion can unfold those keys at purchase time. */
router.post  ("/personal-catalog/infer-bundles", personalPkgCtrl.inferCatalogBundles);
/* Restore kind:"item" on products that the earlier infer-bundles run
   flipped to kind:"social". expandBundles now matches on items map
   alone, so we can safely put them back where the builder UI sees them. */
router.post  ("/personal-catalog/restore-item-kind", personalPkgCtrl.restoreItemKind);

router.get("/clients/:phone/package",       c.getClientPackage);
/* Coin redeem — manager spends client's existing coin balance on a
   service slot (campaign_leads / campaign_traffic / social_ad_10)
   linked to an existing approved-ads slotKey. */
router.post("/clients/:phone/coin-redeem",  c.coinRedeem);
router.get( "/clients/:phone/coins",        c.getClientCoins);
router.get( "/clients/:phone/wow-ads/approved-slots", c.getApprovedAdsSlots);
router.get( "/clients/:phone/wow-ads/campaign-sessions", c.listCampaignSessions);
router.get("/clients/:phone/packages",      c.listClientPackages);
/* Read-only drill-down: products generated under a specific historical
   package. Drives the expanded-state of the older-package cards. */
router.get("/clients/:phone/packages/:pkgId/products", c.getClientPackageProducts);
router.get("/clients/:phone/package-debug", c.getClientPackageDebug);
router.put("/clients/:phone/notes",         c.updateClientNotes);

/* Manual rescue: replay a Cardcom transaction JSON for a customer who paid
   but Cardcom never called our webhook. Body = the raw Cardcom response. */
router.post("/clients/:phone/replay-cardcom", c.replayCardcomTransaction);

// Facebook campaign launch — creates campaign/adset/ads from approved WowAds
router.post("/clients/:phone/campaigns/launch", fbGate, c.launchFacebookCampaign);

// WOW Ads — 10 marketing ads pipeline (OpenAI text + Gemini image)
/* Webinar onboarding: grant 0₪ package + free campaign access (agent-auth) */
router.post("/clients/:phone/webinar-grant", require("../controllers/webinar-grant.controller").grant);

router.post("/clients/:phone/wow-ads/generate",            wowAds.generateWowAds);
router.get( "/clients/:phone/wow-ads",                     wowAds.getWowAds);
router.get( "/clients/:phone/wow-ads/status",              wowAds.getWowAdsStatus);
router.post("/clients/:phone/wow-ads/:adId/regenerate",    wowAds.regenerateWowAd);
router.post("/clients/:phone/wow-ads/:adId/promotion-description", wowAds.generateAdPromotionDescription);
router.put( "/clients/:phone/wow-ads/:adId",               wowAds.updateWowAdText);
router.post("/clients/:phone/wow-ads/:adId/approve",       wowAds.managerApproveAd);
router.post("/clients/:phone/wow-ads/send-approval",       wowAds.sendAdsForApproval);
router.post("/clients/:phone/wow-ads/:adId/image",         wowAds.adImageUploadMw, wowAds.uploadWowAdImage);

// WOW Organic Ads — 5 organic social posts (OpenAI text + Gemini lifestyle image)
router.post("/clients/:phone/wow-organic/generate",            wowOrganic.generateOrganicAds);
router.get( "/clients/:phone/wow-organic",                     wowOrganic.getOrganicAds);
router.get( "/clients/:phone/wow-organic/status",              wowOrganic.getOrganicAdsStatus);
router.post("/clients/:phone/wow-organic/:postId/regenerate",  wowOrganic.regenerateOrganicPost);
router.post("/clients/:phone/wow-organic/:postId/promotion-description", wowOrganic.generateOrganicPromotionDescription);
router.put( "/clients/:phone/wow-organic/:postId",             wowOrganic.updateOrganicPostText);
router.post("/clients/:phone/wow-organic/:postId/approve",     wowOrganic.managerApprovePost);
router.post("/clients/:phone/wow-organic/:postId/image",       wowOrganic.organicImageUploadMw, wowOrganic.uploadOrganicPostImage);
router.post("/clients/:phone/wow-organic/send-approval",       wowOrganic.sendOrganicForApproval);
router.post("/clients/:phone/wow-organic/carousel/generate",   wowOrganic.generateOrganicCarousel);
router.post("/clients/:phone/wow-organic/carousel/:postId/slides/:slideId/regenerate", wowOrganic.regenerateCarouselSlide);

// WOW Landing Page — AI-generated LP (OpenAI content + Gemini hero images)
router.post( "/clients/:phone/wow-lp/generate",            wowLp.generateLp);
router.get(  "/clients/:phone/wow-lp",                     wowLp.getLp);
router.get(  "/clients/:phone/wow-lp/status",              wowLp.getLpStatus);
router.patch("/clients/:phone/wow-lp",                     wowLp.patchLp);
router.post( "/clients/:phone/wow-lp/regenerate-image",    wowLp.regenerateLpImage);
router.post( "/clients/:phone/wow-lp/upload-image",        wowLp.lpImageUploadMw, wowLp.uploadLpImage);
router.post( "/clients/:phone/wow-lp/set-image",           wowLp.setLpSectionImage);
/* Render the LP using the new template-driven engine (v2) — pulls a
   hand-crafted template from services/wow-lp-templates/ and fills its
   data-inject placeholders from the brief via one gpt-4o call. */
router.post( "/clients/:phone/wow-lp/render-v2",            wowLp.renderLpV2);
/* "🚀 פרסם ל-Netlify" button. Zips the stored sess.html + redirects
   manifest and POSTs to Netlify's deploy API. Caches the site_id on
   the session so subsequent redeploys hit the same URL. */
router.post( "/clients/:phone/wow-lp/deploy-netlify",       wowLp.deployLpToNetlify);
router.post( "/clients/:phone/wow-lp/send-approval",       wowLp.sendForApproval);

// Referral (חבר מביא חבר) — award coins from client detail page
router.patch("/clients/:phone/referral-approve", c.approveReferralClient);
router.patch("/clients/:phone/referral-close",   c.closeReferralClient);

// Logo generator (used by Characterization tab when client has no logo)
// POST starts a BACKGROUND job and returns { jobId } immediately — the
// OpenAI gpt-image-1 call routinely runs 25-45s at quality:"high" and
// would otherwise hit Heroku's 30s H12 timeout. GET below polls the job.
router.post("/logo/generate",      c.generateLogo);
router.get("/logo/job/:jobId",     c.getLogoJob);

// Custom categories — manager can add new top-level / sub-categories on the fly
router.get("/categories",                            c.listCustomCategories);
router.post("/categories",                           c.addCustomCategory);
router.post("/categories/:catKey/subcategories",     c.addCustomSubCategory);

// Logs
router.get("/logs",            c.getCpanelLogs);
router.get("/leads",           c.getCpanelLeadsAggregate);

// Auto-derived tasks (status-driven — drives the משימות sidebar page)
router.get(   "/tasks",        c.getTasks);
// Legacy: personal manual tasks list — moved off /tasks GET. Kept reachable
// for any external caller that still relies on it; the new UI doesn't use it.
router.get(   "/personal-tasks", c.listTasks);
router.post(  "/tasks",        c.createTask);
router.patch( "/tasks/:id",    c.updateTask);
router.delete("/tasks/:id",    c.deleteTask);

/* ── ADMIN PANEL surface ───────────────────────────────────────────────
   Every route below requires agent.role === "admin". Mounted under the
   already-authenticated cpanel router so authMiddleware runs first. */
router.use("/admin", adminCtrl.requireAdmin);
router.get("/admin/dashboard",       adminCtrl.getDashboard);
/* Funnel report — every client who's bought a package + their current
   journey stage. Drives the "מסע לקוח" admin page. */
router.get ("/admin/customer-journey", adminCtrl.getCustomerJourney);
/* One-shot backfill for clients whose launches predate the
   activePackage.launchedCampaigns persistence. Body or query: phone
   to fix one client, otherwise scans all clients without the flag. */
router.post("/admin/customer-journey/backfill-campaigns", adminCtrl.backfillCustomerJourneyCampaigns);
router.get("/admin/managers",        adminCtrl.listManagers);
router.get("/admin/managers/:id",    adminCtrl.getManagerDetail);
router.post("/admin/managers/:id/transfer-clients", adminCtrl.transferManagerClients);
router.patch("/admin/clients/:phone/force-status", adminCtrl.forceClientStatus);
router.delete("/admin/clients/:phone",             adminCtrl.deleteAdminClient);
router.post ("/admin/refunds",                    adminCtrl.createRefund);
router.get  ("/admin/refunds",                    adminCtrl.listRefunds);
router.get  ("/admin/agents",                     adminCtrl.listAdminAgents);
router.post ("/admin/agents",                     adminCtrl.createAdminAgent);
router.patch("/admin/agents/:id",                 adminCtrl.updateAdminAgent);
router.post ("/admin/agents/:id/force-logout",    adminCtrl.forceLogoutAgent);
router.post ("/admin/agents/:id/avatar",          adminCtrl.adminAgentAvatarUploadMw, adminCtrl.uploadAdminAgentAvatar);
router.get("/admin/clients",         adminCtrl.listClients);
router.get("/admin/finance/revenue",     adminCtrl.getFinanceRevenue);
router.get("/admin/finance/payments",    adminCtrl.getFinancePayments);
router.get("/admin/finance/commissions", adminCtrl.getFinanceCommissions);
router.post("/admin/finance/commissions/:id/pay",   adminCtrl.payCommission);
router.post("/admin/finance/commissions/batch-pay", adminCtrl.batchPayCommissions);
router.get("/admin/tasks",               adminCtrl.getAdminTasks);
router.get   ("/admin/catalog",           adminCtrl.listCatalog);
router.post  ("/admin/catalog",           adminCtrl.upsertCatalogItem);
router.delete("/admin/catalog/:key",      adminCtrl.deleteCatalogItem);
router.get  ("/admin/settings",           adminCtrl.getSettings);
router.patch("/admin/settings",           adminCtrl.patchSettings);
router.get  ("/admin/ai-usage",           adminCtrl.getAdminAiUsage);
router.get  ("/admin/reviews-analytics",  adminCtrl.getAdminReviewsAnalytics);
router.get  ("/admin/pipeline-global",     adminCtrl.getAdminPipelineGlobal);
router.get  ("/admin/chats",               adminCtrl.getAdminChats);
router.get  ("/admin/integrations",        adminCtrl.getAdminIntegrations);
router.get  ("/admin/broadcasts",          adminCtrl.listAdminBroadcasts);
router.post ("/admin/broadcasts",          adminCtrl.sendAdminBroadcast);
router.get  ("/admin/reports/monthly-pnl",        adminCtrl.reportMonthlyPnl);
router.get  ("/admin/reports/manager-performance", adminCtrl.reportManagerPerformance);
router.get  ("/admin/reports/client-list",         adminCtrl.reportClientList);
router.get  ("/admin/reports/vat",                 adminCtrl.reportVat);
router.get  ("/admin/reports/activity",            adminCtrl.reportActivity);
router.get("/admin/audit",           adminCtrl.getAuditLog);
router.post("/admin/sync-manager-assignments", c.syncManagerAssignments);

module.exports = router;
