const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/ad-plan.controller");

// GET  /api/ad-plan/by-phone/:phone  → get plan by phone
router.get("/by-phone/:phone", ctrl.getByPhone);

// POST /api/ad-plan/generate         → generate plan via GPT-4o
router.post("/generate", ctrl.generatePlan);

// POST /api/ad-plan/save             → save edited plan
router.post("/save", ctrl.savePlan);

// POST /api/ad-plan/upload-image     → upload reference image per ad
router.post("/upload-image", ctrl.uploadAdImage);

module.exports = router;
