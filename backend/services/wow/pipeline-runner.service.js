/**
 * Runs the Gemini + Ads pipelines through the job queue.
 * Each runner is idempotent: if the session already has the output of a given
 * step persisted in Mongo, that step is skipped.
 *
 * Exports:
 *   register()       — called once at server boot to wire into job.service
 *   enqueueGemini()  — kick off (or resume) the Gemini pipeline
 *   enqueueAds()     — kick off (or resume) the Ads pipeline
 */

const jobService = require("./job.service");
const briefService = require("./brief.service");
const sessionService = require("./session.service");
const { runGeminiPipeline } = require("./gemini-pipeline.service");
const { runAdsPipeline, loadAdsJson } = require("./ads.service");

const briefToPipelineInput = (brief) => ({
  businessName: brief.businessName,
  businessField: brief.businessField,
  businessNiche: brief.businessNiche,
  about: brief.about,
  services: brief.services,
  phone: brief.phone,
  address: brief.address,
  targetAudience: brief.targetAudience,
  preferredColors: brief.preferredColors,
  promotion: brief.promotion,
  socialLinks: brief.socialLinks,
  designStyle: brief.designStyle,
  animationStyle: brief.animationStyle,
  pageGoal: brief.pageGoal,
  logo: brief.logo,
  photos: brief.photos,
  facePhoto: brief.facePhoto,
  faq: brief.faq,
});

/**
 * Gemini runner invoked by job.service.
 * Short-circuits if HTML + all images are already persisted.
 */
const runGemini = async (sessionId) => {
  const session = await sessionService.getSession(sessionId);
  if (session.edits && session.edits.geminiHtml && session.status === "ready") {
    console.log(`[wow/runner] gemini/${sessionId} already completed — skipping`);
    return;
  }
  if (!session.briefId) throw new Error(`session ${sessionId} has no briefId`);
  const brief = await briefService.getBrief(session.briefId);
  await runGeminiPipeline(sessionId, briefToPipelineInput(brief));

  // Record in history so the user can find this session even before publishing
  try {
    const historyService = require("./history.service");
    await historyService.recordPublish({
      phone: brief.phone || "",
      sessionId,
      briefId: session.briefId,
      url: "",
      businessName: brief.businessName || null,
    });
  } catch (e) {
    console.warn(`[wow/runner] history record failed: ${e.message}`);
  }
};

/**
 * Ads runner invoked by job.service.
 * Short-circuits if adsStatus is already 'ready' and we have 10 ads.
 */
const runAds = async (sessionId) => {
  const session = await sessionService.getSession(sessionId);
  if (session.edits && session.edits.adsStatus === "ready") {
    const ads = await loadAdsJson(sessionId);
    const ready = (ads && (ads.generatedAds || ads.ads) || []).filter((a) => a.imageUrl).length;
    if (ready >= 10) {
      console.log(`[wow/runner] ads/${sessionId} already completed — skipping`);
      return;
    }
  }
  if (!session.briefId) throw new Error(`session ${sessionId} has no briefId`);
  const brief = await briefService.getBrief(session.briefId);
  await runAdsPipeline(sessionId, briefToPipelineInput(brief));
};

const register = () => {
  jobService.register({
    gemini: runGemini,
    ads: runAds,
  });
};

const enqueueGemini = (sessionId, briefId) => jobService.enqueue({ sessionId, briefId, kind: "gemini" });
const enqueueAds    = (sessionId, briefId) => jobService.enqueue({ sessionId, briefId, kind: "ads" });

module.exports = { register, enqueueGemini, enqueueAds };
