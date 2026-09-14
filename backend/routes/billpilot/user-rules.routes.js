const express = require('express');
const router = express.Router();
const { bpProtect } = require('../../middlewares/bp.middleware');
const { col, oid, nowISO } = require('../../services/bp-db');

// GET /api/bp/user-rules
router.get('/', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const rules = await col('user_rules').find({ userId, isActive: true }).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, data: rules });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/bp/user-rules
router.post('/', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const { ruleType, value, action } = req.body;
    if (!ruleType || !value || !action) {
      return res.status(400).json({ success: false, message: 'ruleType, value and action required' });
    }
    const VALID_TYPES = ['SENDER_EMAIL', 'SENDER_DOMAIN', 'SUBJECT_CONTAINS', 'LINK_DOMAIN'];
    const VALID_ACTIONS = ['ALWAYS_IGNORE', 'ALWAYS_SCAN', 'ALWAYS_MARK_AS_INVOICE', 'ALWAYS_MARK_AS_RECEIPT', 'ALWAYS_NEEDS_REVIEW'];
    if (!VALID_TYPES.includes(ruleType)) return res.status(400).json({ success: false, message: 'Invalid ruleType' });
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ success: false, message: 'Invalid action' });

    const now = nowISO();
    const result = await col('user_rules').insertOne({ userId, ruleType, value, action, isActive: true, createdAt: now, updatedAt: now });
    res.status(201).json({ success: true, data: { _id: result.insertedId } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/bp/user-rules/:id
router.delete('/:id', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    await col('user_rules').updateOne(
      { _id: oid(req.params.id), userId },
      { $set: { isActive: false, updatedAt: nowISO() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
