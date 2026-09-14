const express = require('express');
const router = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const { col, oid, nowISO } = require('../../services/bp-db');

// GET /api/bp/integrations
router.get('/', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const tenantId = req.bp.tenantId;
    const integrations = await col('integrations').find({ tenantId }).toArray();
    res.json({ success: true, data: integrations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/bp/integrations
router.post('/', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const tenantId = req.bp.tenantId;
    const { type, name, credentials = {}, settings = {} } = req.body;
    if (!type) return res.status(400).json({ success: false, message: 'type required' });

    const now = nowISO();
    const result = await col('integrations').insertOne({
      tenantId, type, name: name || type, credentials, settings,
      isActive: true, stats: { totalExported: 0 },
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ success: true, data: { _id: result.insertedId } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/bp/integrations/:id
router.patch('/:id', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const tenantId = req.bp.tenantId;
    const { name, credentials, settings, isActive } = req.body;
    const update = { updatedAt: nowISO() };
    if (name !== undefined) update.name = name;
    if (credentials !== undefined) update.credentials = credentials;
    if (settings !== undefined) update.settings = settings;
    if (isActive !== undefined) update.isActive = isActive;

    const result = await col('integrations').findOneAndUpdate(
      { _id: oid(req.params.id), tenantId },
      { $set: update },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// DELETE /api/bp/integrations/:id
router.delete('/:id', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const tenantId = req.bp.tenantId;
    await col('integrations').deleteOne({ _id: oid(req.params.id), tenantId });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
