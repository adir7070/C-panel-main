const express = require("express");
const router = express.Router();
const { DB } = require("../../config/db");

const COL = "wow_visits";
const HISTORY_COL = "wow_history";

function parseDevice(ua) {
  if (!ua) return "unknown";
  return /Mobile|Android|iPhone|iPad/i.test(ua) ? "mobile" : "desktop";
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

// GET /api/wow/page/:sessionId — logs visit then 302 → S3
router.get("/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  try {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || null;
    const referrer = req.headers["referer"] || req.headers["referrer"] || null;
    await DB.collection(COL).insertOne({
      sessionId,
      visitedAt: new Date().toISOString(),
      ua,
      device: parseDevice(ua),
      ip,
      referrer,
      screenWidth: null,
    });
    console.log(`[wow/page] visit logged for session ${sessionId} — ${ip}`);
  } catch (err) {
    console.warn(`[wow/page] visit log failed: ${err.message}`);
  }

  const record = await DB.collection(HISTORY_COL).findOne({ sessionId }).catch(() => null);
  const target = record?.s3Url || null;

  if (!target) {
    return res.status(404).send("Landing page not found");
  }
  res.redirect(302, target);
});

module.exports = router;
