const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();
    const status = req.query.status;
    const pageId = req.query.pageId;

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    if (status) filter.status = status;
    if (pageId) filter.page_id = pageId;

    const [leads, total] = await Promise.all([
      col("leads").find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col("leads").countDocuments(filter),
    ]);

    res.json({ leads, page, totalPages: Math.ceil(total / limit), total });
  } catch (err) {
    console.error("[Admin/Leads] list:", err.message);
    res.status(500).json({ message: "Failed to list leads" });
  }
};

exports.getStats = async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [byStatus, byPage, daily] = await Promise.all([
      col("leads").aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      col("leads").aggregate([
        { $group: { _id: "$page_id", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]).toArray(),
      col("leads").aggregate([
        { $match: { created_at: { $gte: thirtyDaysAgo } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    const total = byStatus.reduce((s, b) => s + b.count, 0);
    res.json({ total, byStatus, byPage, daily });
  } catch (err) {
    console.error("[Admin/Leads] stats:", err.message);
    res.status(500).json({ message: "Failed to get lead stats" });
  }
};
