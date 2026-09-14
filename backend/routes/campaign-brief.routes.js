const express = require("express");
const router = express.Router();
const c = require("../controllers/campaign-brief.controller");

// POST /api/campaign-brief/submit
router.post("/submit", c.submit);

// GET /api/campaign-brief/status/:phone
router.get("/status/:phone", c.getStatus);

module.exports = router;
