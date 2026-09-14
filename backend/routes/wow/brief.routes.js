const express = require("express");
const router = express.Router();
const { saveBrief, updateBriefFiles } = require("../../services/wow/brief.service");
const { removeLogoBackground } = require("../../services/wow/gemini-image.service");
const wowUpload = require("../../middlewares/wow-upload.middleware");
const backblazeService = require("../../services/backblaze.service");

// POST /api/brief — שמירת בריף
router.post('/', async (req, res, next) => {
  try {
    const result = await saveBrief(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/brief/upload/:briefId — העלאת קבצים
router.post(
  '/upload/:briefId',
  wowUpload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'photos', maxCount: 10 },
    { name: 'facePhoto', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const files = req.files || {};
      const briefId = req.params.briefId;

      // Upload logo to Backblaze
      let logo = null;
      if (files.logo?.[0]) {
        const f = files.logo[0];
        const logoPath = `wow/briefs/${briefId}/logo-${Date.now()}-${f.originalname || 'logo'}`;
        const up = await backblazeService.uploadImage(logoPath, f.buffer, f.mimetype);
        logo = up.publicUrl;

        // הסרת רקע לוגו אוטומטית דרך Gemini — takes a Backblaze path
        const noBgUrl = await removeLogoBackground(logoPath).catch(() => null);
        if (noBgUrl) {
          logo = noBgUrl;
        }
      }

      // Upload photos to Backblaze
      const photos = [];
      for (const f of (files.photos || [])) {
        const photoPath = `wow/briefs/${briefId}/photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${f.originalname || 'photo'}`;
        const up = await backblazeService.uploadImage(photoPath, f.buffer, f.mimetype);
        photos.push(up.publicUrl);
      }

      // Upload face photo to Backblaze
      let facePhoto = null;
      if (files.facePhoto?.[0]) {
        const f = files.facePhoto[0];
        const facePath = `wow/briefs/${briefId}/face-${Date.now()}-${f.originalname || 'face'}`;
        const up = await backblazeService.uploadImage(facePath, f.buffer, f.mimetype);
        facePhoto = up.publicUrl;
      }

      await updateBriefFiles(briefId, logo, photos, facePhoto);

      res.json({ logo, photos, facePhoto });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
