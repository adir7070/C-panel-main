/**
 * audit-log.service — write/read entries to `audit_log` collection.
 *
 * Every admin (or sensitive manager) action should funnel through here so
 * we have a complete, immutable record of who did what, when. Spec:
 * docs/ADMIN-PANEL-SPEC.md sec 2.13.
 *
 * Schema per doc:
 *   {
 *     actor:   { id, name, role },         // who
 *     action:  "manager.transfer_clients", // dotted action key
 *     target:  { kind, id, label },        // what
 *     before:  any,                        // pre-state
 *     after:   any,                        // post-state
 *     meta:    any,                  // extra context (reason, etc.)
 *     at:      Date,
 *   }
 */

const { getDB } = require("../config/db");

const col = () => getDB().collection("audit_log");

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ at: -1 });
    await col().createIndex({ "actor.id": 1, at: -1 });
    await col().createIndex({ action: 1, at: -1 });
    await col().createIndex({ "target.kind": 1, "target.id": 1, at: -1 });
    indexed = true;
  } catch (err) {
    console.warn("[audit] index ensure failed:", err.message);
  }
}

/**
 * Write one audit entry. Best-effort — never throws (audit failure must
 * not block the underlying action).
 */
async function record(entry) {
  try {
    await ensureIndexes();
    await col().insertOne({
      actor:  entry.actor  || null,
      action: entry.action || "unknown",
      target: entry.target || null,
      before: entry.before === undefined ? null : entry.before,
      after:  entry.after  === undefined ? null : entry.after,
      meta:   entry.meta   || null,
      at:     new Date(),
    });
  } catch (err) {
    console.warn("[audit] record failed:", err.message);
  }
}

/** Convenience: pull actor info from req.agent. */
function actorFromReq(req) {
  const a = req.agent || {};
  return {
    id:   a._id ? String(a._id) : null,
    name: a.nickname || a.name || null,
    role: a.role || null,
  };
}

/**
 * List audit entries with optional filters.
 *   { actor, action, kind, id, from, to, limit }
 */
async function list(filters = {}) {
  const q = {};
  if (filters.actor)  q["actor.id"] = String(filters.actor);
  if (filters.action) q.action      = filters.action;
  if (filters.kind)   q["target.kind"] = filters.kind;
  if (filters.id)     q["target.id"]   = String(filters.id);
  if (filters.from || filters.to) {
    q.at = {};
    if (filters.from) q.at.$gte = new Date(filters.from);
    if (filters.to)   q.at.$lte = new Date(filters.to);
  }
  const limit = Math.min(parseInt(filters.limit, 10) || 100, 500);
  return col().find(q).sort({ at: -1 }).limit(limit).toArray();
}

module.exports = { record, list, actorFromReq };
