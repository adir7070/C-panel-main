const DB = require("../utils/DB");

const COLLECTION = "app_logs";

/**
 * POST /api/log/ingest — receive log batch from the app
 * Body: { phone, logs: [{ level, message, timestamp, meta }], deviceInfo }
 */
exports.ingest = async (req, res) => {
  try {
    const { phone, logs, deviceInfo } = req.body || {};
    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ success: false, message: "No logs provided" });
    }

    const docs = logs.map((log) => ({
      phone: phone || "unknown",
      level: log.level || "log",
      message: log.message || "",
      timestamp: log.timestamp || new Date().toISOString(),
      screen: log.screen || null,
      stack: log.stack || null,
      meta: log.meta || null,
      deviceInfo: deviceInfo || null,
      createdAt: new Date(),
    }));

    await DB.collection(COLLECTION).insertMany(docs);
    res.json({ success: true, count: docs.length });
  } catch (e) {
    console.error("[Log Ingest] Error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * GET /api/log — query logs with filters
 * Query params: phone, level, from, to, limit, skip, search
 */
exports.query = async (req, res) => {
  try {
    const { phone, level, from, to, limit = 100, skip = 0, search } = req.query;

    const filter = {};
    if (phone) filter.phone = phone;
    if (level) filter.level = level;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (search) {
      filter.message = { $regex: search, $options: "i" };
    }

    const logs = await DB.collection(COLLECTION)
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(Number(skip))
      .limit(Math.min(Number(limit), 500))
      .toArray();

    const total = await DB.collection(COLLECTION).countDocuments(filter);

    res.json({ success: true, data: logs, total, limit: Number(limit), skip: Number(skip) });
  } catch (e) {
    console.error("[Log Query] Error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// Legacy endpoint — now also stores in MongoDB
exports.clientError = (req, res) => {
  const { error, stack, componentStack, breadcrumbs, agentId, url, ts } = req.body || {};
  const doc = {
    phone: agentId || "unknown",
    level: "error",
    message: error || "",
    timestamp: ts || new Date().toISOString(),
    meta: { stack, componentStack, breadcrumbs, url },
    createdAt: new Date(),
  };
  DB.collection(COLLECTION).insertOne(doc).catch(() => {});
  console.error("[CLIENT ERROR]", error);
  res.json({ success: true });
};
