const { getDB } = require("../config/db");

const submitRating = async (req, res) => {
  try {
    const { phone, name, agentName, rating, comment, date } = req.body;
    if (!phone || !rating) {
      return res.status(400).json({ success: false, message: "phone and rating are required" });
    }

    const now = new Date();

    // שלוף pendingAgentRating לפני השמירה כדי להעשיר את chat_ratings
    let pendingAgent = null;
    try {
      const chatDoc = await getDB().collection("support_chats").findOne(
        { phone, "pendingAgentRating.agentId": { $exists: true, $ne: null } },
        { projection: { _id: 1, pendingAgentRating: 1 } }
      );
      if (chatDoc?.pendingAgentRating?.agentId) {
        pendingAgent = { ...chatDoc.pendingAgentRating, _chatId: chatDoc._id };
      }
    } catch (e) {
      console.error("ratings/submit pendingAgent fetch error:", e.message);
    }

    // שמירה ב-chat_ratings — כולל נתוני נציג אם קיימים
    await getDB().collection("chat_ratings").insertOne({
      phone,
      name:          name          || null,
      agentName:     agentName     || pendingAgent?.agentName || null,
      rating:        Number(rating),
      comment:       comment       || null,
      date:          date ? new Date(date) : now,
      createdAt:     now,
      agentId:       pendingAgent?.agentId       || null,
      agentName:     pendingAgent?.agentName     || null,
      callType:      pendingAgent?.callType      || null,
      callPurpose:   pendingAgent?.callPurpose   || null,
      handledAgents: pendingAgent?.handledAgents || [],
      stations:      pendingAgent?.stations      || [],
    });

    // שמירה ישירה ל-agent_ratings כשהלקוח שלח ביקורת ידנית על נציג
    if (!pendingAgent && agentName) {
      try {
        await getDB().collection("agent_ratings").insertOne({
          agentId:       null,
          agentName:     agentName,
          appointmentId: null,
          chatId:        null,
          customerPhone: phone,
          customerName:  name  || null,
          callType:      "chat",
          callPurpose:   null,
          scheduledStart: null,
          handledAgents: [],
          stations:      [],
          rating:        Number(rating),
          comment:       comment || null,
          createdAt:     now,
        });
      } catch (directErr) {
        console.error("ratings/submit direct agent_rating error:", directErr.message);
      }
    }

    // שמירה ב-agent_ratings + ניקוי pending
    if (pendingAgent) {
      try {
        const { agentId, agentName, callType, appointmentId, callPurpose, scheduledStart, _chatId, handledAgents, stations } = pendingAgent;
        const exists = appointmentId
          ? await getDB().collection("agent_ratings").findOne({ appointmentId })
          : _chatId
            ? await getDB().collection("agent_ratings").findOne({ chatId: _chatId.toString() })
            : null;
        if (!exists) {
          await getDB().collection("agent_ratings").insertOne({
            agentId,
            agentName:      agentName      || '',
            appointmentId:  appointmentId  || null,
            chatId:         _chatId        ? _chatId.toString() : null,
            customerPhone:  phone,
            customerName:   name           || null,
            callType:       callType       || null,
            callPurpose:    callPurpose    || null,
            scheduledStart: scheduledStart ? new Date(scheduledStart) : null,
            handledAgents:  handledAgents  || [],
            stations:       stations       || [],
            rating:         Number(rating),
            comment:        comment        || null,
            createdAt:      now,
          });
        }
        await getDB().collection("support_chats").updateOne(
          { _id: _chatId },
          { $unset: { pendingAgentRating: "" } }
        );
      } catch (crossErr) {
        console.error("ratings/submit cross-save error:", crossErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("ratings/submit error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const getRatings = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = [30, 50, 100, 300].includes(+req.query.limit) ? +req.query.limit : 30;
    const search = req.query.search?.trim() || '';
    const rf     = req.query.ratingFilter ? +req.query.ratingFilter : 0;
    const skip   = (page - 1) * limit;

    const match = {};
    if (rf >= 1 && rf <= 5) match.rating = rf;
    if (req.query.agentId)  match.agentId  = req.query.agentId;
    if (req.query.callType) match.callType = req.query.callType;
    if (req.query.from || req.query.to) {
      match.createdAt = {};
      if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   match.createdAt.$lte = new Date(req.query.to + 'T23:59:59');
    }
    if (req.query.station) {
      match.stations = { $elemMatch: { $regex: req.query.station, $options: 'i' } };
    }
    if (search) {
      const re = new RegExp(search, 'i');
      match.$or = [{ name: re }, { phone: re }, { agentName: re }];
    }

    const [data, total, avgArr] = await Promise.all([
      getDB().collection('chat_ratings').find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      getDB().collection('chat_ratings').countDocuments(match),
      getDB().collection('chat_ratings').aggregate([
        { $match: match },
        { $group: { _id: null, avg: { $avg: '$rating' } } },
      ]).toArray(),
    ]);

    res.json({
      success: true, data, total, page,
      totalPages: Math.ceil(total / limit) || 1,
      avgRating: +(avgArr[0]?.avg ?? 0).toFixed(2),
    });
  } catch (err) {
    console.error('ratings/list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getRatingsSummary = async (req, res) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [summary, distribution, thisMonth, lastMonth] = await Promise.all([
      getDB().collection('chat_ratings').aggregate([
        { $group: { _id: null, total: { $sum: 1 }, avg: { $avg: '$rating' } } },
      ]).toArray(),
      getDB().collection('chat_ratings').aggregate([
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ]).toArray(),
      getDB().collection('chat_ratings').countDocuments({ createdAt: { $gte: thisMonthStart } }),
      getDB().collection('chat_ratings').countDocuments({ createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
    ]);

    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    distribution.forEach(d => { if (d._id >= 1 && d._id <= 5) dist[d._id] = d.count; });

    res.json({
      success: true,
      total: summary[0]?.total ?? 0,
      avgRating: +(summary[0]?.avg ?? 0).toFixed(2),
      distribution: dist, thisMonth, lastMonth,
    });
  } catch (err) {
    console.error('ratings/summary error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { submitRating, getRatings, getRatingsSummary };
