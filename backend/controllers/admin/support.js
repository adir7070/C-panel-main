const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.listChats = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const status = req.query.status;

    const filter = {};
    if (status) filter.status = status;

    const [chats, total] = await Promise.all([
      col("support_chats").find(filter).sort({ updated_at: -1 }).skip(skip).limit(limit).toArray(),
      col("support_chats").countDocuments(filter),
    ]);

    res.json({ chats, page, totalPages: Math.ceil(total / limit), total });
  } catch (err) {
    console.error("[Admin/Support] chats:", err.message);
    res.status(500).json({ message: "Failed to list chats" });
  }
};

exports.getStats = async (req, res) => {
  try {
    const [byStatus, byStation, totalMessages] = await Promise.all([
      col("support_chats").aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).toArray(),
      col("support_chats").aggregate([
        { $group: { _id: "$station", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      col("support_chats").aggregate([
        { $project: { msgCount: { $size: { $ifNull: ["$messages", []] } } } },
        { $group: { _id: null, total: { $sum: "$msgCount" } } },
      ]).toArray(),
    ]);

    res.json({
      byStatus: Object.fromEntries(byStatus.map((s) => [s._id || "unassigned", s.count])),
      byStation,
      totalMessages: totalMessages[0]?.total || 0,
    });
  } catch (err) {
    console.error("[Admin/Support] stats:", err.message);
    res.status(500).json({ message: "Failed to get support stats" });
  }
};

exports.listAgents = async (req, res) => {
  try {
    const agents = await col("agents")
      .find({})
      .project({ password: 0, token: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ agents });
  } catch (err) {
    console.error("[Admin/Support] agents:", err.message);
    res.status(500).json({ message: "Failed to list agents" });
  }
};
