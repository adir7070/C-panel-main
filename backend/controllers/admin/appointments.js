const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const status = req.query.status;
    const search = req.query.search?.trim();

    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { customerPhone: { $regex: search, $options: "i" } },
        { customerName: { $regex: search, $options: "i" } },
      ];
    }

    const [appointments, total] = await Promise.all([
      col("appointments").find(filter).sort({ scheduledStart: -1 }).skip(skip).limit(limit).toArray(),
      col("appointments").countDocuments(filter),
    ]);

    res.json({ appointments, page, totalPages: Math.ceil(total / limit), total });
  } catch (err) {
    console.error("[Admin/Appointments] list:", err.message);
    res.status(500).json({ message: "Failed to list appointments" });
  }
};

exports.getStats = async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [byStatus, upcoming, daily] = await Promise.all([
      col("appointments").aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).toArray(),
      col("appointments").countDocuments({ scheduledStart: { $gte: now } }),
      col("appointments").aggregate([
        { $match: { scheduledStart: { $gte: thirtyDaysAgo } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$scheduledStart" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    res.json({
      byStatus: Object.fromEntries(byStatus.map((s) => [s._id || "unknown", s.count])),
      upcoming,
      daily,
    });
  } catch (err) {
    console.error("[Admin/Appointments] stats:", err.message);
    res.status(500).json({ message: "Failed to get appointment stats" });
  }
};
