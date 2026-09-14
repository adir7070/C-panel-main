/**
 * admin.controller — root of /api/cpanel/admin/* surface.
 *
 * Foundation:
 *   - requireAdmin middleware (every route below mount goes through this)
 *   - getDashboard (KPI cards + alerts)
 *   - getAuditLog (read audit_log)
 *
 * Spec: docs/ADMIN-PANEL-SPEC.md
 */

const { getDB } = require("../config/db");
const auditSvc  = require("../services/audit-log.service");

/* ── Helpers — agent ID handling ───────────────────────────────────────
   The agents collection mixes UUID `_id` (created via the standard
   register flow) and ObjectId `_id` (legacy). Most queries broke for
   UUID agents because they tried `new ObjectId(uuid)` which throws.
   Use these helpers instead. */
function maybeObjectId(id) {
  try {
    const { ObjectId } = require("mongodb");
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

/** Build a `$or` filter that matches an agent _id whether it's stored
 *  as ObjectId or as a string (UUID). */
function agentIdQuery(id) {
  const oid = maybeObjectId(id);
  return oid ? { $or: [{ _id: oid }, { _id: String(id) }] } : { _id: String(id) };
}

/** For a list of agent ids — return a filter matching any of them
 *  in either format. */
function agentIdsInQuery(ids) {
  const list = ids.map(String).filter(Boolean);
  if (list.length === 0) return { _id: { $in: [] } };
  const oids = list.map(maybeObjectId).filter(Boolean);
  return oids.length > 0
    ? { $or: [{ _id: { $in: oids } }, { _id: { $in: list } }] }
    : { _id: { $in: list } };
}

/* ── Middleware ─────────────────────────────────────────────────────── */

/**
 * Hard-block anything below /api/cpanel/admin to admins only. Note this
 * mounts AFTER c.authMiddleware (which sets req.agent) — that's why we
 * can read req.agent.role here.
 */
exports.requireAdmin = (req, res, next) => {
  if (!req.agent) return res.status(401).json({ error: "unauthenticated" });
  if (req.agent.role !== "admin") return res.status(403).json({ error: "admin only" });
  next();
};

/* ── GET /api/cpanel/admin/dashboard ───────────────────────────────────
   KPI snapshot + a chart-friendly revenue trend. Matches spec sec 2.1. */
exports.getDashboard = async (req, res) => {
  try {
    const db = getDB();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);

    /* In parallel — shared aggregations for the dashboard cards. */
    const [
      totalClients,
      totalManagers,
      activeManagers,
      activePackagesAgg,
      pendingPurchasesToday,
      pendingPurchasesMonth,
      pendingPurchasesAll,
      revenueByDay,
      packageMix,
      topManagersAgg,
    ] = await Promise.all([
      db.collection("cpanel_clients").countDocuments({}),
      db.collection("agents").countDocuments({}),
      db.collection("agents").countDocuments({ active: { $ne: false } }),

      db.collection("users").aggregate([
        { $match: { activePackage: { $exists: true } } },
        { $group: { _id: "$activePackage.status", count: { $sum: 1 } } },
      ]).toArray(),

      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: startOfDay } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $exists: true } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),

      /* Revenue trend — last 90 days, bucket by day. */
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: ninetyDaysAgo } } },
        { $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$completedAt" } },
            total: { $sum: "$totalAmount" },
            count: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]).toArray(),

      /* Package mix — by kind across all completed purchases this month. */
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: startOfMonth } } },
        { $group: { _id: "$description", total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
      ]).toArray(),

      /* Top 10 managers by revenue this month. */
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: startOfMonth }, agentId: { $exists: true } } },
        { $group: { _id: "$agentId", total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
      ]).toArray(),
    ]);

    /* Hydrate manager names for the top-managers list. */
    /* Agent ids are UUID strings on newer agents, ObjectIds on older ones. */
    const topAgentIds = topManagersAgg.map(a => a._id).filter(Boolean);
    const agentDocs = topAgentIds.length
      ? await db.collection("agents").find(
          agentIdsInQuery(topAgentIds),
          { projection: { name: 1, nickname: 1 } },
        ).toArray()
      : [];
    const agentNameById = new Map(agentDocs.map(a => [String(a._id), a.nickname || a.name || "—"]));

    /* Tasks across all managers — open + by urgency (auto-derived from
       activePackage.status, mirror of getTasks logic in cpanel.controller). */
    const taskMatrix = activePackagesAgg.reduce((acc, row) => {
      acc[row._id || "unknown"] = row.count;
      return acc;
    }, {});

    /* Compose alerts feed — surface "needs immediate attention" stuff. */
    const alerts = [];
    if (taskMatrix.client_returned_corrections > 0) {
      alerts.push({
        kind: "rejection",
        urgency: "red",
        message: `${taskMatrix.client_returned_corrections} לקוחות החזירו תיקונים — דורש מענה`,
      });
    }
    if (taskMatrix.waiting_brief > 0) {
      alerts.push({
        kind: "stuck",
        urgency: "yellow",
        message: `${taskMatrix.waiting_brief} לקוחות ממתינים להשלמת איפיון`,
      });
    }
    if (taskMatrix.sent_to_client > 0) {
      alerts.push({
        kind: "awaiting",
        urgency: "yellow",
        message: `${taskMatrix.sent_to_client} לקוחות ממתינים לאישור`,
      });
    }

    res.json({
      kpis: {
        revenueToday:   pendingPurchasesToday[0]?.total  || 0,
        revenueMonth:   pendingPurchasesMonth[0]?.total  || 0,
        revenueTotal:   pendingPurchasesAll[0]?.total    || 0,
        purchasesMonth: pendingPurchasesMonth[0]?.count  || 0,
        clientsTotal:   totalClients,
        managersTotal:  totalManagers,
        managersActive: activeManagers,
        packagesByStatus: taskMatrix,
      },
      revenueTrend: revenueByDay.map(d => ({
        date: d._id, total: d.total, count: d.count,
      })),
      packageMix: packageMix.map(p => ({
        name: p._id || "—", total: p.total, count: p.count,
      })),
      topManagers: topManagersAgg.map(m => ({
        agentId: m._id,
        name:    agentNameById.get(String(m._id)) || "—",
        total:   m.total,
        count:   m.count,
      })),
      alerts,
    });
  } catch (err) {
    console.error("[admin] getDashboard:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/managers ────────────────────────────────────
   Spec sec 2.2 list view: every manager with rollup stats. */
exports.listManagers = async (req, res) => {
  try {
    const db = getDB();
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [agents, clientCounts, revLifetime, revMonth, commissionsAgg, tasksAgg] = await Promise.all([
      db.collection("agents").find(
        {},
        { projection: { name: 1, nickname: 1, role: 1, active: 1, lastActiveAt: 1, createdAt: 1 } },
      ).toArray(),

      db.collection("cpanel_clients").aggregate([
        { $group: { _id: "$agentId", count: { $sum: 1 } } },
      ]).toArray(),

      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $exists: true }, agentId: { $exists: true } } },
        { $group: { _id: "$agentId", total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),

      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: startOfMonth }, agentId: { $exists: true } } },
        { $group: { _id: "$agentId", total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),

      db.collection("cpanel_commissions").aggregate([
        { $group: {
            _id: { agentId: "$agentId", status: "$status" },
            total: { $sum: "$commissionAmount" },
        }},
      ]).toArray().catch(() => []),

      /* Open tasks = packages in actionable status, scoped to each manager. */
      db.collection("cpanel_clients").aggregate([
        { $lookup: {
            from: "users",
            localField: "phone",
            foreignField: "phone",
            as: "user",
        }},
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        { $match: { "user.activePackage.status": {
            $in: [
              "waiting_brief","sent_to_creation","waiting_manager_approval","sent_to_client",
              "client_returned_corrections","in_correction","corrections_completed","corrections_done",
            ],
        }}},
        { $group: { _id: "$agentId", openTasks: { $sum: 1 } } },
      ]).toArray().catch(() => []),
    ]);

    const clientsBy   = new Map(clientCounts.map(r => [String(r._id), r.count]));
    const lifetimeBy  = new Map(revLifetime.map(r => [String(r._id), r]));
    const monthBy     = new Map(revMonth.map(r => [String(r._id), r]));
    const tasksBy     = new Map(tasksAgg.map(r => [String(r._id), r.openTasks]));

    /* Commissions: pivot earned vs paid per agent. */
    const commissionsBy = new Map();
    for (const row of commissionsAgg) {
      const key = String(row._id.agentId);
      if (!commissionsBy.has(key)) commissionsBy.set(key, { earned: 0, paid: 0 });
      const slot = commissionsBy.get(key);
      if (row._id.status === "paid") slot.paid   += row.total || 0;
      else                            slot.earned += row.total || 0;
    }

    const managers = agents.map(a => {
      const id = String(a._id);
      const lt = lifetimeBy.get(id) || { total: 0, count: 0 };
      const mn = monthBy.get(id)    || { total: 0, count: 0 };
      const cm = commissionsBy.get(id) || { earned: 0, paid: 0 };
      return {
        id,
        name:        a.nickname || a.name || "—",
        role:        a.role || "account_manager",
        active:      a.active !== false,
        clientCount: clientsBy.get(id) || 0,
        revenue: {
          lifetime: lt.total,
          month:    mn.total,
          deals:    lt.count,
        },
        commissions: {
          earned: cm.earned,
          paid:   cm.paid,
          unpaid: Math.max(0, cm.earned - cm.paid),
        },
        openTasks:    tasksBy.get(id) || 0,
        lastActiveAt: a.lastActiveAt || null,
        createdAt:    a.createdAt    || null,
      };
    });

    /* Sort: active first, then by lifetime revenue descending. */
    managers.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.revenue.lifetime - a.revenue.lifetime;
    });

    res.json({ managers, total: managers.length });
  } catch (err) {
    console.error("[admin] listManagers:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/managers/:id ──────────────────────────────── */
exports.getManagerDetail = async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;

    /* Agents may have either UUID or ObjectId _id — match either. */
    const agent = await db.collection("agents").findOne(
      agentIdQuery(id),
      { projection: { token: 0, password: 0 } },
    );
    if (!agent) return res.status(404).json({ error: "manager not found" });

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [clients, charges, commissions, monthRevenue] = await Promise.all([
      db.collection("cpanel_clients").find({ agentId: id }).toArray(),

      /* Per-client revenue rollup: sum of completed pending purchases. */
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { agentId: id, completedAt: { $exists: true } } },
        { $group: { _id: "$phone", total: { $sum: "$totalAmount" }, count: { $sum: 1 }, lastAt: { $max: "$completedAt" } } },
      ]).toArray(),

      /* Commission ledger — per-row, sorted newest first. */
      db.collection("cpanel_commissions").find(
        { agentId: id },
      ).sort({ earnedAt: -1 }).limit(200).toArray().catch(() => []),

      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { agentId: id, completedAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    /* Hydrate client names + revenue per client. */
    const phones = clients.map(c => c.phone);
    const chats = phones.length
      ? await db.collection("support_chats").find(
          { phone: { $in: phones } },
          { projection: { phone: 1, name: 1, fireberyName: 1 } },
        ).toArray()
      : [];
    const nameByPhone = new Map(chats.map(c => [c.phone, c.fireberyName || c.name || c.phone]));
    const revByPhone  = new Map(charges.map(r => [r._id, r]));

    const clientList = clients.map(c => {
      const rev = revByPhone.get(c.phone) || { total: 0, count: 0, lastAt: null };
      return {
        phone:       c.phone,
        name:        nameByPhone.get(c.phone) || c.customerName || c.phone,
        revenue:     rev.total,
        deals:       rev.count,
        lastDealAt:  rev.lastAt,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    /* Commissions split. */
    const commLedger = commissions.map(c => ({
      id:               String(c._id),
      baseAmount:       c.baseAmount,
      commissionAmount: c.commissionAmount,
      commissionRate:   c.commissionRate,
      sourceKind:       c.sourceKind,
      clientPhone:      c.clientPhone,
      description:      c.description,
      earnedAt:         c.earnedAt,
      status:           c.status,
    }));

    const totalEarned = commLedger.reduce((s, c) => s + (c.commissionAmount || 0), 0);
    const totalPaid   = commLedger.filter(c => c.status === "paid").reduce((s, c) => s + (c.commissionAmount || 0), 0);

    const totalLifetime = charges.reduce((s, r) => s + r.total, 0);
    const totalLifetimeDeals = charges.reduce((s, r) => s + r.count, 0);

    res.json({
      manager: {
        id:           String(agent._id),
        name:         agent.nickname || agent.name || "—",
        role:         agent.role || "account_manager",
        email:        agent.email  || null,
        phone:        agent.phone  || null,
        active:       agent.active !== false,
        lastActiveAt: agent.lastActiveAt || null,
        createdAt:    agent.createdAt    || null,
      },
      stats: {
        clients:       clients.length,
        revenueLifetime: totalLifetime,
        revenueMonth:    monthRevenue[0]?.total || 0,
        dealsLifetime:   totalLifetimeDeals,
        dealsMonth:      monthRevenue[0]?.count || 0,
        commissionEarned: totalEarned,
        commissionPaid:   totalPaid,
        commissionUnpaid: Math.max(0, totalEarned - totalPaid),
      },
      clients:     clientList,
      commissions: commLedger,
    });
  } catch (err) {
    console.error("[admin] getManagerDetail:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/clients ─────────────────────────────────────
   Spec sec 2.3 list view: every client across all managers, filterable. */
exports.listClients = async (req, res) => {
  try {
    const db = getDB();
    const { manager, status, tier, search, source } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    /* Step 1 — clients filtered by manager + tier + source first. */
    const clientFilter = {};
    if (manager) clientFilter.agentId = String(manager);
    if (tier)    clientFilter.tier    = String(tier);
    if (source)  clientFilter.source  = String(source); // e.g. "promo49" landing clients

    const clients = await db.collection("cpanel_clients")
      .find(clientFilter)
      .sort({ createdAt: -1 })
      .toArray();

    if (clients.length === 0) {
      return res.json({ clients: [], total: 0 });
    }

    const phones   = clients.map(c => c.phone).filter(Boolean);
    const agentIds = [...new Set(clients.map(c => c.agentId).filter(Boolean))];

    /* Step 2 — load companion data in parallel. */
    const [users, chats, agents, revenueByPhone] = await Promise.all([
      db.collection("users").find(
        { phone: { $in: phones } },
        { projection: { phone: 1, activePackage: 1, paymentLast4: 1 } },
      ).toArray(),

      db.collection("support_chats").find(
        { phone: { $in: phones } },
        { projection: { phone: 1, name: 1, fireberyName: 1, fireberyLogoUrl: 1, updated_at: 1 } },
      ).toArray(),

      agentIds.length
        ? db.collection("agents").find(
            agentIdsInQuery(agentIds),
            { projection: { name: 1, nickname: 1 } },
          ).toArray()
        : [],

      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { phone: { $in: phones }, completedAt: { $exists: true } } },
        { $group: { _id: "$phone", total: { $sum: "$totalAmount" }, count: { $sum: 1 }, lastAt: { $max: "$completedAt" } } },
      ]).toArray(),
    ]);

    const userByPhone   = new Map(users.map(u => [u.phone, u]));
    const chatByPhone   = new Map(chats.map(c => [c.phone, c]));
    const nameByAgentId = new Map(agents.map(a => [String(a._id), a.nickname || a.name || "—"]));
    const revByPhone    = new Map(revenueByPhone.map(r => [r._id, r]));

    /* Step 3 — assemble + status filter + text search. */
    let rows = clients.map(c => {
      const user = userByPhone.get(c.phone) || {};
      const chat = chatByPhone.get(c.phone) || {};
      const rev  = revByPhone.get(c.phone) || { total: 0, count: 0, lastAt: null };
      return {
        phone:           c.phone,
        name:            chat.fireberyName || chat.name || c.customerName || c.phone,
        logoUrl:         chat.fireberyLogoUrl || null,
        agentId:         c.agentId || null,
        managerName:     c.agentId ? (nameByAgentId.get(String(c.agentId)) || "—") : "—",
        tier:            c.tier || "REGULAR",
        packageName:     user?.activePackage?.name || null,
        packageStatus:   user?.activePackage?.status || null,
        hasPaymentToken: !!user?.paymentLast4,
        revenue:         rev.total,
        deals:           rev.count,
        lastDealAt:      rev.lastAt,
        lastChatAt:      chat.updated_at || null,
        createdAt:       c.createdAt || null,
      };
    });

    if (status) {
      const wanted = String(status);
      rows = rows.filter(r => r.packageStatus === wanted);
    }

    if (search) {
      const q = String(search).toLowerCase();
      rows = rows.filter(r =>
        (r.name && r.name.toLowerCase().includes(q)) ||
        (r.phone && r.phone.toLowerCase().includes(q)) ||
        (r.managerName && r.managerName.toLowerCase().includes(q))
      );
    }

    /* Default sort: revenue descending. */
    rows.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));


    res.json({ clients: rows.slice(0, limit), total: rows.length });
  } catch (err) {
    console.error("[admin] listClients:", err.message);
    res.status(500).json({ error: err.message });
  }
};





/* ── GET /api/cpanel/admin/finance/revenue ─────────────────────────────
   Spec sec 2.4. Monthly buckets, breakdown by package + manager + tier.
   Range query: ?months=12 (default 12, max 36). */
exports.getFinanceRevenue = async (req, res) => {
  try {
    const db = getDB();
    const months = Math.min(parseInt(req.query.months, 10) || 12, 36);
    const rangeStart = new Date();
    rangeStart.setMonth(rangeStart.getMonth() - months);
    rangeStart.setDate(1);
    rangeStart.setHours(0, 0, 0, 0);

    const baseMatch = { completedAt: { $gte: rangeStart } };
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const startOfLastMonth = new Date(startOfMonth);
    startOfLastMonth.setMonth(startOfLastMonth.getMonth() - 1);

    const [byMonth, byPackage, byManager, byTier, totalAll, totalThisMonth, totalLastMonth] = await Promise.all([
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: baseMatch },
        { $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$completedAt" } },
            total: { $sum: "$totalAmount" },
            count: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]).toArray(),

      db.collection("cpanel_pending_purchases").aggregate([
        { $match: baseMatch },
        { $group: { _id: "$description", total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 20 },
      ]).toArray(),

      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { ...baseMatch, agentId: { $exists: true } } },
        { $group: { _id: "$agentId", total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 20 },
      ]).toArray(),

      /* Tier requires join via cpanel_clients. */
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: baseMatch },
        { $lookup: {
            from: "cpanel_clients",
            localField: "phone",
            foreignField: "phone",
            as: "client",
        }},
        { $unwind: { path: "$client", preserveNullAndEmptyArrays: true } },
        { $group: {
            _id: { $ifNull: ["$client.tier", "REGULAR"] },
            total: { $sum: "$totalAmount" },
            count: { $sum: 1 },
        }},
        { $sort: { total: -1 } },
      ]).toArray(),

      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $exists: true } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: startOfLastMonth, $lt: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    /* Hydrate manager names. Agents may be UUID or ObjectId. */
    const agentIds  = byManager.map(m => m._id).filter(Boolean);
    const agentDocs = agentIds.length
      ? await db.collection("agents").find(agentIdsInQuery(agentIds), { projection: { name: 1, nickname: 1 } }).toArray()
      : [];
    const nameById = new Map(agentDocs.map(a => [String(a._id), a.nickname || a.name || "—"]));

    const monthCur  = totalThisMonth[0]?.total || 0;
    const monthPrev = totalLastMonth[0]?.total || 0;
    const trend = monthPrev > 0 ? ((monthCur - monthPrev) / monthPrev) * 100 : null;

    res.json({
      summary: {
        revenueTotal:    totalAll[0]?.total      || 0,
        dealsTotal:      totalAll[0]?.count      || 0,
        revenueMonth:    monthCur,
        revenueLastMonth: monthPrev,
        trendPct:        trend,                     /* null if no prior month */
      },
      byMonth: byMonth.map(b => ({ month: b._id, total: b.total, count: b.count })),
      byPackage: byPackage.map(b => ({ name: b._id || "—", total: b.total, count: b.count })),
      byManager: byManager.map(b => ({
        agentId: b._id,
        name: nameById.get(String(b._id)) || "—",
        total: b.total, count: b.count,
      })),
      byTier: byTier.map(b => ({ tier: b._id || "REGULAR", total: b.total, count: b.count })),
    });
  } catch (err) {
    console.error("[admin] getFinanceRevenue:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/finance/payments ──────────────────────────── */
exports.getFinancePayments = async (req, res) => {
  try {
    const db = getDB();
    const { from, to, manager, status, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const match = {};
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to)   match.createdAt.$lte = new Date(to);
    }
    if (manager) match.agentId = String(manager);

    /* status filter — completed/pending */
    if (status === "completed") match.completedAt = { $exists: true };
    if (status === "pending")   match.completedAt = { $exists: false };

    const rows = await db.collection("cpanel_pending_purchases")
      .find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    /* Hydrate manager + customer names. */
    const phones   = [...new Set(rows.map(r => r.phone).filter(Boolean))];
    const agentIds = [...new Set(rows.map(r => r.agentId).filter(Boolean))];
    /* Agents may have UUID or ObjectId _id — agentIdsInQuery handles both. */

    const [chats, agents] = await Promise.all([
      phones.length ? db.collection("support_chats").find(
        { phone: { $in: phones } }, { projection: { phone: 1, name: 1, fireberyName: 1 } },
      ).toArray() : [],
      agentIds.length ? db.collection("agents").find(
        agentIdsInQuery(agentIds), { projection: { name: 1, nickname: 1 } },
      ).toArray() : [],
    ]);
    const nameByPhone   = new Map(chats.map(c => [c.phone, c.fireberyName || c.name || c.phone]));
    const nameByAgentId = new Map(agents.map(a => [String(a._id), a.nickname || a.name || "—"]));

    let payments = rows.map(r => ({
      id:           String(r._id),
      lowProfileId: r.lowProfileId || null,
      phone:        r.phone,
      clientName:   nameByPhone.get(r.phone) || r.phone,
      agentId:      r.agentId || null,
      managerName:  r.agentId ? (nameByAgentId.get(String(r.agentId)) || "—") : "—",
      kind:         r.kind || "package",
      description:  r.description || null,
      amount:       r.totalAmount || r.amount || 0,
      status:       r.completedAt ? "completed" : "pending",
      createdAt:    r.createdAt,
      completedAt:  r.completedAt || null,
    }));

    if (search) {
      const q = String(search).toLowerCase();
      payments = payments.filter(p =>
        (p.clientName && p.clientName.toLowerCase().includes(q)) ||
        (p.phone && p.phone.toLowerCase().includes(q)) ||
        (p.managerName && p.managerName.toLowerCase().includes(q)) ||
        (p.description && p.description.toLowerCase().includes(q))
      );
    }

    res.json({ payments, total: payments.length });
  } catch (err) {
    console.error("[admin] getFinancePayments:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/finance/commissions ───────────────────────── */
exports.getFinanceCommissions = async (req, res) => {
  try {
    const db = getDB();
    const { manager, status, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);

    const match = {};
    if (manager) match.agentId = String(manager);
    if (status === "earned" || status === "paid") match.status = status;
    if (from || to) {
      match.earnedAt = {};
      if (from) match.earnedAt.$gte = new Date(from);
      if (to)   match.earnedAt.$lte = new Date(to);
    }

    const rows = await db.collection("cpanel_commissions")
      .find(match)
      .sort({ earnedAt: -1 })
      .limit(limit)
      .toArray();

    /* Hydrate manager + client names. */
    const phones   = [...new Set(rows.map(r => r.clientPhone).filter(Boolean))];
    const agentIds = [...new Set(rows.map(r => r.agentId).filter(Boolean))];
    /* Agents may have UUID or ObjectId _id — agentIdsInQuery handles both. */

    const [chats, agents] = await Promise.all([
      phones.length ? db.collection("support_chats").find(
        { phone: { $in: phones } }, { projection: { phone: 1, name: 1, fireberyName: 1 } },
      ).toArray() : [],
      agentIds.length ? db.collection("agents").find(
        agentIdsInQuery(agentIds), { projection: { name: 1, nickname: 1 } },
      ).toArray() : [],
    ]);
    const nameByPhone   = new Map(chats.map(c => [c.phone, c.fireberyName || c.name || c.phone]));
    const nameByAgentId = new Map(agents.map(a => [String(a._id), a.nickname || a.name || "—"]));

    /* Aggregate totals across the result set (for the summary cards). */
    const sumEarned = rows.reduce((s, r) => s + (r.commissionAmount || 0), 0);
    const sumPaid   = rows.filter(r => r.status === "paid").reduce((s, r) => s + (r.commissionAmount || 0), 0);

    const commissions = rows.map(r => ({
      id:               String(r._id),
      agentId:          r.agentId || null,
      managerName:      r.agentId ? (nameByAgentId.get(String(r.agentId)) || "—") : "—",
      clientPhone:      r.clientPhone || null,
      clientName:       r.clientPhone ? (nameByPhone.get(r.clientPhone) || r.clientPhone) : "—",
      baseAmount:       r.baseAmount,
      commissionAmount: r.commissionAmount,
      commissionRate:   r.commissionRate,
      sourceKind:       r.sourceKind,
      description:      r.description || null,
      earnedAt:         r.earnedAt,
      status:           r.status,
      paidAt:           r.paidAt || null,
      paidBatchId:      r.paidBatchId || null,
    }));

    res.json({
      commissions,
      total: commissions.length,
      summary: {
        earned: sumEarned,
        paid:   sumPaid,
        unpaid: Math.max(0, sumEarned - sumPaid),
      },
    });
  } catch (err) {
    console.error("[admin] getFinanceCommissions:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/tasks ───────────────────────────────────────
   Spec sec 2.6: every open task across every manager, with the same
   auto-derived rules (TASK_DEFS / minHours / urgency) used in
   GET /cpanel/tasks — but unscoped to req.agent. */
const ADMIN_TASK_DEFS = {
  waiting_brief:               { label: "השלמת איפיון",         desc: "לקוח שילם, האיפיון לא הושלם",     minHours: 0  },
  sent_to_creation:            { label: "יצירת מוצרים",         desc: "איפיון הושלם, מוצרים לא נוצרו",   minHours: 4  },
  waiting_manager_approval:    { label: "אישור תוצרים",         desc: "מוצרים מוכנים לאישור המנהל",      minHours: 0  },
  sent_to_client:              { label: "לקוח לא הגיב",         desc: "שלחנו ללקוח, לא קיבלנו תגובה",   minHours: 24 },
  client_returned_corrections: { label: "תיקוני לקוח ממתינים", desc: "הלקוח החזיר תיקונים — יש לטפל",   minHours: 0  },
  in_correction:               { label: "השלמת תיקונים",        desc: "בתיקון — לא הוחזר ללקוח",         minHours: 24 },
  corrections_done:            { label: "שלח שוב ללקוח",        desc: "תיקונים הושלמו, טרם נשלח",        minHours: 0  },
  /* Mirror the alt spelling used by some flows */
  corrections_completed:       { label: "שלח שוב ללקוח",        desc: "תיקונים הושלמו, טרם נשלח",        minHours: 0  },
};

function adminTaskUrgency(h) {
  if (h <  24) return "normal";
  if (h <  48) return "yellow";
  if (h <  72) return "orange";
  if (h < 120) return "red";
  return "blink";
}

exports.getAdminTasks = async (req, res) => {
  try {
    const db = getDB();
    const allClients = await db.collection("cpanel_clients")
      .find({}, { projection: { phone: 1, customerName: 1, agentId: 1 } })
      .toArray();
    if (!allClients.length) {
      return res.json({ tasks: [], total: 0, byUrgency: {}, byManager: [] });
    }

    const phones = allClients.map(c => c.phone);
    const clientMeta = new Map(allClients.map(c => [c.phone, c]));

    const users = await db.collection("users").find(
      { phone: { $in: phones }, activePackage: { $exists: true } },
      { projection: { phone: 1, activePackage: 1 } },
    ).toArray();

    /* Hydrate manager names. */
    const agentIds = [...new Set(allClients.map(c => c.agentId).filter(Boolean))];
    /* Agents may have UUID or ObjectId _id — agentIdsInQuery handles both. */
    const agents = agentIds.length
      ? await db.collection("agents").find(
          agentIdsInQuery(agentIds),
          { projection: { name: 1, nickname: 1 } },
        ).toArray()
      : [];
    const nameByAgentId = new Map(agents.map(a => [String(a._id), a.nickname || a.name || "—"]));

    const now = Date.now();
    const tasks = [];
    for (const u of users) {
      const pkg    = u.activePackage;
      const status = pkg.status || "waiting_brief";
      const def    = ADMIN_TASK_DEFS[status];
      if (!def) continue;
      const since = new Date(pkg.statusUpdatedAt || pkg.purchasedAt || now).getTime();
      const elapsedHours = (now - since) / 3_600_000;
      if (elapsedHours < def.minHours) continue;

      const meta = clientMeta.get(u.phone) || {};
      tasks.push({
        id:           `${u.phone}_${status}`,
        clientPhone:  u.phone,
        clientName:   meta.customerName || u.phone,
        agentId:      meta.agentId || null,
        managerName:  meta.agentId ? (nameByAgentId.get(String(meta.agentId)) || "—") : "—",
        packageName:  pkg.name || "חבילה",
        taskType:     status,
        taskLabel:    def.label,
        description:  def.desc,
        since:        new Date(since).toISOString(),
        elapsedHours: Math.floor(elapsedHours),
        urgency:      adminTaskUrgency(elapsedHours),
      });
    }

    /* Sort: blink → red → orange → yellow → normal; oldest first within each. */
    const ORDER = { blink: 0, red: 1, orange: 2, yellow: 3, normal: 4 };
    tasks.sort((a, b) => {
      const u = (ORDER[a.urgency] ?? 9) - (ORDER[b.urgency] ?? 9);
      if (u !== 0) return u;
      return b.elapsedHours - a.elapsedHours;
    });

    const byUrgency = { normal: 0, yellow: 0, orange: 0, red: 0, blink: 0 };
    tasks.forEach(t => { byUrgency[t.urgency]++; });

    /* Roll up by manager — counts + most-urgent. */
    const byManagerMap = new Map();
    for (const t of tasks) {
      const key = t.agentId || "_none";
      if (!byManagerMap.has(key)) {
        byManagerMap.set(key, {
          agentId: t.agentId,
          managerName: t.managerName,
          total: 0,
          byUrgency: { normal: 0, yellow: 0, orange: 0, red: 0, blink: 0 },
        });
      }
      const slot = byManagerMap.get(key);
      slot.total++;
      slot.byUrgency[t.urgency]++;
    }
    const byManager = [...byManagerMap.values()].sort((a, b) => {
      /* Worst-off manager first — count blink+red. */
      const aHot = a.byUrgency.blink * 2 + a.byUrgency.red;
      const bHot = b.byUrgency.blink * 2 + b.byUrgency.red;
      if (aHot !== bHot) return bHot - aHot;
      return b.total - a.total;
    });

    res.json({ tasks, total: tasks.length, byUrgency, byManager });
  } catch (err) {
    console.error("[admin] getAdminTasks:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── Catalog & Pricing (spec sec 2.11) ─────────────────────────────────
   Read-write surface over services/cpanel-products.service.js.
   Every mutation auto-records to audit_log so spec sec 2.13 (version
   history) is covered without a separate collection. */

const productsSvc = require("../services/cpanel-products.service");

exports.listCatalog = async (_req, res) => {
  try {
    const catalog = await productsSvc.listAll();
    res.json(catalog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* POST /admin/catalog
   Body: a full product document — { key, kind, ...fields }.
   Upserts by `key`. Returns the saved doc. */
exports.upsertCatalogItem = async (req, res) => {
  try {
    const input = req.body || {};
    if (!input.key)  return res.status(400).json({ error: "key required" });
    if (!input.kind) return res.status(400).json({ error: "kind required" });

    /* Snapshot the previous state for audit. */
    const before = await productsSvc.getPackageByKey(input.key)
      || (await getDB().collection("cpanel_products").findOne({ key: input.key }));

    const saved = await productsSvc.upsertProduct(input);

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: before ? "catalog.update" : "catalog.create",
      target: { kind: "catalog", id: input.key, label: input.name || input.label || input.key },
      before: before || null,
      after:  saved,
    });

    res.json({ success: true, product: saved });
  } catch (err) {
    console.error("[admin] upsertCatalogItem:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* DELETE /admin/catalog/:key — soft-delete (sets active=false) */
exports.deleteCatalogItem = async (req, res) => {
  try {
    const { key } = req.params;
    const before = await getDB().collection("cpanel_products").findOne({ key });
    if (!before) return res.status(404).json({ error: "not found" });

    await productsSvc.deleteProduct(key);

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "catalog.delete",
      target: { kind: "catalog", id: key, label: before.name || before.label || key },
      before,
      after:  null,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("[admin] deleteCatalogItem:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── System Settings (spec sec 2.15) ───────────────────────────────────
   KV-style sections with bake-in defaults. Mutations are audit-attached. */

const settingsSvc = require("../services/admin-settings.service");

exports.getSettings = async (_req, res) => {
  try {
    const all = await settingsSvc.getAll();
    res.json({ settings: all, defaults: settingsSvc.DEFAULTS });
  } catch (err) {
    console.error("[admin] getSettings:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* PATCH /admin/settings
   Body: { section, values } — only the diff for one section. */
exports.patchSettings = async (req, res) => {
  try {
    const { section, values } = req.body || {};
    if (!section)            return res.status(400).json({ error: "section required" });
    if (!values || typeof values !== "object") {
      return res.status(400).json({ error: "values must be an object" });
    }
    const { before, after } = await settingsSvc.patchSection(section, values);

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "settings.update",
      target: { kind: "settings", id: section, label: section },
      before, after,
    });

    res.json({ success: true, section, values: after });
  } catch (err) {
    console.error("[admin] patchSettings:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/ai-usage ────────────────────────────────────
   Spec sec 2.7. Aggregates coin spend across clients + managers, plus
   regeneration counts pulled from the wow_*_sessions arrays. */
exports.getAdminAiUsage = async (req, res) => {
  try {
    const db = getDB();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    /* Coin-spend aggregations from `users` (coinsUsed is the canonical
       lifetime-spent field; coins is current balance). */
    const [coinAgg, topClients, agentClientLink] = await Promise.all([
      db.collection("users").aggregate([
        { $match: { activePackage: { $exists: true } } },
        { $group: {
            _id: null,
            grantedTotal: { $sum: { $ifNull: ["$activePackage.coins", 0] } },
            usedTotal:    { $sum: { $ifNull: ["$coinsUsed", 0] } },
            balanceTotal: { $sum: { $ifNull: ["$coins", 0] } },
            clientCount:  { $sum: 1 },
        }},
      ]).toArray(),

      db.collection("users").aggregate([
        { $match: { activePackage: { $exists: true }, coinsUsed: { $gt: 0 } } },
        { $project: {
            phone: 1,
            coinsUsed: { $ifNull: ["$coinsUsed", 0] },
            coinsBalance: { $ifNull: ["$coins", 0] },
            coinsGranted: { $ifNull: ["$activePackage.coins", 0] },
            packageName: { $ifNull: ["$activePackage.name", null] },
        }},
        { $sort: { coinsUsed: -1 } },
        { $limit: limit },
      ]).toArray(),

      db.collection("cpanel_clients").find(
        {}, { projection: { phone: 1, agentId: 1, customerName: 1 } },
      ).toArray(),
    ]);

    const phoneToAgent = new Map(agentClientLink.map(c => [c.phone, c.agentId || null]));
    const phoneToName  = new Map(agentClientLink.map(c => [c.phone, c.customerName || c.phone]));

    /* Hydrate manager names. */
    const agentIds = [...new Set(agentClientLink.map(c => c.agentId).filter(Boolean))];
    /* Agents may have UUID or ObjectId _id — agentIdsInQuery handles both. */
    const agentDocs = agentIds.length
      ? await db.collection("agents").find(agentIdsInQuery(agentIds), { projection: { name: 1, nickname: 1 } }).toArray()
      : [];
    const nameByAgentId = new Map(agentDocs.map(a => [String(a._id), a.nickname || a.name || "—"]));

    /* Top clients with manager-name attached. */
    const topClientsHydrated = topClients.map(c => {
      const agentId = phoneToAgent.get(c.phone);
      return {
        phone:        c.phone,
        clientName:   phoneToName.get(c.phone) || c.phone,
        agentId,
        managerName:  agentId ? (nameByAgentId.get(String(agentId)) || "—") : "—",
        coinsUsed:    c.coinsUsed,
        coinsBalance: c.coinsBalance,
        coinsGranted: c.coinsGranted,
        packageName:  c.packageName,
      };
    });

    /* By-manager rollup: aggregate coinsUsed across each manager's clients. */
    const byManagerMap = new Map();
    for (const c of topClients) {
      const agentId = phoneToAgent.get(c.phone);
      if (!agentId) continue;
      const key = String(agentId);
      if (!byManagerMap.has(key)) {
        byManagerMap.set(key, {
          agentId,
          managerName: nameByAgentId.get(key) || "—",
          coinsUsed:   0,
          clientCount: 0,
        });
      }
      const slot = byManagerMap.get(key);
      slot.coinsUsed   += c.coinsUsed;
      slot.clientCount += 1;
    }
    const byManager = [...byManagerMap.values()].sort((a, b) => b.coinsUsed - a.coinsUsed);

    /* Regeneration counts — count items with `regeneratedAt` across wow sessions. */
    const [adsRegens, organicRegens, lpRegens] = await Promise.all([
      db.collection("wow_ads_sessions").aggregate([
        { $unwind: { path: "$generatedAds", preserveNullAndEmptyArrays: false } },
        { $match: { "generatedAds.regeneratedAt": { $exists: true } } },
        { $count: "total" },
      ]).toArray(),
      db.collection("wow_organic_ads_sessions").aggregate([
        { $unwind: { path: "$generatedPosts", preserveNullAndEmptyArrays: false } },
        { $match: { "generatedPosts.regeneratedAt": { $exists: true } } },
        { $count: "total" },
      ]).toArray(),
      /* LP — image regenerations live elsewhere; counting sessions with regenerated marker if any. */
      db.collection("wow_lp_sessions").aggregate([
        { $match: { lastImageRegeneratedAt: { $exists: true } } },
        { $count: "total" },
      ]).toArray().catch(() => []),
    ]);

    const summary = coinAgg[0] || { grantedTotal: 0, usedTotal: 0, balanceTotal: 0, clientCount: 0 };

    res.json({
      summary: {
        clientsWithPackage: summary.clientCount,
        coinsGranted:       summary.grantedTotal,
        coinsUsed:          summary.usedTotal,
        coinsBalance:       summary.balanceTotal,
        utilizationPct:     summary.grantedTotal > 0 ? (summary.usedTotal / summary.grantedTotal) * 100 : 0,
      },
      regenerations: {
        ads:     adsRegens[0]?.total      || 0,
        organic: organicRegens[0]?.total  || 0,
        lp:      lpRegens[0]?.total       || 0,
      },
      topClients: topClientsHydrated,
      byManager,
    });
  } catch (err) {
    console.error("[admin] getAdminAiUsage:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/reviews-analytics ───────────────────────────
   Spec sec 2.8. Approval cycle analytics across all managers + product
   types. Pulls from wow_ads_sessions / wow_organic_ads_sessions /
   wow_lp_sessions + cpanel_product_reviews. */
exports.getAdminReviewsAnalytics = async (req, res) => {
  try {
    const db = getDB();

    /* Map phone → agentId for the per-manager rollup. */
    const clientMap = await db.collection("cpanel_clients")
      .find({}, { projection: { phone: 1, agentId: 1 } })
      .toArray();
    const phoneToAgent = new Map(clientMap.map(c => [c.phone, c.agentId || null]));

    /* Hydrate manager names. */
    const agentIds = [...new Set(clientMap.map(c => c.agentId).filter(Boolean))];
    /* Agents may have UUID or ObjectId _id — agentIdsInQuery handles both. */
    const agentDocs = agentIds.length
      ? await db.collection("agents").find(agentIdsInQuery(agentIds), { projection: { name: 1, nickname: 1 } }).toArray()
      : [];
    const nameByAgentId = new Map(agentDocs.map(a => [String(a._id), a.nickname || a.name || "—"]));

    /* Pull all sessions that were sent for approval (sent / approved / rejected). */
    const SENT = ["sent", "approved", "rejected"];
    const [adsSessions, organicSessions, lpSessions] = await Promise.all([
      db.collection("wow_ads_sessions").find(
        { clientApprovalStatus: { $in: SENT } },
        { projection: { phone: 1, clientApprovalStatus: 1, sentForApprovalAt: 1, clientApprovedAt: 1, clientResponseAt: 1, generatedAds: 1 } },
      ).toArray(),
      db.collection("wow_organic_ads_sessions").find(
        { clientApprovalStatus: { $in: SENT } },
        { projection: { phone: 1, clientApprovalStatus: 1, sentForApprovalAt: 1, clientApprovedAt: 1, clientResponseAt: 1, generatedPosts: 1 } },
      ).toArray(),
      db.collection("wow_lp_sessions").find(
        { $or: [{ approvalStatus: { $in: SENT } }, { clientApprovalStatus: { $in: SENT } }] },
        { projection: { phone: 1, approvalStatus: 1, clientApprovalStatus: 1, sentForApprovalAt: 1, clientResponseAt: 1, clientApprovedAt: 1 } },
      ).toArray(),
    ]);

    /* Helper: compute response time in hours. */
    function responseHours(sentAt, respondedAt) {
      if (!sentAt || !respondedAt) return null;
      const ms = new Date(respondedAt).getTime() - new Date(sentAt).getTime();
      if (ms <= 0) return null;
      return ms / 3_600_000;
    }

    /* Helper: count items per status using clientApproved booleans. */
    function tallyItems(items) {
      let approved = 0, rejected = 0, pending = 0;
      for (const i of items || []) {
        if (i.clientApproved === true)  approved++;
        else if (i.clientApproved === false) rejected++;
        else pending++;
      }
      return { approved, rejected, pending };
    }

    /* Per-product-type rollup: session-level (was the whole batch approved?) */
    function rollupByType(sessions, statusField, itemsField) {
      let sent = 0, approved = 0, rejected = 0, totalRespHours = 0, respondedCount = 0;
      let itemsApproved = 0, itemsRejected = 0;
      for (const s of sessions) {
        sent++;
        const status = s[statusField] || "sent";
        if (status === "approved") approved++;
        else if (status === "rejected") rejected++;
        const r = responseHours(s.sentForApprovalAt, s.clientResponseAt || s.clientApprovedAt);
        if (r !== null) { totalRespHours += r; respondedCount++; }
        if (itemsField) {
          const t = tallyItems(s[itemsField]);
          itemsApproved += t.approved;
          itemsRejected += t.rejected;
        }
      }
      const responded = approved + rejected;
      return {
        sent,
        approved,
        rejected,
        pending:           sent - responded,
        approvalRate:      responded > 0 ? (approved / responded) * 100 : 0,
        avgResponseHours:  respondedCount > 0 ? totalRespHours / respondedCount : null,
        itemsApproved,
        itemsRejected,
      };
    }

    const byType = {
      ads:     rollupByType(adsSessions,     "clientApprovalStatus", "generatedAds"),
      organic: rollupByType(organicSessions, "clientApprovalStatus", "generatedPosts"),
      lp:      rollupByType(lpSessions,      "approvalStatus",       null),
    };

    /* Per-manager rollup. Walk every session, attribute to the assigned
       agent, then aggregate counts + response times. */
    const byManagerMap = new Map();
    function attribute(sessions, statusField) {
      for (const s of sessions) {
        const agentId = phoneToAgent.get(s.phone);
        if (!agentId) continue;
        const key = String(agentId);
        if (!byManagerMap.has(key)) {
          byManagerMap.set(key, {
            agentId,
            managerName: nameByAgentId.get(key) || "—",
            sent: 0, approved: 0, rejected: 0,
            totalRespHours: 0, respondedCount: 0,
          });
        }
        const slot = byManagerMap.get(key);
        slot.sent++;
        const status = s[statusField] || "sent";
        if (status === "approved") slot.approved++;
        else if (status === "rejected") slot.rejected++;
        const r = responseHours(s.sentForApprovalAt, s.clientResponseAt || s.clientApprovedAt);
        if (r !== null) { slot.totalRespHours += r; slot.respondedCount++; }
      }
    }
    attribute(adsSessions,     "clientApprovalStatus");
    attribute(organicSessions, "clientApprovalStatus");
    attribute(lpSessions,      "approvalStatus");

    const byManager = [...byManagerMap.values()].map(m => {
      const responded = m.approved + m.rejected;
      return {
        agentId:          m.agentId,
        managerName:      m.managerName,
        sent:             m.sent,
        approved:         m.approved,
        rejected:         m.rejected,
        pending:          m.sent - responded,
        approvalRate:     responded > 0 ? (m.approved / responded) * 100 : 0,
        avgResponseHours: m.respondedCount > 0 ? m.totalRespHours / m.respondedCount : null,
      };
    }).sort((a, b) => b.sent - a.sent);

    /* Recent rejections — last 20, useful for "what's failing?" */
    const phoneToName = new Map(clientMap.map(c => [c.phone, c.customerName || c.phone]));
    const allRejected = [
      ...adsSessions.filter(s => s.clientApprovalStatus === "rejected").map(s => ({ ...s, kind: "ads" })),
      ...organicSessions.filter(s => s.clientApprovalStatus === "rejected").map(s => ({ ...s, kind: "organic" })),
      ...lpSessions.filter(s => (s.approvalStatus || s.clientApprovalStatus) === "rejected").map(s => ({ ...s, kind: "lp" })),
    ]
      .sort((a, b) => new Date(b.clientResponseAt || b.clientApprovedAt || 0).getTime() - new Date(a.clientResponseAt || a.clientApprovedAt || 0).getTime())
      .slice(0, 20)
      .map(s => {
        const agentId = phoneToAgent.get(s.phone);
        return {
          phone:        s.phone,
          clientName:   phoneToName.get(s.phone) || s.phone,
          managerName:  agentId ? (nameByAgentId.get(String(agentId)) || "—") : "—",
          kind:         s.kind,
          rejectedAt:   s.clientResponseAt || s.clientApprovedAt || null,
          responseHours: responseHours(s.sentForApprovalAt, s.clientResponseAt || s.clientApprovedAt),
        };
      });

    /* Headline KPIs. */
    const totalSent     = byType.ads.sent     + byType.organic.sent     + byType.lp.sent;
    const totalApproved = byType.ads.approved + byType.organic.approved + byType.lp.approved;
    const totalRejected = byType.ads.rejected + byType.organic.rejected + byType.lp.rejected;
    const responded     = totalApproved + totalRejected;

    res.json({
      summary: {
        totalSent,
        totalApproved,
        totalRejected,
        totalPending:    totalSent - responded,
        approvalRatePct: responded > 0 ? (totalApproved / responded) * 100 : 0,
      },
      byType,
      byManager,
      recentRejections: allRejected,
    });
  } catch (err) {
    console.error("[admin] getAdminReviewsAnalytics:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/pipeline-global ─────────────────────────────
   Spec sec 2.9. Every pipeline card across every manager, plus
   per-manager conversion funnel + stage velocity. */
exports.getAdminPipelineGlobal = async (req, res) => {
  try {
    const db = getDB();
    const STAGES = ["new", "qualified", "proposal", "won", "lost"];

    /* Pull every pipeline doc + every cpanel_clients (we only show
       cards that have a stage row). */
    const [stageDocs, clientDocs] = await Promise.all([
      db.collection("cpanel_pipeline").find({}).toArray(),
      db.collection("cpanel_clients").find(
        {}, { projection: { phone: 1, agentId: 1, customerName: 1 } },
      ).toArray(),
    ]);

    const clientByPhone = new Map(clientDocs.map(c => [c.phone, c]));

    /* Hydrate manager + customer names. */
    const phones = stageDocs.map(s => s.phone).filter(Boolean);
    const agentIds = [...new Set(stageDocs.map(s => s.agentId).filter(Boolean))];
    /* Agents may have UUID or ObjectId _id — agentIdsInQuery handles both. */

    const [chatDocs, agentDocs] = await Promise.all([
      phones.length ? db.collection("support_chats").find(
        { phone: { $in: phones } },
        { projection: { phone: 1, name: 1, fireberyName: 1, fireberyLogoUrl: 1 } },
      ).toArray() : [],
      agentIds.length ? db.collection("agents").find(
        agentIdsInQuery(agentIds),
        { projection: { name: 1, nickname: 1 } },
      ).toArray() : [],
    ]);
    const chatByPhone   = new Map(chatDocs.map(c => [c.phone, c]));
    const nameByAgentId = new Map(agentDocs.map(a => [String(a._id), a.nickname || a.name || "—"]));

    /* Build cards. */
    const cards = stageDocs.map(s => {
      const client = clientByPhone.get(s.phone);
      const chat   = chatByPhone.get(s.phone);
      return {
        phone:       s.phone,
        clientName:  chat?.fireberyName || chat?.name || client?.customerName || s.phone,
        logoUrl:     chat?.fireberyLogoUrl || null,
        stage:       s.stage,
        agentId:     s.agentId,
        managerName: s.agentId ? (nameByAgentId.get(String(s.agentId)) || "—") : "—",
        value:       s.value || 0,
        notes:       s.notes || null,
        movedAt:     s.movedAt   || null,
        updatedAt:   s.updatedAt || null,
      };
    });

    /* Group by stage for kanban. */
    const byStage = Object.fromEntries(STAGES.map(s => [s, []]));
    for (const c of cards) {
      if (byStage[c.stage]) byStage[c.stage].push(c);
    }

    /* Per-manager funnel: count cards at each stage. */
    const byManagerMap = new Map();
    for (const c of cards) {
      if (!c.agentId) continue;
      const key = String(c.agentId);
      if (!byManagerMap.has(key)) {
        byManagerMap.set(key, {
          agentId:     c.agentId,
          managerName: c.managerName,
          counts: Object.fromEntries(STAGES.map(s => [s, 0])),
          totalValue: 0,
        });
      }
      const slot = byManagerMap.get(key);
      slot.counts[c.stage] = (slot.counts[c.stage] || 0) + 1;
      slot.totalValue += c.value || 0;
    }
    const byManager = [...byManagerMap.values()].map(m => {
      const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
      const won   = m.counts.won  || 0;
      const lost  = m.counts.lost || 0;
      const closed = won + lost;
      return {
        ...m,
        total,
        winRate: closed > 0 ? (won / closed) * 100 : 0,
      };
    }).sort((a, b) => b.totalValue - a.totalValue);

    /* Stage velocity: avg time spent in each stage based on movedAt deltas
       within the same client's history. We don't store stage history, so
       this approximates by current-stage age (now - movedAt). */
    const now = Date.now();
    const stageAgeBuckets = Object.fromEntries(STAGES.map(s => [s, []]));
    for (const c of cards) {
      if (!c.movedAt) continue;
      const ageHours = (now - new Date(c.movedAt).getTime()) / 3_600_000;
      if (ageHours < 0) continue;
      stageAgeBuckets[c.stage].push(ageHours);
    }
    const velocity = STAGES.map(s => {
      const ages = stageAgeBuckets[s];
      const avgHours = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : null;
      return { stage: s, count: ages.length, avgHours };
    });

    /* Headline KPIs. */
    const totalCards = cards.length;
    const totalWon   = cards.filter(c => c.stage === "won").length;
    const totalLost  = cards.filter(c => c.stage === "lost").length;
    const totalOpen  = cards.filter(c => !["won", "lost"].includes(c.stage)).length;
    const totalValue = cards.reduce((s, c) => s + (c.value || 0), 0);
    const wonValue   = cards.filter(c => c.stage === "won").reduce((s, c) => s + (c.value || 0), 0);

    res.json({
      summary: {
        totalCards, totalOpen, totalWon, totalLost,
        totalValue, wonValue,
        overallWinRate: (totalWon + totalLost) > 0 ? (totalWon / (totalWon + totalLost)) * 100 : 0,
      },
      byStage,
      byManager,
      velocity,
    });
  } catch (err) {
    console.error("[admin] getAdminPipelineGlobal:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/chats ────────────────────────────────────────
   Spec sec 2.10. Every support conversation across the system. Returns
   one summary row per phone with last-message preview, total count,
   unread (no managerSeenAt), and the assigned manager. */
exports.getAdminChats = async (req, res) => {
  try {
    const db = getDB();
    const { search, manager, unreadOnly } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    /* Pull every cpanel_clients row first — that's the canonical client
       list. Some support_chats rows may not have a corresponding agent
       assignment (legacy / unassigned). */
    const clientFilter = {};
    if (manager) clientFilter.agentId = String(manager);
    const clients = await db.collection("cpanel_clients").find(clientFilter).toArray();

    if (clients.length === 0) {
      return res.json({ chats: [], total: 0 });
    }

    const phones = clients.map(c => c.phone);
    const agentIds = [...new Set(clients.map(c => c.agentId).filter(Boolean))];
    /* Agents may have UUID or ObjectId _id — agentIdsInQuery handles both. */

    const [chatDocs, agentDocs] = await Promise.all([
      db.collection("support_chats").find(
        { phone: { $in: phones } },
        { projection: { messages: 0 } },  /* don't pull full thread, summary only */
      ).toArray(),
      agentIds.length ? db.collection("agents").find(
        agentIdsInQuery(agentIds), { projection: { name: 1, nickname: 1 } },
      ).toArray() : [],
    ]);

    /* Pull last-message preview separately — efficient query. */
    const previewDocs = await db.collection("support_chats").aggregate([
      { $match: { phone: { $in: phones } } },
      { $project: {
          phone: 1,
          lastMessage:    { $arrayElemAt: ["$messages", -1] },
          messageCount:   { $size: { $ifNull: ["$messages", []] } },
      }},
    ]).toArray().catch(() => []);

    const chatByPhone     = new Map(chatDocs.map(c => [c.phone, c]));
    const previewByPhone  = new Map(previewDocs.map(p => [p.phone, p]));
    const nameByAgentId   = new Map(agentDocs.map(a => [String(a._id), a.nickname || a.name || "—"]));
    const clientByPhone   = new Map(clients.map(c => [c.phone, c]));

    let rows = clients.map(c => {
      const chat    = chatByPhone.get(c.phone);
      const preview = previewByPhone.get(c.phone);
      const last    = preview?.lastMessage || null;
      const lastFromClient = last && (last.fromRole === "user" || last.fromRole === "client");
      const lastSeenAt = chat?.managerSeenAt || null;
      const lastMsgAt  = last ? (last.createdAt || last.timestamp || null) : (chat?.updated_at || null);
      const isUnread   = !!lastFromClient && !lastSeenAt;

      return {
        phone:       c.phone,
        clientName:  chat?.fireberyName || chat?.name || c.customerName || c.phone,
        logoUrl:     chat?.fireberyLogoUrl || null,
        agentId:     c.agentId || null,
        managerName: c.agentId ? (nameByAgentId.get(String(c.agentId)) || "—") : "—",
        messageCount: preview?.messageCount || 0,
        lastMessage:  last ? {
          text:      typeof last.text === "string" ? last.text.slice(0, 200) : (last.type === "image" ? "🖼️ תמונה" : "—"),
          fromRole:  last.fromRole || null,
          createdAt: last.createdAt || last.timestamp || null,
        } : null,
        lastMsgAt,
        isUnread,
      };
    });

    if (search) {
      const q = String(search).toLowerCase();
      rows = rows.filter(r =>
        r.clientName.toLowerCase().includes(q) ||
        r.phone.toLowerCase().includes(q) ||
        r.managerName.toLowerCase().includes(q) ||
        (r.lastMessage?.text || "").toLowerCase().includes(q)
      );
    }

    if (unreadOnly === "true" || unreadOnly === "1") {
      rows = rows.filter(r => r.isUnread);
    }

    /* Sort by last message time desc. */
    rows.sort((a, b) => {
      const aT = a.lastMsgAt ? new Date(a.lastMsgAt).getTime() : 0;
      const bT = b.lastMsgAt ? new Date(b.lastMsgAt).getTime() : 0;
      return bT - aT;
    });

    /* Suppress unused warning on clientByPhone */
    void clientByPhone;

    res.json({
      chats: rows.slice(0, limit),
      total: rows.length,
      unreadCount: rows.filter(r => r.isUnread).length,
    });
  } catch (err) {
    console.error("[admin] getAdminChats:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/integrations ────────────────────────────────
   Spec sec 2.12. Live health snapshot of every external dependency.
   Most checks are read-only against the DB (no upstream traffic) so this
   endpoint is safe to poll. Live API pings are deliberately avoided to
   keep latency + cost predictable. */
exports.getAdminIntegrations = async (req, res) => {
  try {
    const db = getDB();
    const now = new Date();
    const ago1d = new Date(Date.now() - 24 * 3_600_000);
    const ago7d = new Date(Date.now() - 7 * 24 * 3_600_000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    /* Run all probes in parallel. Each returns { name, status, detail, meta }. */
    const [
      cardcomLast,
      greenState,
      notifyCounts,
      fbHealthyClients,
      backblazeUploads,
      mongoStats,
    ] = await Promise.all([
      /* Cardcom — last completed pending purchase = last webhook hit. */
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $exists: true } } },
        { $sort: { completedAt: -1 } },
        { $limit: 1 },
      ]).toArray().catch(() => []),

      /* WhatsApp — ask Green API for the live instance state, so a phone that
         was never linked (or went offline) shows up here instead of at send time. */
      (async () => {
        const greenApi = require("../services/greenapi.service");
        if (!greenApi.isConfigured()) return null;
        try {
          const [state, settings] = await Promise.all([
            greenApi.getAccountState(),
            greenApi.getSettings().catch(() => null),
          ]);
          return { state: state?.stateInstance || null, wid: settings?.wid || null };
        } catch (err) {
          return { error: err.message };
        }
      })(),

      /* Automatic client messages (client_notifications) — last 24h by status. */
      db.collection("client_notifications").aggregate([
        { $match: { createdAt: { $gte: ago1d } } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]).toArray().catch(() => []),

      /* Facebook — count of users with non-empty fb token. */
      db.collection("users").countDocuments({
        $or: [
          { fbToken:        { $exists: true, $ne: null, $ne: "" } },
          { facebookToken:  { $exists: true, $ne: null, $ne: "" } },
        ],
      }).catch(() => 0),

      /* Backblaze — count of files uploaded this month, looking at any
         imageUrl write activity within sessions. */
      db.collection("wow_ads_sessions").aggregate([
        { $match: { updatedAt: { $gte: startOfMonth } } },
        { $count: "total" },
      ]).toArray().catch(() => []),

      db.stats().catch(() => null),
    ]);

    function check(name, ok, detail, meta = {}) {
      return {
        name,
        status: ok === true ? "ok" : ok === false ? "error" : "warn",
        detail,
        meta,
        lastCheck: new Date().toISOString(),
      };
    }

    const integrations = [
      /* Cardcom */
      (() => {
        const last = cardcomLast[0];
        const hasEnv = !!(process.env.CARDCOM_TERMINAL_NUMBER && process.env.CARDCOM_API_NAME);
        if (!hasEnv) return check("Cardcom", false, "ENV חסר (CARDCOM_TERMINAL_NUMBER / CARDCOM_API_NAME)");
        if (!last)   return check("Cardcom", "warn", "אין תשלום שהתקבל אי פעם דרך ה-webhook", { hasEnv });
        const ageHours = (Date.now() - new Date(last.completedAt).getTime()) / 3_600_000;
        const ok = ageHours < 24 * 7;
        return check("Cardcom", ok, `תשלום אחרון לפני ${ageHours < 24 ? `${ageHours.toFixed(1)} שעות` : `${(ageHours / 24).toFixed(1)} ימים`}`, {
          lastAt: last.completedAt,
          totalAmount: last.totalAmount,
        });
      })(),

      /* Facebook Ads */
      (() => {
        if (fbHealthyClients === 0) {
          return check("Facebook Ads", "warn", "אין לקוחות עם FB token שמור");
        }
        return check("Facebook Ads", true, `${fbHealthyClients} לקוחות עם טוקן פעיל`, {
          tokenCount: fbHealthyClients,
        });
      })(),

      /* WhatsApp (GreenAPI) — live instance state */
      (() => {
        const NAME = "WhatsApp · GreenAPI";
        if (!(process.env.GREEN_API_INSTANCE_ID && process.env.GREEN_API_TOKEN)) {
          return check(NAME, false, "GREEN_API ENV חסר");
        }
        if (!greenState)       return check(NAME, "warn", "לא הצלחנו לבדוק את מצב החיבור");
        if (greenState.error)  return check(NAME, false, `שגיאה בבדיקת החיבור: ${greenState.error}`);
        if (greenState.state === "authorized") {
          const num = String(greenState.wid || "").replace(/@c\.us$/, "");
          return check(NAME, true, num ? `מחובר למספר ${num}` : "מחובר ומוכן לשליחה", greenState);
        }
        const hint = {
          notAuthorized: "האינסטנס לא מקושר לוואטסאפ — יש לסרוק QR בקונסולה של Green API",
          blocked:       "האינסטנס חסום ב-Green API",
          sleepMode:     "הטלפון המקושר לא מחובר לאינטרנט",
          starting:      "האינסטנס עולה — בדוק שוב בעוד רגע",
        }[greenState.state] || `מצב האינסטנס: ${greenState.state || "לא ידוע"}`;
        return check(NAME, false, hint, greenState);
      })(),

      /* Automatic client messages — welcome / איפיון הושלם / התוצרים מוכנים */
      (() => {
        const NAME = "הודעות אוטומטיות ללקוחות";
        const by = Object.fromEntries(notifyCounts.map(r => [r._id, r.n]));
        const sent = by.sent || 0, skipped = by.skipped || 0;
        const stuck = (by.failed || 0) + (by.dead || 0) + (by.expired || 0);
        const parts = [`${sent} נשלחו`];
        if (skipped) parts.push(`${skipped} דולגו (אין חיבור WhatsApp)`);
        if (stuck)   parts.push(`${stuck} נכשלו`);
        if (stuck)   return check(NAME, "warn", `ב-24 שעות: ${parts.join(" · ")}`, by);
        if (skipped) return check(NAME, "warn", `ב-24 שעות: ${parts.join(" · ")}`, by);
        return check(NAME, true, sent ? `ב-24 שעות: ${parts.join(" · ")}` : "אין הודעות ב-24 השעות האחרונות", by);
      })(),

      /* SMS (sms4free) */
      (() => {
        const hasEnv = !!(process.env.SMS4FREE_KEY && process.env.SMS4FREE_USER);
        return check("SMS · sms4free", hasEnv, hasEnv ? "ENV מוגדר — קרדיטים נבדקים בשליחה" : "SMS4FREE ENV חסר");
      })(),

      /* Backblaze B2 */
      (() => {
        const hasEnv = !!(process.env.B2_APPLICATION_KEY_ID && process.env.B2_APPLICATION_KEY);
        const uploadsThisMonth = backblazeUploads[0]?.total || 0;
        if (!hasEnv) return check("Backblaze B2", false, "B2 ENV חסר");
        return check("Backblaze B2", true, `${uploadsThisMonth} sessions עם פעילות החודש`, {
          uploadsThisMonth,
        });
      })(),

      /* OpenAI */
      (() => {
        const hasEnv = !!process.env.OPENAI_API_KEY;
        return check("OpenAI", hasEnv, hasEnv ? "API key מוגדר" : "OPENAI_API_KEY חסר");
      })(),

      /* Gemini / Google AI */
      (() => {
        const hasEnv = !!process.env.GOOGLE_AI_API_KEY;
        return check("Google Gemini", hasEnv, hasEnv ? "API key מוגדר" : "GOOGLE_AI_API_KEY חסר");
      })(),

      /* MongoDB */
      (() => {
        if (!mongoStats) return check("MongoDB", false, "אין גישה ל-stats");
        const collections = mongoStats.collections || 0;
        const dataSizeMB = ((mongoStats.dataSize || 0) / 1024 / 1024).toFixed(1);
        return check("MongoDB", true, `${collections} קולקציות · ${dataSizeMB} MB נתונים`, {
          collections,
          dataSizeMB: Number(dataSizeMB),
          objects: mongoStats.objects || 0,
        });
      })(),

      /* Server itself */
      (() => {
        const upMs = process.uptime() * 1000;
        const upHours = upMs / 3_600_000;
        return check("Server (Node.js)", true, `Uptime: ${upHours < 24 ? `${upHours.toFixed(1)} שעות` : `${(upHours / 24).toFixed(1)} ימים`}`, {
          uptimeMs: upMs,
          nodeVersion: process.version,
        });
      })(),
    ];

    const summary = {
      total:  integrations.length,
      ok:     integrations.filter(i => i.status === "ok").length,
      warn:   integrations.filter(i => i.status === "warn").length,
      error:  integrations.filter(i => i.status === "error").length,
    };

    /* Mark unused vars defensive */
    void ago1d; void ago7d;

    res.json({ integrations, summary, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[admin] getAdminIntegrations:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── Admin Broadcasts (spec sec 2.14) ──────────────────────────────────
   Compose system-wide messages targeted by segment instead of a
   per-manager phone list. Reuses the existing greenapi + sms4free
   services. Send is synchronous and capped at 500 phones per call. */

const ADMIN_BROADCAST_COL = "admin_broadcasts";
const adminBroadcastCol = () => getDB().collection(ADMIN_BROADCAST_COL);

/* GET — recent broadcasts with summary stats. */
exports.listAdminBroadcasts = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await adminBroadcastCol()
      .find({})
      .sort({ sentAt: -1 })
      .limit(limit)
      .toArray();
    res.json({
      broadcasts: rows.map(r => ({
        id:           String(r._id),
        message:      r.message,
        channel:      r.channel,
        segment:      r.segment,
        targetCount:  r.targetCount || 0,
        sentCount:    r.sentCount   || 0,
        failCount:    r.failCount   || 0,
        sentBy:       r.sentBy      || null,
        sentAt:       r.sentAt,
      })),
      total: rows.length,
    });
  } catch (err) {
    console.error("[admin] listAdminBroadcasts:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* Resolve a segment → list of phone numbers.
   segment shape:
     { kind: "all" }
     { kind: "manager",         agentId: "..." }
     { kind: "package",         packageId: "platinum" }
     { kind: "tier",            tier: "VIP" }
     { kind: "phones",          phones: ["...", "..."] }
*/
async function resolvePhonesForSegment(segment) {
  const db = getDB();
  if (!segment || typeof segment !== "object") return [];

  switch (segment.kind) {
    case "all": {
      const rows = await db.collection("cpanel_clients").find({}, { projection: { phone: 1 } }).toArray();
      return rows.map(r => r.phone).filter(Boolean);
    }
    case "manager": {
      if (!segment.agentId) return [];
      const rows = await db.collection("cpanel_clients").find(
        { agentId: String(segment.agentId) }, { projection: { phone: 1 } },
      ).toArray();
      return rows.map(r => r.phone).filter(Boolean);
    }
    case "package": {
      if (!segment.packageId) return [];
      const rows = await db.collection("users").find(
        { "activePackage.id": String(segment.packageId) },
        { projection: { phone: 1 } },
      ).toArray();
      return rows.map(r => r.phone).filter(Boolean);
    }
    case "tier": {
      if (!segment.tier) return [];
      const rows = await db.collection("cpanel_clients").find(
        { tier: String(segment.tier) }, { projection: { phone: 1 } },
      ).toArray();
      return rows.map(r => r.phone).filter(Boolean);
    }
    case "phones":
      return Array.isArray(segment.phones)
        ? segment.phones.map(p => String(p).trim()).filter(Boolean)
        : [];
    default:
      return [];
  }
}

/* POST — send a broadcast to a segment. */
exports.sendAdminBroadcast = async (req, res) => {
  try {
    const { message, channel = "sms", segment, dryRun = false } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: "message required" });
    if (!segment)         return res.status(400).json({ error: "segment required" });
    if (!["sms", "whatsapp"].includes(channel)) {
      return res.status(400).json({ error: "channel must be sms or whatsapp" });
    }

    const allPhones = await resolvePhonesForSegment(segment);
    const phones    = [...new Set(allPhones)].slice(0, 500);   /* hard cap */

    if (phones.length === 0) {
      return res.status(400).json({ error: "segment matched zero recipients" });
    }

    if (dryRun) {
      return res.json({ targetCount: phones.length, phones: phones.slice(0, 20), dryRun: true });
    }

    /* Send. Pace a little to avoid rate limits. */
    const results = [];
    for (const phone of phones) {
      try {
        if (channel === "whatsapp") {
          const greenApi = require("../services/greenapi.service");
          await greenApi.sendMessage(phone, message);
        } else {
          const { sendSMS } = require("../services/sms4free.service");
          await sendSMS(phone, message);
        }
        results.push({ phone, ok: true });
      } catch (e) {
        results.push({ phone, ok: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const sentCount = results.filter(r => r.ok).length;
    const failCount = results.filter(r => !r.ok).length;
    const actor     = auditSvc.actorFromReq(req);

    const doc = {
      message:     message.trim(),
      channel,
      segment,
      targetCount: phones.length,
      sentCount,
      failCount,
      sentBy:      actor.name,
      sentByAgentId: actor.id,
      sentAt:      new Date(),
      results,
    };
    const inserted = await adminBroadcastCol().insertOne(doc);

    auditSvc.record({
      actor,
      action: "broadcast.send",
      target: { kind: "broadcast", id: String(inserted.insertedId), label: `${channel} → ${phones.length}` },
      after:  { message: doc.message, channel, segment, targetCount: phones.length, sentCount, failCount },
    });

    res.json({
      success:     true,
      id:          String(inserted.insertedId),
      targetCount: phones.length,
      sentCount,
      failCount,
    });
  } catch (err) {
    console.error("[admin] sendAdminBroadcast:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── Reports & Exports (spec sec 2.16) ─────────────────────────────────
   Stream CSV with BOM so Excel renders Hebrew correctly. */

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sendCsv(res, filename, header, rows) {
  const lines = [header.join(","), ...rows.map(r => r.map(csvEscape).join(","))];
  /* UTF-8 BOM so Excel renders Hebrew correctly. */
  const body = `﻿${lines.join("\n")}`;
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(body);
}

/* GET /admin/reports/monthly-pnl?year=2026 */
exports.reportMonthlyPnl = async (req, res) => {
  try {
    const db = getDB();
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const start = new Date(year, 0, 1);
    const end   = new Date(year + 1, 0, 1);

    const [revenueByMonth, commissionsByMonth] = await Promise.all([
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: start, $lt: end } } },
        { $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$completedAt" } },
            revenue: { $sum: "$totalAmount" },
            deals:   { $sum: 1 },
        }},
      ]).toArray(),
      db.collection("cpanel_commissions").aggregate([
        { $match: { earnedAt: { $gte: start, $lt: end } } },
        { $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$earnedAt" } },
            commissions: { $sum: "$commissionAmount" },
        }},
      ]).toArray().catch(() => []),
    ]);

    const revBy = new Map(revenueByMonth.map(r => [r._id, r]));
    const comBy = new Map(commissionsByMonth.map(c => [c._id, c]));

    const rows = [];
    for (let m = 0; m < 12; m++) {
      const key = `${year}-${String(m + 1).padStart(2, "0")}`;
      const r = revBy.get(key) || { revenue: 0, deals: 0 };
      const c = comBy.get(key) || { commissions: 0 };
      const gross = r.revenue;
      const net   = gross - c.commissions;
      rows.push([
        key,
        r.deals,
        gross.toFixed(2),
        c.commissions.toFixed(2),
        net.toFixed(2),
      ]);
    }

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "report.export",
      target: { kind: "report", id: "monthly-pnl", label: `monthly-pnl-${year}` },
      meta:   { year, rowCount: rows.length },
    });

    sendCsv(res,
      `pnl-${year}.csv`,
      ["חודש", "עסקאות", "הכנסה", "עמלות מנהלים", "רווח לפני הוצאות"],
      rows,
    );
  } catch (err) {
    console.error("[admin] reportMonthlyPnl:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /admin/reports/manager-performance?from=&to= */
exports.reportManagerPerformance = async (req, res) => {
  try {
    const db = getDB();
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), 0, 1);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    const agents = await db.collection("agents").find(
      {}, { projection: { name: 1, nickname: 1, role: 1, active: 1, lastActiveAt: 1 } },
    ).toArray();

    const [salesByAgent, commByAgent, clientsByAgent] = await Promise.all([
      db.collection("cpanel_pending_purchases").aggregate([
        { $match: { completedAt: { $gte: from, $lt: to }, agentId: { $exists: true } } },
        { $group: { _id: "$agentId", revenue: { $sum: "$totalAmount" }, deals: { $sum: 1 } } },
      ]).toArray(),
      db.collection("cpanel_commissions").aggregate([
        { $match: { earnedAt: { $gte: from, $lt: to }, agentId: { $exists: true } } },
        { $group: { _id: "$agentId", earned: { $sum: "$commissionAmount" } } },
      ]).toArray().catch(() => []),
      db.collection("cpanel_clients").aggregate([
        { $group: { _id: "$agentId", clients: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const salesBy   = new Map(salesByAgent.map(s => [String(s._id), s]));
    const commBy    = new Map(commByAgent.map(c => [String(c._id), c]));
    const clientsBy = new Map(clientsByAgent.map(c => [String(c._id), c]));

    const rows = agents.map(a => {
      const id = String(a._id);
      const s = salesBy.get(id)   || { revenue: 0, deals: 0 };
      const c = commBy.get(id)    || { earned: 0 };
      const k = clientsBy.get(id) || { clients: 0 };
      return [
        a.nickname || a.name || "—",
        a.role || "account_manager",
        a.active === false ? "מנוטרל" : "פעיל",
        k.clients,
        s.deals,
        s.revenue.toFixed(2),
        c.earned.toFixed(2),
        a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleDateString("he-IL") : "—",
      ];
    });

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "report.export",
      target: { kind: "report", id: "manager-performance", label: "manager-performance" },
      meta:   { from, to, rowCount: rows.length },
    });

    sendCsv(res,
      `manager-performance-${new Date().toISOString().slice(0, 10)}.csv`,
      ["מנהל", "תפקיד", "סטטוס", "לקוחות", "עסקאות", "הכנסה", "עמלות שצברו", "פעילות אחרונה"],
      rows,
    );
  } catch (err) {
    console.error("[admin] reportManagerPerformance:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /admin/reports/client-list */
exports.reportClientList = async (req, res) => {
  try {
    const db = getDB();
    const clients = await db.collection("cpanel_clients").find({}).toArray();
    const phones = clients.map(c => c.phone);
    const agentIds = [...new Set(clients.map(c => c.agentId).filter(Boolean))];
    /* Agents may have UUID or ObjectId _id — agentIdsInQuery handles both. */

    const [users, chats, agents] = await Promise.all([
      db.collection("users").find({ phone: { $in: phones } }, { projection: { phone: 1, activePackage: 1, paymentLast4: 1 } }).toArray(),
      db.collection("support_chats").find({ phone: { $in: phones } }, { projection: { phone: 1, name: 1, fireberyName: 1 } }).toArray(),
      agentIds.length ? db.collection("agents").find(agentIdsInQuery(agentIds), { projection: { name: 1, nickname: 1 } }).toArray() : [],
    ]);
    const userBy  = new Map(users.map(u => [u.phone, u]));
    const chatBy  = new Map(chats.map(c => [c.phone, c]));
    const nameBy  = new Map(agents.map(a => [String(a._id), a.nickname || a.name || "—"]));

    const rows = clients.map(c => {
      const u = userBy.get(c.phone) || {};
      const ch = chatBy.get(c.phone) || {};
      return [
        ch.fireberyName || ch.name || c.customerName || c.phone,
        c.phone,
        c.agentId ? (nameBy.get(String(c.agentId)) || "—") : "—",
        c.tier || "REGULAR",
        u.activePackage?.name || "—",
        u.activePackage?.status || "—",
        u.paymentLast4 || "—",
        c.createdAt ? new Date(c.createdAt).toLocaleDateString("he-IL") : "—",
      ];
    });

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "report.export",
      target: { kind: "report", id: "client-list", label: "client-list" },
      meta:   { rowCount: rows.length },
    });

    sendCsv(res,
      `clients-${new Date().toISOString().slice(0, 10)}.csv`,
      ["שם", "טלפון", "מנהל", "רמה", "חבילה", "סטטוס חבילה", "כרטיס", "נוצר"],
      rows,
    );
  } catch (err) {
    console.error("[admin] reportClientList:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /admin/reports/vat?from=&to=  (Israeli compliance) */
exports.reportVat = async (req, res) => {
  try {
    const db = getDB();
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    const transactions = await db.collection("cpanel_pending_purchases").find(
      { completedAt: { $gte: from, $lt: to } },
    ).sort({ completedAt: 1 }).toArray();

    const VAT_RATE = 0.17;
    const rows = transactions.map(t => {
      const total = t.totalAmount || 0;
      const beforeVat = total / (1 + VAT_RATE);
      const vat = total - beforeVat;
      return [
        t.completedAt ? new Date(t.completedAt).toLocaleDateString("he-IL") : "—",
        t.lowProfileId || "—",
        t.phone,
        t.description || "—",
        beforeVat.toFixed(2),
        vat.toFixed(2),
        total.toFixed(2),
      ];
    });

    /* Totals row */
    const totalGross = transactions.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const totalVat   = totalGross - (totalGross / (1 + VAT_RATE));
    rows.push(["", "", "", "סה״כ", (totalGross - totalVat).toFixed(2), totalVat.toFixed(2), totalGross.toFixed(2)]);

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "report.export",
      target: { kind: "report", id: "vat", label: "vat" },
      meta:   { from, to, rowCount: transactions.length, totalGross, totalVat },
    });

    sendCsv(res,
      `vat-${new Date(from).toISOString().slice(0, 10)}-to-${new Date(to).toISOString().slice(0, 10)}.csv`,
      ["תאריך", "מס׳ עסקה", "טלפון", "תיאור", "לפני מע״מ", "מע״מ (17%)", "כולל מע״מ"],
      rows,
    );
  } catch (err) {
    console.error("[admin] reportVat:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /admin/reports/activity?from=&to= */
exports.reportActivity = async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86_400_000);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    const entries = await auditSvc.list({ from, to, limit: 5000 });

    const rows = entries.map(e => [
      e.at ? new Date(e.at).toLocaleString("he-IL") : "—",
      e.actor?.name || "—",
      e.actor?.role || "—",
      e.action,
      e.target?.kind || "—",
      e.target?.label || e.target?.id || "—",
    ]);

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "report.export",
      target: { kind: "report", id: "activity", label: "activity" },
      meta:   { from, to, rowCount: rows.length },
    });

    sendCsv(res,
      `activity-${new Date(from).toISOString().slice(0, 10)}-to-${new Date(to).toISOString().slice(0, 10)}.csv`,
      ["תאריך", "מבצע", "תפקיד", "פעולה", "סוג יעד", "יעד"],
      rows,
    );
  } catch (err) {
    console.error("[admin] reportActivity:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/admin/managers/:id/transfer-clients ──────────────
   Spec sec 2.2 (action). Move all (or selected) clients from manager
   :id → toAgentId. Each transfer writes to audit_log. */
exports.transferManagerClients = async (req, res) => {
  try {
    const db = getDB();
    const fromAgentId = String(req.params.id || "").trim();
    const { toAgentId, phones } = req.body || {};

    if (!fromAgentId)        return res.status(400).json({ error: "fromAgentId (URL :id) required" });
    if (!toAgentId)          return res.status(400).json({ error: "toAgentId required in body" });
    if (fromAgentId === String(toAgentId)) {
      return res.status(400).json({ error: "source and target must be different" });
    }

    /* Validate both agents exist (UUID or ObjectId — agentIdQuery handles both). */
    const [fromAgent, toAgent] = await Promise.all([
      db.collection("agents").findOne(agentIdQuery(fromAgentId), { projection: { name: 1, nickname: 1 } }),
      db.collection("agents").findOne(agentIdQuery(toAgentId),   { projection: { name: 1, nickname: 1, active: 1 } }),
    ]);
    if (!fromAgent) return res.status(404).json({ error: "source agent not found" });
    if (!toAgent)   return res.status(404).json({ error: "target agent not found" });
    if (toAgent.active === false) {
      return res.status(400).json({ error: "target agent is disabled" });
    }

    /* Build the list of phones to move. If `phones` is missing or
       === "all" → move every client of fromAgentId. */
    const filter = { agentId: fromAgentId };
    let phoneList = [];
    if (Array.isArray(phones) && phones.length > 0) {
      phoneList = phones.map(p => String(p).trim()).filter(Boolean);
      filter.phone = { $in: phoneList };
    } else {
      const allRows = await db.collection("cpanel_clients").find(filter, { projection: { phone: 1 } }).toArray();
      phoneList = allRows.map(r => r.phone);
    }

    if (phoneList.length === 0) {
      return res.status(400).json({ error: "no clients to transfer" });
    }

    /* Snapshot before for audit. */
    const before = await db.collection("cpanel_clients").find(filter).toArray();

    const result = await db.collection("cpanel_clients").updateMany(
      filter,
      { $set: { agentId: String(toAgentId), updatedAt: new Date() } },
    );

    /* Audit per-client (so the boss can see exact movements later). */
    const fromName = fromAgent.nickname || fromAgent.name || "—";
    const toName   = toAgent.nickname   || toAgent.name   || "—";
    for (const c of before) {
      auditSvc.record({
        actor:  auditSvc.actorFromReq(req),
        action: "client.transfer",
        target: { kind: "client", id: c.phone, label: c.customerName || c.phone },
        before: { agentId: fromAgentId, agentName: fromName },
        after:  { agentId: String(toAgentId), agentName: toName },
        meta:   { source: "admin-bulk-transfer" },
      });
    }

    res.json({
      success:  true,
      moved:    result.modifiedCount,
      attempted: phoneList.length,
      from: { id: fromAgentId, name: fromName },
      to:   { id: String(toAgentId), name: toName },
    });
  } catch (err) {
    console.error("[admin] transferManagerClients:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/admin/finance/commissions/:id/pay ──────────────── */
exports.payCommission = async (req, res) => {
  try {
    const db = getDB();
    const { ObjectId } = require("mongodb");
    const id = String(req.params.id || "").trim();
    let oid;
    try { oid = new ObjectId(id); } catch { return res.status(400).json({ error: "invalid id" }); }

    const before = await db.collection("cpanel_commissions").findOne({ _id: oid });
    if (!before) return res.status(404).json({ error: "commission not found" });
    if (before.status === "paid") {
      return res.status(409).json({ error: "already paid", paidAt: before.paidAt });
    }

    const paidAt = new Date();
    await db.collection("cpanel_commissions").updateOne(
      { _id: oid },
      { $set: { status: "paid", paidAt, paidBy: auditSvc.actorFromReq(req).id } },
    );

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "commission.pay",
      target: { kind: "commission", id, label: `${before.commissionAmount} ₪` },
      before: { status: before.status, paidAt: null },
      after:  { status: "paid", paidAt: paidAt.toISOString() },
      meta:   {
        agentId:          before.agentId,
        commissionAmount: before.commissionAmount,
        clientPhone:      before.clientPhone,
      },
    });

    res.json({ success: true, id, paidAt });
  } catch (err) {
    console.error("[admin] payCommission:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/admin/finance/commissions/batch-pay ──────────────
   Body: { ids: [...], batchNote? } — mark many commissions paid in one
   atomic batch, audit-logged with a shared batchId. */
exports.batchPayCommissions = async (req, res) => {
  try {
    const db = getDB();
    const { ObjectId } = require("mongodb");
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const batchNote = (req.body?.batchNote || "").toString().trim() || null;

    if (ids.length === 0) return res.status(400).json({ error: "ids[] required" });
    if (ids.length > 1000) return res.status(400).json({ error: "max 1000 per batch" });

    const oids = ids.map(s => { try { return new ObjectId(String(s)); } catch { return null; } }).filter(Boolean);
    if (oids.length !== ids.length) {
      return res.status(400).json({ error: "one or more ids are invalid ObjectIds" });
    }

    /* Snapshot rows that aren't already paid. */
    const rows = await db.collection("cpanel_commissions").find(
      { _id: { $in: oids }, status: { $ne: "paid" } },
    ).toArray();

    if (rows.length === 0) {
      return res.status(409).json({ error: "no unpaid commissions in selection" });
    }

    const batchId = require("crypto").randomBytes(8).toString("hex");
    const paidAt  = new Date();
    const actor   = auditSvc.actorFromReq(req);

    await db.collection("cpanel_commissions").updateMany(
      { _id: { $in: rows.map(r => r._id) } },
      { $set: { status: "paid", paidAt, paidBy: actor.id, paidBatchId: batchId } },
    );

    /* Audit-record one batch summary entry + one per-item entry. */
    const totalAmount = rows.reduce((s, r) => s + (r.commissionAmount || 0), 0);
    auditSvc.record({
      actor,
      action: "commission.batch_pay",
      target: { kind: "commission_batch", id: batchId, label: `${rows.length} עמלות · ${totalAmount.toFixed(0)} ₪` },
      after:  { batchId, count: rows.length, totalAmount, paidAt: paidAt.toISOString(), note: batchNote },
    });
    for (const r of rows) {
      auditSvc.record({
        actor,
        action: "commission.pay",
        target: { kind: "commission", id: String(r._id), label: `${r.commissionAmount} ₪` },
        before: { status: r.status },
        after:  { status: "paid", paidBatchId: batchId },
        meta:   { batchId, agentId: r.agentId, clientPhone: r.clientPhone },
      });
    }

    res.json({
      success:     true,
      batchId,
      paidAt,
      count:       rows.length,
      totalAmount,
      skipped:     ids.length - rows.length,
    });
  } catch (err) {
    console.error("[admin] batchPayCommissions:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── PATCH /api/cpanel/admin/clients/:phone/force-status ──────────────
   Spec sec 2.3 (admin emergency override). Bypasses MANUAL_TRANSITIONS
   whitelist used by the manager-side PATCH /client/project-detail/:id/status.
   Audit-attached with mandatory reason. */

const PACKAGE_STATUSES_FOR_ADMIN = [
  "waiting_brief",
  "sent_to_creation",
  "waiting_manager_approval",
  "sent_to_client",
  "client_returned_corrections",
  "in_correction",
  "corrections_completed",
  "corrections_done",
  "client_approved",
  "completed",
];

exports.forceClientStatus = async (req, res) => {
  try {
    const db = getDB();
    const phone  = String(req.params.phone || "").trim();
    const status = (req.body?.status || "").toString().trim();
    const reason = (req.body?.reason || "").toString().trim();

    if (!phone)  return res.status(400).json({ error: "phone required" });
    if (!status) return res.status(400).json({ error: "status required" });
    if (!reason) return res.status(400).json({ error: "reason required for force-status" });
    if (!PACKAGE_STATUSES_FOR_ADMIN.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${PACKAGE_STATUSES_FOR_ADMIN.join(", ")}`,
      });
    }

    const user = await db.collection("users").findOne(
      { phone }, { projection: { activePackage: 1 } },
    );
    if (!user?.activePackage) {
      return res.status(404).json({ error: "no active package for this client" });
    }

    const previousStatus = user.activePackage.status || null;
    const now = new Date();

    await db.collection("users").updateOne(
      { phone },
      { $set: {
          "activePackage.status":          status,
          "activePackage.statusUpdatedAt": now.toISOString(),
          "activePackage.lastForcedAt":    now.toISOString(),
          "activePackage.lastForcedBy":    auditSvc.actorFromReq(req).id,
        }
      },
    );

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "client.force_status",
      target: { kind: "client", id: phone, label: user.activePackage.name || phone },
      before: { status: previousStatus },
      after:  { status },
      meta:   { reason, override: true },
    });

    res.json({
      success:  true,
      phone,
      previousStatus,
      newStatus: status,
      reason,
    });
  } catch (err) {
    console.error("[admin] forceClientStatus:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── DELETE /api/cpanel/admin/clients/:phone ──────────────────────────
   Hard-delete a client. Removes the user document and every user-owned
   content row (sessions, profiles, briefs, pipeline, tasks, messages).
   PRESERVES financial records (cpanel_pending_purchases, coin_transactions,
   willbox_invoices) for accounting/legal retention — Israel requires 7yr
   retention on financial records and you'd want them for refund disputes.

   The full user document is snapshotted into the audit log's `before`
   field so an admin can manually reconstruct the client if the deletion
   turns out to be a mistake.

   Body:
     reason       required — admin reason, audit-logged
     confirmName  required — admin must type the client's exact full name
                             OR phone to prevent accidental clicks

   Returns: { success, phone, deletionSummary, preserved } */

const CLIENT_DELETE_COLLECTIONS = [
  "users",
  "business_profiles",
  "cpanel_clients",
  "cpanel_pipeline",
  "cpanel_tasks",
  "wow_ads_sessions",
  "wow_lp_sessions",
  "wow_organic_ads_sessions",
  "client_briefs",
  "ad_briefs",
  "ad_sessions",
  "ad_image_jobs",
  "ad_plans",
  "support_chats",
  "message_logs",
  "chat_ratings",
  "instagram_posts",
  "wa_sessions",
  "sms_logs",
  "user_leads",
  "profiles",
  "profiles_by_page",
  "leads",
  "customers",
  "fireberry_customers",
];

const CLIENT_DELETE_PRESERVED = [
  "cpanel_pending_purchases",
  "coin_transactions",
  "willbox_invoices",
];

exports.deleteAdminClient = async (req, res) => {
  try {
    const db = getDB();
    const phone       = String(req.params.phone || "").trim();
    const reason      = String(req.body?.reason || "").trim();
    const confirmName = String(req.body?.confirmName || "").trim();

    if (!phone)       return res.status(400).json({ error: "phone required" });
    if (!reason)      return res.status(400).json({ error: "reason required" });
    if (!confirmName) return res.status(400).json({ error: "confirmName required" });

    const user = await db.collection("users").findOne({ phone });
    if (!user) return res.status(404).json({ error: "client not found" });

    const expectedName = String(user.fullName || user.name || "").trim();
    if (confirmName !== expectedName && confirmName !== phone) {
      return res.status(400).json({
        error: "confirmName mismatch — type the client's exact name or phone to confirm",
      });
    }

    /* Hard-delete from every user-owned collection. Missing collections
       and zero-row deletes are silent — we just record the count. Errors
       on a single collection don't abort the whole sweep. */
    const deletionSummary = {};
    for (const col of CLIENT_DELETE_COLLECTIONS) {
      try {
        const r = await db.collection(col).deleteMany({ phone });
        deletionSummary[col] = r.deletedCount || 0;
      } catch (err) {
        deletionSummary[col] = `error: ${err.message}`;
      }
    }

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "client.deleted",
      target: { kind: "client", id: phone, label: user.fullName || user.name || phone },
      before: user,
      after:  null,
      meta:   { reason, deletionSummary, preserved: CLIENT_DELETE_PRESERVED },
    });

    res.json({
      success:   true,
      phone,
      deletionSummary,
      preserved: CLIENT_DELETE_PRESERVED,
    });
  } catch (err) {
    console.error("[admin] deleteAdminClient:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ─── Lead distribution ───────────────────────────────────────────────
   Pulls Iconiq's incoming leads from Fireberry (objecttype 1, filtered
   by FIREBERRY_LEADS_QUERY env var) and lets the admin assign them in
   bulk to specific managers. Each assignment writes a cpanel_clients
   row with the chosen manager's agentId AND a lead_assignments record
   so the same lead never reappears in the pool. */






/* ── POST /api/cpanel/admin/refunds ────────────────────────────────────
   Spec sec 2.4. Records a refund in our books — does NOT auto-call
   Cardcom (admin must do that manually for safety). Reverses the
   manager's commission and optionally revokes the package.

   Body:
     paymentId           required — _id of cpanel_pending_purchases row
     amount              required — refund amount (≤ original)
     reason              required — typed by admin, audit-logged
     revokePackage       optional — if true, clears users.activePackage
     mode                "ledger_only" (default) | "cardcom" — only ledger_only is
                          implemented today; cardcom mode reserved for future. */
exports.createRefund = async (req, res) => {
  try {
    const db = getDB();
    const { ObjectId } = require("mongodb");
    const { paymentId, amount, reason, revokePackage = false, mode = "ledger_only" } = req.body || {};

    if (!paymentId)         return res.status(400).json({ error: "paymentId required" });
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be positive number" });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "reason required" });
    }
    if (mode !== "ledger_only") {
      return res.status(400).json({ error: "only ledger_only mode supported (Cardcom auto-refund not enabled)" });
    }

    let paymentOid;
    try { paymentOid = new ObjectId(String(paymentId)); }
    catch { return res.status(400).json({ error: "invalid paymentId" }); }

    const payment = await db.collection("cpanel_pending_purchases").findOne({ _id: paymentOid });
    if (!payment)             return res.status(404).json({ error: "payment not found" });
    if (!payment.completedAt) return res.status(400).json({ error: "payment never completed — nothing to refund" });
    if (payment.refundedAt)   return res.status(409).json({ error: "payment already refunded" });
    if (amount > (payment.totalAmount || 0)) {
      return res.status(400).json({ error: `amount exceeds original (${payment.totalAmount})` });
    }

    const actor = auditSvc.actorFromReq(req);
    const now   = new Date();

    /* 1. Insert refund record. */
    const refundDoc = {
      paymentId:    String(payment._id),
      lowProfileId: payment.lowProfileId || null,
      phone:        payment.phone,
      agentId:      payment.agentId || null,
      originalAmount: payment.totalAmount,
      refundAmount: Number(amount),
      isFullRefund: Number(amount) === Number(payment.totalAmount),
      reason:       String(reason).trim(),
      mode,
      revokedPackage: !!revokePackage,
      issuedBy:     actor.id,
      issuedByName: actor.name,
      issuedAt:     now,
    };
    const inserted = await db.collection("cpanel_refunds").insertOne(refundDoc);

    /* 2. Mark the original payment refunded (idempotent). */
    await db.collection("cpanel_pending_purchases").updateOne(
      { _id: paymentOid },
      { $set: {
          refundedAt:    now,
          refundAmount:  Number(amount),
          refundReason:  String(reason).trim(),
          refundId:      String(inserted.insertedId),
        }
      },
    );

    /* 3. Reverse manager commission(s) — find original commission(s) for
       this payment and insert a counter entry per row. */
    let reversedCount = 0;
    let reversedTotal = 0;
    const sourceChargeId = `pending:${payment.lowProfileId || payment._id}`;
    const originalComms = await db.collection("cpanel_commissions").find(
      { sourceChargeId },
    ).toArray().catch(() => []);
    const refundShareRatio = Number(amount) / Number(payment.totalAmount || 1);
    for (const c of originalComms) {
      const reversedAmount = -1 * (c.commissionAmount || 0) * refundShareRatio;
      await db.collection("cpanel_commissions").insertOne({
        agentId:          c.agentId,
        clientPhone:      c.clientPhone,
        baseAmount:       -Number(amount),
        commissionAmount: reversedAmount,
        commissionRate:   c.commissionRate,
        sourceKind:       "refund_reversal",
        sourceChargeId:   `refund:${inserted.insertedId}`,
        description:      `החזר על: ${c.description || "תשלום"} — ${reason}`,
        earnedAt:         now,
        status:           "earned",   /* shows up as a negative pending — admin pays it back via batch */
        relatedRefundId:  String(inserted.insertedId),
      });
      reversedCount++;
      reversedTotal += reversedAmount;
    }

    /* 4. Optional package revoke. */
    let packageRevoked = false;
    if (revokePackage) {
      const upd = await db.collection("users").updateOne(
        { phone: payment.phone, activePackage: { $exists: true } },
        { $unset: { activePackage: "" }, $set: { lastPackageRevokedAt: now } },
      );
      packageRevoked = upd.modifiedCount > 0;
    }

    /* 5. Audit. */
    auditSvc.record({
      actor,
      action: "refund.create",
      target: { kind: "refund", id: String(inserted.insertedId), label: `${amount} ₪ · ${payment.phone}` },
      before: { paymentRefundedAt: null, packageActive: !!revokePackage },
      after:  {
        refundAmount:    Number(amount),
        isFullRefund:    refundDoc.isFullRefund,
        revokedPackage:  packageRevoked,
        reversedCommissions: { count: reversedCount, total: reversedTotal },
      },
      meta: { reason, mode, paymentId: String(payment._id) },
    });

    res.json({
      success:   true,
      refundId:  String(inserted.insertedId),
      paymentId: String(payment._id),
      refundAmount: Number(amount),
      isFullRefund: refundDoc.isFullRefund,
      packageRevoked,
      commissionsReversed: { count: reversedCount, total: reversedTotal },
      issuedAt:  now,
    });
  } catch (err) {
    console.error("[admin] createRefund:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/refunds ──────────────────────────────────── */
exports.listRefunds = async (req, res) => {
  try {
    const db = getDB();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const rows = await db.collection("cpanel_refunds")
      .find({})
      .sort({ issuedAt: -1 })
      .limit(limit)
      .toArray();
    res.json({
      refunds: rows.map(r => ({
        id:             String(r._id),
        paymentId:      r.paymentId,
        phone:          r.phone,
        agentId:        r.agentId,
        originalAmount: r.originalAmount,
        refundAmount:   r.refundAmount,
        isFullRefund:   r.isFullRefund,
        reason:         r.reason,
        revokedPackage: r.revokedPackage,
        issuedByName:   r.issuedByName,
        issuedAt:       r.issuedAt,
      })),
      total: rows.length,
    });
  } catch (err) {
    console.error("[admin] listRefunds:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── Admin user management (Tier A #5) ────────────────────────────────
   CRUD on `agents` collection so the boss can manage roles/passwords/
   accounts without touching Atlas. Every mutation audit-logged.
   Password hash matches the existing manager login flow:
     sha256(password + "iconiq2024") */

const crypto = require("crypto");
function hashAgentPassword(password) {
  return crypto.createHash("sha256").update(password + "iconiq2024").digest("hex");
}

const VALID_AGENT_ROLES = ["admin", "supervisor", "account_manager", "finance"];

/* GET /admin/agents — all agents with safe projection. */
/**
 * Strip the direct B2 download URL — that URL needs an auth header to
 * load, which <img> tags can't send, so it renders as a broken image.
 * Old agent.avatarUrl rows still carry the direct URL from before we
 * switched to the /api/img proxy. Return null for those so the UI
 * falls back to the initials placeholder until the admin re-uploads.
 */
function safeAvatarUrl(url) {
  if (typeof url !== "string" || !url) return null;
  if (url.includes("b2api/v2/b2_download_file_by_id")) return null;
  return url;
}

exports.listAdminAgents = async (req, res) => {
  try {
    const db = getDB();
    const agents = await db.collection("agents")
      .find({}, { projection: { password: 0, token: 0 } })
      .sort({ active: -1, name: 1 })
      .toArray();
    res.json({
      agents: agents.map(a => ({
        id:           String(a._id),
        name:         a.name || null,
        nickname:     a.nickname || null,
        email:        a.email || null,
        phone:        a.phone || null,
        role:         a.role || "account_manager",
        active:       a.active !== false,
        station:      a.station || null,
        team:         a.team || null,
        avatarUrl:    safeAvatarUrl(a.avatarUrl),
        bio:          a.bio || null,
        createdAt:    a.createdAt || null,
        lastLogin:    a.lastLogin || null,
        lastActiveAt: a.lastActiveAt || null,
      })),
      total: agents.length,
    });
  } catch (err) {
    console.error("[admin] listAdminAgents:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── Manager avatar upload ────────────────────────────────────────────
   Used by the admin /admin/users page so admin can set a face for each
   manager. The URL is stored on the agent doc as avatarUrl and surfaced
   in listAdminAgents — and (in the upcoming choose-your-manager mobile
   flow) will also be exposed via a public read endpoint. */
const multer = require("multer");
const _avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    cb(ok.includes(file.mimetype) ? null : new Error(`bad mime ${file.mimetype}`), ok.includes(file.mimetype));
  },
});
exports.adminAgentAvatarUploadMw = _avatarUpload.single("avatar");

exports.uploadAdminAgentAvatar = async (req, res) => {
  try {
    const db = getDB();
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });
    if (!req.file) return res.status(400).json({ error: "no file uploaded (field name: 'avatar')" });

    const agentFilter = agentIdQuery(id);
    const agent = await db.collection("agents").findOne(agentFilter, { projection: { _id: 1, name: 1, avatarUrl: 1 } });
    if (!agent) return res.status(404).json({ error: "agent not found" });

    const ext = (() => {
      switch (req.file.mimetype) {
        case "image/png":  return "png";
        case "image/webp": return "webp";
        default:           return "jpg";
      }
    })();
    const b2Path = `agents/${String(agent._id)}/avatar-${Date.now()}.${ext}`;

    const { uploadImage } = require("../services/backblaze.service");
    const result = await uploadImage(b2Path, req.file.buffer, req.file.mimetype);

    /* Bucket is private — the direct B2 download URL (result.publicUrl)
       returns 401 to anyone without a B2 auth header (so <img> tags
       can't load it). Save the public proxy URL instead, which streams
       from B2 server-side and serves it open. Same pattern used for
       ad images, LP heroes, etc. */
    const baseUrl = process.env.BASE_URL
      || process.env.SERVER_BASE_URL
      || `${req.protocol}://${req.get("host")}`;
    const proxyUrl = `${baseUrl}/api/img?url=${encodeURIComponent(b2Path)}`;

    await db.collection("agents").updateOne(agentFilter, {
      $set: {
        avatarUrl:        proxyUrl,
        avatarB2Path:     b2Path,
        avatarUpdatedAt:  new Date(),
        updatedAt:        new Date(),
      },
    });

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "agent.avatar.upload",
      target: { kind: "agent", id, label: agent.name },
      meta:   { b2Path, size: result.size, prevAvatarUrl: agent.avatarUrl || null },
    });

    res.json({ success: true, id, avatarUrl: proxyUrl });
  } catch (err) {
    console.error("[admin] uploadAdminAgentAvatar:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* POST /admin/agents — create new agent. */
exports.createAdminAgent = async (req, res) => {
  try {
    const db = getDB();
    const { name, password, role = "account_manager", nickname, email, phone, station, team } = req.body || {};

    if (!name || !String(name).trim())   return res.status(400).json({ error: "name required" });
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: "password required (min 6 chars)" });
    }
    if (!VALID_AGENT_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_AGENT_ROLES.join(", ")}` });
    }

    const existing = await db.collection("agents").findOne({ name: String(name).trim() });
    if (existing) return res.status(409).json({ error: "username already taken" });

    const { v4: uuidv4 } = require("uuid");
    const doc = {
      _id:       uuidv4(),
      name:      String(name).trim(),
      nickname:  nickname ? String(nickname).trim() : null,
      email:     email    ? String(email).trim()    : null,
      phone:     phone    ? String(phone).trim()    : null,
      password:  hashAgentPassword(password),
      role,
      station:   station || null,
      team:      team    || null,
      active:    true,
      createdAt: new Date(),
      createdBy: auditSvc.actorFromReq(req).id,
    };
    await db.collection("agents").insertOne(doc);

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "agent.create",
      target: { kind: "agent", id: doc._id, label: doc.nickname || doc.name },
      after:  { name: doc.name, nickname: doc.nickname, role: doc.role, active: true },
    });

    res.json({
      success: true,
      agent: {
        id: doc._id, name: doc.name, nickname: doc.nickname,
        role: doc.role, active: true, createdAt: doc.createdAt,
      },
    });
  } catch (err) {
    console.error("[admin] createAdminAgent:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* PATCH /admin/agents/:id — update profile, role, password, active. */
exports.updateAdminAgent = async (req, res) => {
  try {
    const db = getDB();
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });

    /* Agent _id can be UUID or ObjectId — use the helper. */
    const agentFilter = agentIdQuery(id);
    const before = await db.collection("agents").findOne(
      agentFilter, { projection: { password: 0, token: 0 } },
    );
    if (!before) return res.status(404).json({ error: "agent not found" });

    const { name, nickname, email, phone, role, station, team, active, password, bio } = req.body || {};

    const $set = { updatedAt: new Date() };
    if (typeof name      === "string" && name.trim())      $set.name = name.trim();
    if (typeof nickname  === "string")                     $set.nickname = nickname.trim() || null;
    if (typeof email     === "string")                     $set.email = email.trim() || null;
    if (typeof phone     === "string")                     $set.phone = phone.trim() || null;
    if (typeof station   === "string")                     $set.station = station || null;
    if (typeof team      === "string")                     $set.team = team || null;
    if (typeof active    === "boolean")                    $set.active = active;
    /* Short bio shown on the upcoming "choose-your-manager" mobile screen. */
    if (typeof bio       === "string")                     $set.bio = bio.trim().slice(0, 500) || null;
    if (typeof role      === "string") {
      if (!VALID_AGENT_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_AGENT_ROLES.join(", ")}` });
      }
      $set.role = role;
    }
    if (typeof password === "string" && password.length > 0) {
      if (password.length < 6) return res.status(400).json({ error: "password must be ≥ 6 chars" });
      $set.password = hashAgentPassword(password);
    }

    await db.collection("agents").updateOne(agentFilter, { $set });

    /* Snapshot diff (excluding password). */
    const auditableBefore = { ...before }; delete auditableBefore.password;
    const auditableAfter  = { ...auditableBefore, ...$set }; delete auditableAfter.password;
    if (password) auditableAfter.password = "[updated]";

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "agent.update",
      target: { kind: "agent", id, label: before.nickname || before.name },
      before: auditableBefore,
      after:  auditableAfter,
      meta:   { passwordChanged: !!password, roleChanged: !!role && before.role !== role },
    });

    res.json({ success: true, id });
  } catch (err) {
    console.error("[admin] updateAdminAgent:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* DELETE /managers/:id (app-admin) — soft-delete: set active=false */
exports.deactivateAdminAgent = async (req, res) => {
  try {
    const db = getDB();
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });
    const agentFilter = agentIdQuery(id);
    const agent = await db.collection("agents").findOne(agentFilter, { projection: { name: 1, nickname: 1 } });
    if (!agent) return res.status(404).json({ error: "agent not found" });
    await db.collection("agents").updateOne(agentFilter, { $set: { active: false, updatedAt: new Date() } });
    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "agent.deactivate",
      target: { kind: "agent", id, label: agent.nickname || agent.name },
    });
    res.json({ success: true, id });
  } catch (err) {
    console.error("[admin] deactivateAdminAgent:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* POST /admin/agents/:id/force-logout — clears the agent's session token. */
exports.forceLogoutAgent = async (req, res) => {
  try {
    const db = getDB();
    const id = String(req.params.id || "").trim();
    const agentFilter = agentIdQuery(id);
    const before = await db.collection("agents").findOne(agentFilter);
    if (!before) return res.status(404).json({ error: "agent not found" });

    await db.collection("agents").updateOne(
      agentFilter, { $unset: { token: "" }, $set: { tokenInvalidatedAt: new Date() } },
    );

    auditSvc.record({
      actor:  auditSvc.actorFromReq(req),
      action: "agent.force_logout",
      target: { kind: "agent", id, label: before.nickname || before.name },
      meta:   { reason: req.body?.reason || null },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("[admin] forceLogoutAgent:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/customer-journey ────────────────────────────
   One row per client who has an activePackage — i.e. anyone who bought
   a package via the Personal Catalog. For each client we walk the
   pipeline downstream of the purchase and report the highest stage
   they've reached, so the admin can see at a glance who's stuck where.

   Stage table (ordered by precedence — last reached wins):
     1. purchased         — has activePackage.purchasedAt
     2. brief_done        — businessProfile passes assessCompleteness
     3. products_created  — any wow session has at least one generated artefact
     4. campaign_launched — at least one campaign exists in cpanel_clients.fbCampaignIds
     5. completed         — activePackage.status = completed

   Per stage we also report the timestamp the client first crossed it,
   so the UI can show "X days in current stage". */
exports.getCustomerJourney = async (req, res) => {
  try {
    const db = getDB();

    /* Pull every user who has any activePackage. activePackage is
       a sub-doc on the users collection — that's the same source the
       wallet / personal-catalog tabs read from. */
    const users = await db.collection("users")
      .find(
        { "activePackage.purchasedAt": { $exists: true } },
        { projection: {
            phone: 1, name: 1, fullName: 1, firstName: 1, lastName: 1,
            activePackage: 1,
        }},
      )
      .toArray();

    if (users.length === 0) return res.json({ clients: [] });

    const phones = users.map(u => u.phone).filter(Boolean);

    /* Parallel lookups for every per-client derivation. Each map is
       keyed by phone so the merge loop below is O(N) regardless of
       how the collections are queried. personal_packages carries the
       finalPrice that's missing from the activePackage sub-doc — we
       look it up by id parsed from activePackage.key. */
    const { ObjectId } = require("mongodb");
    const [profiles, adsSessions, organicSessions, lpSessions, managers, personalPkgs] = await Promise.all([
      db.collection("business_profiles").find({ phone: { $in: phones } }).toArray(),
      db.collection("wow_ads_sessions").find({ phone: { $in: phones } }).toArray(),
      db.collection("wow_organic_ads_sessions").find({ phone: { $in: phones } }).toArray(),
      db.collection("wow_lp_sessions").find({ phone: { $in: phones } }).toArray(),
      db.collection("cpanel_clients").find({ phone: { $in: phones } }, { projection: { phone: 1, agentName: 1, fbCampaignIds: 1 } }).toArray(),
      db.collection("personal_packages").find({ phone: { $in: phones }, purchased: true }, { projection: { _id: 1, phone: 1, finalPrice: 1, items: 1 } }).toArray(),
    ]);

    const personalPkgById = new Map();
    for (const p of personalPkgs) personalPkgById.set(String(p._id), p);

    const profileByPhone = new Map();
    for (const p of profiles) profileByPhone.set(p.phone, p);

    /* All product sessions across the three types — for status walking. */
    const sessionsByPhone = new Map();
    const addSession = (s) => {
      if (!s.phone) return;
      const arr = sessionsByPhone.get(s.phone) || [];
      arr.push(s);
      sessionsByPhone.set(s.phone, arr);
    };
    adsSessions.forEach(addSession);
    organicSessions.forEach(addSession);
    lpSessions.forEach(addSession);

    const managerByPhone = new Map();
    for (const c of managers) managerByPhone.set(c.phone, c);

    /* Mirror of ProductsTab.assessCompleteness — kept in lock-step so
       "brief_done" matches what the UI gates on. */
    const isBriefComplete = (bp) => {
      if (!bp) return false;
      if (!bp.businessName?.trim()) return false;
      if (!bp.categoryKey) return false;
      if (!Array.isArray(bp.subCategoryKeys) || bp.subCategoryKeys.filter(k => k !== "other_input").length === 0) return false;
      if (!Array.isArray(bp.services) || bp.services.length === 0) return false;
      if (!Array.isArray(bp.targetAudience) || bp.targetAudience.length === 0) return false;
      if (!bp.pageGoal) return false;
      return true;
    };

    const STAGE_ORDER = [
      "purchased",
      "brief_done",
      "products_created",
      "campaign_launched",
      "completed",
    ];

    const clients = users.map(u => {
      const phone = u.phone;
      const pkg = u.activePackage || {};
      const bp  = profileByPhone.get(phone);
      const sess = sessionsByPhone.get(phone) || [];
      const cpanel = managerByPhone.get(phone);

      /* timeline[stage] = ISO timestamp the client first reached that
         stage, where known. We always have purchased; the rest are
         best-effort derivations. */
      const timeline = {};
      timeline.purchased = pkg.purchasedAt || null;

      if (isBriefComplete(bp)) {
        timeline.brief_done = bp.updatedAt || bp.completedAt || null;
      }

      /* products_created — any session with generated artefacts. */
      const productSess = sess.find(s =>
        (Array.isArray(s.generatedAds)   && s.generatedAds.length   > 0) ||
        (Array.isArray(s.generatedPosts) && s.generatedPosts.length > 0) ||
        (s.lp && Object.keys(s.lp).length > 0)
      );
      if (productSess) {
        timeline.products_created = productSess.createdAt || productSess.updatedAt || null;
      }

      /* campaign_launched — the launch flow now persists every
         successful run to activePackage.launchedCampaigns +
         activePackage.lastCampaignLaunchedAt. Older launches that
         predate that write live only in FB Ads Manager, so we also
         accept the legacy cpanel_clients.fbCampaignIds array. */
      const launchedAt = pkg.lastCampaignLaunchedAt
                      || (Array.isArray(pkg.launchedCampaigns) && pkg.launchedCampaigns[0]?.at)
                      || cpanel?.lastCampaignLaunchedAt
                      || null;
      const hasCampaign = !!launchedAt
                       || (Array.isArray(pkg.launchedCampaigns) && pkg.launchedCampaigns.length > 0)
                       || (Array.isArray(cpanel?.fbCampaignIds) && cpanel.fbCampaignIds.length > 0);
      if (hasCampaign) timeline.campaign_launched = launchedAt;

      if (pkg.status === "completed") {
        timeline.completed = pkg.completedAt || null;
      }

      /* Current stage = the LAST stage in STAGE_ORDER that has a
         non-null timeline entry. Falls back to "purchased". */
      let currentStage = "purchased";
      for (const stage of STAGE_ORDER) {
        if (timeline[stage] !== undefined) currentStage = stage;
      }

      const currentStageAt = timeline[currentStage] || pkg.purchasedAt || null;

      /* Resolve the original personal_packages doc so we can show the
         purchase amount (not stored on activePackage) and a friendly
         breakdown of what's inside. activePackage.key is
         `personal_<ObjectId>`; bail gracefully if it isn't. */
      let purchaseAmount = null;
      const keyMatch = (pkg.key || "").match(/^personal_([a-f0-9]{24})$/i);
      if (keyMatch) {
        const src = personalPkgById.get(keyMatch[1]);
        if (src && typeof src.finalPrice === "number") purchaseAmount = src.finalPrice;
      }

      /* Items breakdown — Hebrew per-line list of what the customer
         actually bought. Maps the normalized items keys to user-facing
         labels and drops zeros so the cell stays compact. */
      const items = pkg.items || {};
      const ITEM_LABELS = [
        ["paidAds",         "מודעות ממומנות"],
        ["organicAds",      "פוסטים אורגניים"],
        ["lps",             "דפי נחיתה"],
        ["videos",          "סרטונים"],
        ["logos",           "לוגו"],
        ["campaignTraffic", "קמפיין אתר"],
        ["campaignLeads",   "קמפיין לידים"],
      ];
      const itemsBreakdown = ITEM_LABELS
        .map(([k, label]) => ({ key: k, label, count: Number(items[k] || 0) }))
        .filter(it => it.count > 0);

      return {
        phone,
        name: u.fullName || u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || phone,
        businessName: bp?.businessName?.trim() || null,
        purchasedAt: pkg.purchasedAt,
        packageName: pkg.name || pkg.key || "—",
        itemsBreakdown,
        purchaseAmount,
        coins: Number(pkg.coins || 0),
        managerName: cpanel?.agentName || null,
        currentStage,
        currentStageAt,
        timeline,
      };
    });

    /* Aggregate stage counts for the KPI strip on the page header. */
    const stageCounts = {};
    for (const s of STAGE_ORDER) stageCounts[s] = 0;
    for (const c of clients) stageCounts[c.currentStage] = (stageCounts[c.currentStage] || 0) + 1;

    res.json({ clients, stageCounts, stages: STAGE_ORDER });
  } catch (err) {
    console.error("[admin] getCustomerJourney:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/admin/customer-journey/backfill-campaigns ────────
   One-shot for legacy clients whose campaigns predate the activePackage
   .launchedCampaigns persistence (added 2026-06). Queries Facebook Ads
   Manager for each client's ad account and, when ≥1 active campaign
   exists, stamps lastCampaignLaunchedAt = first campaign start_time
   so the funnel can detect them. Idempotent — skips clients that
   already have the field set. */
exports.backfillCustomerJourneyCampaigns = async (req, res) => {
  try {
    const db = getDB();
    const axios = require("axios");
    const FB_GRAPH = "https://graph.facebook.com/v21.0";
    const { getClientFbCredentials, resolveAdAccounts } =
      require("./cpanel.controller");
    /* Optional `phone` body filter — fix one specific client without
       sweeping the entire user base. */
    const phoneFilter = (req.body?.phone || req.query?.phone || "").trim();

    const query = {
      "activePackage.purchasedAt": { $exists: true },
      "activePackage.lastCampaignLaunchedAt": { $exists: false },
    };
    if (phoneFilter) query.phone = phoneFilter;

    const users = await db.collection("users")
      .find(query, { projection: { phone: 1 } })
      .toArray();

    let updated = 0, skipped = 0, errors = 0;
    const log = [];

    for (const u of users) {
      const phone = u.phone;
      try {
        const creds = await getClientFbCredentials(phone);
        if (!creds?.userToken) { skipped++; log.push({ phone, reason: "no FB token" }); continue; }
        const accounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
        if (!accounts.length)   { skipped++; log.push({ phone, reason: "no ad accounts" }); continue; }

        const actId = (creds.adAccountId || accounts[0]).replace(/^act_/, "");
        const { data } = await axios.get(`${FB_GRAPH}/act_${actId}/campaigns`, {
          params: {
            access_token: creds.userToken,
            fields: "id,start_time,effective_status",
            limit: 5,
          },
        });
        const campaigns = data?.data || [];
        if (campaigns.length === 0) { skipped++; log.push({ phone, reason: "0 campaigns" }); continue; }

        const earliest = campaigns
          .map(c => c.start_time)
          .filter(Boolean)
          .sort()[0] || new Date().toISOString();

        const entries = campaigns.map(c => ({
          campaignId: c.id,
          type: null,
          slotKey: null,
          adCount: null,
          at: c.start_time || earliest,
          source: "backfill",
        }));

        await db.collection("users").updateOne(
          { phone },
          {
            $set:  { "activePackage.lastCampaignLaunchedAt": earliest },
            $push: { "activePackage.launchedCampaigns": { $each: entries } },
          },
        );
        updated++;
        log.push({ phone, count: campaigns.length, earliest });
      } catch (err) {
        errors++;
        const fbErr = err.response?.data?.error;
        log.push({ phone, error: fbErr?.message || err.message });
      }
    }

    res.json({ scanned: users.length, updated, skipped, errors, log });
  } catch (err) {
    console.error("[admin] backfillCustomerJourneyCampaigns:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/admin/audit ────────────────────────────────────── */
exports.getAuditLog = async (req, res) => {
  try {
    const entries = await auditSvc.list(req.query);
    res.json({
      entries: entries.map(e => ({
        ...e,
        _id: String(e._id),
      })),
      total: entries.length,
    });
  } catch (err) {
    console.error("[admin] getAuditLog:", err.message);
    res.status(500).json({ error: err.message });
  }
};
