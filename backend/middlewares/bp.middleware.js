'use strict';

/**
 * BillPilot middleware for iconiq-server.
 *
 * Ported from BillPilot's auth.middleware.ts, tenant.middleware.ts,
 * and rbac.middleware.ts — using the raw MongoDB driver (no Mongoose).
 *
 * All BP collections are accessed via col() from bp-db (prefix: bp_).
 *
 * Auth identity: X-Phone header (or ?phone query param).
 * After bpAuth  → req.bp = { user, phone }
 * After bpTenant → req.bp.tenantId is set
 */

const { col, normalizePhone } = require('../services/bp-db');

// ---------------------------------------------------------------------------
// bpAuth
// ---------------------------------------------------------------------------

/**
 * Reads the X-Phone header (or req.query.phone), normalizes the number, and
 * looks up the user in bp_users. Populates req.bp = { user, phone }.
 *
 * Returns 401 if the header is missing or the user is not found.
 *
 * @type {import('express').RequestHandler}
 */
async function bpAuth(req, res, next) {
  try {
    const rawPhone =
      req.headers['x-phone'] ||
      (typeof req.query.phone === 'string' ? req.query.phone : undefined);

    if (!rawPhone) {
      return res.status(401).json({
        error: 'AUTH_PHONE_MISSING',
        message: 'X-Phone header is required',
      });
    }

    const phone = normalizePhone(rawPhone);

    const user = await col('users').findOne({
      phone,
      deletedAt: { $exists: false },
    });

    if (!user) {
      return res.status(401).json({
        error: 'AUTH_USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    req.bp = { user, phone };
    next();
  } catch (err) {
    console.error('[bpAuth]', err.message);
    res.status(500).json({ error: 'AUTH_ERROR', message: 'Authentication error' });
  }
}

// ---------------------------------------------------------------------------
// bpTenant
// ---------------------------------------------------------------------------

/**
 * Resolves the tenantId for the authenticated BP user and attaches it to
 * req.bp.tenantId. Must run after bpAuth.
 *
 * - super_admin / accountant / team_member → tenantId = their own organizationId
 * - client with parentAccountantId → tenantId = that accountant's organizationId
 * - client without parentAccountantId → tenantId = their own organizationId
 *
 * @type {import('express').RequestHandler}
 */
async function bpTenant(req, res, next) {
  try {
    if (!req.bp || !req.bp.user) {
      return res.status(401).json({
        error: 'AUTH_REQUIRED',
        message: 'Authentication required',
      });
    }

    const { user } = req.bp;
    const { role, organizationId, parentAccountantId } = user;

    if (
      role === 'super_admin' ||
      role === 'accountant' ||
      role === 'team_member'
    ) {
      // These roles use their own organization as the tenant scope
      const tenantId = organizationId ? organizationId.toString() : null;
      req.bp.tenantId = tenantId;
      return next();
    }

    if (role === 'client') {
      if (parentAccountantId) {
        // Resolve the accountant's organizationId
        const { ObjectId } = require('mongodb');
        let accountantQuery;
        try {
          accountantQuery = { _id: new ObjectId(parentAccountantId.toString()) };
        } catch {
          accountantQuery = { _id: parentAccountantId };
        }

        const accountant = await col('users').findOne(accountantQuery, {
          projection: { organizationId: 1 },
        });

        if (!accountant) {
          console.warn(
            `[bpTenant] client ${user._id} has invalid parentAccountantId ${parentAccountantId}`,
          );
          return res.status(500).json({
            error: 'TENANT_RESOLUTION_FAILED',
            message: 'Invalid account configuration',
          });
        }

        req.bp.tenantId = accountant.organizationId
          ? accountant.organizationId.toString()
          : null;
        return next();
      }

      // Client without a linked accountant — fall back to their own org
      req.bp.tenantId = organizationId ? organizationId.toString() : null;
      return next();
    }

    // Unknown role — still set tenantId to own org if available
    req.bp.tenantId = organizationId ? organizationId.toString() : null;
    next();
  } catch (err) {
    console.error('[bpTenant]', err.message);
    res.status(500).json({ error: 'TENANT_ERROR', message: 'Tenant resolution error' });
  }
}

// ---------------------------------------------------------------------------
// bpRequireRole
// ---------------------------------------------------------------------------

/**
 * Factory middleware that restricts access to users with one of the given roles.
 * super_admin always passes regardless of the role list.
 *
 * @param {...string} roles - Allowed role strings (e.g. 'accountant', 'super_admin')
 * @returns {import('express').RequestHandler}
 *
 * @example
 *   router.get('/reports', bpProtect, bpRequireRole('accountant', 'super_admin'), handler)
 */
function bpRequireRole(...roles) {
  return function (req, res, next) {
    if (!req.bp || !req.bp.user) {
      return res.status(401).json({
        error: 'AUTH_REQUIRED',
        message: 'Authentication required',
      });
    }

    const { role } = req.bp.user;

    // super_admin bypasses all role restrictions
    if (role === 'super_admin') return next();

    if (!roles.includes(role)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `Access denied. Required roles: ${roles.join(', ')}`,
      });
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// bpRequirePermission
// ---------------------------------------------------------------------------

/**
 * Factory middleware that checks a named permission on team_member users.
 * super_admin and accountant always pass. Clients are denied unless they
 * happen to hold the permission.
 *
 * @param {string} permission - Permission key (e.g. 'manage_documents')
 * @returns {import('express').RequestHandler}
 *
 * @example
 *   router.post('/docs', bpProtect, bpRequirePermission('manage_documents'), handler)
 */
function bpRequirePermission(permission) {
  return function (req, res, next) {
    if (!req.bp || !req.bp.user) {
      return res.status(401).json({
        error: 'AUTH_REQUIRED',
        message: 'Authentication required',
      });
    }

    const { role, permissions } = req.bp.user;

    // super_admin and accountant have all permissions implicitly
    if (role === 'super_admin' || role === 'accountant') return next();

    if (role === 'team_member') {
      if (!Array.isArray(permissions) || !permissions.includes(permission)) {
        return res.status(403).json({
          error: 'PERMISSION_DENIED',
          message: `Missing required permission: ${permission}`,
        });
      }
      return next();
    }

    // Any other role (e.g. client) is denied
    res.status(403).json({ error: 'FORBIDDEN', message: 'Access denied' });
  };
}

// ---------------------------------------------------------------------------
// bpProtect — convenience shortcut
// ---------------------------------------------------------------------------

/**
 * Combined [bpAuth, bpTenant] middleware array.
 * Use as the standard protection stack on all BP routes.
 *
 * @example
 *   router.get('/invoices', bpProtect, handler)
 *   router.get('/invoices', [...bpProtect, bpRequireRole('accountant')], handler)
 */
const bpProtect = [bpAuth, bpTenant];

// ---------------------------------------------------------------------------

module.exports = { bpAuth, bpTenant, bpRequireRole, bpRequirePermission, bpProtect };
