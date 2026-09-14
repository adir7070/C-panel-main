const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/ai-creation-order.controller");

// POST /api/ai-creation-order/submit
router.post("/submit", ctrl.submitOrder);

// GET  /api/ai-creation-order/by-phone/:phone
router.get("/by-phone/:phone", ctrl.getByPhone);

// PATCH /api/ai-creation-order/:id/status
router.patch("/:id/status", ctrl.updateStatus);

// DELETE /api/ai-creation-order/:id
router.delete("/:id", ctrl.deleteOrder);

// POST /api/ai-creation-order/retry-failed
router.post("/retry-failed", ctrl.retryFailed);

// POST /api/ai-creation-order/trigger-publish
router.post("/trigger-publish", ctrl.triggerPublish);

// POST /api/ai-creation-order/schedule-social
router.post("/schedule-social", ctrl.scheduleSocial);

module.exports = router;
