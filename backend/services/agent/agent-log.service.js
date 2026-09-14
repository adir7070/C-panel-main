'use strict';

/**
 * agent-log.service — append-only audit of every AI-agent decision + tool call
 * to the `agent_actions` collection. Clone of services/audit-log.service.js:
 * best-effort, NEVER throws (a logging failure must not break an agent run).
 *
 * One entry per reasoning step / tool call:
 *   { agentRunId, clientPhone, trigger, step, type, tool, args,
 *     policyDecision, policyReasons, status, approvalId,
 *     before, after, result, model, tokens, latencyMs, at }
 *   trigger ∈ proactive_cron | client_message | manager_invoked
 *   type    ∈ reasoning | tool_call
 *   status  ∈ executed | awaiting_approval | blocked | failed
 */

const { getDB } = require("../../config/db");

const col = () => getDB().collection("agent_actions");

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ agentRunId: 1, step: 1 });
    await col().createIndex({ clientPhone: 1, at: -1 });
    await col().createIndex({ status: 1, at: -1 });
    indexed = true;
  } catch (err) {
    console.warn("[agent-log] index ensure failed:", err.message);
  }
}

async function record(entry = {}) {
  try {
    await ensureIndexes();
    await col().insertOne({
      agentRunId:     entry.agentRunId     || null,
      clientPhone:    entry.clientPhone    || null,
      trigger:        entry.trigger        || null,
      step:           entry.step ?? null,
      type:           entry.type           || null,
      tool:           entry.tool           || null,
      args:           entry.args ?? null,
      policyDecision: entry.policyDecision || null,
      policyReasons:  entry.policyReasons  || null,
      status:         entry.status         || null,
      approvalId:     entry.approvalId      || null,
      before:         entry.before === undefined ? null : entry.before,
      after:          entry.after  === undefined ? null : entry.after,
      result:         entry.result ?? null,
      model:          entry.model          || null,
      tokens:         entry.tokens         || null,
      latencyMs:      entry.latencyMs ?? null,
      at:             new Date(),
    });
  } catch (err) {
    console.warn("[agent-log] record failed:", err.message);
  }
}

/** List agent actions with optional filters: { agentRunId, phone, status, from, to, limit }. */
async function list(filters = {}) {
  const q = {};
  if (filters.agentRunId) q.agentRunId  = filters.agentRunId;
  if (filters.phone)      q.clientPhone = String(filters.phone);
  if (filters.status)     q.status      = filters.status;
  if (filters.from || filters.to) {
    q.at = {};
    if (filters.from) q.at.$gte = new Date(filters.from);
    if (filters.to)   q.at.$lte = new Date(filters.to);
  }
  const limit = Math.min(parseInt(filters.limit, 10) || 100, 500);
  return col().find(q).sort({ at: -1 }).limit(limit).toArray();
}

module.exports = { record, list };
