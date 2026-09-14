const { getDB } = require("../config/db");

const col = () => getDB().collection("agent_ratings");

// GET /api/agent-ratings
// רשימת דירוגים עם פגינציה ופילטרים
// query: page, limit, agentId, ratingFilter, search, from, to
exports.getAgentRatings = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = [30, 50, 100, 300].includes(+req.query.limit) ? +req.query.limit : 30;
    const skip   = (page - 1) * limit;
    const rf     = req.query.ratingFilter ? +req.query.ratingFilter : 0;
    const search = req.query.search?.trim() || '';

    const match = {};
    if (req.query.agentId) match.agentId = req.query.agentId;
    if (rf >= 1 && rf <= 5) match.rating = rf;
    if (search) {
      const re = new RegExp(search, 'i');
      match.$or = [{ agentName: re }, { customerName: re }, { customerPhone: re }];
    }
    if (req.query.from || req.query.to) {
      match.createdAt = {};
      if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   match.createdAt.$lte = new Date(req.query.to);
    }

    const [data, total, avgArr] = await Promise.all([
      col().find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      col().countDocuments(match),
      col().aggregate([
        { $match: match },
        { $group: { _id: null, avg: { $avg: '$rating' } } },
      ]).toArray(),
    ]);

    res.json({
      success: true,
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      avgRating: +(avgArr[0]?.avg ?? 0).toFixed(2),
    });
  } catch (err) {
    console.error("agent-ratings/list error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

// GET /api/agent-ratings/summary
// סטטיסטיקה כללית על כלל הדירוגים
exports.getAgentRatingsSummary = async (req, res) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [overall, distribution, callTypeDist, thisMonth, lastMonth] = await Promise.all([
      col().aggregate([
        { $group: { _id: null, total: { $sum: 1 }, avg: { $avg: '$rating' }, agents: { $addToSet: '$agentId' } } },
      ]).toArray(),
      col().aggregate([
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ]).toArray(),
      col().aggregate([
        { $group: { _id: '$callType', count: { $sum: 1 }, avg: { $avg: '$rating' } } },
      ]).toArray(),
      col().countDocuments({ createdAt: { $gte: thisMonthStart } }),
      col().countDocuments({ createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
    ]);

    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    distribution.forEach(d => { if (d._id >= 1 && d._id <= 5) dist[d._id] = d.count; });

    const byCallType = {};
    callTypeDist.forEach(d => { byCallType[d._id || 'unknown'] = { count: d.count, avg: +(d.avg ?? 0).toFixed(2) }; });

    res.json({
      success: true,
      total:        overall[0]?.total        ?? 0,
      avgRating:    +(overall[0]?.avg ?? 0).toFixed(2),
      totalAgents:  overall[0]?.agents?.length ?? 0,
      distribution: dist,
      byCallType,
      thisMonth,
      lastMonth,
    });
  } catch (err) {
    console.error("agent-ratings/summary error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

// GET /api/agent-ratings/leaderboard
// דירוג נציגים ממוין לפי ממוצע דירוג
// query: from, to, stationId, agentId, callType
exports.getAgentLeaderboard = async (req, res) => {
  try {
    const match = {};
    if (req.query.stationId) match.stationId = req.query.stationId;
    if (req.query.agentId)   match.agentId   = req.query.agentId;
    if (req.query.callType)  match.callType  = req.query.callType;
    if (req.query.from || req.query.to) {
      match.createdAt = {};
      if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   match.createdAt.$lte = new Date(req.query.to);
    }

    const leaderboard = await col().aggregate([
      { $match: match },
      {
        $group: {
          _id: '$agentId',
          agentName: { $first: '$agentName' },
          stationId: { $first: '$stationId' },
          avgRating: { $avg: '$rating' },
          totalRatings: { $sum: 1 },
          chatCount:  { $sum: { $cond: [{ $eq: ['$callType', 'chat'] },  1, 0] } },
          phoneCount: { $sum: { $cond: [{ $eq: ['$callType', 'phone'] }, 1, 0] } },
          dist1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
          dist2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
          dist3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
          dist4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
          dist5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          agentId: '$_id',
          agentName: 1,
          stationId: 1,
          avgRating: { $round: ['$avgRating', 2] },
          totalRatings: 1,
          chatCount: 1,
          phoneCount: 1,
          distribution: { 1: '$dist1', 2: '$dist2', 3: '$dist3', 4: '$dist4', 5: '$dist5' },
        },
      },
      { $sort: { avgRating: -1, totalRatings: -1 } },
    ]).toArray();

    res.json({ success: true, data: leaderboard });
  } catch (err) {
    console.error("agent-ratings/leaderboard error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

// GET /api/agent-ratings/agent/:agentId
// סטטיסטיקות + כל הביקורות לנציג ספציפי
exports.getSingleAgentStats = async (req, res) => {
  try {
    const { agentId } = req.params;
    const match = { agentId };
    if (req.query.from || req.query.to) {
      match.createdAt = {};
      if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   match.createdAt.$lte = new Date(req.query.to);
    }

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = [30, 50, 100].includes(+req.query.limit) ? +req.query.limit : 30;
    const skip  = (page - 1) * limit;

    const [statsArr, callTypeDist, ratings, total] = await Promise.all([
      col().aggregate([
        { $match: match },
        {
          $group: {
            _id: '$agentId',
            agentName: { $first: '$agentName' },
            avgRating: { $avg: '$rating' },
            totalRatings: { $sum: 1 },
            dist1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
            dist2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
            dist3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
            dist4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
            dist5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
          },
        },
      ]).toArray(),
      col().aggregate([
        { $match: match },
        { $group: { _id: '$callType', count: { $sum: 1 }, avg: { $avg: '$rating' } } },
      ]).toArray(),
      col().find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      col().countDocuments(match),
    ]);

    const stats = statsArr[0] || { avgRating: 0, totalRatings: 0 };

    const byCallType = {};
    callTypeDist.forEach(d => { byCallType[d._id || 'unknown'] = { count: d.count, avg: +(d.avg ?? 0).toFixed(2) }; });

    res.json({
      success: true,
      agentId,
      agentName: stats.agentName || '',
      avgRating: +(stats.avgRating ?? 0).toFixed(2),
      totalRatings: stats.totalRatings ?? 0,
      distribution: {
        1: stats.dist1 ?? 0,
        2: stats.dist2 ?? 0,
        3: stats.dist3 ?? 0,
        4: stats.dist4 ?? 0,
        5: stats.dist5 ?? 0,
      },
      byCallType,
      ratings,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    console.error("agent-ratings/single error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
