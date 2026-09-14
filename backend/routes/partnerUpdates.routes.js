const express = require("express");
const router = express.Router();
const {
  getSettings,
  updateSettings,
  getActiveUpdates,
  submitForm,
  createUpdate,
  toggleActive,
  deleteUpdate,
  getAllUpdates,
  getSubmissions,
  getPublicWebinar,
  submitPublicRegistration,
} = require("../controllers/partnerUpdates.controller");

// Public (no auth) — must be before /:id routes to avoid collision
router.get("/public/:token", getPublicWebinar);
router.post("/public/:token/register", submitPublicRegistration);

// App endpoints (kept for backwards compat)
router.get("/active", getActiveUpdates);
router.post("/submit-form", submitForm);

// Settings (admin)
router.get("/settings", getSettings);
router.patch("/settings", updateSettings);

// Admin endpoints
router.get("/", getAllUpdates);
router.post("/", createUpdate);
router.patch("/:id/toggle", toggleActive);
router.delete("/:id", deleteUpdate);
router.get("/:id/submissions", getSubmissions);

module.exports = router;
