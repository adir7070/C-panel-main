const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.getStats = async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [totalInsta, instaByStatus, totalBatch, batchByStatus, totalImages, daily] =
      await Promise.all([
        col("instagram_jobs").countDocuments(),
        col("instagram_jobs").aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
        col("image_batch_jobs").countDocuments(),
        col("image_batch_jobs").aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
        col("images").countDocuments(),
        col("instagram_jobs").aggregate([
          { $match: { createdAt: { $gte: thirtyDaysAgo } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]).toArray(),
      ]);

    res.json({
      instagram: { total: totalInsta, byStatus: Object.fromEntries(instaByStatus.map((s) => [s._id, s.count])) },
      imageBatch: { total: totalBatch, byStatus: Object.fromEntries(batchByStatus.map((s) => [s._id, s.count])) },
      totalImages,
      dailyGenerations: daily,
    });
  } catch (err) {
    console.error("[Admin/Content] stats:", err.message);
    res.status(500).json({ message: "Failed to get content stats" });
  }
};

exports.listJobs = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const type = req.query.type || "instagram";
    const status = req.query.status;

    const collection = type === "batch" ? "image_batch_jobs" : "instagram_jobs";
    const filter = {};
    if (status) filter.status = status;

    const [jobs, total] = await Promise.all([
      col(collection).find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      col(collection).countDocuments(filter),
    ]);

    res.json({ jobs, page, totalPages: Math.ceil(total / limit), total, type });
  } catch (err) {
    console.error("[Admin/Content] jobs:", err.message);
    res.status(500).json({ message: "Failed to list jobs" });
  }
};
