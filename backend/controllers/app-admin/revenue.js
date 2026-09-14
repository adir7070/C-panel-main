const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.getStats = async (_req, res) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

    const [totalAppts, thisMonthAppts, lastMonthAppts, totalClients, totalLeadsAgg] = await Promise.all([
      col("appointments").countDocuments(),
      col("appointments").countDocuments({ createdAt: { $gte: thisMonthStart } }),
      col("appointments").countDocuments({ createdAt: { $gte: lastMonthStart, $lt: thisMonthStart } }),
      col("fireberry_customers").countDocuments(),
      col("user_leads").aggregate([
        { $unwind: "$forms" },
        { $group: { _id: null, total: { $sum: "$forms.leadsCount" } } },
      ]).toArray(),
    ]);

    const totalLeads = totalLeadsAgg[0]?.total || 0;
    const apptTrend = lastMonthAppts > 0 ? Math.round(((thisMonthAppts - lastMonthAppts) / lastMonthAppts) * 100) : 0;

    res.json({ totalAppointments: totalAppts, thisMonthAppointments: thisMonthAppts, apptTrend, totalClients, totalLeads });
  } catch (err) {
    console.error("[AppAdmin/Revenue] stats:", err.message);
    res.status(500).json({ message: "Failed to load stats" });
  }
};

exports.getChart = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const data = await col("appointments").aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $substr: ["$createdAt", 0, 10] }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    res.json({ data });
  } catch (err) {
    console.error("[AppAdmin/Revenue] chart:", err.message);
    res.status(500).json({ message: "Failed to load chart" });
  }
};

exports.getByAction = async (_req, res) => {
  try {
    const data = await col("appointments").aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    res.json({ data });
  } catch (err) {
    console.error("[AppAdmin/Revenue] byAction:", err.message);
    res.status(500).json({ message: "Failed" });
  }
};

exports.listTransactions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const phone = req.query.phone || "";
    const query = {};
    if (phone) query.customerPhone = { $regex: phone, $options: "i" };

    const [data, total] = await Promise.all([
      col("appointments").find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      col("appointments").countDocuments(query),
    ]);
    res.json({ data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[AppAdmin/Revenue] transactions:", err.message);
    res.status(500).json({ message: "Failed" });
  }
};
