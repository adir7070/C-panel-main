const { DB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const col = (name) => DB.collection(name);

exports.getActiveUsers = async (req, res) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now - 7 * 86400000);
    const monthAgo = new Date(now - 30 * 86400000);

    const [total, lastWeek, lastMonth, dailyRegistrations] = await Promise.all([
      col("users").countDocuments(),
      col("users").countDocuments({ createdAt: { $gte: weekAgo } }),
      col("users").countDocuments({ createdAt: { $gte: monthAgo } }),
      col("users").aggregate([
        { $match: { createdAt: { $gte: monthAgo } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Jerusalem" } },
          count: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    res.json({ total, lastWeek, lastMonth, dailyRegistrations });
  } catch (err) {
    console.error("[Metrics/ActiveUsers]", err.message);
    res.status(500).json({ message: err.message });
  }
};

const KNOWN_SYSTEM_AGENTS = {
  "fireberry-embed": "Fireberry (אוטומטי)",
};

exports.getQuotesStats = async (req, res) => {
  try {
    const { getDB } = require("../../config/db");
    const db = getDB();
    const { from, to } = req.query;

    const match = {};
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to)   match.createdAt.$lte = new Date(to);
    }

    const rows = await db.collection("personal_packages").aggregate([
      { $match: match },
      {
        $group: {
          _id: "$agentId",
          quotesTotal:     { $sum: 1 },
          quotesClosed:    { $sum: { $cond: [{ $eq: ["$purchased", true] }, 1, 0] } },
          revenueTotal:    { $sum: { $cond: [{ $eq: ["$purchased", true] }, "$finalPrice", 0] } },
          clientsReached:  { $addToSet: "$phone" },
          purchasedPhones: {
            $addToSet: {
              $cond: [{ $eq: ["$purchased", true] }, "$phone", null],
            },
          },
        },
      },
      {
        $project: {
          _id:            0,
          agentId:        "$_id",
          quotesTotal:    1,
          quotesClosed:   1,
          quotesOpen:     { $subtract: ["$quotesTotal", "$quotesClosed"] },
          revenueTotal:   1,
          clientsReached: { $size: "$clientsReached" },
          clientsClosed: {
            $size: {
              $filter: {
                input: "$purchasedPhones",
                as:    "ph",
                cond:  { $ne: ["$$ph", null] },
              },
            },
          },
          conversionRate: {
            $divide: ["$quotesClosed", { $max: ["$quotesTotal", 1] }],
          },
        },
      },
      { $sort: { revenueTotal: -1 } },
    ]).toArray();

    // enrich with agent names
    const agentIds = rows.map(r => r.agentId).filter(Boolean);

    const agents = await db.collection("agents")
      .find({ _id: { $in: agentIds } }, { projection: { name: 1 } })
      .toArray();

    const nameMap = Object.fromEntries(agents.map(a => [a._id.toString(), a.name]));

    const byAgent = rows.map(r => {
      const key = r.agentId?.toString();
      return {
        ...r,
        agentId:   key,
        agentName: nameMap[key] ?? KNOWN_SYSTEM_AGENTS[key] ?? "לא ידוע",
      };
    });

    const totals = byAgent.reduce(
      (acc, r) => ({
        quotesTotal:    acc.quotesTotal    + r.quotesTotal,
        quotesClosed:   acc.quotesClosed   + r.quotesClosed,
        clientsReached: acc.clientsReached + r.clientsReached,
        clientsClosed:  acc.clientsClosed  + r.clientsClosed,
        revenueTotal:   acc.revenueTotal   + r.revenueTotal,
      }),
      { quotesTotal: 0, quotesClosed: 0, clientsReached: 0, clientsClosed: 0, revenueTotal: 0 }
    );

    const now = new Date();
    const weekAgo       = new Date(now - 7  * 86400000);
    const twoWeeksAgo   = new Date(now - 14 * 86400000);
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    const yearAgo       = new Date(now - 365 * 86400000);

    const Q = { agentId: { $nin: Object.keys(KNOWN_SYSTEM_AGENTS) } };

    const [
      staleQuotes,
      closedThisWeek,
      closedLastWeek,
      multiQuoteResult,
      avgDaysResult,
      byDayOfWeek,
      monthlyStats,
      totalUsersCount,
      uniqueClientsResult,
      pipelineResult,
      discountResult,
      topClientResult,
      avgQuotesResult,
      byHour,
      staleByAgentResult,
      avgTimeToFirstQuoteResult,
      avgRevenueByDayResult,
      last3MonthsResult,
      fastestAgentResult,
    ] = await Promise.all([
      db.collection("personal_packages").countDocuments({ ...Q, purchased: { $ne: true }, createdAt: { $lte: thirtyDaysAgo } }),
      db.collection("personal_packages").countDocuments({ ...Q, purchased: true, createdAt: { $gte: weekAgo } }),
      db.collection("personal_packages").countDocuments({ ...Q, purchased: true, createdAt: { $gte: twoWeeksAgo, $lt: weekAgo } }),
      db.collection("personal_packages").aggregate([
        { $match: Q },
        { $group: { _id: "$phone", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $count: "total" }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: true, purchasedAt: { $ne: null } } },
        { $addFields: { purchasedDate: { $toDate: "$purchasedAt" } } },
        { $project: { daysDiff: { $divide: [{ $subtract: ["$purchasedDate", "$createdAt"] }, 86400000] } } },
        { $group: { _id: null, avgDays: { $avg: "$daysDiff" } } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: true } },
        { $group: { _id: { $dayOfWeek: { date: "$createdAt", timezone: "Asia/Jerusalem" } }, count: { $sum: 1 }, revenue: { $sum: "$finalPrice" } } },
        { $sort: { _id: 1 } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: true, createdAt: { $gte: yearAgo } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Jerusalem" } },
          revenue: { $sum: "$finalPrice" },
          count: { $sum: 1 }
        }},
        { $sort: { _id: 1 } }
      ]).toArray(),
      db.collection("users").countDocuments(),
      db.collection("personal_packages").aggregate([
        { $group: { _id: "$phone" } },
        { $count: "total" }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: { $ne: true } } },
        { $group: { _id: null, total: { $sum: "$finalPrice" } } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: Q },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          withDiscount: { $sum: { $cond: [{ $gt: [{ $ifNull: ["$discountPct", 0] }, 0] }, 1, 0] } },
          avgDiscount: { $avg: { $ifNull: ["$discountPct", 0] } }
        }}
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: Q },
        { $group: { _id: "$phone", count: { $sum: 1 }, closed: { $sum: { $cond: [{ $eq: ["$purchased", true] }, 1, 0] } } } },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: Q },
        { $group: { _id: "$phone", count: { $sum: 1 }, hasPurchase: { $sum: { $cond: [{ $eq: ["$purchased", true] }, 1, 0] } } } },
        { $match: { hasPurchase: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: "$count" } } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: true } },
        { $group: { _id: { $hour: { date: "$createdAt", timezone: "Asia/Jerusalem" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: { $ne: true }, createdAt: { $lte: thirtyDaysAgo } } },
        { $group: { _id: "$agentId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: Q },
        { $sort: { createdAt: 1 } },
        { $group: { _id: "$phone", firstQuoteDate: { $first: "$createdAt" } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "phone", as: "user" } },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: false } },
        { $project: { daysDiff: { $divide: [{ $subtract: ["$firstQuoteDate", "$user.createdAt"] }, 86400000] } } },
        { $match: { daysDiff: { $gte: 0, $lt: 365 } } },
        { $group: { _id: null, avgDays: { $avg: "$daysDiff" } } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: true } },
        { $group: { _id: { $dayOfWeek: { date: "$createdAt", timezone: "Asia/Jerusalem" } }, totalRevenue: { $sum: "$finalPrice" }, count: { $sum: 1 } } },
        { $project: { _id: 1, avgRevenue: { $divide: ["$totalRevenue", "$count"] }, count: 1 } },
        { $sort: { _id: 1 } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: true, createdAt: { $gte: new Date(now - 90 * 86400000) } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Jerusalem" } }, revenue: { $sum: "$finalPrice" } } }
      ]).toArray(),
      db.collection("personal_packages").aggregate([
        { $match: { ...Q, purchased: true, purchasedAt: { $ne: null } } },
        { $addFields: { purchasedDate: { $toDate: "$purchasedAt" } } },
        { $project: { agentId: 1, daysDiff: { $divide: [{ $subtract: ["$purchasedDate", "$createdAt"] }, 86400000] } } },
        { $group: { _id: "$agentId", avgDays: { $avg: "$daysDiff" }, count: { $sum: 1 } } },
        { $match: { count: { $gte: 2 } } },
        { $sort: { avgDays: 1 } },
        { $limit: 1 }
      ]).toArray(),
    ]);

    const advanced = {
      staleQuotes,
      pipelineValue:           pipelineResult[0]?.total ?? 0,
      closedThisWeek,
      closedLastWeek,
      weekTrendPct:            closedLastWeek > 0
                                 ? Math.round((closedThisWeek - closedLastWeek) / closedLastWeek * 100)
                                 : closedThisWeek > 0 ? 100 : 0,
      multiQuoteClients:       multiQuoteResult[0]?.total ?? 0,
      avgDaysToClose:          avgDaysResult[0]?.avgDays != null ? Math.round(avgDaysResult[0].avgDays * 10) / 10 : null,
      byDayOfWeek,
      monthlyStats,
      totalUsers:              totalUsersCount,
      uniqueClientsWithQuotes: uniqueClientsResult[0]?.total ?? 0,
      exposureRate:            totalUsersCount > 0 ? (uniqueClientsResult[0]?.total ?? 0) / totalUsersCount : 0,
      discountUsagePct:        discountResult[0]?.total > 0 ? Math.round(discountResult[0].withDiscount / discountResult[0].total * 100) : 0,
      avgDiscountGiven:        discountResult[0]?.avgDiscount != null ? Math.round(discountResult[0].avgDiscount * 10) / 10 : 0,
      topClient:               topClientResult[0] ? { phone: topClientResult[0]._id, count: topClientResult[0].count, closed: topClientResult[0].closed } : null,
      avgQuotesBeforeClose:    avgQuotesResult[0]?.avg != null ? Math.round(avgQuotesResult[0].avg * 10) / 10 : null,
      byHour,
      staleByAgent:            staleByAgentResult.map(r => ({
        agentId:   r._id,
        agentName: nameMap[r._id] ?? KNOWN_SYSTEM_AGENTS[r._id] ?? "לא ידוע",
        count:     r.count,
      })),
      avgTimeToFirstQuote:     avgTimeToFirstQuoteResult[0]?.avgDays != null ? Math.round(avgTimeToFirstQuoteResult[0].avgDays * 10) / 10 : null,
      avgRevenueByDay:         avgRevenueByDayResult.map(r => ({ ...r, avgRevenue: Math.round(r.avgRevenue) })),
      forecastNextMonth:       last3MonthsResult.length > 0 ? Math.round(last3MonthsResult.reduce((s, m) => s + m.revenue, 0) / 3) : 0,
      fastestAgent:            fastestAgentResult[0] ? {
        agentId:   fastestAgentResult[0]._id,
        agentName: nameMap[fastestAgentResult[0]._id] ?? KNOWN_SYSTEM_AGENTS[fastestAgentResult[0]._id] ?? "לא ידוע",
        avgDays:   Math.round(fastestAgentResult[0].avgDays * 10) / 10,
      } : null,
      usersWithoutQuote:       0,
    };

    res.json({ byAgent, totals, advanced });
  } catch (err) {
    console.error("[Metrics/QuotesStats]", err.message, err.stack);
    res.status(500).json({ message: err.message });
  }
};

// ── Drill-down: rows backing a single metric card ──────────────────────────
// GET /api/appinfo/metrics/details/:type
// Returns { title, columns: [{key,label,type?}], rows: [...] }.
// Every supported metric resolves to a list of underlying rows.
exports.getMetricDetails = async (req, res) => {
  try {
    const { getDB } = require("../../config/db");
    const db = getDB();
    const { type } = req.params;

    const now = new Date();
    const weekAgo       = new Date(now - 7  * 86400000);
    const twoWeeksAgo   = new Date(now - 14 * 86400000);
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    const monthAgo      = new Date(now - 30 * 86400000);

    // KNOWN_SYSTEM_AGENTS exists in module scope above
    const Q = { agentId: { $nin: Object.keys(KNOWN_SYSTEM_AGENTS) } };

    // Helper: hydrate agentName onto a list of quote docs
    async function withAgentNames(docs) {
      const ids = [...new Set(docs.map(d => d.agentId).filter(Boolean))];
      const agents = await db.collection("agents").find(
        { _id: { $in: ids } },
        { projection: { name: 1 } }
      ).toArray();
      const nameMap = Object.fromEntries(agents.map(a => [a._id.toString(), a.name]));
      return docs.map(d => ({
        ...d,
        agentName: nameMap[d.agentId?.toString()] ?? KNOWN_SYSTEM_AGENTS[d.agentId] ?? "לא ידוע",
      }));
    }

    // Columns shared by quote-list drilldowns
    const QUOTE_COLS = [
      { key: "phone",       label: "טלפון" },
      { key: "agentName",   label: "נציג" },
      { key: "createdAt",   label: "נשלחה",  type: "date" },
      { key: "finalPrice",  label: "מחיר",   type: "currency" },
      { key: "purchased",   label: "סטטוס",  type: "status" },
      { key: "purchasedAt", label: "נסגרה",  type: "date" },
    ];

    // Columns for client-list drilldowns
    const CLIENT_COLS = [
      { key: "phone",       label: "טלפון" },
      { key: "quotesCount", label: "מס׳ הצעות" },
      { key: "closedCount", label: "נסגרו" },
      { key: "revenue",     label: "הכנסות", type: "currency" },
      { key: "lastQuoteAt", label: "הצעה אחרונה", type: "date" },
    ];

    async function fetchClientList(match) {
      return db.collection("personal_packages").aggregate([
        { $match: { ...Q, ...match } },
        { $sort: { createdAt: -1 } },
        { $group: {
          _id: "$phone",
          quotesCount: { $sum: 1 },
          closedCount: { $sum: { $cond: [{ $eq: ["$purchased", true] }, 1, 0] } },
          revenue:     { $sum: { $cond: [{ $eq: ["$purchased", true] }, "$finalPrice", 0] } },
          lastQuoteAt: { $max: "$createdAt" },
        }},
        { $project: {
          _id: 0,
          phone: "$_id",
          quotesCount: 1,
          closedCount: 1,
          revenue: 1,
          lastQuoteAt: 1,
        }},
        { $sort: { quotesCount: -1, lastQuoteAt: -1 } },
      ]).toArray();
    }

    let title = "פירוט";
    let columns = QUOTE_COLS;
    let rows = [];

    switch (type) {
      case "all": {
        title = "כל ההצעות שנשלחו";
        rows = await db.collection("personal_packages")
          .find(Q, { projection: { phone: 1, agentId: 1, createdAt: 1, finalPrice: 1, purchased: 1, purchasedAt: 1 } })
          .sort({ createdAt: -1 })
          .toArray();
        rows = await withAgentNames(rows);
        break;
      }
      case "closed": {
        title = "הצעות שנסגרו";
        rows = await db.collection("personal_packages")
          .find({ ...Q, purchased: true }, { projection: { phone: 1, agentId: 1, createdAt: 1, finalPrice: 1, purchased: 1, purchasedAt: 1 } })
          .sort({ purchasedAt: -1, createdAt: -1 })
          .toArray();
        rows = await withAgentNames(rows);
        break;
      }
      case "pipeline":
      case "open": {
        title = "הצעות פתוחות";
        columns = QUOTE_COLS.filter(c => c.key !== "purchasedAt");
        rows = await db.collection("personal_packages")
          .find({ ...Q, purchased: { $ne: true } }, { projection: { phone: 1, agentId: 1, createdAt: 1, finalPrice: 1, purchased: 1 } })
          .sort({ finalPrice: -1, createdAt: -1 })
          .toArray();
        rows = await withAgentNames(rows);
        break;
      }
      case "stale": {
        title = "הצעות ישנות (פתוחות מעל 30 יום)";
        columns = QUOTE_COLS.filter(c => c.key !== "purchasedAt");
        rows = await db.collection("personal_packages")
          .find({ ...Q, purchased: { $ne: true }, createdAt: { $lte: thirtyDaysAgo } }, { projection: { phone: 1, agentId: 1, createdAt: 1, finalPrice: 1, purchased: 1 } })
          .sort({ createdAt: 1 })
          .toArray();
        rows = await withAgentNames(rows);
        break;
      }
      case "weekTrend": {
        title = "סגירות בשבועיים האחרונים";
        rows = await db.collection("personal_packages")
          .find({ ...Q, purchased: true, createdAt: { $gte: twoWeeksAgo } }, { projection: { phone: 1, agentId: 1, createdAt: 1, finalPrice: 1, purchased: 1, purchasedAt: 1 } })
          .sort({ createdAt: -1 })
          .toArray();
        rows = await withAgentNames(rows);
        break;
      }
      case "clientsReached": {
        title = "לקוחות שקיבלו הצעה";
        columns = CLIENT_COLS;
        rows = await fetchClientList({});
        break;
      }
      case "clientsClosed": {
        title = "לקוחות שסגרו עסקה";
        columns = CLIENT_COLS;
        const all = await fetchClientList({});
        rows = all.filter(r => r.closedCount > 0);
        break;
      }
      case "multiQuote": {
        title = "לקוחות עם 2+ הצעות";
        columns = CLIENT_COLS;
        const all = await fetchClientList({});
        rows = all.filter(r => r.quotesCount > 1);
        break;
      }
      case "exposure": {
        title = "משתמשים — חשיפה להצעות";
        columns = [
          { key: "phone",       label: "טלפון" },
          { key: "createdAt",   label: "נרשם",      type: "date" },
          { key: "quotesCount", label: "מס׳ הצעות" },
          { key: "closedCount", label: "נסגרו" },
          { key: "revenue",     label: "הכנסות",    type: "currency" },
        ];
        const users = await db.collection("users")
          .find({}, { projection: { phone: 1, createdAt: 1 } })
          .sort({ createdAt: -1 })
          .toArray();
        const quoteStats = await fetchClientList({});
        const statsByPhone = Object.fromEntries(quoteStats.map(s => [s.phone, s]));
        rows = users.map(u => {
          const s = statsByPhone[u.phone];
          return {
            phone: u.phone,
            createdAt: u.createdAt,
            quotesCount: s?.quotesCount ?? 0,
            closedCount: s?.closedCount ?? 0,
            revenue: s?.revenue ?? 0,
          };
        });
        break;
      }
      case "topAgent": {
        title = "נציגים — ממוצע הכנסה לעסקה";
        columns = [
          { key: "agentName",     label: "נציג" },
          { key: "quotesClosed",  label: "עסקאות סגורות" },
          { key: "revenueTotal",  label: "סך הכנסות",     type: "currency" },
          { key: "avgPerDeal",    label: "ממוצע לעסקה",   type: "currency" },
        ];
        const agg = await db.collection("personal_packages").aggregate([
          { $match: { ...Q, purchased: true } },
          { $group: {
            _id: "$agentId",
            quotesClosed: { $sum: 1 },
            revenueTotal: { $sum: "$finalPrice" },
          }},
          { $project: {
            _id: 0,
            agentId: "$_id",
            quotesClosed: 1,
            revenueTotal: 1,
            avgPerDeal: { $divide: ["$revenueTotal", { $max: ["$quotesClosed", 1] }] },
          }},
          { $sort: { avgPerDeal: -1 } },
        ]).toArray();
        rows = await withAgentNames(agg);
        break;
      }
      case "avgDaysToClose": {
        title = "עסקאות סגורות — ימים עד סגירה";
        columns = [
          ...QUOTE_COLS,
          { key: "daysToClose", label: "ימים לסגירה" },
        ];
        const docs = await db.collection("personal_packages")
          .find({ ...Q, purchased: true, purchasedAt: { $ne: null } }, { projection: { phone: 1, agentId: 1, createdAt: 1, finalPrice: 1, purchased: 1, purchasedAt: 1 } })
          .sort({ purchasedAt: -1 })
          .toArray();
        const withDays = docs.map(d => {
          const purchased = d.purchasedAt instanceof Date ? d.purchasedAt : new Date(d.purchasedAt);
          const days = (purchased - d.createdAt) / 86400000;
          return { ...d, daysToClose: Math.round(days * 10) / 10 };
        });
        rows = await withAgentNames(withDays);
        break;
      }
      case "revenueTotal":
      case "avgRevenue": {
        // Both show the same closed list — UX makes the source of the number clear.
        title = type === "revenueTotal" ? "הכנסות — כל העסקאות הסגורות" : "עסקאות סגורות — בסיס לממוצע";
        rows = await db.collection("personal_packages")
          .find({ ...Q, purchased: true }, { projection: { phone: 1, agentId: 1, createdAt: 1, finalPrice: 1, purchased: 1, purchasedAt: 1 } })
          .sort({ finalPrice: -1 })
          .toArray();
        rows = await withAgentNames(rows);
        break;
      }
      default:
        return res.status(400).json({ message: `unknown metric type: ${type}` });
    }

    res.json({ title, columns, rows });
  } catch (err) {
    console.error("[Metrics/Details]", err.message, err.stack);
    res.status(500).json({ message: err.message });
  }
};
