const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.list = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim() || "";
    const phone = req.query.phone || "";

    const pipeline = [
      { $unwind: "$forms" },
      { $unwind: "$forms.leads" },
      { $replaceRoot: { newRoot: { $mergeObjects: ["$forms.leads", { ownerPhone: "$phone", formName: "$forms.formName" }] } } },
    ];

    if (phone) pipeline.unshift({ $match: { phone } });
    if (search) pipeline.push({ $match: { $or: [
      { name: { $regex: search, $options: "i" } },
      { lead_phone: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ]}});

    const countResult = await col("user_leads").aggregate([...pipeline, { $count: "total" }]).toArray();
    const total = countResult[0]?.total || 0;

    pipeline.push({ $sort: { created_time: -1 } }, { $skip: skip }, { $limit: limit });
    const data = await col("user_leads").aggregate(pipeline).toArray();

    res.json({ data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[AppAdmin/Leads] list:", err.message);
    res.status(500).json({ message: "Failed to load leads" });
  }
};

exports.getStats = async (_req, res) => {
  try {
    const [byUser, totalAgg] = await Promise.all([
      col("user_leads").aggregate([
        { $unwind: "$forms" },
        { $group: { _id: "$phone", totalLeads: { $sum: "$forms.leadsCount" }, formCount: { $sum: 1 } } },
        { $sort: { totalLeads: -1 } },
      ]).toArray(),
      col("user_leads").aggregate([
        { $unwind: "$forms" },
        { $group: { _id: null, totalLeads: { $sum: "$forms.leadsCount" }, totalForms: { $sum: 1 } } },
      ]).toArray(),
    ]);

    res.json({
      totalLeads: totalAgg[0]?.totalLeads || 0,
      totalForms: totalAgg[0]?.totalForms || 0,
      totalUsers: byUser.length,
      byUser,
    });
  } catch (err) {
    console.error("[AppAdmin/Leads] stats:", err.message);
    res.status(500).json({ message: "Failed to load lead stats" });
  }
};
