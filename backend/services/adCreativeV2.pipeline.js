const aiService = require("./aiV2.service");
const facebookService = require("./facebook.service");
const { buildStrategy } = require("./strategyBuilder.service");
const { extractVideoIntelligence } = require("./videoIntelligence.service");
const adScoring = require("../utils/adScoring");
const extractSiteContent = require("../utils/extractSiteContent");
const prompts = require("../utils/adCopyPromptsV2");
const { createLogger } = require("../utils/pipelineLogger");
const {
  validateCreativeAnalysis,
  validateVariations,
  validateStrategy,
  FALLBACK_CREATIVE_ANALYSIS,
  FALLBACK_VARIATION,
  FALLBACK_STRATEGY,
} = require("../utils/adCreativeV2.schema");
const {
  parseUrlInfo,
  probeMediaUrl,
  detectMediaType,
  isLikelyThumbnail,
  extractFbCreativeSignals,
} = require("../utils/mediaDetection");
const {
  extractOfferFromCreativeAnalysis,
  validateCopyGrounding,
  buildGroundingRetryInstruction,
} = require("../utils/copyGrounding");

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function timed(fn) {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

function emptyMetrics() {
  return {
    timings: {
      adsFetchMs: 0,
      siteExtractMs: 0,
      visionMs: 0,
      copyMs: 0,
      totalMs: 0,
    },
    ai: {
      calls: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      totalRetries: 0,
    },
    failures: {
      validationFailures: 0,
      parseFailures: 0,
      fallbacksUsed: [],
    },
    videoDebug: null,
    mediaDebug: null,
    copyQualityDebug: null,
  };
}

function recordAiUsage(metrics, step, usage) {
  if (!usage) return;
  metrics.ai.calls.push({ step, ...usage });
  metrics.ai.totalInputTokens += usage.inputTokens || 0;
  metrics.ai.totalOutputTokens += usage.outputTokens || 0;
  metrics.ai.totalCostUsd = Math.round((metrics.ai.totalCostUsd + (usage.costUsd || 0)) * 1_000_000) / 1_000_000;
  metrics.ai.totalRetries += usage.retries || 0;
  if (usage.retries > 0) metrics.failures.validationFailures += usage.retries;
  if (usage.fallbackUsed) metrics.failures.fallbacksUsed.push(step);
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * V2 Ad Creative Pipeline
 *
 * @param {Object} params
 * @param {string} params.requestId
 * @param {string} params.token
 * @param {string} params.actId
 * @param {string} params.phone
 * @param {Object} params.payload   - { service, goal }
 * @param {string} [params.imageUrl]
 * @param {string} [params.site]
 *
 * @returns {Promise<{
 *   variations: Array,
 *   creativeAnalysis: Object,
 *   strategy: Object,
 *   _metrics: Object
 * }>}
 */
async function runAdCreativeV2Pipeline({ requestId, token, actId, phone, payload, imageUrl, site }) {
  const log = createLogger(requestId);
  const metrics = emptyMetrics();
  const pipelineStart = Date.now();

  const { service = "", goal = "" } = payload || {};

  log.info({ step: "pipeline_start", hasService: !!service, hasGoal: !!goal, actId: actId || "missing", hasImage: !!imageUrl, hasSite: !!site });

  // ── Media Detection Phase ─────────────────────────────────────────────────
  // Runs BEFORE the parallel step so vision/video branch is chosen correctly.

  const mediaDebug = {
    inputUrlPreview: imageUrl?.substring(0, 120) || null,
    inputUrlHost: null,
    detectedInitialType: null,
    finalType: null,
    detectionReason: null,
    confidence: 0,
    contentType: null,
    contentLength: 0,
    finalUrlSource: "app_url",
    isLikelyThumbnail: false,
    likelyThumbnailReasons: [],
    facebookSignals: { hasVideoId: false, videoId: null, hasVideoData: false, hasImageUrl: false, hasThumbnailUrl: false },
    resolutionAttempts: [],
  };

  let mediaIsVideo = false;
  let resolvedMediaUrl = imageUrl; // may be overridden by FB video resolution

  if (imageUrl) {
    const urlInfo = parseUrlInfo(imageUrl);
    mediaDebug.inputUrlHost = urlInfo.host;

    log.info({
      step: "media_input_received",
      imageUrlPreview: imageUrl.substring(0, 120),
      urlHost: urlInfo.host,
      urlPath: urlInfo.path,
      urlExtension: urlInfo.extension,
      queryKeys: urlInfo.queryKeys,
      hasFbcdn: urlInfo.hasFbcdn,
    });

    log.info({ step: "media_detection_start", detectionMethod: "probe_then_extension", inputUrlExtension: urlInfo.extension });

    // HEAD probe (fast, <2s typical on good network)
    const probe = await probeMediaUrl(imageUrl).catch((err) => ({
      success: false, method: "failed", error: err.message, contentType: null, contentLength: 0, finalUrl: imageUrl,
    }));

    log.info({
      step: "media_head_probe",
      success: probe.success,
      method: probe.method,
      status: probe.status,
      contentType: probe.contentType,
      contentLength: probe.contentLength,
      acceptRanges: probe.acceptRanges,
      finalUrl: probe.finalUrl?.substring(0, 120),
      error: probe.error,
    });

    mediaDebug.contentType = probe.contentType;
    mediaDebug.contentLength = probe.contentLength;

    const detection = detectMediaType({
      url: imageUrl,
      contentType: probe.contentType,
      contentLength: probe.contentLength,
    });

    mediaDebug.detectedInitialType = detection.type;
    mediaDebug.detectionReason = detection.reason;
    mediaDebug.confidence = detection.confidence;

    log.info({
      step: "media_type_detected",
      detectedType: detection.type,
      reason: detection.reason,
      confidence: detection.confidence,
    });

    mediaIsVideo = detection.type === "video";
  }

  metrics.mediaDebug = mediaDebug;

  // Early thumbnail check — skip image vision before the parallel step
  const thumbEarlyCheck = imageUrl ? isLikelyThumbnail({
    url: imageUrl,
    contentType: mediaDebug.contentType,
    contentLength: mediaDebug.contentLength,
    fbCreativeData: null,
  }) : { isLikely: false, reasons: [] };

  if (thumbEarlyCheck.isLikely && !mediaIsVideo) {
    log.info({
      step: "image_vision_skipped",
      reason: "likely_video_thumbnail",
      contentLength: mediaDebug.contentLength,
      likelyThumbnailReasons: thumbEarlyCheck.reasons,
    });
    mediaDebug.isLikelyThumbnail = true;
    mediaDebug.likelyThumbnailReasons = thumbEarlyCheck.reasons;
  }

  // ── Step 1 — parallel: FB ads + site content + vision AI ─────────────────
  const visionUserPrompt = prompts.constructVisionUserPrompt({ service, goal });

  const [
    { result: adsRaw,      durationMs: adsFetchMs },
    { result: siteContext, durationMs: siteExtractMs },
    { result: visionResult, durationMs: visionMs },
  ] = await Promise.all([
    timed(() =>
      facebookService.getAds(actId, token).catch((err) => {
        log.error({ step: "fb_fetch", error: err.message });
        metrics.failures.fallbacksUsed.push("fb_fetch");
        return [];
      }),
    ),
    timed(() =>
      site ? extractSiteContent(site).catch(() => "") : Promise.resolve(""),
    ),
    timed(() => {
      if (!imageUrl) return Promise.resolve({ data: null, usage: null });

      // ── Video path ────────────────────────────────────────────────────────
      if (mediaIsVideo) {
        return extractVideoIntelligence(resolvedMediaUrl, log)
          .then(({ creativeAnalysis: videoCreativeAnalysis, offerExtracted, cleanedTranscript, videoDebug }) => ({
            data: { _videoIntelligence: true, creativeAnalysis: videoCreativeAnalysis, offerExtracted, cleanedTranscript, videoDebug },
            usage: null,
          }))
          .catch((err) => {
            log.error({ step: "video_intelligence", error: err.message });
            metrics.failures.fallbacksUsed.push("video_intelligence");
            return { data: null, usage: null };
          });
      }

      // ── Image path ────────────────────────────────────────────────────────
      // Skip if likely thumbnail — real video will be resolved post-parallel
      if (thumbEarlyCheck.isLikely) {
        return Promise.resolve({ data: null, usage: null });
      }
      return aiService.analyzeCreativeVision(
        prompts.visionSystemPrompt,
        visionUserPrompt,
        imageUrl,
        validateCreativeAnalysis,
        requestId,
      ).catch((err) => {
        log.error({ step: "vision_ai", error: err.message, type: err.type ?? "unknown" });
        if (err.type === "parse_failure") metrics.failures.parseFailures++;
        return { data: null, usage: { retries: 0, fallbackUsed: true } };
      });
    }),
  ]);

  metrics.timings.adsFetchMs = adsFetchMs;
  metrics.timings.siteExtractMs = siteExtractMs;
  metrics.timings.visionMs = visionMs;

  // ── Post-parallel: FB creative media signal inspection ───────────────────
  // Log media signals for the top ads so we can see what FB creative data contains.
  if (imageUrl && adsRaw?.length > 0) {
    const topAdsForSignals = adsRaw
      .filter((ad) => ad?.creative)
      .slice(0, 3);

    for (const ad of topAdsForSignals) {
      const signals = extractFbCreativeSignals(ad.creative);
      if (signals) {
        log.info({
          step: "fb_creative_media_signals",
          adId: ad.id,
          ...signals,
        });
      }
    }

    // Update mediaDebug with FB signals from first ad that has video data
    const videoAd = adsRaw.find((ad) => {
      const spec = ad?.creative?.object_story_spec;
      return !!(ad?.creative?.video_id || spec?.video_data?.video_id || spec?.video_data);
    });

    if (videoAd) {
      const signals = extractFbCreativeSignals(videoAd.creative);
      if (signals) {
        mediaDebug.facebookSignals = {
          hasVideoId: signals.hasVideoId,
          videoId: signals.videoId,
          hasVideoData: signals.hasVideoData,
          hasImageUrl: signals.hasImageUrl,
          hasThumbnailUrl: signals.hasThumbnailUrl,
        };
      }
    }
  }

  // ── Thumbnail detection + FB video resolution attempt ────────────────────
  // Only runs when we detected image but conditions suggest it's a video thumbnail.
  if (imageUrl && !mediaIsVideo) {
    const thumbCheck = isLikelyThumbnail({
      url: imageUrl,
      contentType: mediaDebug.contentType,
      contentLength: mediaDebug.contentLength,
      fbCreativeData: null,
    });

    mediaDebug.isLikelyThumbnail = thumbCheck.isLikely;
    mediaDebug.likelyThumbnailReasons = thumbCheck.reasons;

    if (thumbCheck.isLikely) {
      log.info({
        step: "thumbnail_detected",
        isLikely: true,
        reasons: thumbCheck.reasons,
        contentType: mediaDebug.contentType,
        contentLength: mediaDebug.contentLength,
      });

      // Try to find a video_id from fetched ads to resolve actual video
      const videoAdWithId = adsRaw?.find((ad) => {
        const spec = ad?.creative?.object_story_spec;
        return !!(ad?.creative?.video_id || spec?.video_data?.video_id);
      });

      const fbVideoId = videoAdWithId?.creative?.object_story_spec?.video_data?.video_id
        || videoAdWithId?.creative?.video_id;

      if (fbVideoId) {
        log.info({ step: "media_source_retry_fb_video_start", videoId: fbVideoId });
        mediaDebug.resolutionAttempts.push({ method: "facebook_video_source", videoId: fbVideoId, success: false, error: null });

        try {
          const videoData = await facebookService.getVideoSource(fbVideoId, token);
          const videoSourceUrl = videoData?.source;

          if (videoSourceUrl) {
            log.info({ step: "media_source_retry_fb_video_success", videoId: fbVideoId, sourceFound: true });
            mediaDebug.resolutionAttempts[mediaDebug.resolutionAttempts.length - 1].success = true;
            mediaDebug.finalUrlSource = "fb_resolved_video";
            resolvedMediaUrl = videoSourceUrl;
            mediaIsVideo = true;
            mediaDebug.finalType = "video";
            mediaDebug.detectionReason = "fb_video_source_resolved";
            mediaDebug.confidence = 10;
          } else {
            log.warn({ step: "media_source_retry_fb_video_failed", videoId: fbVideoId, reason: "no_source_url" });
            mediaDebug.resolutionAttempts[mediaDebug.resolutionAttempts.length - 1].error = "no_source_url";
          }
        } catch (err) {
          log.error({ step: "media_source_retry_fb_video_failed", videoId: fbVideoId, error: err.message });
          mediaDebug.resolutionAttempts[mediaDebug.resolutionAttempts.length - 1].error = err.message;
        }
      }
    }
  }

  // ── Final media decision log ──────────────────────────────────────────────
  const finalType = mediaDebug.finalType || mediaDebug.detectedInitialType || (imageUrl ? "image" : "none");
  mediaDebug.finalType = finalType;

  const willRun = !imageUrl ? "reject_no_media"
    : finalType === "video" ? "video_intelligence"
    : "vision_image";

  log.info({
    step: "media_source_final",
    finalType,
    finalUrlPreview: resolvedMediaUrl?.substring(0, 120),
    source: mediaDebug.finalUrlSource,
    reason: mediaDebug.detectionReason,
    confidence: mediaDebug.confidence,
    isLikelyThumbnail: mediaDebug.isLikelyThumbnail,
    willRun,
  });

  // Both video and image paths produce creativeAnalysis in the unified persuasion schema
  const isVideoPath = visionResult?.data?._videoIntelligence === true;
  if (isVideoPath && visionResult?.data?.videoDebug) {
    metrics.videoDebug = visionResult.data.videoDebug;
  }

  // If thumbnail was resolved to video AFTER the parallel step already ran image vision,
  // re-run with video intelligence on the resolved URL.
  let creativeAnalysis;
  let videoOfferExtracted = null;
  let videoCleanedTranscript = null;

  if (mediaDebug.finalUrlSource === "fb_resolved_video" && !isVideoPath) {
    log.info({ step: "video_intelligence_retry", reason: "thumbnail_resolved_after_parallel_step" });
    try {
      const { creativeAnalysis: retriedAnalysis, offerExtracted: retriedOffer, cleanedTranscript: retriedTranscript, videoDebug: retriedVidDebug } =
        await extractVideoIntelligence(resolvedMediaUrl, log);
      creativeAnalysis = retriedAnalysis;
      videoOfferExtracted = retriedOffer;
      videoCleanedTranscript = retriedTranscript;
      metrics.videoDebug = retriedVidDebug;
    } catch (err) {
      log.error({ step: "video_intelligence_retry", error: err.message });
      creativeAnalysis = visionResult?.data ?? null;
    }
  } else {
    creativeAnalysis = isVideoPath
      ? (visionResult?.data?.creativeAnalysis ?? (imageUrl ? FALLBACK_CREATIVE_ANALYSIS : null))
      : (visionResult?.data ?? (imageUrl ? FALLBACK_CREATIVE_ANALYSIS : null));
    videoOfferExtracted = isVideoPath ? (visionResult?.data?.offerExtracted ?? null) : null;
    videoCleanedTranscript = isVideoPath ? (visionResult?.data?.cleanedTranscript ?? null) : null;
  }

  if (!isVideoPath && mediaDebug.finalUrlSource !== "fb_resolved_video") {
    recordAiUsage(metrics, "vision", visionResult?.usage);
  }

  log.info({
    step: "step1_done",
    adCount: adsRaw?.length ?? 0,
    hasSite: !!siteContext,
    creativeType: isVideoPath || mediaDebug.finalUrlSource === "fb_resolved_video" ? "video" : creativeAnalysis ? "image" : "none",
    adsFetchMs, siteExtractMs, visionMs,
  });

  // ── Step 2 — score ads ────────────────────────────────────────────────────
  const adsWithCreative = (adsRaw || [])
    .filter((ad) => ad?.creative?.object_story_spec)
    .slice(0, 20);

  const adsWithInsights = [];
  let rateLimitHit = false;

  for (const ad of adsWithCreative) {
    if (rateLimitHit) {
      adsWithInsights.push({ ...ad, insights: {} });
      continue;
    }
    try {
      const insights = await facebookService.getInsights(ad.id, token);
      adsWithInsights.push({ ...ad, insights: insights || {} });
    } catch (err) {
      if (err?.isRateLimit) {
        log.warn({ step: "insights_fetch", event: "rate_limit_hit", adId: ad.id });
        metrics.failures.fallbacksUsed.push("insights_rate_limit");
        rateLimitHit = true;
      }
      adsWithInsights.push({ ...ad, insights: {} });
    }
  }

  const scoredAds = adsWithInsights.map((ad) => {
    const data = {
      ...ad,
      impressions: ad.insights?.impressions || 0,
      spend: ad.insights?.spend || 0,
      clicks: ad.insights?.clicks || 0,
      inline_link_clicks: ad.insights?.inline_link_clicks || 0,
      actions: ad.insights?.actions || [],
      quality_ranking: ad.insights?.quality_ranking || "UNKNOWN",
    };
    return { ...data, score: adScoring.scoreAd(data, 20) };
  });

  const sorted = [...scoredAds].sort((a, b) => b.score - a.score);
  const topFiltered = sorted.filter((ad) => ad.score >= 60);
  const topAds = topFiltered.length >= 3 ? topFiltered.slice(0, 3) : sorted.slice(0, 3);

  log.info({ step: "ads_scored", total: scoredAds.length, above60: topFiltered.length, top: topAds.map((a) => `${a.id}:${a.score}`).join(", ") });

  // ── Step 3 — deterministic strategy ──────────────────────────────────────
  const rawStrategy = buildStrategy(topAds);
  const { normalized: validatedStrategy, result: strategyResult } = validateStrategy(rawStrategy);

  let finalStrategy;
  if (strategyResult.success) {
    finalStrategy = validatedStrategy;
  } else {
    log.warn({ step: "strategy_validation", event: "validation_failed", issues: strategyResult.error.issues });
    metrics.failures.validationFailures++;
    metrics.failures.fallbacksUsed.push("strategy");
    finalStrategy = FALLBACK_STRATEGY;
  }

  log.info({ step: "strategy_built", structure: finalStrategy.dominantStructure, emojiDensity: finalStrategy.emojiDensity });

  // ── Minimum context validation ────────────────────────────────────────────
  const hasCreativeContext = !!creativeAnalysis;
  const hasGoal = !!goal?.trim();

  if (!hasCreativeContext && !hasGoal) {
    log.error({ step: "context_validation", event: "rejected", reason: "no goal and no creative analysis" });
    throw new Error("אין מספיק מידע ליצירת קופי — יש להזין מטרה או לצרף קריאייטיב");
  }

  if (!hasCreativeContext) {
    log.warn({ step: "context_validation", event: "no_creative", goal });
  }

  // ── Step 4 — copy generation ──────────────────────────────────────────────

  // Offer extraction: video path gets it from intelligence service; image path extracts from schema
  const offerExtracted = videoOfferExtracted || extractOfferFromCreativeAnalysis(creativeAnalysis);

  log.info({
    step: "offer_extracted",
    mainOffer: offerExtracted.mainOffer || "none",
    includedItems: offerExtracted.includedItems,
    price: offerExtracted.price || "none",
    deadline: offerExtracted.deadline || "none",
    hasCta: !!offerExtracted.ctaFromVideo,
  });

  const copyUserPrompt = prompts.constructCopyUserPromptV2({
    service,
    goal,
    creativeAnalysis,
    strategy: { ...rawStrategy, ...finalStrategy },
    siteContext,
    offerExtracted,
  });

  let variations;
  const { result: copyResult, durationMs: copyMs } = await timed(() =>
    aiService.generateAdCopyV2(
      prompts.copywriterSystemPromptV2,
      copyUserPrompt,
      validateVariations,
      requestId,
    ).catch((err) => {
      log.error({ step: "copy_ai", error: err.message, type: err.type ?? "unknown" });
      if (err.type === "parse_failure") metrics.failures.parseFailures++;
      return { data: null, usage: { retries: 0, fallbackUsed: true } };
    }),
  );

  metrics.timings.copyMs = copyMs;
  recordAiUsage(metrics, "copy", copyResult?.usage);

  if (copyResult?.data?.variations?.length > 0) {
    variations = copyResult.data.variations;
    log.info({ step: "copy_done", variationCount: variations.length, copyMs });
  } else {
    log.warn({ step: "copy_done", event: "fallback_used", copyMs });
    metrics.failures.fallbacksUsed.push("copy");
    variations = [FALLBACK_VARIATION];
  }

  // ── Step 4.5 — grounding validation + retry ───────────────────────────────
  const groundingCheck = validateCopyGrounding(variations, offerExtracted);
  let retryUsed = false;

  if (!groundingCheck.passed && variations !== [FALLBACK_VARIATION]) {
    log.warn({
      step: "copy_grounding_failed",
      failures: groundingCheck.failures,
      forbiddenHits: groundingCheck.forbiddenHits.map((h) => `v${h.variationIndex}:"${h.phrase}"`),
    });

    const retryInstruction = buildGroundingRetryInstruction(groundingCheck.failures, offerExtracted);
    const retryPrompt = `${copyUserPrompt}\n\n${retryInstruction}`;

    const { result: retryResult } = await timed(() =>
      aiService.generateAdCopyV2(
        prompts.copywriterSystemPromptV2,
        retryPrompt,
        validateVariations,
        requestId,
      ).catch((err) => {
        log.error({ step: "copy_grounding_retry", error: err.message });
        return { data: null };
      }),
    );

    if (retryResult?.data?.variations?.length > 0) {
      variations = retryResult.data.variations;
      retryUsed = true;
      recordAiUsage(metrics, "copy_grounding_retry", retryResult?.usage);
    } else {
      log.warn({ step: "copy_grounding_retry_done", event: "retry_failed_kept_original" });
    }
  } else {
    log.info({ step: "copy_grounding_passed" });
  }

  // Re-validate after retry for accurate final state
  const finalGroundingCheck = retryUsed
    ? validateCopyGrounding(variations, offerExtracted)
    : groundingCheck;

  if (retryUsed) {
    if (finalGroundingCheck.passed) {
      log.info({ step: "copy_grounding_retry_done", variationCount: variations.length });
    } else {
      log.warn({
        step: "copy_grounding_retry_done",
        event: "still_failed_after_retry",
        failures: finalGroundingCheck.failures,
      });
      // Deterministic deadline auto-inject: append deadline to hook of first variation if missing
      const deadline = offerExtracted?.deadline;
      if (deadline) {
        const deadlineCount = variations.filter((v) =>
          [v.hook, v.title, v.body, v.cta].join(" ").toLowerCase().includes(deadline.toLowerCase()),
        ).length;
        if (deadlineCount < 2) {
          variations = variations.map((v, i) => {
            const hasDeadline = [v.hook, v.title, v.body, v.cta].join(" ").toLowerCase().includes(deadline.toLowerCase());
            if (!hasDeadline && i < 2) {
              return { ...v, cta: `${v.cta} — ${deadline}` };
            }
            return v;
          });
          log.info({ step: "copy_grounding_auto_fix", applied: "deadline_injected_into_cta" });
          metrics.failures.fallbacksUsed.push("copy_grounding_auto_fix");
        }
      }
    }
  }

  metrics.copyQualityDebug = {
    offerExtracted,
    initialGroundingPassed: groundingCheck.passed,
    forbiddenPhraseHits: groundingCheck.forbiddenHits,
    groundingFailures: groundingCheck.failures,
    retryUsed,
    finalGroundingPassed: finalGroundingCheck.passed,
    finalGroundingFailures: retryUsed ? finalGroundingCheck.failures : [],
    autoFixApplied: metrics.failures.fallbacksUsed.includes("copy_grounding_auto_fix"),
    cleanedTranscript: videoCleanedTranscript || null,
  };

  // ── Finalize metrics ──────────────────────────────────────────────────────
  metrics.timings.totalMs = Date.now() - pipelineStart;

  log.info({
    step: "pipeline_done",
    totalMs: metrics.timings.totalMs,
    totalCostUsd: metrics.ai.totalCostUsd,
    totalRetries: metrics.ai.totalRetries,
    fallbacksUsed: metrics.failures.fallbacksUsed,
  });

  return {
    variations,
    creativeAnalysis: creativeAnalysis ?? FALLBACK_CREATIVE_ANALYSIS,
    strategy: {
      dominantStructure: finalStrategy.dominantStructure,
      emojiDensity: finalStrategy.emojiDensity,
      usesBullets: rawStrategy.usesBullets ?? false,
      ...(finalStrategy.copySignals && { copySignals: finalStrategy.copySignals }),
      ...(finalStrategy.topExamples?.length > 0 && { topExamples: finalStrategy.topExamples }),
    },
    _metrics: metrics,
  };
}

module.exports = { runAdCreativeV2Pipeline };
