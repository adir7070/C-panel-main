const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

const SESSION_GAP_MS = 5 * 60 * 1000;

exports.getStats = async (_req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo = new Date(now - 7 * 86400000).toISOString();
    const monthAgo = new Date(now - 30 * 86400000).toISOString();

    const [todayAppts, weekAppts, monthAppts, todaySms, weekSms, monthSms, todayChats, weekChats] = await Promise.all([
      col("appointments").countDocuments({ createdAt: { $gte: todayStart } }),
      col("appointments").countDocuments({ createdAt: { $gte: weekAgo } }),
      col("appointments").countDocuments({ createdAt: { $gte: monthAgo } }),
      col("sms_logs").countDocuments({ created_at: { $gte: new Date(todayStart) } }),
      col("sms_logs").countDocuments({ created_at: { $gte: new Date(weekAgo) } }),
      col("sms_logs").countDocuments({ created_at: { $gte: new Date(monthAgo) } }),
      col("support_chats").countDocuments({ updated_at: { $gte: todayStart } }),
      col("support_chats").countDocuments({ updated_at: { $gte: weekAgo } }),
    ]);

    res.json({
      today: { appointments: todayAppts, sms: todaySms, chats: todayChats },
      week: { appointments: weekAppts, sms: weekSms, chats: weekChats },
      month: { appointments: monthAppts, sms: monthSms },
    });
  } catch (err) {
    console.error("[AppAdmin/Activity] stats:", err.message);
    res.status(500).json({ message: "Failed to load activity stats" });
  }
};

exports.getTimeline = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000);

    const [apptsByDay, smsByDay] = await Promise.all([
      col("appointments").aggregate([
        { $match: { createdAt: { $gte: since.toISOString() } } },
        { $group: { _id: { $substr: ["$createdAt", 0, 10] }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      col("sms_logs").aggregate([
        { $match: { created_at: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    res.json({ appointmentsByDay: apptsByDay, smsByDay });
  } catch (err) {
    console.error("[AppAdmin/Activity] timeline:", err.message);
    res.status(500).json({ message: "Failed to load timeline" });
  }
};

exports.getByHour = async (_req, res) => {
  try {
    const data = await col("sms_logs").aggregate([
      { $group: { _id: { $hour: "$created_at" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();

    const byHour = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      label: `${String(i).padStart(2, "0")}:00`,
      count: data.find((d) => d._id === i)?.count || 0,
    }));

    res.json({ byHour });
  } catch (err) {
    console.error("[AppAdmin/Activity] byHour:", err.message);
    res.status(500).json({ message: "Failed to load hourly data" });
  }
};

exports.getRecent = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const phone = req.query.phone || "";

    const query = {};
    if (phone) query.phone = { $regex: phone, $options: "i" };

    const [data, total] = await Promise.all([
      col("sms_logs").find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col("sms_logs").countDocuments(query),
    ]);

    res.json({ data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[AppAdmin/Activity] recent:", err.message);
    res.status(500).json({ message: "Failed to load recent activity" });
  }
};

exports.getTopUsers = async (_req, res) => {
  try {
    const topUsers = await col("user_leads").aggregate([
      { $unwind: "$forms" },
      { $group: { _id: "$phone", totalLeads: { $sum: "$forms.leadsCount" }, formCount: { $sum: 1 } } },
      { $sort: { totalLeads: -1 } },
      { $limit: 20 },
    ]).toArray();

    res.json({ topUsers });
  } catch (err) {
    console.error("[AppAdmin/Activity] topUsers:", err.message);
    res.status(500).json({ message: "Failed to load top users" });
  }
};

exports.getUserActivity = async (req, res) => {
  try {
    const { phone } = req.params;
    const { type, from, to, search, page = 1, limit = 50 } = req.query;
    const skip = (Math.max(1, Number(page)) - 1) * Math.min(Number(limit), 200);

    const filter = { phone };
    if (type) filter.type = type;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (search) filter.name = { $regex: search, $options: "i" };

    const [data, total] = await Promise.all([
      col("app_activity").find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.min(Number(limit), 200)).toArray(),
      col("app_activity").countDocuments(filter),
    ]);

    res.json({ success: true, data, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error("[AppAdmin/Activity] userActivity:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getUserActivitySummary = async (req, res) => {
  try {
    const { phone } = req.params;

    const [totalEvents, screenViews, actions, apiCalls, topScreens, topActions, lastEvent] = await Promise.all([
      col("app_activity").countDocuments({ phone }),
      col("app_activity").countDocuments({ phone, type: "screen_view" }),
      col("app_activity").countDocuments({ phone, type: "action" }),
      col("app_activity").countDocuments({ phone, type: "api_call" }),
      col("app_activity").aggregate([
        { $match: { phone, type: "screen_view" } },
        { $group: { _id: "$name", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
      col("app_activity").aggregate([
        { $match: { phone, type: "action" } },
        { $group: { _id: "$name", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
      col("app_activity").find({ phone }).sort({ createdAt: -1 }).limit(1).toArray(),
    ]);

    res.json({ success: true, totalEvents, screenViews, actions, apiCalls, topScreens, topActions, lastActive: lastEvent[0]?.createdAt || null });
  } catch (err) {
    console.error("[AppAdmin/Activity] userSummary:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAppActivityOverview = async (_req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now - 7 * 86400000);

    const [
      activeTodayArr, activeWeekArr,
      eventsToday, eventsWeek,
      topScreens, topActions,
      byPlatform, byAppVersion, activeUsers,
    ] = await Promise.all([
      col("app_activity").find({ createdAt: { $gte: todayStart } }).project({ phone: 1 }).toArray().then(r => [...new Set(r.map(x => x.phone))]),
      col("app_activity").find({ createdAt: { $gte: weekAgo } }).project({ phone: 1 }).toArray().then(r => [...new Set(r.map(x => x.phone))]),
      col("app_activity").countDocuments({ createdAt: { $gte: todayStart } }),
      col("app_activity").countDocuments({ createdAt: { $gte: weekAgo } }),
      col("app_activity").aggregate([
        { $match: { type: "screen_view", createdAt: { $gte: weekAgo } } },
        { $group: { _id: "$name", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
      col("app_activity").aggregate([
        { $match: { type: "action", createdAt: { $gte: weekAgo } } },
        { $group: { _id: "$name", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
      col("app_activity").aggregate([
        { $match: { createdAt: { $gte: weekAgo } } },
        { $group: { _id: "$deviceInfo.platform", users: { $addToSet: "$phone" }, events: { $sum: 1 } } },
        { $project: { _id: 1, users: { $size: "$users" }, events: 1 } },
        { $sort: { events: -1 } },
      ]).toArray(),
      col("app_activity").aggregate([
        { $match: { createdAt: { $gte: weekAgo } } },
        { $group: { _id: "$deviceInfo.appVersion", users: { $addToSet: "$phone" }, events: { $sum: 1 } } },
        { $project: { _id: 1, users: { $size: "$users" }, events: 1 } },
        { $sort: { events: -1 } },
      ]).toArray(),
      col("app_activity").aggregate([
        { $match: { createdAt: { $gte: weekAgo } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$phone", lastSeen: { $first: "$createdAt" }, platform: { $first: "$deviceInfo.platform" }, osVersion: { $first: "$deviceInfo.version" }, appVersion: { $first: "$deviceInfo.appVersion" }, eventCount: { $sum: 1 } } },
        { $sort: { lastSeen: -1 } },
        { $limit: 50 },
      ]).toArray(),
    ]);

    res.json({
      success: true,
      activeToday: activeTodayArr.length,
      activeWeek: activeWeekArr.length,
      eventsToday, eventsWeek,
      topScreens, topActions,
      byPlatform, byAppVersion, activeUsers,
    });
  } catch (err) {
    console.error("[AppAdmin/Activity] appOverview:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAppActivityRecent = async (req, res) => {
  try {
    const { type, phone, search, page = 1, limit = 30 } = req.query;
    const skip = (Math.max(1, Number(page)) - 1) * Math.min(Number(limit), 100);

    const filter = {};
    if (type) filter.type = type;
    if (phone) filter.phone = { $regex: phone, $options: "i" };
    if (search) filter.name = { $regex: search, $options: "i" };

    const [data, total] = await Promise.all([
      col("app_activity").find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.min(Number(limit), 100)).toArray(),
      col("app_activity").countDocuments(filter),
    ]);

    res.json({ success: true, data, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error("[AppAdmin/Activity] appRecent:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAppActivitySessions = async (req, res) => {
  try {
    const { phone, limit = 20, from, to } = req.query;
    if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

    const filter = { phone, type: { $in: ["screen_view", "screen_leave", "action"] } };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to + "T23:59:59.999Z");
    }

    const events = await col("app_activity").find(filter).sort({ createdAt: 1 }).limit(5000).toArray();
    if (events.length === 0) return res.json({ success: true, sessions: [] });

    const sessions = [];
    let current = { start: null, end: null, steps: [], actions: 0 };

    for (const ev of events) {
      const ts = new Date(ev.timestamp || ev.createdAt).getTime();
      if (current.start && ts - new Date(current.end).getTime() > SESSION_GAP_MS) {
        sessions.push(current);
        current = { start: null, end: null, steps: [], actions: 0 };
      }
      if (!current.start) current.start = ev.timestamp || ev.createdAt;
      current.end = ev.timestamp || ev.createdAt;
      if (ev.type === "screen_view") {
        current.steps.push({ screen: ev.name, enteredAt: ev.timestamp || ev.createdAt, duration: null });
      } else if (ev.type === "screen_leave" && current.steps.length > 0) {
        const match = [...current.steps].reverse().find(s => s.screen === ev.name && s.duration === null);
        if (match) match.duration = ev.duration || null;
      } else if (ev.type === "action") {
        current.actions++;
        if (current.steps.length > 0) {
          const last = current.steps[current.steps.length - 1];
          if (!last.actions) last.actions = [];
          last.actions.push(ev.name);
        }
      }
    }
    if (current.steps.length > 0) sessions.push(current);

    const result = sessions.reverse().slice(0, Number(limit)).map((s, i) => ({
      id: i, start: s.start, end: s.end,
      durationMs: new Date(s.end).getTime() - new Date(s.start).getTime(),
      screenCount: s.steps.length, actionCount: s.actions, steps: s.steps,
    }));

    res.json({ success: true, sessions: result, total: sessions.length });
  } catch (err) {
    console.error("[AppAdmin/Activity] sessions:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAppActivityPaths = async (req, res) => {
  try {
    const { from, to, depth = 3 } = req.query;
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from); else dateFilter.$gte = weekAgo;
    if (to) dateFilter.$lte = new Date(to + "T23:59:59.999Z");

    const raw = await col("app_activity").find({ type: "screen_view", createdAt: dateFilter })
      .sort({ phone: 1, createdAt: 1 }).project({ phone: 1, name: 1, createdAt: 1 }).limit(50000).toArray();

    const pathCount = {};
    let currentPhone = null, screens = [], lastTs = 0;

    for (const ev of raw) {
      const ts = new Date(ev.createdAt).getTime();
      if (ev.phone !== currentPhone || ts - lastTs > SESSION_GAP_MS) {
        if (screens.length >= 2) {
          const d = Math.min(Number(depth), screens.length);
          for (let i = 0; i <= screens.length - d; i++) {
            const path = screens.slice(i, i + d).join(" → ");
            pathCount[path] = (pathCount[path] || 0) + 1;
          }
        }
        screens = []; currentPhone = ev.phone;
      }
      if (screens[screens.length - 1] !== ev.name) screens.push(ev.name);
      lastTs = ts;
    }
    if (screens.length >= 2) {
      const d = Math.min(Number(depth), screens.length);
      for (let i = 0; i <= screens.length - d; i++) {
        const path = screens.slice(i, i + d).join(" → ");
        pathCount[path] = (pathCount[path] || 0) + 1;
      }
    }

    const paths = Object.entries(pathCount).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count).slice(0, 20);
    res.json({ success: true, paths });
  } catch (err) {
    console.error("[AppAdmin/Activity] paths:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAppActivityDropoffs = async (req, res) => {
  try {
    const { from, to } = req.query;
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from); else dateFilter.$gte = weekAgo;
    if (to) dateFilter.$lte = new Date(to + "T23:59:59.999Z");

    const raw = await col("app_activity").find({ type: { $in: ["screen_view", "screen_leave"] }, createdAt: dateFilter })
      .sort({ phone: 1, createdAt: 1 }).project({ phone: 1, name: 1, type: 1, createdAt: 1 }).limit(50000).toArray();

    const exitCount = {}, entryCount = {};
    let currentPhone = null, lastScreen = null, firstScreen = null, lastTs = 0;

    function flushSession() {
      if (lastScreen) exitCount[lastScreen] = (exitCount[lastScreen] || 0) + 1;
      if (firstScreen) entryCount[firstScreen] = (entryCount[firstScreen] || 0) + 1;
    }

    for (const ev of raw) {
      const ts = new Date(ev.createdAt).getTime();
      if (ev.phone !== currentPhone || ts - lastTs > SESSION_GAP_MS) {
        flushSession();
        currentPhone = ev.phone; lastScreen = null; firstScreen = null;
      }
      if (ev.type === "screen_view") {
        if (!firstScreen) firstScreen = ev.name;
        lastScreen = ev.name;
      }
      lastTs = ts;
    }
    flushSession();

    const dropoffs = Object.entries(exitCount).map(([screen, exits]) => ({
      screen, exits, entries: entryCount[screen] || 0,
      dropoffRate: entryCount[screen] ? Math.round((exits / entryCount[screen]) * 100) : 0,
    })).sort((a, b) => b.exits - a.exits).slice(0, 15);

    res.json({ success: true, dropoffs });
  } catch (err) {
    console.error("[AppAdmin/Activity] dropoffs:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAppActivityByHour = async (_req, res) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const data = await col("app_activity").aggregate([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: { _id: { $hour: "$createdAt" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();

    const byHour = Array.from({ length: 24 }, (_, i) => ({
      hour: i, label: `${String(i).padStart(2, "0")}:00`,
      count: data.find((d) => d._id === i)?.count || 0,
    }));
    res.json({ success: true, byHour });
  } catch (err) {
    console.error("[AppAdmin/Activity] appByHour:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAppActivityByDay = async (_req, res) => {
  try {
    const monthAgo = new Date(Date.now() - 30 * 86400000);
    const data = await col("app_activity").aggregate([
      { $match: { createdAt: { $gte: monthAgo } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 }, users: { $addToSet: "$phone" } } },
      { $project: { _id: 1, count: 1, users: { $size: "$users" } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    res.json({ success: true, byDay: data });
  } catch (err) {
    console.error("[AppAdmin/Activity] appByDay:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};
