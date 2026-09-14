const DB = require("../utils/DB");

const COLLECTION = "app_activity";

/**
 * POST /api/activity/ingest — receive activity events batch from the app
 * Body: { phone, events: [{ type, name, timestamp, duration?, meta? }], deviceInfo }
 */
exports.ingest = async (req, res) => {
  try {
    const { phone, events, deviceInfo } = req.body || {};
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, message: "No events" });
    }

    const docs = events.map((ev) => ({
      phone: phone || "unknown",
      type: ev.type,
      name: ev.name,
      timestamp: ev.timestamp || new Date().toISOString(),
      duration: ev.duration || null,
      meta: ev.meta || null,
      deviceInfo: deviceInfo || null,
      createdAt: new Date(),
    }));

    await DB.collection(COLLECTION).insertMany(docs);
    res.json({ success: true, count: docs.length });
  } catch (e) {
    console.error("[Activity Ingest] Error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};
