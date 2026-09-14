const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/ad-brief.controller");

// GET  /api/ad-brief                  → list all (admin)
router.get("/", ctrl.getAll);

// GET  /api/ad-brief/by-phone/:phone  → get brief by phone
router.get("/by-phone/:phone", ctrl.getByPhone);

// POST /api/ad-brief/answer           → save single question answer
router.post("/answer", ctrl.saveAnswer);

// POST /api/ad-brief/colors           → save brand colors
router.post("/colors", ctrl.saveColors);

// POST /api/ad-brief/complete         → mark brief as completed
router.post("/complete", ctrl.completeBrief);

module.exports = router;
