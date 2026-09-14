'use strict';

/**
 * invitations.routes.js — BillPilot client invitations
 */

const express = require('express');
const router  = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const { col, oid, normalizePhone, BpError } = require('../../services/bp-db');

function errRes(res, err) {
  return res.status(err.status || 500).json({ success: false, message: err.message });
}

// ─── PUBLIC: Accept invitation (no auth) ─────────────────────────────────────

// POST /api/bp/invitations/accept
router.post('/accept', async (req, res) => {
  try {
    const { code, phone, name } = req.body;
    if (!code) throw new BpError('code required', 400, 'VALIDATION');

    const invitation = await col('invitations').findOne({
      code,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    });

    if (!invitation) throw new BpError('Invitation not found or expired', 404, 'NOT_FOUND');

    // Resolve or create the client user
    let clientId = invitation.clientId;

    if (!clientId && phone) {
      const normalizedPhone = normalizePhone(phone);
      let user = await col('users').findOne({ phone: normalizedPhone, deletedAt: { $exists: false } });

      if (!user) {
        const now = new Date();
        const parts = (name || '').trim().split(/\s+/);

        // Create a minimal org for the client
        const orgResult = await col('orgs').insertOne({
          type: 'business',
          name: name || normalizedPhone,
          settings: { defaultVatRate: 17, currency: 'ILS' },
          createdAt: now,
          updatedAt: now,
        });

        const userResult = await col('users').insertOne({
          phone: normalizedPhone,
          role: 'client',
          organizationId: orgResult.insertedId,
          parentAccountantId: invitation.accountantId,
          profile: { firstName: parts[0] || 'משתמש', lastName: parts.slice(1).join(' ') || '-', language: 'he' },
          auth: { loginCount: 0 },
          pushTokens: [],
          permissions: [],
          createdAt: now,
          updatedAt: now,
        });

        clientId = userResult.insertedId;
      } else {
        clientId = user._id;
        // Link to accountant if not already linked
        if (!user.parentAccountantId) {
          await col('users').updateOne(
            { _id: clientId },
            { $set: { parentAccountantId: invitation.accountantId, updatedAt: new Date() } },
          );
        }
      }
    }

    // Mark invitation accepted
    await col('invitations').updateOne(
      { _id: invitation._id },
      { $set: { status: 'accepted', acceptedAt: new Date(), clientId, updatedAt: new Date() } },
    );

    res.json({ success: true, data: { clientId, invitationId: invitation._id } });
  } catch (err) {
    errRes(res, err);
  }
});

// ─── PROTECTED ────────────────────────────────────────────────────────────────

// GET /api/bp/invitations
router.get('/', bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const { user, tenantId } = req.bp;
    const invitations = await col('invitations')
      .find({ accountantId: user._id, tenantId: oid(tenantId) })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, data: invitations });
  } catch (err) {
    errRes(res, err);
  }
});

// POST /api/bp/invitations
router.post('/', bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const { user, tenantId } = req.bp;
    const { clientName, clientPhone, clientEmail, notes } = req.body;

    if (!clientName) throw new BpError('clientName required', 400, 'VALIDATION');

    const code = require('crypto').randomBytes(16).toString('hex');
    const now   = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invitation = {
      tenantId:     oid(tenantId),
      accountantId: user._id,
      clientName,
      clientPhone:  clientPhone ? normalizePhone(clientPhone) : null,
      clientEmail:  clientEmail || null,
      notes:        notes || '',
      code,
      status:       'pending',
      expiresAt,
      createdAt:    now,
      updatedAt:    now,
    };

    const result = await col('invitations').insertOne(invitation);
    res.status(201).json({ success: true, data: { ...invitation, _id: result.insertedId } });
  } catch (err) {
    errRes(res, err);
  }
});

// DELETE /api/bp/invitations/:id — cancel invitation
router.delete('/:id', bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const { user } = req.bp;
    const result = await col('invitations').findOneAndUpdate(
      { _id: oid(req.params.id), accountantId: user._id, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!result) throw new BpError('Invitation not found', 404, 'NOT_FOUND');
    res.json({ success: true });
  } catch (err) {
    errRes(res, err);
  }
});

module.exports = router;
