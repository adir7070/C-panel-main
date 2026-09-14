const express = require("express");
const router = express.Router();
const c = require("../controllers/file-types.controller");

// Public — mobile app fetches this to know which types to allow in the picker
router.get("/", c.getFileTypes);
router.get("/upload-limits", c.getUploadLimits);

// Admin-auth routes — webapp settings panel
router.get("/admin", c.getFileTypesAdmin);
router.post("/", c.addFileType);
router.put("/upload-limits", c.setUploadLimits);
router.delete("/:id", c.deleteFileType);

module.exports = router;
