const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.getOverview = async (_req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 86400000);

    const [
      totalClients, totalLeadDocs, totalBriefs, openChats,
      totalAppointments, totalWaSessions, totalSms, totalGallery,
    ] = await Promise.all([
      col("fireberry_customers").countDocuments(),
      col("user_leads").countDocuments(),
      col("client_briefs").countDocuments(),
      col("support_chats").countDocuments(),
      col("appointments").countDocuments(),
      col("wa_sessions").countDocuments(),
      col("sms_logs").countDocuments(),
      col("gallery_statuses").countDocuments(),
    ]);

    const leadsAgg = await col("user_leads").aggregate([
      { $unwind: "$forms" },
      { $group: { _id: null, total: { $sum: "$forms.leadsCount" } } },
    ]).toArray();
    const totalLeads = leadsAgg[0]?.total || 0;

    const recentAppointments = await col("appointments").countDocuments({
      createdAt: { $gte: sevenDaysAgo.toISOString() },
    });

    res.json({
      totalClients, totalLeadDocs, totalLeads, totalBriefs,
      openChats, totalAppointments, recentAppointments,
      totalWaSessions, totalSms, totalGallery,
    });
  } catch (err) {
    console.error("[AppAdmin/Dashboard] overview:", err.message);
    res.status(500).json({ message: "Failed to load overview" });
  }
};

exports.getChartData = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const [appointmentsByDay, smsByDay, topPhones] = await Promise.all([
      col("appointments").aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $substr: ["$createdAt", 0, 10] }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      col("sms_logs").aggregate([
        { $match: { created_at: { $gte: new Date(since) } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      col("user_leads").aggregate([
        { $unwind: "$forms" },
        { $group: { _id: "$phone", totalLeads: { $sum: "$forms.leadsCount" } } },
        { $sort: { totalLeads: -1 } },
        { $limit: 10 },
      ]).toArray(),
    ]);

    res.json({ appointmentsByDay, smsByDay, topPhones });
  } catch (err) {
    console.error("[AppAdmin/Dashboard] charts:", err.message);
    res.status(500).json({ message: "Failed to load charts" });
  }
};

exports.getRecentActivity = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const [recentChats, recentAppointments, recentSms] = await Promise.all([
      col("support_chats").find({}).sort({ updated_at: -1 }).limit(limit)
        .project({ phone: 1, updated_at: 1, _id: 1 }).toArray(),
      col("appointments").find({}).sort({ createdAt: -1 }).limit(limit)
        .project({ customerPhone: 1, subject: 1, createdAt: 1, status: 1 }).toArray(),
      col("sms_logs").find({}).sort({ created_at: -1 }).limit(limit)
        .project({ phone: 1, success: 1, created_at: 1 }).toArray(),
    ]);

    const activity = [
      ...recentChats.map((c) => ({ type: "chat", label: "Support chat", phone: c.phone, date: c.updated_at })),
      ...recentAppointments.map((a) => ({ type: "appointment", label: `Appointment: ${a.subject || a.status}`, phone: a.customerPhone, date: a.createdAt })),
      ...recentSms.map((s) => ({ type: "sms", label: s.success ? "OTP sent" : "OTP failed", phone: s.phone, date: s.created_at })),
    ]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);

    res.json({ activity });
  } catch (err) {
    console.error("[AppAdmin/Dashboard] activity:", err.message);
    res.status(500).json({ message: "Failed to load activity" });
  }
};
