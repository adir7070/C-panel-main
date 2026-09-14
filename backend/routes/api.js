const express = require("express");
const router = express.Router();
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("../config/swagger");

// Routes
const paymentRoutes = require("./payment.routes");
const aiRoutes = require("./ai.routes");
const authRoutes = require("./auth.routes");
const whatsappRoutes = require("./whatsapp.routes");
const invoiceRoutes = require("./invoice.routes");
const instagramRoutes = require("./instagram.routes");
const activityRoutes = require("./activity.routes");
const leadsRoutes = require("./leads.routes");
const domainRoutes = require("./domain.routes");
const profileRoutes = require("./profile.routes");
const agentsRoutes = require("./agents.routes");
const appointmentsRoutes = require("./appointments.routes");
const salesRoutes = require("./sales.routes");
const googleRoutes = require("./google.routes");
const clientBriefRoutes = require("./client-brief.routes");
const adBriefRoutes = require("./ad-brief.routes");
const adPlanRoutes = require("./ad-plan.routes");
const adImagesRoutes = require("./ad-images.routes");
const adSessionsRoutes = require("./ad-sessions.routes");
const ratingsRoutes = require("./ratings.routes");
const waSessionRoutes = require("./wa-session.routes");
const appRoutes = require("./app.routes");
const meetingStatusesRoutes = require("./meeting-statuses.routes");
const blockedDaysRoutes = require("./blocked-days.routes");
const chatRoutes = require("./chat.routes");
const websiteChatRoutes = require("./website-chat.routes");
const fileTypesRoutes = require("./file-types.routes");
const willboxRoutes = require("./willbox.routes");
const coinsRoutes = require("./coins.routes");
const packagesRoutes = require("./packages.routes");
const designRoutes = require("./design.routes");
const projectsRoutes = require("./projects.routes");
const customersRoutes = require("./customers.routes");
const demoRoutes = require("./demo.routes");
const adminFixRoutes = require("./admin-fix.routes");
const logRoutes = require("./log.routes");
const correctionsRoutes = require("./corrections.routes");
const masterRoutes = require("./master.routes");
const masterCodeRoutes = require("./master-code.routes");
const waMarketingRoutes = require("./wa-marketing.routes");
const hamragelRoutes = require("./hamragel.routes");
const campaignRoutes = require("./campaign.routes");
const postGenerationRoutes = require("./post-generation.routes");
const aiCreationOrderRoutes = require("./ai-creation-order.routes");
const galleryOrderRoutes = require("./gallery-order.routes");
const campaignBriefRoutes = require("./campaign-brief.routes");
const subscriptionPlansRoutes = require("./subscription-plans.routes");
const businessProfileRoutes = require("./business-profile.routes");
const partnerUpdatesRoutes = require("./partnerUpdates.routes");
const promotionsRoutes = require("./promotions.routes");
const tutorialsRoutes = require("./tutorials.routes");
const cpanelRoutes = require("./cpanel.routes");
const dbHealthRoutes = require("./db-health.routes");
const receiptsRoutes = require("./receipts.routes");
const billpilotRoutes = require("./billpilot.routes");
const bpRouter = require("./billpilot/index");

// WOW landing-page builder
const wowRouter = express.Router();
wowRouter.use("/ai",        require("./wow/ai.routes"));
wowRouter.use("/brief",     require("./wow/brief.routes"));
wowRouter.use("/templates", require("./wow/templates.routes"));
wowRouter.use("/editor",    require("./wow/editor.routes"));
wowRouter.use("/ads",       require("./wow/ads.routes"));
wowRouter.use("/publish",   require("./wow/publish.routes"));
wowRouter.use("/history",     require("./wow/history.routes"));
wowRouter.use("/eligibility", require("./wow/eligibility.routes"));
wowRouter.use("/feedback",    require("./wow/feedback.routes"));
wowRouter.use("/track",       require("./wow/tracking.routes"));
wowRouter.use("/page",        require("./wow/page.routes"));

// Image Proxy
const imageProxyController = require("../controllers/image-proxy.controller");

router.use("/payment", paymentRoutes);
router.use("/ai", aiRoutes);
router.use("/ai/hamragel", hamragelRoutes);
router.use("/auth", authRoutes);
router.use("/whatsapp", whatsappRoutes);
router.use("/invoice", invoiceRoutes);
router.use("/receipts", receiptsRoutes);
router.use("/billpilot", billpilotRoutes);
router.use("/bp", bpRouter);
router.use("/instagram", instagramRoutes);
router.use("/activity", activityRoutes);
router.use("/leads", leadsRoutes);
router.use("/domain", domainRoutes);
router.use("/profile", profileRoutes);
router.use("/agents", agentsRoutes);
router.use("/appointments", appointmentsRoutes);
router.use("/sales", salesRoutes);
router.use("/google", googleRoutes);
router.use("/client-brief", clientBriefRoutes);
router.use("/ad-brief", adBriefRoutes);
router.use("/ad-plan", adPlanRoutes);
router.use("/ad-images", adImagesRoutes);
router.use("/ad-sessions", adSessionsRoutes);
router.use("/ratings", ratingsRoutes);
router.use("/wa", waSessionRoutes);
router.use("/meeting-statuses", meetingStatusesRoutes);
router.use("/blocked-days", blockedDaysRoutes);
router.use("/chat", chatRoutes);
router.use("/website-chat", websiteChatRoutes);
router.use("/file-types", fileTypesRoutes);
router.use("/willbox", willboxRoutes);
router.use("/coins", coinsRoutes);
router.use("/packages", packagesRoutes);
router.use("/app/design", designRoutes);
router.use("/app/corrections", correctionsRoutes);
router.use("/master", masterRoutes);
router.use("/master-code", masterCodeRoutes);
router.use("/projects", projectsRoutes);
router.use("/customers", customersRoutes);
router.use("/demo", demoRoutes);
router.use("/admin", adminFixRoutes);
router.use("/log", logRoutes);
router.use("/wa-marketing", waMarketingRoutes);
router.use("/campaign", campaignRoutes);
router.use("/post-generation", postGenerationRoutes);
router.use("/ai-creation-order", aiCreationOrderRoutes);
router.use("/gallery-order", galleryOrderRoutes);
router.use("/campaign-brief", campaignBriefRoutes);
router.use("/subscription-plans", subscriptionPlansRoutes);
router.use("/subscription", require("./subscription.routes"));
router.use("/promo49", require("./promo49.routes")); // public "מבצע 49" landing purchase
// Supported ad languages (for a per-client language dropdown in cpanel/app).
router.get("/ad-languages", (req, res) => res.json({ success: true, data: require("../services/ad-languages.service").listLanguages() }));
router.use("/business-profile", businessProfileRoutes);
router.use("/partner-updates", partnerUpdatesRoutes);
router.use("/promotions", promotionsRoutes);
router.use("/tutorials", tutorialsRoutes);
router.use("/agent-chat", require("./agent-chat.routes"));
router.use("/agent", require("./agent.routes"));
router.use("/make", require("./make.routes"));
router.use("/cpanel", cpanelRoutes);
router.use("/wow-lp", require("./wow-lp-public.routes"));
/* Mobile-facing manager picker — no auth, called pre-onboarding. */
router.use("/public", require("./public-managers.routes"));
router.use("/wow-ads-preview", require("./wow-ads-public.routes"));
router.use("/wow-organic-preview", require("./wow-organic-public.routes"));

// Client-facing "my projects" list — phone-keyed, no auth header
const clientProjectsCtrl = require("../controllers/client-projects.controller");
router.get  ("/client/projects",                       clientProjectsCtrl.getClientProjects);
router.get  ("/client/project-detail",                 clientProjectsCtrl.getClientProjectDetail);
router.post ("/client/project-detail/:id/approve",     clientProjectsCtrl.approveClientProject);
router.post ("/client/project-detail/:id/reject",      clientProjectsCtrl.rejectClientProject);
/* Package status is a manager action (it can also WhatsApp the client that
   the products are ready): panel login + the per-client ownership gate. The
   gate reads :phone, so it is handed the phone from the body. */
const cpanelAuth = require("../controllers/cpanel.controller");
router.patch("/client/project-detail/:id/status",
  cpanelAuth.authMiddleware,
  (req, res, next) => cpanelAuth.requireClientAccess(
    Object.assign(Object.create(req), { params: { ...req.params, phone: String(req.body?.phone || "") } }), res, next),
  clientProjectsCtrl.updateClientProjectStatus);
router.post ("/client/project-detail/:projectId/items/:itemId/edit-request", clientProjectsCtrl.editRequestForItem);
router.post ("/client/project-detail/:projectId/save-campaign",             clientProjectsCtrl.saveCampaign);
router.get  ("/client/social-access",                  clientProjectsCtrl.getSocialAccess);
router.post ("/client/social-access",                  clientProjectsCtrl.saveSocialAccessPurchase);
router.post ("/client/campaign-access",                clientProjectsCtrl.saveCampaignAccessPurchase);
router.post ("/client/campaign-access/create-payment", clientProjectsCtrl.createCampaignAccessPayment);
router.post ("/client/campaign-access/verify-payment", clientProjectsCtrl.verifyCampaignAccessPayment);
router.post ("/client/social-access/create-payment",   clientProjectsCtrl.createSocialAccessPayment);
router.post ("/client/social-access/verify-payment",   clientProjectsCtrl.verifySocialAccessPayment);
router.get  ("/client/permissions",                    clientProjectsCtrl.getPermissions);
/* Webinar deck: live aggregate of the onboarding-form opening survey (no PII) */
router.get  ("/webinar/survey-stats",                  require("../controllers/webinar-grant.controller").surveyStats);
router.use("/db-health", dbHealthRoutes);
router.use("/app", appRoutes);
router.use("/wow", wowRouter);

router.get("/gallery/:phone", imageProxyController.getCustomerGallery);
router.get("/img", imageProxyController.proxyImage);
router.post(
  "/upload-image",
  (req, res, next) => {
    imageProxyController.upload.single("image")(req, res, (err) => {
      if (err)
        return res.status(400).json({ success: false, error: err.message });
      next();
    });
  },
  imageProxyController.uploadImage,
);
router.get("/video", imageProxyController.proxyVideo);
router.post(
  "/upload-video",
  (req, res, next) => {
    imageProxyController.videoUpload.single("video")(req, res, (err) => {
      if (err)
        return res.status(400).json({ success: false, error: err.message });
      next();
    });
  },
  imageProxyController.uploadVideo,
);
router.get("/file", imageProxyController.proxyFile);
router.post(
  "/upload-pdf",
  (req, res, next) => {
    imageProxyController.pdfUpload.single("file")(req, res, (err) => {
      if (err)
        return res.status(400).json({ success: false, error: err.message });
      next();
    });
  },
  imageProxyController.uploadPdf,
);
router.post(
  "/upload-file",
  (req, res, next) => {
    imageProxyController.fileUpload(req, res, (err) => {
      if (err)
        return res.status(400).json({ success: false, error: err.message });
      next();
    });
  },
  imageProxyController.uploadFile,
);
router.post(
  "/upload-images-batch",
  (req, res, next) => {
    imageProxyController.batchUpload.array("images", 20)(req, res, (err) => {
      if (err)
        return res.status(400).json({ success: false, error: err.message });
      next();
    });
  },
  imageProxyController.uploadImagesBatch,
);
router.use(aiRoutes);

const SERVER_VERSION = "2026-06-09.1";

router.get("/health", (_req, res) => res.status(200).json({ ok: true, version: SERVER_VERSION }));

router.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customSiteTitle: "Iconiq API Docs",
    swaggerOptions: { docExpansion: "list", defaultModelsExpandDepth: 2 },
  }),
);
router.get("/docs.json", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(swaggerSpec);
});

module.exports = router;
