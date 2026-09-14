'use strict';

/**
 * billing.service — charges the client coins for the agent's paid actions, using
 * the SAME model as the app's coins.controller.deductCoins (the `users.coins`
 * field + `action_prices` table + `coin_transactions` log). Every agent write
 * tool maps to one or more priced actions.
 *
 * runBilled: precheck balance → (atomic) deduct → run the action → refund if the
 * action throws (never charge for a failed action; never run an unaffordable one).
 */

const { getDB } = require("../../config/db");
const { billingEnabled } = require("../../utils/billing");

const PRICES_COL = "action_prices";
const TRANS_COL = "coin_transactions";

/* tool → priced action_price key(s). launch adds keys dynamically (lead form). */
const TOOL_PRICING = {
  update_budget:   ["campaign_edit"],
  update_audience: ["campaign_edit"],
  pause_campaign:  ["campaign_toggle"],
  resume_campaign: ["campaign_toggle"],
  pause_ad:        ["ad_toggle"],
  duplicate_ad:    ["campaign_edit"],
  update_ad_text:  ["ad_edit_text_ai"],
  update_ad_link:  ["ad_edit_text_ai"],
  update_ad_image: ["ad_edit_text_ai"],
  generate_ad_image: ["ad_create_ai"],   // a fresh AI image on request
  edit_ad_image: ["ad_create_ai"],        // turn a client-uploaded photo into a branded ad
  delete_ad:       ["ad_delete"],
  // launch: new campaign + an AI-generated ad (image) + (leads) a lead form
  launch_campaign: ["campaign_create", "ad_create_ai"],
};

let _cache = { at: 0, map: {} };
async function loadPrices(force = false) {
  if (!force && _cache.at && (Date.now() - _cache.at) < 5 * 60 * 1000) return _cache.map;
  const map = {};
  try {
    const rows = await getDB().collection(PRICES_COL).find({}).toArray();
    for (const r of rows) map[r.action] = { price: Number(r.price) || 0, label: r.label || r.action };
  } catch (e) { console.warn("[billing] loadPrices failed:", e.message); }
  _cache = { at: Date.now(), map };
  return map;
}

function keysFor(toolName, args = {}) {
  const keys = TOOL_PRICING[toolName] ? [...TOOL_PRICING[toolName]] : [];
  if (toolName === "launch_campaign") {
    // ad_create_ai covers the image launch generates ITSELF. When the client's
    // creatives are pre-supplied (imageUrl/imageUrls) they were already billed at
    // generation (edit_ad_image/generate_ad_image) — don't charge for them twice.
    const preMade = args.imageUrl || (Array.isArray(args.imageUrls) && args.imageUrls.length);
    if (preMade) { const i = keys.indexOf("ad_create_ai"); if (i >= 0) keys.splice(i, 1); }
    if (args.campaignType === "leads") keys.push("lead_form_create");
  }
  return keys;
}

/** Total cost + line items for a tool call.
 *  EVERYTHING the agent does is FULLY included in the client's subscription and is
 *  NEVER charged. This is a permanent no-op (always returns 0), which keeps the
 *  billed path wired but free: precheck is always affordable, commit() short-
 *  circuits, runBilled never blocks, and approval cards show no cost. Do not
 *  re-introduce per-action charging here — it must stay free by product decision. */
async function priceFor(toolName, args = {}) {
  return { cost: 0, items: [] };
}

async function balance(phone) {
  try {
    const u = await getDB().collection("users").findOne({ phone: String(phone) }, { projection: { coins: 1 } });
    return Number(u?.coins) || 0;
  } catch (_) { return 0; }
}

async function precheck(phone, toolName, args) {
  const { cost, items } = await priceFor(toolName, args);
  const bal = await balance(phone);
  return { ok: bal >= cost, cost, items, balance: bal, shortfall: Math.max(0, cost - bal) };
}

/* Atomic check-and-deduct (the {coins:{$gte}} filter prevents overspend races). */
async function commit(phone, toolName, cost, items, meta = {}) {
  if (cost <= 0) return { charged: 0, balance: await balance(phone) };
  const res = await getDB().collection("users").findOneAndUpdate(
    { phone: String(phone), coins: { $gte: cost } },
    { $inc: { coins: -cost }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!res) throw new Error("INSUFFICIENT_COINS");
  const newBal = Number(res.coins) || 0;
  await getDB().collection(TRANS_COL).insertOne({
    phone: String(phone), type: "deduct", amount: cost, action: toolName,
    items: (items || []).map(i => i.key), reason: `סוכן AI: ${toolName}`,
    source: "ai_agent", balance_after: newBal, created_at: new Date(), meta,
  });
  return { charged: cost, balance: newBal };
}

async function refund(phone, cost, toolName, meta = {}) {
  if (cost <= 0) return;
  try {
    const res = await getDB().collection("users").findOneAndUpdate(
      { phone: String(phone) }, { $inc: { coins: cost }, $set: { updatedAt: new Date() } }, { returnDocument: "after" },
    );
    await getDB().collection(TRANS_COL).insertOne({
      phone: String(phone), type: "refund", amount: cost, action: toolName,
      reason: `סוכן AI: החזר על פעולה שנכשלה (${toolName})`, source: "ai_agent",
      balance_after: Number(res?.coins) || null, created_at: new Date(), meta,
    });
  } catch (e) { console.warn("[billing] refund failed:", e.message); }
}

/**
 * runBilled({ phone, toolName, args, run }) — the billed execution wrapper.
 * Returns the action result + { coinsCharged, coinBalance }, OR
 * { status:"insufficient_coins", cost, balance, shortfall } if unaffordable.
 */
async function runBilled({ phone, toolName, args, run }) {
  const pre = await precheck(phone, toolName, args);
  if (!pre.ok) {
    return { status: "insufficient_coins", cost: pre.cost, balance: pre.balance, shortfall: pre.shortfall, items: pre.items };
  }
  let committed = null;
  if (pre.cost > 0) {
    try { committed = await commit(phone, toolName, pre.cost, pre.items, { args }); }
    catch (e) { return { status: "insufficient_coins", cost: pre.cost, balance: pre.balance, shortfall: pre.cost - pre.balance, items: pre.items }; }
  }
  try {
    const out = await run();
    return { ...out, coinsCharged: pre.cost, coinBalance: committed ? committed.balance : pre.balance };
  } catch (e) {
    if (committed) await refund(phone, pre.cost, toolName, { args, error: e.message });
    throw e;
  }
}

module.exports = { priceFor, precheck, commit, refund, balance, loadPrices, runBilled, keysFor, TOOL_PRICING };
