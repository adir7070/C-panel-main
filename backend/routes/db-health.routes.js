const express = require("express");
const router = express.Router();
const { DB } = require("../config/db");

const logs = () => DB.collection("db_fallback_logs");

/**
 * GET /api/db-health/fallback-logs
 * Returns recent fallback events (when primary AWS failed → used Atlas)
 * Query: ?limit=50&page=1&collection=chats
 */
router.get("/fallback-logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.collection) filter.collection = req.query.collection;
    if (req.query.from) filter.timestamp = { $gte: new Date(req.query.from) };

    const [items, total] = await Promise.all([
      logs().find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray(),
      logs().countDocuments(filter),
    ]);

    res.json({ success: true, total, page, limit, items });
  } catch (err) {
    console.error("[db-health] fallback-logs error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/db-health/status
 * Returns DB connection status + fallback event count (last 24h)
 */
router.get("/status", async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const last24h = await logs().countDocuments({ timestamp: { $gte: since } });
    const lastEvent = await logs().find({}).sort({ timestamp: -1 }).limit(1).toArray();

    res.json({
      success: true,
      fallbacks_last_24h: last24h,
      last_fallback: lastEvent[0] || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/db-health/fallback-logs
 * Clear all fallback logs (admin cleanup)
 */
router.delete("/fallback-logs", async (req, res) => {
  try {
    const result = await logs().deleteMany({});
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
