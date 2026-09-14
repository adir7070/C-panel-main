const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.getOverview = async (req, res) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [totalAdded, totalUsed, thisMonthRev, lastMonthRev, totalInvoices, spendByAction] =
      await Promise.all([
        col("coin_transactions").aggregate([
          { $match: { type: "add" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).toArray(),
        col("coin_transactions").aggregate([
          { $match: { type: "deduct" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).toArray(),
        col("coin_transactions").aggregate([
          { $match: { type: "add", created_at: { $gte: thisMonthStart } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).toArray(),
        col("coin_transactions").aggregate([
          { $match: { type: "add", created_at: { $gte: lastMonthStart, $lt: thisMonthStart } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).toArray(),
        col("willbox_invoices").countDocuments(),
        col("coin_transactions").aggregate([
          { $match: { type: "deduct" } },
          { $group: { _id: "$action", total: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ]).toArray(),
      ]);

    const thisM = thisMonthRev[0]?.total || 0;
    const lastM = lastMonthRev[0]?.total || 0;
    const trend = lastM > 0 ? Math.round(((thisM - lastM) / lastM) * 100) : 0;

    res.json({
      totalCoinsAdded: totalAdded[0]?.total || 0,
      totalCoinsUsed: totalUsed[0]?.total || 0,
      thisMonthRevenue: thisM,
      lastMonthRevenue: lastM,
      revenueTrend: trend,
      totalInvoices,
      spendByAction,
    });
  } catch (err) {
    console.error("[Admin/Finance] overview:", err.message);
    res.status(500).json({ message: "Failed to load finance overview" });
  }
};

exports.listTransactions = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.phone) filter.phone = { $regex: req.query.phone, $options: "i" };

    const [transactions, total] = await Promise.all([
      col("coin_transactions").find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col("coin_transactions").countDocuments(filter),
    ]);

    res.json({ transactions, page, totalPages: Math.ceil(total / limit), total });
  } catch (err) {
    console.error("[Admin/Finance] transactions:", err.message);
    res.status(500).json({ message: "Failed to list transactions" });
  }
};

exports.getPackages = async (req, res) => {
  try {
    const [packages, actionPrices] = await Promise.all([
      col("coin_packages").find({}).sort({ coins: 1 }).toArray(),
      col("action_prices").find({}).sort({ action: 1 }).toArray(),
    ]);
    res.json({ packages, actionPrices });
  } catch (err) {
    console.error("[Admin/Finance] packages:", err.message);
    res.status(500).json({ message: "Failed to get packages" });
  }
};

exports.listInvoices = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.phone) filter.phone = { $regex: req.query.phone, $options: "i" };

    const [invoices, total] = await Promise.all([
      col("willbox_invoices").find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col("willbox_invoices").countDocuments(filter),
    ]);

    res.json({ invoices, page, totalPages: Math.ceil(total / limit), total });
  } catch (err) {
    console.error("[Admin/Finance] invoices:", err.message);
    res.status(500).json({ message: "Failed to list invoices" });
  }
};
