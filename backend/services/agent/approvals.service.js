'use strict';

/**
 * approvals.service — the queue for SENSITIVE agent actions that need a human
 * (client or manager) yes/no before they touch Facebook.
 *
 * Flow: loop.js classifies a write as "approval" → create() a pending card →
 * the client taps אשר in the app (or the manager in CPANEL) → approve() RE-checks
 * policy at execution time (caps/kill-switch may have changed; the proposal may
 * be stale) and only then runs the registry handler. reject() just closes it.
 *
 * `expiresAt` (+24h) means a forgotten approval never fires late.
 */

const { ObjectId } = require("mongodb");
const { getDB } = require("../../config/db");
const registry = require("./registry");
const policy = require("./policy.engine");
const agentLog = require("./agent-log.service");

const col = () => getDB().collection("agent_approvals");
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ clientPhone: 1, status: 1, createdAt: -1 });
    await col().createIndex({ status: 1, expiresAt: 1 });
    indexed = true;
  } catch (e) { console.warn("[approvals] index ensure failed:", e.message); }
}

/** Queue a pending approval card. Returns { approvalId, expiresAt }. */
async function create({ agentRunId, phone, tool, args, summary, policyReasons, cost }) {
  await ensureIndexes();
  const now = new Date();
  const doc = {
    agentRunId: agentRunId || null,
    clientPhone: String(phone),
    tool, args: args || {},
    summary: summary || tool,
    reason: args?.reason || null,
    policyReasons: policyReasons || [],
    cost: Number(cost) || 0,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    decidedAt: null, decidedBy: null, result: null,
  };
  const { insertedId } = await col().insertOne(doc);
  return { approvalId: insertedId.toString(), expiresAt: doc.expiresAt };
}

function byId(id) {
  let _id; try { _id = new ObjectId(String(id)); } catch { return null; }
  return col().findOne({ _id });
}

/** Pending (non-expired) approvals for a client. */
async function listPending(phone) {
  const q = { status: "pending", expiresAt: { $gt: new Date() } };
  if (phone) q.clientPhone = String(phone);
  return col().find(q).sort({ createdAt: -1 }).limit(50).toArray();
}

/**
 * Approve → re-validate policy → execute via the registry handler.
 * Returns { ok, status, result?, error? }.
 */
async function approve(approvalId, approver = "client") {
  let _id; try { _id = new ObjectId(String(approvalId)); } catch { return { ok: false, status: "not_found", error: "approval not found" }; }
  // ATOMIC CLAIM: only the FIRST concurrent approve flips pending→processing and
  // proceeds. Double-taps / poll retries find it non-pending and bail — otherwise
  // each would execute (e.g. 4 launch_campaign calls → 4 real campaigns).
  const appr = await col().findOneAndUpdate(
    { _id, status: "pending" },
    { $set: { status: "processing", decidedAt: new Date(), decidedBy: approver } },
    { returnDocument: "after" },
  );
  if (!appr) {
    const cur = await col().findOne({ _id }, { projection: { status: 1 } });
    return { ok: false, status: cur?.status || "not_found", alreadyHandled: true, error: cur ? `already ${cur.status}` : "approval not found" };
  }
  if (appr.expiresAt && appr.expiresAt < new Date()) {
    await col().updateOne({ _id: appr._id }, { $set: { status: "expired", decidedAt: new Date() } });
    return { ok: false, status: "expired", error: "approval expired" };
  }

  const tool = registry.getTool(appr.tool);
  if (!tool || !tool.run) return { ok: false, status: "error", error: `unknown tool ${appr.tool}` };

  // Re-assemble live context to re-check policy + get fresh creds (tokens rotate).
  const { assembleContext } = require("./context");
  const { view, creds, campaigns, monthSpend } = await assembleContext(appr.clientPhone);

  const recheck = await policy.classify(appr.tool, appr.args, { phone: appr.clientPhone, campaigns, monthSpend });
  if (recheck.decision === "block") {
    await col().updateOne({ _id: appr._id }, { $set: { status: "blocked", decidedAt: new Date(), decidedBy: approver, result: { reasons: recheck.reasons } } });
    await agentLog.record({ agentRunId: appr.agentRunId, clientPhone: appr.clientPhone, type: "tool_call", tool: appr.tool, args: appr.args, status: "blocked", policyDecision: "block", policyReasons: recheck.reasons, approvalId });
    return { ok: false, status: "blocked", error: recheck.reasons.join("; ") };
  }

  try {
    // billed execution: precheck balance → deduct → run → refund on failure
    const billing = require("./billing.service");
    const result = await billing.runBilled({
      phone: appr.clientPhone, toolName: appr.tool, args: appr.args,
      run: () => tool.run(appr.args, { phone: appr.clientPhone, creds, view, campaigns }),
    });
    if (result.status === "insufficient_coins") {
      await col().updateOne({ _id: appr._id }, { $set: { status: "insufficient_coins", decidedAt: new Date(), decidedBy: approver, result } });
      await agentLog.record({ agentRunId: appr.agentRunId, clientPhone: appr.clientPhone, type: "tool_call", tool: appr.tool, args: appr.args, status: "blocked", result, approvalId });
      return { ok: false, status: "insufficient_coins", cost: result.cost, balance: result.balance, shortfall: result.shortfall };
    }
    await col().updateOne({ _id: appr._id }, { $set: { status: "executed", decidedAt: new Date(), decidedBy: approver, result } });
    await agentLog.record({ agentRunId: appr.agentRunId, clientPhone: appr.clientPhone, type: "tool_call", tool: appr.tool, args: appr.args, status: "executed", policyDecision: "approval", policyReasons: appr.policyReasons, result, approvalId });
    return { ok: true, status: "executed", result };
  } catch (e) {
    const error = e.response?.data?.error?.message || e.message;
    await col().updateOne({ _id: appr._id }, { $set: { status: "failed", decidedAt: new Date(), decidedBy: approver, result: { error } } });
    await agentLog.record({ agentRunId: appr.agentRunId, clientPhone: appr.clientPhone, type: "tool_call", tool: appr.tool, args: appr.args, status: "failed", result: { error }, approvalId });
    return { ok: false, status: "failed", error };
  }
}

async function reject(approvalId, approver = "client") {
  const appr = await byId(approvalId);
  if (!appr) return { ok: false, status: "not_found" };
  if (appr.status !== "pending") return { ok: false, status: appr.status };
  await col().updateOne({ _id: appr._id }, { $set: { status: "rejected", decidedAt: new Date(), decidedBy: approver } });
  await agentLog.record({ agentRunId: appr.agentRunId, clientPhone: appr.clientPhone, type: "tool_call", tool: appr.tool, args: appr.args, status: "rejected", approvalId });
  return { ok: true, status: "rejected" };
}

module.exports = { create, approve, reject, listPending, byId, ensureIndexes };
