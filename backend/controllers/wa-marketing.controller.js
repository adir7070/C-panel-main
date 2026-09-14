"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// WaMarketingController — HTTP Layer
//
// Routes (mount at /api/wa-marketing in your router):
//
//   Queue
//   POST   /enqueue              → Add single job to queue
//   POST   /enqueue-bulk         → Add multiple jobs (campaign blast)
//   GET    /queue/stats          → Queue statistics
//   POST   /queue/pause          → Pause all pending jobs for a session
//   POST   /queue/resume         → Resume paused jobs for a session
//   DELETE /queue/cancel         → Cancel pending jobs (session or campaign)
//
//   WhatsApp Actions (direct, no queue)
//   POST   /status               → Feature 6:  Post WhatsApp Status
//   POST   /vcard                → Feature 11: Send VCard
//   POST   /location             → Feature 12: Send Location
//   POST   /group                → Feature 17: Create Group
//   POST   /community            → Feature 25: Community Broadcast
//
//   Worker
//   GET    /worker/status        → Worker health
//   POST   /worker/start         → Start worker
//   POST   /worker/stop          → Stop worker
//   POST   /worker/kill-switch/reset → Reset ban-risk kill switch for a session
//
//   Config (DynamicConfigService)
//   GET    /config               → Get all config values
//   GET    /config/:key          → Get single value
//   PATCH  /config               → Update one or more values
//   POST   /config/reset/:key    → Reset key to factory default
// ─────────────────────────────────────────────────────────────────────────────

const queue = require("../services/marketing/wa-queue.service");
const worker = require("../services/marketing/wa-worker.service");
const actions = require("../services/marketing/wa-actions.service");
const mktSession = require("../services/marketing/wa-marketing-session.service");
const dynamicConfig = require("../services/marketing/dynamic-config.service");
const healthLog = require("../services/wa-health-log.service");
const { spintaxPreview, spintaxVariationCount, hasSpintax } = require("../services/marketing/spintax.utils");
const { formatWaError } = require("../errors/wa-errors");

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, ...data });
}

function fail(res, err) {
  const { status, body } = formatWaError(err);
  return res.status(status).json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /enqueue
 * Body: { sessionId, jobType, payload, priority?, runAt?, campaignId? }
 */
exports.enqueue = async (req, res) => {
  try {
    const { sessionId, jobType, payload, priority, runAt, campaignId } = req.body;

    if (!sessionId || !jobType || !payload) {
      return res.status(400).json({
        success: false,
        message: "sessionId, jobType, and payload are required",
      });
    }

    const jobId = await queue.enqueue({
      sessionId,
      jobType,
      payload,
      priority,
      runAt: runAt ? new Date(runAt) : undefined,
      campaignId,
    });

    return ok(res, { jobId }, 201);
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /enqueue-bulk
 * Body: { jobs: [{ sessionId, jobType, payload, ... }] }
 */
exports.enqueueBulk = async (req, res) => {
  try {
    const { jobs } = req.body;

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ success: false, message: "jobs array is required and must not be empty" });
    }

    const jobIds = await queue.enqueueBulk(jobs);
    return ok(res, { count: jobIds.length, jobIds }, 201);
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * GET /queue/stats?sessionId=
 */
exports.queueStats = async (req, res) => {
  try {
    const { sessionId } = req.query;
    const stats = await queue.getStats(sessionId || undefined);
    return ok(res, { stats });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /queue/pause
 * Body: { sessionId }
 */
exports.queuePause = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: "sessionId required" });

    const count = await queue.pauseSession(sessionId);
    return ok(res, { paused: count });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /queue/resume
 * Body: { sessionId }
 */
exports.queueResume = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: "sessionId required" });

    const count = await queue.resumeSession(sessionId);
    return ok(res, { resumed: count });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * DELETE /queue/cancel
 * Body: { sessionId } OR { campaignId }
 */
exports.queueCancel = async (req, res) => {
  try {
    const { sessionId, campaignId } = req.body;
    if (!sessionId && !campaignId) {
      return res.status(400).json({ success: false, message: "sessionId or campaignId required" });
    }

    const count = await queue.cancelJobs({ sessionId, campaignId });
    return ok(res, { cancelled: count });
  } catch (err) {
    return fail(res, err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP ACTIONS (direct — bypasses queue)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /status
 * Body: { sessionId, type, mediaPath?, mediaBase64?, caption?, videoDuration? }
 */
exports.postStatus = async (req, res) => {
  try {
    const { sessionId, type = "image", mediaPath, mediaBase64, caption, videoDuration } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: "sessionId required" });

    let media;
    if (mediaBase64) {
      media = Buffer.from(mediaBase64, "base64");
    } else if (mediaPath) {
      media = mediaPath; // wa-actions.service reads the file
    } else {
      return res.status(400).json({ success: false, message: "mediaPath or mediaBase64 required" });
    }

    const result = await actions.postStatus(sessionId, { media, type, caption, videoDuration });
    return ok(res, { result });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /vcard
 * Body: { sessionId, phone, contact: { name, phone, org?, email?, title?, website? } }
 */
exports.sendVCard = async (req, res) => {
  try {
    const { sessionId, phone, contact } = req.body;
    if (!sessionId || !phone || !contact?.name || !contact?.phone) {
      return res.status(400).json({
        success: false,
        message: "sessionId, phone, contact.name, and contact.phone are required",
      });
    }

    const result = await actions.sendVCard(sessionId, phone, contact);
    return ok(res, { result });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /location
 * Body: { sessionId, phone, latitude, longitude, name?, address? }
 */
exports.sendLocation = async (req, res) => {
  try {
    const { sessionId, phone, latitude, longitude, name, address } = req.body;

    if (!sessionId || !phone || latitude == null || longitude == null) {
      return res.status(400).json({
        success: false,
        message: "sessionId, phone, latitude, and longitude are required",
      });
    }

    const result = await actions.sendLocation(sessionId, phone, {
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      name,
      address,
    });

    return ok(res, { result });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /group
 * Body: { sessionId, name, phones[], adminPhones[]?, description? }
 */
exports.createGroup = async (req, res) => {
  try {
    const { sessionId, name, phones, adminPhones, description } = req.body;

    if (!sessionId || !name || !Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({
        success: false,
        message: "sessionId, name, and phones[] are required",
      });
    }

    const result = await actions.createGroup(sessionId, { name, phones, adminPhones, description });
    return ok(res, result, 201);
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /community
 * Body: { sessionId, announcementJid, text?, media?: { base64, type, caption } }
 */
exports.broadcastToCommunity = async (req, res) => {
  try {
    const { sessionId, announcementJid, text, media: mediaRaw } = req.body;

    if (!sessionId || !announcementJid) {
      return res.status(400).json({ success: false, message: "sessionId and announcementJid required" });
    }
    if (!text && !mediaRaw) {
      return res.status(400).json({ success: false, message: "text or media is required" });
    }

    let media;
    if (mediaRaw) {
      if (!mediaRaw.base64) return res.status(400).json({ success: false, message: "media.base64 required" });
      media = {
        buffer: Buffer.from(mediaRaw.base64, "base64"),
        type: mediaRaw.type || "image",
        caption: mediaRaw.caption || "",
      };
    }

    const result = await actions.broadcastToCommunity(sessionId, { announcementJid, text, media });
    return ok(res, { result });
  } catch (err) {
    return fail(res, err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// WORKER
// ─────────────────────────────────────────────────────────────────────────────

/** GET /worker/status */
exports.workerStatus = (req, res) => {
  return ok(res, worker.status());
};

/** POST /worker/start */
exports.workerStart = (req, res) => {
  worker.start();
  return ok(res, { message: "Worker started" });
};

/** POST /worker/stop */
exports.workerStop = (req, res) => {
  worker.stop();
  return ok(res, { message: "Worker stopped" });
};

/**
 * POST /worker/kill-switch/reset
 * Body: { sessionId }
 */
exports.resetKillSwitch = (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: "sessionId required" });

  mktSession.resetKillSwitch(sessionId);
  return ok(res, { message: `Kill switch reset for session ${sessionId}` });
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

/** GET /config */
exports.getConfig = async (req, res) => {
  try {
    const config = await dynamicConfig.getAll();
    return ok(res, { config });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * GET /config/:key
 */
exports.getConfigKey = async (req, res) => {
  try {
    const { key } = req.params;
    const value = await dynamicConfig.get(key);
    return ok(res, { key, value });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * PATCH /config
 * Body: { key: value, ... }
 */
exports.updateConfig = async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return res.status(400).json({ success: false, message: "Body must be a key-value object" });
    }

    await dynamicConfig.setMany(updates);
    const updated = await dynamicConfig.getAll();
    return ok(res, { updated });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /config/reset/:key
 */
exports.resetConfigKey = async (req, res) => {
  try {
    const { key } = req.params;
    await dynamicConfig.reset(key);
    const value = await dynamicConfig.get(key);
    return ok(res, { key, value, message: `"${key}" reset to default` });
  } catch (err) {
    return fail(res, err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SPINTAX UTILITIES (preview endpoints)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH LOG / BAN RISK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /health/risk?phone=&hours=
 * Returns ban-risk summary for a phone over the last N hours
 */
exports.getAccountRisk = async (req, res) => {
  try {
    const { phone, hours = 24 } = req.query;
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const risk = await healthLog.getAccountRisk(phone, parseInt(hours));
    return ok(res, risk);
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * GET /health/risks?hours=
 * Returns top 50 riskiest accounts
 */
exports.getAllRisks = async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const risks = await healthLog.getAllAccountRisks(parseInt(hours));
    return ok(res, { risks });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * GET /health/timeline?phone=&limit=
 * Returns raw event timeline for a phone
 */
exports.getTimeline = async (req, res) => {
  try {
    const { phone, limit = 100 } = req.query;
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const events = await healthLog.getEventTimeline(phone, parseInt(limit));
    return ok(res, { events });
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /spintax/preview
 * Body: { template }
 * Returns all possible variations (use on small templates only!)
 */
exports.spintaxPreview = (req, res) => {
  const { template } = req.body;
  if (!template) return res.status(400).json({ success: false, message: "template required" });

  const variations = spintaxPreview(template);
  const count = spintaxVariationCount(template);

  return ok(res, {
    hasSpintax: hasSpintax(template),
    variationCount: count,
    variations: variations.slice(0, 50), // cap at 50 for safety
  });
};

/**
 * POST /spintax/resolve
 * Body: { template }
 * Returns one random resolved variation
 */
exports.spintaxResolve = (req, res) => {
  const { template } = req.body;
  if (!template) return res.status(400).json({ success: false, message: "template required" });

  const { spintax } = require("../services/marketing/spintax.utils");
  return ok(res, { resolved: spintax(template) });
};
