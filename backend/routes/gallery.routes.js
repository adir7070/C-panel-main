const express = require("express");
const router = express.Router();
const { getGalleryStatuses, updateGalleryStatus } = require("../controllers/gallery.controller");

// GET /:phone/statuses — שליפת כל הסטטוסים לפי phone
router.get("/:phone/statuses", getGalleryStatuses);

// POST /:phone/status — עדכון סטטוס תמונה
router.post("/:phone/status", updateGalleryStatus);

module.exports = router;
