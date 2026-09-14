/**
 * Commission service — earnings ledger for account managers.
 *
 * Each time a manager triggers a charge against one of their clients
 * (direct token charge or successful payment-link / package payment),
 * we accrue a commission row and bump the manager's wallet balance.
 *
 * Default rate: 10%. Per-agent override stored on agents.commissionRate
 * (decimal, 0.10 = 10%). Env override: DEFAULT_COMMISSION_RATE.
 *
 * Collections:
 *   cpanel_commissions  — append-only ledger of earned commissions
 *   agent_wallets       — denormalized balance + totals per agent
 */
const { getDB } = require("../config/db");

const COMM_COL   = "cpanel_commissions";
const WALLET_COL = "agent_wallets";
const AGENTS_COL = "agents";

const DEFAULT_RATE = parseFloat(process.env.DEFAULT_COMMISSION_RATE || "0.10");

const commCol   = () => getDB().collection(COMM_COL);
const walletCol = () => getDB().collection(WALLET_COL);
const agentsCol = () => getDB().collection(AGENTS_COL);

async function ensureIndexes() {
  try {
    await commCol().createIndex({ agentId: 1, earnedAt: -1 });
    await commCol().createIndex({ clientPhone: 1, earnedAt: -1 });
    await commCol().createIndex({ sourceChargeId: 1 }, { unique: true, sparse: true });
    await walletCol().createIndex({ agentId: 1 }, { unique: true });
  } catch (err) {
    console.warn("[commission] index ensure failed:", err.message);
  }
}

/** Resolve the effective commission rate for an agent. */
async function getRateForAgent(agentId) {
  if (!agentId) return DEFAULT_RATE;
  try {
    const a = await agentsCol().findOne({ _id: agentId }, { projection: { commissionRate: 1 } });
    if (typeof a?.commissionRate === "number" && a.commissionRate >= 0 && a.commissionRate <= 1) {
      return a.commissionRate;
    }
  } catch (_) {}
  return DEFAULT_RATE;
}

/**
 * Accrue commission on a confirmed payment.
 *
 * @param {object} opts
 * @param {string}        opts.agentId        Manager who owns the commission.
 * @param {string}        opts.clientPhone    Client who paid.
 * @param {number}        opts.baseAmount     Charge amount before commission.
 * @param {string}        [opts.currency]     Default ILS.
 * @param {string}        opts.sourceKind     "direct_charge" | "payment_link" | "package"
 * @param {string}        [opts.sourceChargeId] Idempotency key — the charge / pending-purchase id.
 * @param {string}        [opts.transactionId]  CardCom TranzactionId.
 * @param {string}        [opts.description]
 * @returns {Promise<object|null>} The inserted commission doc, or null if duplicate.
 */
async function accrueCommission(opts) {
  const {
    agentId, clientPhone, baseAmount,
    currency = "ILS", sourceKind, sourceChargeId,
    transactionId, description,
  } = opts || {};

  if (!agentId)       { console.warn("[commission] no agentId — skipping accrual"); return null; }
  if (!baseAmount)    { console.warn("[commission] no baseAmount — skipping accrual"); return null; }
  if (!sourceKind)    { console.warn("[commission] no sourceKind — skipping accrual"); return null; }

  const rate = await getRateForAgent(agentId);
  const amount = Math.round(baseAmount * rate * 100) / 100; // 2dp

  const doc = {
    agentId: String(agentId),
    clientPhone: clientPhone ? String(clientPhone) : null,
    baseAmount: Number(baseAmount),
    commissionRate: rate,
    commissionAmount: amount,
    currency,
    sourceKind,
    sourceChargeId: sourceChargeId ? String(sourceChargeId) : null,
    transactionId: transactionId ? String(transactionId) : null,
    description: description || null,
    earnedAt: new Date(),
    status: "earned",
  };

  /* Idempotency: same sourceChargeId never accrues twice. */
  if (doc.sourceChargeId) {
    const existing = await commCol().findOne({ sourceChargeId: doc.sourceChargeId });
    if (existing) {
      console.log(`[commission] duplicate sourceChargeId=${doc.sourceChargeId} — skipping`);
      return null;
    }
  }

  await commCol().insertOne(doc);

  /* Bump the wallet — upsert, never go negative. */
  await walletCol().updateOne(
    { agentId: doc.agentId },
    {
      $inc: { balance: amount, totalEarned: amount, totalChargedBase: doc.baseAmount },
      $set: { currency, lastEarnedAt: doc.earnedAt, updatedAt: new Date() },
      $setOnInsert: { agentId: doc.agentId, totalPaid: 0, createdAt: new Date() },
    },
    { upsert: true }
  );

  console.log(`[commission] +${amount} ${currency} for agent ${doc.agentId} (rate ${(rate * 100).toFixed(0)}%, base ${doc.baseAmount})`);
  return doc;
}

/**
 * Build the wallet summary for an agent — used by the cpanel /wallet page.
 *
 * @param {string} agentId
 * @returns {Promise<{
 *   balance: number, totalEarned: number, totalPaid: number,
 *   totalChargedBase: number, monthEarned: number,
 *   commissionRate: number, currency: string,
 *   trend: { date: string, earned: number, count: number }[],
 *   recent: any[],
 * }>}
 */
async function getAgentWalletSummary(agentId) {
  const id = String(agentId);
  const [wallet, agent, recent, monthAgg, trendAgg] = await Promise.all([
    walletCol().findOne({ agentId: id }),
    agentsCol().findOne({ _id: id }, { projection: { commissionRate: 1 } }),
    commCol().find({ agentId: id }).sort({ earnedAt: -1 }).limit(50).toArray(),
    commCol().aggregate([
      {
        $match: {
          agentId: id,
          earnedAt: { $gte: startOfMonth() },
          status: "earned",
        },
      },
      { $group: { _id: null, total: { $sum: "$commissionAmount" } } },
    ]).toArray(),
    commCol().aggregate([
      {
        $match: {
          agentId: id,
          earnedAt: { $gte: daysAgo(30) },
          status: "earned",
        },
      },
      {
        $group: {
          _id: { $dateToString: { date: "$earnedAt", format: "%Y-%m-%d" } },
          earned: { $sum: "$commissionAmount" },
          count:  { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).toArray(),
  ]);

  return {
    balance:          wallet?.balance ?? 0,
    totalEarned:      wallet?.totalEarned ?? 0,
    totalPaid:        wallet?.totalPaid ?? 0,
    totalChargedBase: wallet?.totalChargedBase ?? 0,
    monthEarned:      monthAgg[0]?.total ?? 0,
    commissionRate:   typeof agent?.commissionRate === "number" ? agent.commissionRate : DEFAULT_RATE,
    currency:         wallet?.currency ?? "ILS",
    trend: trendAgg.map(d => ({ date: d._id, earned: d.earned, count: d.count })),
    recent: recent.map(c => ({
      id:               String(c._id),
      clientPhone:      c.clientPhone,
      baseAmount:       c.baseAmount,
      commissionAmount: c.commissionAmount,
      commissionRate:   c.commissionRate,
      sourceKind:       c.sourceKind,
      transactionId:    c.transactionId,
      description:      c.description,
      earnedAt:         c.earnedAt,
      status:           c.status,
      paidAt:           c.paidAt,
    })),
  };
}

function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/** Mark a commission as paid (admin operation). */
async function markCommissionPaid(commissionId, paidByAgentId) {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(commissionId)) throw new Error("invalid commissionId");
  const _id = new ObjectId(commissionId);

  const cur = await commCol().findOne({ _id });
  if (!cur) throw new Error("commission not found");
  if (cur.status === "paid") return cur;

  await commCol().updateOne(
    { _id },
    {
      $set: {
        status: "paid",
        paidAt: new Date(),
        paidBy: paidByAgentId ? String(paidByAgentId) : null,
      },
    }
  );

  /* Decrement available balance on payout — totals stay in totalEarned/totalPaid. */
  await walletCol().updateOne(
    { agentId: cur.agentId },
    {
      $inc: { balance: -cur.commissionAmount, totalPaid: cur.commissionAmount },
      $set: { updatedAt: new Date() },
    }
  );

  return commCol().findOne({ _id });
}

module.exports = {
  ensureIndexes,
  accrueCommission,
  getAgentWalletSummary,
  markCommissionPaid,
  getRateForAgent,
  DEFAULT_RATE,
};
