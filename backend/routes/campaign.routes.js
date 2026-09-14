const router = require("express").Router();
const multer = require("multer");
const ctrl = require("../controllers/campaign.controller");
const demoCampaignCtrl = require("../controllers/demo-campaign.controller");

// Multer for multipart/form-data (logo + user images from React Native FormData)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// POST /api/campaign/generate-images
// Initial request (no jobId): starts async generation, returns { jobId }
// Polling request (with jobId): returns { status: true, data } or { status: false }
router.post(
  "/generate-images",
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "images", maxCount: 10 },
  ]),
  ctrl.generateImages
);

// POST /api/campaign/create-demo
// Uploads a demo campaign to Facebook: creates campaign → ad set → ads
router.post("/create-demo", demoCampaignCtrl.createDemoCampaign);

// POST /api/campaign/add-ad
// Injects ONE already-generated AI image as a real (PAUSED) ad into an existing
// campaign's ad set — used by the app's "הוסף מודעה חדשה → AI" flow.
router.post("/add-ad", ctrl.addAd);

module.exports = router;
