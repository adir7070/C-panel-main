/**
 * Internal routes — called by iconiq-server itself, no bp auth required.
 * POST /api/bp/internal/provision — upsert user by phone
 */
const express = require('express');
const router = express.Router();
const { col, normalizePhone, nowISO } = require('../../services/bp-db');
const { seedDefaultCategories } = require('../../services/bp-categories.service');

router.post('/provision', async (req, res) => {
  try {
    const { phone: rawPhone, name, role } = req.body;
    if (!rawPhone) return res.status(400).json({ success: false, message: 'phone required' });

    const phone = normalizePhone(rawPhone);
    const userRole = role === 'accountant' ? 'accountant' : 'client';
    const now = nowISO();

    const existing = await col('users').findOne({ phone, deletedAt: { $exists: false } });
    if (existing) {
      return res.json({ success: true, data: { userId: existing._id, phone, isNew: false } });
    }

    const parts = (name || '').trim().split(/\s+/);
    const firstName = parts[0] || 'משתמש';
    const lastName = parts.slice(1).join(' ') || '-';

    // Create org
    const orgResult = await col('orgs').insertOne({
      type: userRole === 'accountant' ? 'accounting_firm' : 'business',
      name: name || phone,
      settings: {
        defaultVatRate: 17,
        currency: 'ILS',
        autoApproveEnabled: false,
        confidenceThresholds: { autoApprove: 90, needsReview: 70 },
        duplicateWindowDays: 30,
      },
      createdAt: now,
      updatedAt: now,
    });

    // Create user
    const userResult = await col('users').insertOne({
      phone,
      role: userRole,
      organizationId: orgResult.insertedId,
      profile: { firstName, lastName, language: 'he', timezone: 'Asia/Jerusalem' },
      auth: { loginCount: 0 },
      pushTokens: [],
      permissions: [],
      createdAt: now,
      updatedAt: now,
    });

    console.log(`[BpProvision] new user ${phone} role=${userRole} id=${userResult.insertedId}`);

    // Seed default categories for new org (non-blocking)
    seedDefaultCategories(orgResult.insertedId.toString()).catch(e =>
      console.error('[BpProvision] seed categories failed:', e.message)
    );

    res.status(201).json({ success: true, data: { userId: userResult.insertedId, phone, isNew: true } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
