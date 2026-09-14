const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.list = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim() || "";

    const query = {};
    if (search) {
      query.$or = [
        { phone: { $regex: search, $options: "i" } },
        { bizname: { $regex: search, $options: "i" } },
        { firstname: { $regex: search, $options: "i" } },
        { accountname: { $regex: search, $options: "i" } },
      ];
    }

    const [customers, total] = await Promise.all([
      col("fireberry_customers").find(query).sort({ fetchedAt: -1 }).skip(skip).limit(limit).toArray(),
      col("fireberry_customers").countDocuments(query),
    ]);

    const phones = customers.map((c) => c.phone);
    const [briefs, leads, chatCounts, appointments] = await Promise.all([
      col("client_briefs").find({ phone: { $in: phones } }).toArray(),
      col("user_leads").find({ phone: { $in: phones } }).toArray(),
      col("support_chats").aggregate([
        { $match: { phone: { $in: phones } } },
        { $project: { phone: 1, msgCount: { $size: { $ifNull: ["$messages", []] } } } },
      ]).toArray(),
      col("appointments").aggregate([
        { $match: { customerPhone: { $in: phones } } },
        { $group: { _id: "$customerPhone", count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const briefMap = Object.fromEntries(briefs.map((b) => [b.phone, b]));
    const leadsMap = Object.fromEntries(leads.map((l) => [l.phone, l]));
    const chatMap = Object.fromEntries(chatCounts.map((c) => [c.phone, c.msgCount]));
    const apptMap = Object.fromEntries(appointments.map((a) => [a._id, a.count]));

    const enriched = customers.map((c) => {
      const brief = briefMap[c.phone];
      const leadDoc = leadsMap[c.phone];
      const totalLeads = leadDoc?.forms?.reduce((sum, f) => sum + (f.leadsCount || 0), 0) || 0;
      return {
        phone: c.phone,
        name: c.firstname || c.accountname || null,
        bizname: c.bizname || null,
        email: c.email || null,
        logoUrl: c.logoUrl || null,
        websiteUrl: c.websiteUrl || null,
        driveUrl: c.driveUrl || null,
        hasLogo: c.hasLogo || false,
        fetchedAt: c.fetchedAt,
        briefProgress: brief ? `${brief.currentStep || 0}/${brief.totalSteps || 0}` : null,
        totalLeads,
        chatMessages: chatMap[c.phone] || 0,
        appointments: apptMap[c.phone] || 0,
      };
    });

    res.json({ users: enriched, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[AppAdmin/Users] list:", err.message);
    res.status(500).json({ message: "Failed to load users" });
  }
};

exports.getByPhone = async (req, res) => {
  try {
    const { phone } = req.params;

    const [customer, brief, leadDoc, chats, appointments, gallery, smsLogs, ratings, recentActivity] = await Promise.all([
      col("fireberry_customers").findOne({ phone }),
      col("client_briefs").findOne({ phone }),
      col("user_leads").findOne({ phone }),
      col("support_chats").findOne({ phone }),
      col("appointments").find({ customerPhone: phone }).sort({ createdAt: -1 }).limit(20).toArray(),
      col("gallery_statuses").find({ phone }).toArray(),
      col("sms_logs").find({ phone: { $regex: phone.replace(/^0/, "972") } }).sort({ created_at: -1 }).limit(20).toArray(),
      col("agent_ratings").find({ customerPhone: phone }).toArray(),
      col("app_activity").find({ phone }).sort({ createdAt: -1 }).limit(20).toArray(),
    ]);

    if (!customer) return res.status(404).json({ message: "User not found" });

    const forms = leadDoc?.forms || [];
    const totalLeads = forms.reduce((sum, f) => sum + (f.leadsCount || 0), 0);
    const messages = chats?.messages || [];

    res.json({
      customer, brief,
      leads: { totalLeads, formCount: forms.length, forms: forms.map((f) => ({ formId: f.formId, formName: f.formName, leadsCount: f.leadsCount })) },
      chat: { totalMessages: messages.length, userMessages: messages.filter((m) => m.fromRole === "user").length, agentMessages: messages.filter((m) => m.fromRole === "agent").length, lastMessage: messages[messages.length - 1] || null },
      appointments, gallery, smsLogs, ratings, recentActivity,
    });
  } catch (err) {
    console.error("[AppAdmin/Users] getByPhone:", err.message);
    res.status(500).json({ message: "Failed to load user" });
  }
};
