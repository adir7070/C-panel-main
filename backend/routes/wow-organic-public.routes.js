/**
 * Public WOW Organic preview routes — NO auth.
 *   POST /api/wow-organic-preview/:token/approve
 *   POST /api/wow-organic-preview/:token/reject
 */

const express = require("express");
const router  = express.Router();
const wow     = require("../controllers/wow-organic-ads.controller");

router.post("/:token/approve", wow.publicOrganicApprove);
router.post("/:token/reject",  wow.publicOrganicReject);

module.exports = router;
