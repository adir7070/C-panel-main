const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.listSessions = async (req, res) => {
  try {
    const sessions = await col("wa_sessions").find({}).sort({ created_at: -1 }).toArray();
    const [totalLogs, successLogs] = await Promise.all([
      col("sms_logs").countDocuments(),
      col("sms_logs").countDocuments({ success: true }),
    ]);

    res.json({
      sessions,
      totalSessions: sessions.length,
      connectedCount: sessions.filter((s) => s.status === "connected").length,
      smsStats: {
        total: totalLogs,
        success: successLogs,
        failed: totalLogs - successLogs,
        successRate: totalLogs > 0 ? Math.round((successLogs / totalLogs) * 100) : 0,
      },
    });
  } catch (err) {
    console.error("[Admin/WA] sessions:", err.message);
    res.status(500).json({ message: "Failed to list sessions" });
  }
};

exports.getSmsLogs = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.phone) filter.phone = { $regex: req.query.phone, $options: "i" };
    if (req.query.success !== undefined) filter.success = req.query.success === "true";

    const [logs, total] = await Promise.all([
      col("sms_logs").find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col("sms_logs").countDocuments(filter),
    ]);

    res.json({ logs, page, totalPages: Math.ceil(total / limit), total });
  } catch (err) {
    console.error("[Admin/WA] smsLogs:", err.message);
    res.status(500).json({ message: "Failed to get SMS logs" });
  }
};

exports.disconnectSession = async (req, res) => {
  try {
    const { phone } = req.params;
    await col("wa_sessions").updateOne(
      { phone },
      { $set: { status: "disconnected", disconnected_at: new Date() } }
    );
    res.json({ message: "Session disconnected" });
  } catch (err) {
    console.error("[Admin/WA] disconnect:", err.message);
    res.status(500).json({ message: "Failed to disconnect session" });
  }
};
