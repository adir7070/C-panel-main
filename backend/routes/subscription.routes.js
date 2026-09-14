/**
 * subscription.routes.js — client-facing subscription tiers (REGULAR/PRO/VIP).
 * Mounted at /api/subscription, no auth (mobile-facing, like the coins routes).
 * /payment-confirm is the Cardcom webhook.
 */
const express = require("express");
const router = express.Router();
const c = require("../controllers/tier-subscription.controller");

router.get("/tiers", c.getTiers);
router.get("/status", c.getMyStatus);
router.get("/return", c.paymentReturn);
router.post("/purchase", c.purchaseTier);
router.post("/payment-confirm", c.paymentConfirm);

module.exports = router;
