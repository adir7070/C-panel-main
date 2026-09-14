/**
 * Public WOW Landing Page preview routes — NO auth.
 * Used when account manager sends the LP draft for client approval.
 *   GET  /api/wow-lp/preview/:token              — returns LP json
 *   POST /api/wow-lp/preview/:token/approve      — client approves
 *   POST /api/wow-lp/preview/:token/reject       — client rejects with feedback
 */

const express = require("express");
const router  = express.Router();
const wowLp   = require("../controllers/wow-lp.controller");

router.get( "/preview/:token",          wowLp.publicPreview);
router.post("/preview/:token/approve",  wowLp.publicApprove);
router.post("/preview/:token/reject",   wowLp.publicReject);

module.exports = router;
