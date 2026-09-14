'use strict';

const { col, oid } = require('./bp-db');

// ─── Create Audit Log ─────────────────────────────────────────────────────────

/**
 * Inserts an audit log entry into bp_audit_logs.
 * Errors are swallowed — audit failures must never break the main flow.
 * @param {{
 *   tenantId?: string,
 *   actorId?: string,
 *   actorRole?: string,
 *   action: string,
 *   targetType?: string,
 *   targetId?: string,
 *   changes?: { before?: object, after?: object },
 *   metadata?: object,
 *   ip?: string,
 *   userAgent?: string
 * }} entry
 * @returns {Promise<void>}
 */
async function createAuditLog(entry) {
  try {
    const doc = {
      action: entry.action,
      createdAt: new Date(),
    };

    if (entry.tenantId) {
      try { doc.tenantId = oid(entry.tenantId); } catch { doc.tenantId = entry.tenantId; }
    }
    if (entry.actorId) {
      try { doc.actorId = oid(entry.actorId); } catch { doc.actorId = entry.actorId; }
    }
    if (entry.actorRole) doc.actorRole = entry.actorRole;
    if (entry.targetType) doc.targetType = entry.targetType;
    if (entry.targetId) {
      try { doc.targetId = oid(entry.targetId); } catch { doc.targetId = entry.targetId; }
    }
    if (entry.changes) doc.changes = entry.changes;
    if (entry.metadata) doc.metadata = entry.metadata;
    if (entry.ip) doc.ip = entry.ip;
    if (entry.userAgent) doc.userAgent = entry.userAgent;

    await col('audit_logs').insertOne(doc);
  } catch (err) {
    // Audit log failures should never propagate
    console.error('[Audit] Failed to create audit log', { err, entry });
  }
}

// ─── Audit From Request ───────────────────────────────────────────────────────

/**
 * Extracts actor info from an Express request (via req.bp set by auth middleware)
 * and calls createAuditLog.
 * @param {import('express').Request} req
 * @param {string} action
 * @param {{
 *   targetType?: string,
 *   targetId?: string,
 *   changes?: object,
 *   metadata?: object
 * }} [extra={}]
 * @returns {Promise<void>}
 */
function auditFromRequest(req, action, extra = {}) {
  const bp = req.bp || req.user || {};

  return createAuditLog({
    tenantId: bp.tenantId || undefined,
    actorId: bp.userId || bp._id || undefined,
    actorRole: bp.role || undefined,
    action,
    ip: req.ip,
    userAgent: req.headers && req.headers['user-agent'],
    ...extra,
  });
}

module.exports = { createAuditLog, auditFromRequest };
