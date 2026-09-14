const express = require("express");
const router = express.Router();
const s3PublishService = require("../../services/wow/s3-publish.service");

// POST /api/wow/publish/:sessionId  body: { phone }
router.post("/:sessionId", async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const phone = req.body && req.body.phone;
    if (!phone) {
      return res.status(400).json({ error: true, message: "phone is required" });
    }
    const { url } = await s3PublishService.publish(sessionId, phone);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
