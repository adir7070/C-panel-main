const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.getOverview = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(todayStart);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const prevWeekStart = new Date(weekAgo);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);

    const [
      totalUsers,
      newUsersThisWeek,
      newUsersPrevWeek,
      activeSessions,
      openTickets,
      todayRevenue,
      totalLeads,
      newLeadsThisWeek,
      pendingJobs,
    ] = await Promise.all([
      col("users").countDocuments(),
      col("users").countDocuments({ createdAt: { $gte: weekAgo } }),
      col("users").countDocuments({ createdAt: { $gte: prevWeekStart, $lt: weekAgo } }),
      col("wa_sessions").countDocuments({ status: "connected" }),
      col("support_chats").countDocuments({ status: { $ne: "closed" } }),
      col("coin_transactions")
        .aggregate([
          { $match: { type: "add", created_at: { $gte: todayStart } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
        .toArray(),
      col("leads").countDocuments(),
      col("leads").countDocuments({ created_at: { $gte: weekAgo } }),
      col("instagram_jobs").countDocuments({ status: "processing" }),
    ]);

    const usersTrend =
      newUsersPrevWeek > 0
        ? Math.round(((newUsersThisWeek - newUsersPrevWeek) / newUsersPrevWeek) * 100)
        : newUsersThisWeek > 0 ? 100 : 0;

    res.json({
      totalUsers,
      newUsersThisWeek,
      usersTrend,
      activeSessions,
      openTickets,
      todayRevenue: todayRevenue[0]?.total || 0,
      totalLeads,
      newLeadsThisWeek,
      pendingJobs,
    });
  } catch (err) {
    console.error("[Admin/Dashboard] overview:", err.message);
    res.status(500).json({ message: "Failed to load overview" });
  }
};

exports.getRecentActivity = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const [recentUsers, recentLeads, recentTx] = await Promise.all([
      col("users").find({}).sort({ createdAt: -1 }).limit(limit)
        .project({ phone: 1, name: 1, createdAt: 1 }).toArray(),
      col("leads").find({}).sort({ created_at: -1 }).limit(limit)
        .project({ name: 1, phone: 1, status: 1, created_at: 1 }).toArray(),
      col("coin_transactions").find({}).sort({ created_at: -1 }).limit(limit)
        .project({ phone: 1, type: 1, amount: 1, action: 1, created_at: 1 }).toArray(),
    ]);

    const activity = [
      ...recentUsers.map((u) => ({
        type: "new_user", label: `New user: ${u.name || u.phone}`, phone: u.phone, date: u.createdAt,
      })),
      ...recentLeads.map((l) => ({
        type: "new_lead", label: `New lead: ${l.name || l.phone}`, phone: l.phone, date: l.created_at,
      })),
      ...recentTx.map((t) => ({
        type: "transaction",
        label: `${t.type === "add" ? "+" : "-"}${t.amount} coins${t.action ? ` (${t.action})` : ""}`,
        phone: t.phone, date: t.created_at,
      })),
    ]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);

    res.json({ activity });
  } catch (err) {
    console.error("[Admin/Dashboard] activity:", err.message);
    res.status(500).json({ message: "Failed to load activity" });
  }
};

exports.getChartData = async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const start = new Date();
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    const datePipeline = (dateField) => [
      { $match: { [dateField]: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: `$${dateField}` } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ];

    const [usersByDay, leadsByDay, revenueByDay] = await Promise.all([
      col("users").aggregate(datePipeline("createdAt")).toArray(),
      col("leads").aggregate(datePipeline("created_at")).toArray(),
      col("coin_transactions").aggregate([
        { $match: { type: "add", created_at: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } }, total: { $sum: "$amount" } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    res.json({ usersByDay, leadsByDay, revenueByDay });
  } catch (err) {
    console.error("[Admin/Dashboard] charts:", err.message);
    res.status(500).json({ message: "Failed to load chart data" });
  }
};
