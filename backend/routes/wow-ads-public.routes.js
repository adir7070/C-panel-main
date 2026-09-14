/**
 * Public WOW Ads preview routes — NO auth.
 * Used when account manager sends approved ads to the client for approval.
 *   POST /api/wow-ads-preview/:token/approve  — client approves all
 *   POST /api/wow-ads-preview/:token/reject   — client rejects with feedback
 */

const express = require("express");
const router  = express.Router();
const wowAds  = require("../controllers/wow-ads.controller");

router.post("/:token/approve", wowAds.publicApproveAds);
router.post("/:token/reject",  wowAds.publicRejectAds);

module.exports = router;
