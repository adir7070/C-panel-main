"use strict";

const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/wa-marketing.controller");

// ─────────────────────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────────────────────

router.post("/enqueue", ctrl.enqueue);
router.post("/enqueue-bulk", ctrl.enqueueBulk);
router.get("/queue/stats", ctrl.queueStats);
router.post("/queue/pause", ctrl.queuePause);
router.post("/queue/resume", ctrl.queueResume);
router.delete("/queue/cancel", ctrl.queueCancel);

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Actions (direct — bypasses queue)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/status", ctrl.postStatus);
router.post("/vcard", ctrl.sendVCard);
router.post("/location", ctrl.sendLocation);
router.post("/group", ctrl.createGroup);
router.post("/community", ctrl.broadcastToCommunity);

// ─────────────────────────────────────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────────────────────────────────────

router.get("/worker/status", ctrl.workerStatus);
router.post("/worker/start", ctrl.workerStart);
router.post("/worker/stop", ctrl.workerStop);
router.post("/worker/kill-switch/reset", ctrl.resetKillSwitch);

// ─────────────────────────────────────────────────────────────────────────────
// DynamicConfig
// ─────────────────────────────────────────────────────────────────────────────

router.get("/config", ctrl.getConfig);
router.get("/config/:key", ctrl.getConfigKey);
router.patch("/config", ctrl.updateConfig);
router.post("/config/reset/:key", ctrl.resetConfigKey);

// ─────────────────────────────────────────────────────────────────────────────
// Health Log / Ban Risk
// ─────────────────────────────────────────────────────────────────────────────

router.get("/health/risk", ctrl.getAccountRisk);
router.get("/health/risks", ctrl.getAllRisks);
router.get("/health/timeline", ctrl.getTimeline);

// ─────────────────────────────────────────────────────────────────────────────
// Spintax utilities
// ─────────────────────────────────────────────────────────────────────────────

router.post("/spintax/preview", ctrl.spintaxPreview);
router.post("/spintax/resolve", ctrl.spintaxResolve);

module.exports = router;
