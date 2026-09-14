const express = require("express");
const router = express.Router();
const {
  submitCorrections,
  savePending,
  loadPending,
} = require("../controllers/corrections.controller");

// POST /api/app/corrections/:phone/submit
router.post("/:phone/submit", submitCorrections);

// POST /api/app/corrections/:phone/pending — save draft
router.post("/:phone/pending", savePending);

// GET /api/app/corrections/:phone/pending — load draft
router.get("/:phone/pending", loadPending);

module.exports = router;
