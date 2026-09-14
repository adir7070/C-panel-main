const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

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
    if (search) filter.message = { $regex: search, $options: "i" };

    const [logs, total] = await Promise.all([
      col("app_logs").find(filter).sort({ createdAt: -1 }).skip(Number(skip)).limit(Math.min(Number(limit), 500)).toArray(),
      col("app_logs").countDocuments(filter),
    ]);

    res.json({ success: true, data: logs, total, limit: Number(limit), skip: Number(skip) });
  } catch (err) {
    console.error("[AppAdmin/Logs]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};
