const express = require("express");
const router = express.Router();
const { saveWowFeedback } = require("../../services/fireberry.service");

// POST /api/wow/feedback  body: { phone, comment }
router.post("/", async (req, res, next) => {
  try {
    const { phone, comment } = req.body;
    if (!phone || !comment) {
      return res.status(400).json({ ok: false, error: "phone and comment required" });
    }
    await saveWowFeedback(phone, comment);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
