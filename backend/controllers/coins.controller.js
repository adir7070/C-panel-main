const { getDB } = require("../config/db");
const {
  getCustomer: getCustomerCached,
  refreshCustomer,
} = require("../services/customer-cache.service");
const { billingEnabled } = require("../utils/billing");
const TRANS_COL = "coin_transactions";
const PRICES_COL = "action_prices";

// ─── Helper: admin guard ──────────────────────────────────────────────────────
async function requireAdmin(req, res) {
  const bearerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  if (!bearerToken) {
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }
  const agent = await getDB()
    .collection("agents")
    .findOne({ token: bearerToken });
  if (!agent || agent.role !== "admin") {
    res.status(403).json({ message: "Forbidden — admin only" });
    return null;
  }
  return agent;
}

// ─── Load coins (webhook from Make.com after purchase) ────────────────────────

// POST /api/coins/load   { phone, amount, secret }
exports.loadCoins = async (req, res) => {
  const { phone, amount, secret } = req.body;
  if (!secret || secret !== process.env.COINS_WEBHOOK_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (!phone || !amount)
    return res.status(400).json({ message: "phone and amount are required" });
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0)
    return res.status(400).json({ message: "amount must be positive" });
  try {
    const result = await getDB()
      .collection("users")
      .findOneAndUpdate(
        { phone },
        {
          $inc: { coins: n },
          $set: { updatedAt: new Date() },
          $setOnInsert: { phone, createdAt: new Date() },
        },
        { returnDocument: "after", upsert: true },
      );
    const newBalance = result.coins ?? n;
    await getDB().collection(TRANS_COL).insertOne({
      phone,
      type: "add",
      amount: n,
      reason: "purchase",
      balance_after: newBalance,
      created_at: new Date(),
    });
    res.json({ success: true, data: { balance: newBalance } });
  } catch (err) {
    console.error("[Coins] loadCoins:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Balance ──────────────────────────────────────────────────────────────────

// GET /api/coins/balance?phone=972...
// Coins are a HIDDEN backend usage-control quota — never exposed to the client.
// This client-facing endpoint reports subscription status instead of a number,
// so the app can show "מנוי פעיל" without ever revealing tokens. (Operators see
// real balances via /cpanel/clients/:phone/coins and the coins overview.)
exports.getBalance = async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ message: "phone is required" });
  try {
    const { getActiveSubscription } = require("../services/tier-subscription.service");
    const sub = await getActiveSubscription(phone);
    res.json({ success: true, data: { subscriptionActive: !!sub, tier: sub?.tier || null } });
  } catch (err) {
    console.error("[Coins] getBalance:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Add (admin / purchase flow) ─────────────────────────────────────────────

// POST /api/coins/add   { phone, amount, reason? }
exports.addCoins = async (req, res) => {
  const { phone, amount, reason } = req.body;
  if (!phone || !amount)
    return res.status(400).json({ message: "phone and amount are required" });
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0)
    return res.status(400).json({ message: "amount must be positive" });
  try {
    const result = await getDB()
      .collection("users")
      .findOneAndUpdate(
        { phone },
        {
          $inc: { coins: n },
          $set: { updatedAt: new Date() },
          $setOnInsert: { phone, createdAt: new Date() },
        },
        { returnDocument: "after", upsert: true },
      );
    const newBalance = result.coins ?? n;
    await getDB()
      .collection(TRANS_COL)
      .insertOne({
        phone,
        type: "add",
        amount: n,
        reason: reason || "purchase",
        balance_after: newBalance,
        created_at: new Date(),
      });
    res.json({ success: true, data: { balance: newBalance } });
  } catch (err) {
    console.error("[Coins] addCoins:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Deduct by action name ────────────────────────────────────────────────────

// POST /api/coins/deduct   { phone, action, quantity? }
exports.deductCoins = async (req, res) => {
  const { phone, action, quantity } = req.body;
  if (!phone || !action)
    return res.status(400).json({ message: "phone and action are required" });
  const qty = Math.max(1, parseInt(quantity) || 1);
  try {
    // Look up price for this action
    const actionDoc = await getDB().collection(PRICES_COL).findOne({ action });
    if (!actionDoc)
      return res.status(404).json({ message: `פעולה לא מוגדרת: ${action}` });
    // Free while billing is off: nothing to charge, so the balance check below passes.
    const n = billingEnabled() ? actionDoc.price * qty : 0;

    const user = await getDB()
      .collection("users")
      .findOne({ phone }, { projection: { coins: 1 } });
    if (!user) return res.status(404).json({ message: "User not found" });
    const current = user.coins ?? 0;
    if (current < n) {
      return res.status(400).json({
        message: "יתרה לא מספיקה",
        data: { balance: current, required: n },
      });
    }
    const result = await getDB()
      .collection("users")
      .findOneAndUpdate(
        { phone },
        { $inc: { coins: -n }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
    const newBalance = result.coins ?? 0;
    // Nothing was charged while billing is off — don't log a zero-coin deduction.
    if (n > 0) {
      await getDB()
        .collection(TRANS_COL)
        .insertOne({
          phone,
          type: "deduct",
          amount: n,
          action,
          quantity: qty,
          reason: actionDoc.label || action,
          balance_after: newBalance,
          created_at: new Date(),
        });
    }
    res.json({ success: true, data: { balance: newBalance, deducted: n } });
  } catch (err) {
    console.error("[Coins] deductCoins:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Action prices — public read ─────────────────────────────────────────────

// GET /api/coins/actions
exports.getActions = async (req, res) => {
  try {
    const actions = await getDB()
      .collection(PRICES_COL)
      .find({})
      .sort({ action: 1 })
      .toArray();
    res.json({ success: true, data: actions });
  } catch (err) {
    console.error("[Coins] getActions:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Action prices — admin CRUD ───────────────────────────────────────────────

// PUT /api/coins/actions/:action   { label, price }   (admin)
exports.upsertAction = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { action } = req.params;
  const { label, price } = req.body;
  if (!label || price === undefined)
    return res.status(400).json({ message: "label and price are required" });
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0)
    return res
      .status(400)
      .json({ message: "price must be a non-negative number" });
  try {
    await getDB()
      .collection(PRICES_COL)
      .updateOne(
        { action },
        { $set: { action, label, price: p, updatedAt: new Date() } },
        { upsert: true },
      );
    res.json({ success: true });
  } catch (err) {
    console.error("[Coins] upsertAction:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// DELETE /api/coins/actions/:action   (admin)
exports.deleteAction = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { action } = req.params;
  try {
    await getDB().collection(PRICES_COL).deleteOne({ action });
    res.json({ success: true });
  } catch (err) {
    console.error("[Coins] deleteAction:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Can Afford check ─────────────────────────────────────────────────────────

// GET /api/coins/can-afford?phone=972...&action=campaign_create&quantity=3
exports.canAfford = async (req, res) => {
  const { phone, action, quantity } = req.query;
  if (!phone || !action)
    return res.status(400).json({ message: "phone and action are required" });
  const digits = phone.replace(/\D/g, "");
  const qty = Math.max(1, parseInt(quantity) || 1);
  try {
    const actionDoc = await getDB().collection(PRICES_COL).findOne({ action });
    if (!actionDoc)
      return res.status(404).json({ message: `פעולה לא מוגדרת: ${action}` });
    // Quota check only — while billing is off, cost is 0 so it always passes.
    const required = billingEnabled() ? actionDoc.price * qty : 0;

    const user = await getDB()
      .collection("users")
      .findOne({ phone: digits }, { projection: { coins: 1 } });
    const balance = user?.coins ?? 0;

    // Coins are hidden from the client — return only the boolean the UI needs,
    // never the balance/required numbers.
    res.json({ success: true, data: { canAfford: balance >= required, action, quantity: qty } });
  } catch (err) {
    console.error("[Coins] canAfford:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Customer lookup (cache-first → Fireberry) ────────────────────────────────

// GET /api/coins/customer?phone=972...   (admin)
exports.getCustomer = async (req, res) => {
  const { phone, refresh } = req.query;
  if (!phone) return res.status(400).json({ message: "phone is required" });
  try {
    const forceRefresh = refresh === "true";
    const customer = forceRefresh
      ? await refreshCustomer(phone)
      : await getCustomerCached(phone);

    if (!customer) return res.status(404).json({ message: "לקוח לא נמצא" });

    const normalized = customer.phone;
    const user = await getDB()
      .collection("users")
      .findOne({ phone: normalized }, { projection: { coins: 1 } });

    res.json({
      success: true,
      data: { customer, coins: user?.coins ?? 0, fromCache: !forceRefresh },
    });
  } catch (err) {
    console.error("[Coins] getCustomer:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Overview: aggregate stats (admin) ────────────────────────────────────────

// GET /api/coins/overview/stats
exports.getOverviewStats = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const db = getDB();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Per-user spending totals
    const userStats = await db
      .collection(TRANS_COL)
      .aggregate([
        { $match: { type: "deduct" } },
        {
          $group: {
            _id: "$phone",
            totalSpent: { $sum: "$amount" },
            firstTx: { $min: "$created_at" },
          },
        },
      ])
      .toArray();

    const totalSpentAllTime = userStats.reduce((s, u) => s + u.totalSpent, 0);
    const activeUsersCount = userStats.length;
    const topSpender = userStats.length
      ? userStats.reduce((a, b) => (b.totalSpent > a.totalSpent ? b : a))
      : null;

    // Avg monthly spend per user: total / months_active per user, then average
    let avgMonthlyPerUser = 0;
    if (userStats.length > 0) {
      const rates = userStats.map((u) => {
        const monthsActive = Math.max(
          1,
          (now - new Date(u.firstTx)) / (1000 * 60 * 60 * 24 * 30),
        );
        return u.totalSpent / monthsActive;
      });
      avgMonthlyPerUser = Math.round(
        rates.reduce((s, r) => s + r, 0) / rates.length,
      );
    }

    // This month's spend
    const thisMonthAgg = await db
      .collection(TRANS_COL)
      .aggregate([
        { $match: { type: "deduct", created_at: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ])
      .toArray();
    const thisMonthSpend = thisMonthAgg[0]?.total || 0;

    // Avg balance among active users
    const activePhones = userStats.map((u) => u._id);
    const balanceAgg = await db
      .collection("users")
      .aggregate([
        { $match: { phone: { $in: activePhones } } },
        { $group: { _id: null, avg: { $avg: "$coins" } } },
      ])
      .toArray();
    const avgBalanceActive = Math.round(balanceAgg[0]?.avg || 0);

    res.json({
      success: true,
      data: {
        topSpender: topSpender
          ? { phone: topSpender._id, totalSpent: topSpender.totalSpent }
          : null,
        avgMonthlyPerUser,
        totalSpentAllTime,
        activeUsersCount,
        avgBalanceActive,
        thisMonthSpend,
      },
    });
  } catch (err) {
    console.error("[Coins] getOverviewStats:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Overview: paginated user list (admin) ─────────────────────────────────────

// GET /api/coins/overview/users?page=1&limit=50&sort=totalSpent&order=desc
exports.getOverviewUsers = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const db = getDB();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limitRaw = parseInt(req.query.limit) || 50;
    const limit = [20, 50, 100, 200, 500].includes(limitRaw) ? limitRaw : 50;
    const VALID_SORT = [
      "phone",
      "coins",
      "totalSpent",
      "transactionCount",
      "lastActivity",
    ];
    const safeSort = VALID_SORT.includes(req.query.sort)
      ? req.query.sort
      : "totalSpent";
    const sortOrder = req.query.order === "asc" ? 1 : -1;
    const skip = (page - 1) * limit;

    // Aggregate spending from coin_transactions (all phones that ever had activity)
    const spendingByPhone = await db
      .collection(TRANS_COL)
      .aggregate([
        {
          $group: {
            _id: "$phone",
            totalSpent: {
              $sum: { $cond: [{ $eq: ["$type", "deduct"] }, "$amount", 0] },
            },
            transactionCount: {
              $sum: { $cond: [{ $eq: ["$type", "deduct"] }, 1, 0] },
            },
            lastActivity: {
              $max: {
                $cond: [
                  { $eq: ["$type", "deduct"] },
                  "$created_at",
                  "$$REMOVE",
                ],
              },
            },
          },
        },
      ])
      .toArray();

    // All managed clients from cpanel_clients (canonical roster — always show even with no activity)
    const cpanelClients = await db
      .collection("cpanel_clients")
      .find(
        { phone: { $exists: true, $ne: null } },
        { projection: { phone: 1, customerName: 1, fireberyName: 1, businessName: 1, _id: 0 } },
      )
      .toArray();

    // All known customers from support_chats (every phone that ever chatted)
    const chatDocs = await db
      .collection("support_chats")
      .find(
        { phone: { $exists: true, $ne: null } },
        { projection: { phone: 1, name: 1, fireberyName: 1, _id: 0 } },
      )
      .toArray();

    // All phones from users collection (for coin balances)
    const userDocs = await db
      .collection("users")
      .find({}, { projection: { phone: 1, coins: 1, _id: 0 } })
      .toArray();

    // Build merged map: phone → row — seed from cpanel_clients so all managed clients appear
    const map = new Map();
    for (const c of cpanelClients) {
      if (!c.phone) continue;
      map.set(c.phone, {
        phone: c.phone,
        name: c.customerName || c.fireberyName || null,
        coins: 0,
        totalSpent: 0,
        transactionCount: 0,
        lastActivity: null,
      });
    }
    // Merge support_chats data (may fill name for non-cpanel users)
    for (const c of chatDocs) {
      if (!c.phone) continue;
      const existing = map.get(c.phone);
      if (existing) {
        existing.name = existing.name || c.fireberyName || c.name || null;
      } else {
        map.set(c.phone, {
          phone: c.phone,
          name: c.fireberyName || c.name || null,
          coins: 0,
          totalSpent: 0,
          transactionCount: 0,
          lastActivity: null,
        });
      }
    }
    // Merge coin balances from users collection
    for (const u of userDocs) {
      if (!u.phone) continue;
      const existing = map.get(u.phone);
      if (existing) {
        existing.coins = u.coins ?? 0;
      } else {
        map.set(u.phone, {
          phone: u.phone,
          name: null,
          coins: u.coins ?? 0,
          totalSpent: 0,
          transactionCount: 0,
          lastActivity: null,
        });
      }
    }
    // Merge spending/transaction data
    for (const s of spendingByPhone) {
      const existing = map.get(s._id);
      if (existing) {
        existing.totalSpent = s.totalSpent;
        existing.transactionCount = s.transactionCount;
        existing.lastActivity = s.lastActivity ?? null;
      } else {
        map.set(s._id, {
          phone: s._id,
          name: null,
          coins: 0,
          totalSpent: s.totalSpent,
          transactionCount: s.transactionCount,
          lastActivity: s.lastActivity ?? null,
        });
      }
    }

    let allUsers = Array.from(map.values());

    // Sort
    allUsers.sort((a, b) => {
      const av = a[safeSort] ?? 0;
      const bv = b[safeSort] ?? 0;
      if (av < bv) return sortOrder;
      if (av > bv) return -sortOrder;
      return 0;
    });

    const total = allUsers.length;
    const users = allUsers.slice(skip, skip + limit);

    res.json({
      success: true,
      data: { users, total, page, limit },
    });
  } catch (err) {
    console.error("[Coins] getOverviewUsers:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Transaction history ───────────────────────────────────────────────────────

// GET /api/coins/transactions?phone=972...   (admin)
exports.getTransactions = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ message: "phone is required" });
  const digits = phone.replace(/\D/g, "");
  try {
    const transactions = await getDB()
      .collection(TRANS_COL)
      .find({ phone: digits })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    res.json({ success: true, data: transactions });
  } catch (err) {
    console.error("[Coins] getTransactions:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Get coin packages (public) ──────────────────────────────────────────────

// GET /api/coins/packages?phone=972...
exports.getPackages = async (req, res) => {
  try {
    const { phone } = req.query;
    const db = getDB();

    let isNewCustomer = true;
    if (phone) {
      const user = await db
        .collection("users")
        .findOne({ phone }, { projection: { paymentToken: 1 } });
      isNewCustomer = !user?.paymentToken;
    }

    const query = {
      kind: "coins",
      active: { $ne: false },
      ...(isNewCustomer ? {} : { isNewCustomer: { $ne: true } }),
    };

    const packages = await db
      .collection("cpanel_products")
      .find(query)
      .sort({ sortOrder: 1 })
      .toArray();

    // מפה key → packageId כדי לשמור תאימות לאחור עם הלקוח הקיים
    const data = packages.map(({ key, ...rest }) => ({
      ...rest,
      key,
      packageId: key,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error("[Coins] getPackages:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Package CRUD (admin) ─────────────────────────────────────────────────────

// GET /api/coins/packages/admin
exports.getPackagesAdmin = async (req, res) => {
  const agent = await requireAdmin(req, res);
  if (!agent) return;
  try {
    const packages = await getDB()
      .collection("coin_packages")
      .find({})
      .sort({ sortOrder: 1 })
      .toArray();
    res.json({ success: true, data: packages });
  } catch (err) {
    console.error("[Coins] getPackagesAdmin:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/coins/packages
exports.createPackage = async (req, res) => {
  const agent = await requireAdmin(req, res);
  if (!agent) return;
  const {
    packageId,
    name,
    label,
    coins,
    price,
    sortOrder,
    isNewCustomer,
    color,
    imageUrl,
  } = req.body;
  if (
    !packageId ||
    !name ||
    !label ||
    coins == null ||
    price == null ||
    sortOrder == null
  ) {
    return res.status(400).json({ message: "כל השדות חובה" });
  }
  try {
    const db = getDB();
    const existing = await db
      .collection("coin_packages")
      .findOne({ packageId });
    if (existing)
      return res.status(409).json({ message: "packageId כבר קיים" });
    const doc = {
      packageId,
      name,
      label,
      coins: Number(coins),
      price: Number(price),
      sortOrder: Number(sortOrder),
      isNewCustomer: !!isNewCustomer,
      color: color || null,
      imageUrl: imageUrl || null,
      updatedAt: new Date(),
    };
    await db.collection("coin_packages").insertOne(doc);
    res.json({ success: true, data: doc });
  } catch (err) {
    console.error("[Coins] createPackage:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// PUT /api/coins/packages/:packageId
exports.updatePackage = async (req, res) => {
  const agent = await requireAdmin(req, res);
  if (!agent) return;
  const { packageId } = req.params;
  const {
    name,
    label,
    coins,
    price,
    sortOrder,
    isNewCustomer,
    color,
    imageUrl,
  } = req.body;
  try {
    const result = await getDB()
      .collection("coin_packages")
      .updateOne(
        { packageId },
        {
          $set: {
            name,
            label,
            coins: Number(coins),
            price: Number(price),
            sortOrder: Number(sortOrder),
            isNewCustomer: !!isNewCustomer,
            color: color || null,
            imageUrl: imageUrl || null,
            updatedAt: new Date(),
          },
        },
      );
    if (result.matchedCount === 0)
      return res.status(404).json({ message: "חבילה לא נמצאה" });
    res.json({ success: true });
  } catch (err) {
    console.error("[Coins] updatePackage:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// DELETE /api/coins/packages/:packageId
exports.deletePackage = async (req, res) => {
  const agent = await requireAdmin(req, res);
  if (!agent) return;
  const { packageId } = req.params;
  try {
    const result = await getDB()
      .collection("coin_packages")
      .deleteOne({ packageId });
    if (result.deletedCount === 0)
      return res.status(404).json({ message: "חבילה לא נמצאה" });
    res.json({ success: true });
  } catch (err) {
    console.error("[Coins] deletePackage:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
