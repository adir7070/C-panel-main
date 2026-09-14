const express = require("express");
const multer = require("multer");
const router = express.Router();
const ctrl = require("../controllers/gallery-order.controller");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per image
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// POST /api/gallery-order/submit
router.post(
  "/submit",
  (req, res, next) => {
    upload.array("images", 10)(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, error: err.message });
      next();
    });
  },
  ctrl.submitGalleryOrder
);

module.exports = router;
