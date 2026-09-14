const { getDB } = require("../config/db");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const agentsCol = () => getDB().collection("agents");
const stationsCol = () => getDB().collection("stations");
const rolesCol = () => getDB().collection("custom_roles");
const chatsCol = () => getDB().collection("support_chats");
const templatesCol = () => getDB().collection("canned_templates");
const profilesCol = () => getDB().collection("profiles");

const { checkAndUploadToDrive } = require("../services/google-drive.service");
const backblazeService = require("../services/backblaze.service");

function hashPass(password) {
  return crypto
    .createHash("sha256")
    .update(password + "iconiq2024")
    .digest("hex");
}

// יצירת אדמין ברירת מחדל אם אין נציגים במערכת
exports.initAdmin = async () => {
  try {
    const count = await agentsCol().countDocuments();
    // Production never gets a well-known default password: the first admin is
    // only created when INIT_ADMIN_PASSWORD is set.
    const initPassword =
      process.env.INIT_ADMIN_PASSWORD ||
      (process.env.NODE_ENV === "production" ? null : "admin123");
    if (count === 0 && initPassword) {
      await agentsCol().insertOne({
        _id: uuidv4(),
        name: "admin",
        password: hashPass(initPassword),
        role: "admin",
        station: null,
        active: true,
        createdAt: new Date(),
      });
      console.log(
        "[Agents] Default admin created — name: admin",
      );
    }
  } catch (err) {
    console.error("[Agents] Failed to init admin:", err.message);
  }
};

const buildAgentResponse = async (agent) => {
  const { password: _p, token: _t, ...rest } = agent;
  const base = { ...rest, id: agent._id };
  if (agent.station) {
    const stationDoc = await stationsCol().findOne({ _id: agent.station });
    if (stationDoc) base.stationData = { canViewWebsiteSupport: !!stationDoc.canViewWebsiteSupport };
  }
  return base;
};

exports.login = async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password)
      return res.status(400).json({ error: "שם משתמש וסיסמא חובה" });

    const agent = await agentsCol().findOne({
      name,
      password: hashPass(password),
    });
    if (!agent)
      return res.status(401).json({ error: "שם משתמש או סיסמא שגויים" });
    if (agent.active === false)
      return res
        .status(403)
        .json({ error: "חשבון זה אינו פעיל. אנא פנה למנהל המערכת." });

    const token = agent.token || crypto.randomBytes(32).toString("hex");
    await agentsCol().updateOne(
      { _id: agent._id },
      { $set: { token, lastLogin: new Date() } },
    );

    res.json({ agent: await buildAgentResponse(agent), token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getMe = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Token required" });

    const agent = await agentsCol().findOne({ token });
    if (!agent) return res.status(401).json({ error: "Invalid token" });
    if (agent.active === false) return res.status(403).json({ error: "Account inactive" });

    res.json({ agent: await buildAgentResponse(agent) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getAgents = async (req, res) => {
  try {
    const list = await agentsCol()
      .find({})
      .project({ password: 0, token: 0 })
      .toArray();
    res.json(list.map((a) => ({ ...a, id: a._id })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createAgent = async (req, res) => {
  try {
    const {
      name,
      password,
      role = "agent",
      station = null,
      permissions = {},
      nickname = "",
      phone = "",
      active = true,
    } = req.body;
    if (!name || !password)
      return res.status(400).json({ error: "שם משתמש וסיסמא חובה" });

    const existing = await agentsCol().findOne({ name });
    if (existing) return res.status(409).json({ error: "שם משתמש כבר קיים" });

    const id = uuidv4();
    await agentsCol().insertOne({
      _id: id,
      name,
      password: hashPass(password),
      role,
      station,
      permissions: permissions ?? {},
      nickname,
      phone,
      active,
      createdAt: new Date(),
    });
    res.json({
      id,
      name,
      role,
      station,
      permissions: permissions ?? {},
      nickname,
      phone,
      active,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateAgent = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      password,
      role,
      station,
      permissions,
      nickname,
      phone,
      active,
    } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (password) update.password = hashPass(password);
    if (role !== undefined) update.role = role;
    if (station !== undefined) update.station = station;
    if (permissions !== undefined) update.permissions = permissions;
    if (nickname !== undefined) update.nickname = nickname;
    if (phone !== undefined) update.phone = phone;
    if (active !== undefined) update.active = active;

    await agentsCol().updateOne({ _id: id }, { $set: update });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteAgent = async (req, res) => {
  try {
    const { id } = req.params;
    await agentsCol().deleteOne({ _id: id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getStations = async (req, res) => {
  try {
    const list = await stationsCol().find({}).toArray();
    res.json(list.map((s) => ({ ...s, id: s._id })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createStation = async (req, res) => {
  try {
    const { name, canClose = false, canViewWebsiteSupport = false } = req.body;
    if (!name) return res.status(400).json({ error: "שם עמדה חובה" });

    const id = uuidv4();
    await stationsCol().insertOne({
      _id: id,
      name,
      canClose,
      canViewWebsiteSupport,
      createdAt: new Date(),
    });
    res.json({ id, name, canClose, canViewWebsiteSupport });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateStation = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, canClose, canViewWebsiteSupport } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (canClose !== undefined) update.canClose = canClose;
    if (canViewWebsiteSupport !== undefined) update.canViewWebsiteSupport = canViewWebsiteSupport;

    await stationsCol().updateOne({ _id: id }, { $set: update });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteStation = async (req, res) => {
  try {
    const { id } = req.params;
    await stationsCol().deleteOne({ _id: id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── ניהול לקוחות (support_chats) ───

exports.getUsers = async (req, res) => {
  try {
    const sessions = await chatsCol()
      .aggregate([
        { $sort: { updated_at: -1 } },
        {
          $project: {
            name: 1,
            phone: 1,
            status: 1,
            station: 1,
            updated_at: 1,
            created_at: 1,
            messageCount: { $size: { $ifNull: ["$messages", []] } },
            lastUserMsg: {
              $let: {
                vars: {
                  userMsgs: {
                    $filter: {
                      input: { $ifNull: ["$messages", []] },
                      as: "m",
                      cond: { $eq: ["$$m.fromRole", "user"] },
                    },
                  },
                },
                in: { $arrayElemAt: ["$$userMsgs", -1] },
              },
            },
          },
        },
      ])
      .toArray();

    res.json(
      sessions.map((s) => ({
        id: s._id,
        name: s.name || `לקוח ${s._id}`,
        phone: s.phone || "",
        status: s.status || "open",
        station: s.station || null,
        messageCount: s.messageCount || 0,
        lastMsg: s.lastUserMsg?.text || "",
        lastActive: s.updated_at,
        createdAt: s.created_at,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, station, notes } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (phone !== undefined) update.phone = phone;
    if (station !== undefined) update.station = station || null;
    if (notes !== undefined) update.notes = notes;
    await chatsCol().updateOne(
      { _id: id },
      { $set: { ...update, updated_at: new Date() } },
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.assignManager = async (req, res) => {
  try {
    const { id } = req.params;
    const { agentId } = req.body;
    let accountManagerName = null;
    if (agentId) {
      const agent = await agentsCol().findOne({ _id: agentId });
      accountManagerName = agent?.nickname || agent?.name || null;
    }

    // Grab the chat's phone up front — needed to keep cpanel_clients in sync.
    const chat = await chatsCol().findOne({ _id: id }, { projection: { phone: 1 } });

    await chatsCol().updateOne(
      { _id: id },
      { $set: { accountManagerId: agentId || null, accountManagerName, updated_at: new Date() } },
    );

    /* Keep cpanel_clients in sync with the assignment. The admin clients list
       derives the manager column from cpanel_clients.agentId — NOT from the
       chat — so without this a reassignment showed on the client page but the
       list kept the OLD manager (e.g. a webinar-landing-page client stuck on
       the "webinar" agent). Collapse to a single row owned by the new manager,
       and flag it manualAssignment so the Fireberry sync won't revert it. */
    const phone = chat?.phone;
    if (phone && agentId) {
      const clients = getDB().collection("cpanel_clients");
      const prev = await clients.find({ phone }).sort({ createdAt: -1 }).limit(1).next();
      await clients.deleteMany({ phone });
      await clients.insertOne({
        agentId:        String(agentId),
        agentName:      accountManagerName || "",
        phone,
        customerName:   prev?.customerName || phone,
        firebery1013Id: prev?.firebery1013Id || null,
        customerId:     prev?.customerId || null,
        createdAt:      prev?.createdAt || new Date(),
        manualAssignment:        true,
        manualAssignedAt:        new Date(),
        manualAssignedBy:        req.agent ? String(req.agent._id) : null,
        reassignedFromAgentName: prev?.agentName || null,
      });
    }

    res.json({ success: true, accountManagerId: agentId || null, accountManagerName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── תבניות תשובות מוכנות (Canned Responses) ───

exports.getTemplates = async (req, res) => {
  try {
    const list = await templatesCol().find({}).sort({ title: 1 }).toArray();
    res.json(list.map((t) => ({ ...t, id: t._id })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createTemplate = async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body)
      return res.status(400).json({ error: "כותרת ותוכן חובה" });
    const id = uuidv4();
    await templatesCol().insertOne({
      _id: id,
      title,
      body,
      createdAt: new Date(),
    });
    res.json({ id, title, body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body } = req.body;
    const update = {};
    if (title !== undefined) update.title = title;
    if (body !== undefined) update.body = body;
    await templatesCol().updateOne({ _id: id }, { $set: update });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    await templatesCol().deleteOne({ _id: id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    await chatsCol().deleteOne({ _id: id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── סטטיסטיקות ───

exports.getStats = async (req, res) => {
  try {
    // Determine if the requesting agent is station-restricted
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    const requestingAgent = bearerToken
      ? await agentsCol().findOne({ token: bearerToken })
      : null;

    const isAdmin = requestingAgent?.role === "admin";
    const isSupervisor = requestingAgent?.role === "supervisor";
    const isRestricted =
      !isAdmin &&
      !isSupervisor &&
      requestingAgent?.permissions?.stationRestricted === true &&
      !!requestingAgent?.station;

    const stationFilter = isRestricted
      ? { station: requestingAgent.station }
      : {};

    const dateFrom = req.query.from ? new Date(req.query.from) : null;
    const dateTo   = req.query.to   ? new Date(req.query.to)   : null;

    const matchCriteria = { ...stationFilter, "messages.fromRole": "user" };
    if (dateFrom || dateTo) {
      matchCriteria.created_at = {};
      if (dateFrom) matchCriteria.created_at.$gte = dateFrom;
      if (dateTo)   matchCriteria.created_at.$lte = dateTo;
    }
    const matchStage = Object.keys(matchCriteria).length
      ? [{ $match: matchCriteria }]
      : [];

    const [chatStats, agents, stations, chatsWithMessages] = await Promise.all([
      chatsCol()
        .aggregate([
          ...matchStage,
          {
            $facet: {
              totals: [
                {
                  $group: {
                    _id: null,
                    total: { $sum: 1 },
                    open: {
                      $sum: { $cond: [{ $ne: ["$status", "closed"] }, 1, 0] },
                    },
                    closed: {
                      $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] },
                    },
                    totalMessages: {
                      $sum: { $size: { $ifNull: ["$messages", []] } },
                    },
                  },
                },
              ],
              byStation: [
                {
                  $group: {
                    _id: "$station",
                    count: { $sum: 1 },
                    open: {
                      $sum: { $cond: [{ $ne: ["$status", "closed"] }, 1, 0] },
                    },
                    closed: {
                      $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] },
                    },
                  },
                },
              ],
              topClients: [
                {
                  $project: {
                    name: { $ifNull: ["$name", "לא ידוע"] },
                    phone: 1,
                    status: 1,
                    station: 1,
                    messageCount: { $size: { $ifNull: ["$messages", []] } },
                    userMsgCount: {
                      $size: {
                        $filter: {
                          input: { $ifNull: ["$messages", []] },
                          as: "m",
                          cond: { $eq: ["$$m.fromRole", "user"] },
                        },
                      },
                    },
                    created_at: 1,
                    updated_at: 1,
                  },
                },
                { $sort: { messageCount: -1 } },
                { $limit: 10 },
              ],
            },
          },
        ])
        .toArray(),
      agentsCol().find({}).project({ password: 0, token: 0 }).toArray(),
      stationsCol().find({}).toArray(),
      chatsCol().find(matchCriteria, { projection: { messages: 1, station: 1 } }).toArray(),
    ]);

    const result = chatStats[0];
    const totals = result.totals[0] || {
      total: 0,
      open: 0,
      closed: 0,
      totalMessages: 0,
    };

    // Per-station map
    const stationChatMap = {};
    result.byStation.forEach((s) => {
      if (s._id) stationChatMap[s._id] = s;
    });

    // Per-agent stats based on their assigned station
    const filteredAgents = isRestricted
      ? agents.filter((a) => a.station === requestingAgent.station)
      : agents;

    const agentStats = filteredAgents.map((a) => {
      const stationData = a.station ? stationChatMap[a.station] || {} : {};
      const station = stations.find(
        (s) => s._id === a.station || s.id === a.station,
      );
      return {
        id: a._id,
        name: a.name,
        nickname: a.nickname || "",
        role: a.role,
        stationName: station?.name || null,
        active: a.active !== false,
        stationChats: stationData.count || 0,
        stationOpen: stationData.open || 0,
        stationClosed: stationData.closed || 0,
      };
    });

    // Station breakdown with names (already filtered by $match if restricted)
    const byStation = result.byStation.map((s) => {
      const station = stations.find(
        (st) => st._id === s._id || st.id === s._id,
      );
      return {
        stationId: s._id,
        stationName: station?.name || (s._id ? s._id : "ללא עמדה"),
        count: s.count,
        open: s.open,
        closed: s.closed,
      };
    });

    // ── Response-time computation (both modes in one pass) ──────────────────
    const stationNameMap = {};
    stations.forEach((s) => { stationNameMap[s._id] = s.name; });

    const rtAll   = { agentMap: {}, stationMap: {} };
    const rtBiz   = { agentMap: {}, stationMap: {} };

    function accumulateRT(maps, agentId, agentName, stationId, diffSec) {
      if (!maps.agentMap[agentId]) {
        maps.agentMap[agentId] = { agentId, agentName, stationId, totalSec: 0, minSec: Infinity, maxSec: -Infinity, count: 0 };
      }
      maps.agentMap[agentId].totalSec += diffSec;
      maps.agentMap[agentId].minSec = Math.min(maps.agentMap[agentId].minSec, diffSec);
      maps.agentMap[agentId].maxSec = Math.max(maps.agentMap[agentId].maxSec, diffSec);
      maps.agentMap[agentId].count++;
      if (stationId) {
        if (!maps.stationMap[stationId]) {
          maps.stationMap[stationId] = { stationId, stationName: stationNameMap[stationId] || stationId, totalSec: 0, minSec: Infinity, maxSec: -Infinity, count: 0 };
        }
        maps.stationMap[stationId].totalSec += diffSec;
        maps.stationMap[stationId].minSec = Math.min(maps.stationMap[stationId].minSec, diffSec);
        maps.stationMap[stationId].maxSec = Math.max(maps.stationMap[stationId].maxSec, diffSec);
        maps.stationMap[stationId].count++;
      }
    }

    for (const chat of chatsWithMessages) {
      const sorted = (chat.messages || [])
        .filter((m) => {
          if (!m.createdAt || !m.fromRole) return false;
          const d = new Date(m.createdAt);
          if (dateFrom && d < dateFrom) return false;
          if (dateTo   && d > dateTo)   return false;
          return true;
        })
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      let lastUserMsg = null;
      for (const msg of sorted) {
        if (msg.fromRole === "user") {
          lastUserMsg = msg;
        } else if (msg.fromRole === "agent" && lastUserMsg) {
          const agentTime   = new Date(msg.createdAt).getTime();
          const rawUserDate = new Date(lastUserMsg.createdAt);
          const diffAll = Math.round((agentTime - rawUserDate.getTime()) / 1000);
          const diffBiz = Math.round((agentTime - toEffectiveBusinessTime(rawUserDate).getTime()) / 1000);
          const agentId   = msg.user?._id || msg.user?.name || "unknown";
          const agentName = msg.user?.name || "לא ידוע";
          const stationId = chat.station || null;
          if (diffAll >= 0) accumulateRT(rtAll, agentId, agentName, stationId, diffAll);
          if (diffBiz >= 0) accumulateRT(rtBiz, agentId, agentName, stationId, diffBiz);
          lastUserMsg = null;
        }
      }
    }

    function finalizeRT(maps) {
      const toResult = (obj) => ({
        ...obj,
        avgSec: obj.count > 0 ? Math.round(obj.totalSec / obj.count) : 0,
        minSec: obj.minSec === Infinity  ? 0 : obj.minSec,
        maxSec: obj.maxSec === -Infinity ? 0 : obj.maxSec,
      });
      return {
        byAgent:   Object.values(maps.agentMap).map(toResult).sort((a, b) => a.avgSec - b.avgSec),
        byStation: Object.values(maps.stationMap).map(toResult).sort((a, b) => a.avgSec - b.avgSec),
      };
    }

    res.json({
      totals: {
        total: totals.total,
        open: totals.open,
        closed: totals.closed,
        totalMessages: totals.totalMessages,
        avgMessages:
          totals.total > 0
            ? Math.round(totals.totalMessages / totals.total)
            : 0,
      },
      topClients: result.topClients.map((c) => ({ id: c._id, ...c })),
      byStation,
      agentStats,
      responseTimes: {
        all:      finalizeRT(rtAll),
        business: finalizeRT(rtBiz),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
// ─── זמני תגובה ───────────────────────────────────────────────────────────────

/**
 * Adjusts a customer message timestamp to "effective" business-hours time.
 * Business hours: 09:00–18:00, Sun(0)–Thu(4), Asia/Jerusalem timezone.
 * - If the message was sent during business hours → unchanged
 * - If before 09:00 on a work day → shift to 09:00 same day
 * - If after 18:00 on a work day, or on Fri/Sat → shift to 09:00 next work day
 */
function toEffectiveBusinessTime(date) {
  const tz = 'Asia/Jerusalem';
  const WORK_START = 9;
  const WORK_END = 18;

  // Get local date parts in Israel timezone
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = dayMap[parts.weekday];
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const second = parseInt(parts.second, 10);
  const [month, day, year] = [parts.month, parts.day, parts.year].map(Number);

  const isWorkDay = weekday >= 0 && weekday <= 4; // Sun–Thu
  const isAfterStart = hour > WORK_START || (hour === WORK_START && (minute > 0 || second > 0)) || hour === WORK_START;
  const isBeforeEnd = hour < WORK_END;
  const isDuringHours = isWorkDay && isAfterStart && isBeforeEnd;

  if (isDuringHours) return date;

  // Find next business day start (09:00)
  let d = new Date(date);
  // Advance past the current period
  if (isWorkDay && hour < WORK_START) {
    // Same day, set to 09:00 local — reconstruct as UTC offset
    d = new Date(`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T09:00:00`);
    // We need to convert this local time to UTC. Use the offset at this date.
    const localMidnight = new Date(date);
    localMidnight.setUTCHours(0, 0, 0, 0);
    // Simpler: just add the offset from a reference point
    const refDate = new Date(date);
    const utcRefStr = refDate.toLocaleString('en-US', { timeZone: 'UTC' });
    const ilRefStr = refDate.toLocaleString('en-US', { timeZone: tz });
    const offsetMs = new Date(utcRefStr) - new Date(ilRefStr);
    // Build 09:00 in local time as a date string, then adjust by offset
    const localDate9 = new Date(`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T09:00:00.000Z`);
    return new Date(localDate9.getTime() + offsetMs);
  } else {
    // After hours or weekend — advance to next work day
    d = new Date(date);
    d.setDate(d.getDate() + 1);
    let nextWeekday = (weekday + 1) % 7;
    let daysAdded = 1;
    while (nextWeekday > 4) { // skip Fri and Sat
      d.setDate(d.getDate() + 1);
      nextWeekday = (nextWeekday + 1) % 7;
      daysAdded++;
    }
    // Get Israel offset for the advanced date
    const refDate = new Date(d);
    const utcRefStr = refDate.toLocaleString('en-US', { timeZone: 'UTC' });
    const ilRefStr = refDate.toLocaleString('en-US', { timeZone: tz });
    const offsetMs = new Date(utcRefStr) - new Date(ilRefStr);
    const nextParts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(d).map(p => [p.type, p.value])
    );
    const [nm, nd, ny] = [nextParts.month, nextParts.day, nextParts.year].map(Number);
    const localDate9 = new Date(`${ny}-${String(nm).padStart(2,'0')}-${String(nd).padStart(2,'0')}T09:00:00.000Z`);
    return new Date(localDate9.getTime() + offsetMs);
  }
}

// ─── ניהול תפקידים מותאמים ───────────────────────────────────────────────────

exports.getRoles = async (req, res) => {
  try {
    const list = await rolesCol().find({}).toArray();
    res.json(list.map((r) => ({ ...r, id: r._id })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createRole = async (req, res) => {
  try {
    const { name, description = "", permissions = {} } = req.body;
    if (!name) return res.status(400).json({ error: "שם תפקיד חובה" });

    const existing = await rolesCol().findOne({ name });
    if (existing)
      return res.status(409).json({ error: "תפקיד עם שם זה כבר קיים" });

    const id = uuidv4();
    const doc = {
      _id: id,
      name,
      description,
      permissions,
      createdAt: new Date(),
    };
    await rolesCol().insertOne(doc);
    res.json({ ...doc, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissions } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (permissions !== undefined) update.permissions = permissions;
    await rolesCol().updateOne({ _id: id }, { $set: update });

    // Cascade: sync updated permissions to all agents currently using this role
    if (permissions !== undefined) {
      await agentsCol().updateMany(
        { role: id },
        { $set: { permissions } }
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteRole = async (req, res) => {
  try {
    const { id } = req.params;
    await rolesCol().deleteOne({ _id: id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.driveUploadMessageFile = async (req, res) => {
  try {
    const {
      userId,
      messageId,
      fileUrl,
      driveUrl,
      mimeType,
      messageDate,
      filename,
    } = req.body;
    if (!userId || !messageId || !fileUrl || !driveUrl) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Missing required fields: userId, messageId, fileUrl, driveUrl",
        });
    }

    const { smartUploadToDrive } = require("../services/google-drive.service");

    const fileData = await smartUploadToDrive(
      driveUrl,
      fileUrl,
      filename || `file_${Date.now()}`,
      mimeType || "application/octet-stream",
      messageDate ? new Date(messageDate) : new Date(),
    );

    // Update message in DB — messageId is a numeric timestamp
    const msgId = Number(messageId);
    await chatsCol().updateOne(
      { _id: userId, "messages._id": msgId },
      {
        $set: {
          "messages.$.driveUploaded": true,
          "messages.$.driveFileUrl": fileData.webViewLink,
        },
      },
    );

    res.json({ success: true, driveFileUrl: fileData.webViewLink });
  } catch (err) {
    console.error("[Drive Upload] Error:", err.message, '| code:', err.code);
    const errorCode = err.code || 'UPLOAD_ERROR';
    res.status(errorCode === 'UPLOAD_ERROR' ? 500 : 400).json({
      success: false,
      errorCode,
      error: err.message,
    });
  }
};

exports.driveCheckAndUpload = async (req, res) => {
  try {
    const { driveUrl, fileUrl, filename, mimeType, date } = req.body;
    if (!driveUrl || !fileUrl || !filename) {
      return res
        .status(400)
        .json({
          success: false,
          error: "Missing required fields: driveUrl, fileUrl, filename",
        });
    }

    const result = await checkAndUploadToDrive(
      driveUrl,
      fileUrl,
      filename,
      mimeType || "application/octet-stream",
      date ? new Date(date) : new Date(),
    );

    console.log(
      `[Drive Check+Upload] ${result.existed ? "EXISTS" : "UPLOADED"} — "${filename}" → ${result.webViewLink}`,
    );

    res.json({
      success: true,
      existed: result.existed,
      fileId: result.id,
      fileName: result.name,
      driveFileUrl: result.webViewLink,
    });
  } catch (err) {
    console.error("[Drive Check+Upload] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.driveTest = async (req, res) => {
  try {
    const { testDriveConnection } = require('../services/google-drive.service');
    const result = await testDriveConnection(req.query.driveUrl || null);
    console.log('[Drive Test] serviceAccount:', result.serviceAccount);
    if (result.folderTest) {
      console.log(`[Drive Test] folder ${result.folderTest.folderId} → ${result.folderTest.filesFound} file(s)`);
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Drive Test] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── תמונת פרופיל לקוח מ-Backblaze ───────────────────────────────────────────

exports.getUserAvatar = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json({ url: null });

    const host = `${req.protocol}://${req.get('host')}`;

    // Priority 1: avatar/{phone}/ — AI-generated avatars
    let files = await backblazeService.listClientAvatars(phone);
    if (files.length > 0) {
      const latest = files.sort((a, b) => b.uploadedAt - a.uploadedAt)[0];
      return res.json({ url: `${host}/api/img?url=${encodeURIComponent(latest.fileName)}` });
    }

    // Priority 2: post/{phone}/ — gallery images
    files = await backblazeService.listClientImages(phone);
    if (files.length > 0) {
      const latest = files.sort((a, b) => b.uploadedAt - a.uploadedAt)[0];
      return res.json({ url: `${host}/api/img?url=${encodeURIComponent(latest.fileName)}` });
    }

    return res.json({ url: null });
  } catch (err) {
    console.error('[getUserAvatar] Error:', err.message);
    res.json({ url: null }); // fail silently — avatar is non-critical
  }
};

// Returns all clients that have a portfolio manager (are in cpanel_clients).
// Used by the "מנהלי תיק" page and to filter the main chat sidebar.
exports.getManagedClients = async (req, res) => {
  try {
    const cpanelClientsCol = () => getDB().collection("cpanel_clients");
    const rows = await cpanelClientsCol().find({}).sort({ createdAt: -1 }).toArray();
    if (rows.length === 0) return res.json([]);

    const phones = rows.map(r => r.phone).filter(Boolean);
    const chatsData = phones.length
      ? await chatsCol().find({ phone: { $in: phones } }, { projection: { phone: 1, fireberyName: 1, updated_at: 1 } }).toArray()
      : [];
    const profilesData = phones.length
      ? await profilesCol().find({ phone: { $in: phones } }, { projection: { phone: 1, businessName: 1 } }).toArray()
      : [];

    const chatMap    = Object.fromEntries(chatsData.map(c => [c.phone, c]));
    const profileMap = Object.fromEntries(profilesData.map(p => [p.phone, p]));

    const clients = rows.map(r => {
      const chat    = chatMap[r.phone];
      const profile = profileMap[r.phone];
      return {
        phone:              r.phone,
        name:               chat?.fireberyName || profile?.businessName || r.customerName || r.phone,
        lastActive:         chat?.updated_at || null,
        accountManagerName: r.agentName || null,
        accountManagerId:   r.agentId || null,
      };
    });

    res.json(clients);
  } catch (err) {
    console.error('[getManagedClients] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
