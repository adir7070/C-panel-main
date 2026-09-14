const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.getStats = async (_req, res) => {
  try {
    const [totalGallery, approvedImages, archivedImages, totalProfiles, byUser] = await Promise.all([
      col("gallery_statuses").countDocuments(),
      col("gallery_statuses").countDocuments({ status: "approved" }),
      col("gallery_statuses").countDocuments({ status: "archived" }),
      col("profiles_by_page").countDocuments(),
      col("gallery_statuses").aggregate([
        { $group: { _id: "$phone", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
    ]);
    res.json({ totalGallery, approvedImages, archivedImages, totalProfiles, byUser });
  } catch (err) {
    console.error("[AppAdmin/Content] stats:", err.message);
    res.status(500).json({ message: "Failed to load content stats" });
  }
};

exports.listJobs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const phone = req.query.phone || "";
    const query = {};
    if (phone) query.phone = { $regex: phone, $options: "i" };

    const [data, total] = await Promise.all([
      col("gallery_statuses").find(query).skip(skip).limit(limit).toArray(),
      col("gallery_statuses").countDocuments(query),
    ]);
    res.json({ data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[AppAdmin/Content] jobs:", err.message);
    res.status(500).json({ message: "Failed to load gallery" });
  }
};

exports.listImages = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      col("profiles_by_page").find({}).skip(skip).limit(limit).toArray(),
      col("profiles_by_page").countDocuments(),
    ]);
    res.json({ data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[AppAdmin/Content] images:", err.message);
    res.status(500).json({ message: "Failed to load profiles" });
  }
};
