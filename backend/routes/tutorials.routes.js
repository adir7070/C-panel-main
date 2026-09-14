const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/tutorials.controller");

// Public — app fetches this
router.get("/", ctrl.getAll);

// Admin — categories
router.get("/admin/categories", ctrl.adminGetCategories);
router.post("/admin/categories", ctrl.adminCreateCategory);
router.put("/admin/categories/:id", ctrl.adminUpdateCategory);
router.delete("/admin/categories/:id", ctrl.adminDeleteCategory);

// Admin — videos
router.get("/admin/videos", ctrl.adminGetVideos);
router.post("/admin/videos", ctrl.adminCreateVideo);
router.put("/admin/videos/:id", ctrl.adminUpdateVideo);
router.delete("/admin/videos/:id", ctrl.adminDeleteVideo);

module.exports = router;
