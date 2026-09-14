'use strict';

/**
 * benchmarks.service — INTERNAL industry benchmarks from Kliq's own client base,
 * so the agent's judgment is CALIBRATED instead of intuitive: "7₪ לליד בתיירות —
 * טוב מהממוצע אצלנו (11₪)" beats "זה לא רע".
 *
 * Zero extra Facebook calls: every agent run already assembles live performance
 * (context.js); recordSnapshot() persists ONE daily row per client from that
 * in-hand data (`agent_perf_snapshots`, upsert keyed phone+date). Benchmarks
 * pool the latest snapshot per client over the last 30 days and compute a
 * pooled CPL per business field + overall. Minimum pool sizes guard against
 * quoting a "benchmark" of one client.
 *
 * PRIVACY: only aggregates reach the prompt — never other clients' names/data.
 */

const { getDB } = require("../../config/db");

const col = () => getDB().collection("agent_perf_snapshots");

const WINDOW_DAYS = 30;
const MIN_CATEGORY_POOL = 3;   // quote a field benchmark only with ≥3 clients
const MIN_OVERALL_POOL = 5;

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ phone: 1, date: 1 }, { unique: true });
    await col().createIndex({ date: -1 });
    indexed = true;
  } catch (e) { console.warn("[benchmarks] index ensure failed:", e.message); }
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * recordSnapshot(view) — persist today's per-client performance row from an
 * already-assembled context view. Fire-and-forget; deduped per day by upsert.
 */
async function recordSnapshot(view) {
  try {
    const perf = view?.performance;
    if (!view?.phone || !perf || perf.skipped || perf.campaignsError) return;
    if (!Number.isFinite(perf.spend14d) || perf.spend14d <= 0) return; // nothing meaningful to pool
    await ensureIndexes();
    await col().updateOne(
      { phone: String(view.phone), date: dayKey() },
      { $set: {
        category: view.profile?.businessField || null,
        spend14d: perf.spend14d,
        leads14d: perf.leads14d?.total || 0,
        activeCampaigns: perf.activeCampaigns || 0,
        at: new Date(),
      } },
      { upsert: true },
    );
  } catch (e) { console.warn("[benchmarks] recordSnapshot failed:", e.message); }
}

/* ── aggregation (cached 1h in-process) ─────────────────────────────────────── */

const CACHE_MS = 60 * 60 * 1000;
let _cache = { at: 0, pools: null };

/* latest snapshot per phone within the window → pooled per category + overall */
async function buildPools() {
  if (_cache.pools && (Date.now() - _cache.at) < CACHE_MS) return _cache.pools;
  await ensureIndexes();
  const since = dayKey(new Date(Date.now() - WINDOW_DAYS * 86400000));
  const rows = await col().aggregate([
    { $match: { date: { $gte: since }, leads14d: { $gt: 0 } } },
    { $sort: { date: -1 } },
    { $group: { _id: "$phone", category: { $first: "$category" }, spend: { $first: "$spend14d" }, leads: { $first: "$leads14d" } } },
  ]).toArray();

  const pools = { overall: { spend: 0, leads: 0, clients: 0 }, byCategory: {} };
  for (const r of rows) {
    pools.overall.spend += r.spend; pools.overall.leads += r.leads; pools.overall.clients++;
    const cat = r.category || "אחר";
    const p = pools.byCategory[cat] || (pools.byCategory[cat] = { spend: 0, leads: 0, clients: 0 });
    p.spend += r.spend; p.leads += r.leads; p.clients++;
  }
  _cache = { at: Date.now(), pools };
  return pools;
}

const cpl = (p) => (p && p.leads > 0 ? Number((p.spend / p.leads).toFixed(1)) : null);

/**
 * getBenchmark(category) → { categoryCPL, categoryClients, overallCPL, overallClients } | null
 * Values are null when the pool is too small to be meaningful.
 */
async function getBenchmark(category) {
  try {
    const pools = await buildPools();
    const catPool = category ? pools.byCategory[category] : null;
    const out = {
      categoryCPL: catPool && catPool.clients >= MIN_CATEGORY_POOL ? cpl(catPool) : null,
      categoryClients: catPool?.clients || 0,
      overallCPL: pools.overall.clients >= MIN_OVERALL_POOL ? cpl(pools.overall) : null,
      overallClients: pools.overall.clients,
    };
    return (out.categoryCPL || out.overallCPL) ? out : null;
  } catch (e) {
    console.warn("[benchmarks] getBenchmark failed:", e.message);
    return null;
  }
}

/** Admin view — every pool (for the owner's oversight). */
async function getAllBenchmarks() {
  const pools = await buildPools();
  return {
    windowDays: WINDOW_DAYS,
    overall: { cpl: cpl(pools.overall), clients: pools.overall.clients },
    byCategory: Object.fromEntries(Object.entries(pools.byCategory)
      .map(([k, p]) => [k, { cpl: cpl(p), clients: p.clients }])
      .sort((a, b) => b[1].clients - a[1].clients)),
  };
}

module.exports = { recordSnapshot, getBenchmark, getAllBenchmarks };
