const express = require("express");
const multer = require("multer");
const router = express.Router();
const ctrl = require("../controllers/ad-images.controller");

const upload = multer({ storage: multer.memoryStorage() });

// POST /api/ad-images/generate         → start image generation job (Make.com based)
router.post("/generate", ctrl.generateImages);

// POST /api/ad-images/generate-quick   → starts async job, returns { jobId }
router.post("/generate-quick", ctrl.generateQuick);

// GET  /api/ad-images/quick-status/:jobId → poll quick-gen job status
router.get("/quick-status/:jobId", ctrl.getQuickJobStatus);

// POST /api/ad-images/generate-changes → generate/edit ad image (replaces Make scenario)
router.post(
  "/generate-changes",
  upload.fields([
    { name: "logo_file", maxCount: 1 },
    { name: "base_image_file", maxCount: 1 },
    { name: "real_photo_file", maxCount: 1 },
  ]),
  ctrl.generateChanges
);

// GET  /api/ad-images/status/:jobId    → poll job status
router.get("/status/:jobId", ctrl.getJobStatus);

// GET  /api/ad-images/latest/:phone    → get latest job for phone
router.get("/latest/:phone", ctrl.getLatestJob);

module.exports = router;
