'use strict';

const express = require('express');
const router = express.Router();
const { bpProtect } = require('../../middlewares/bp.middleware');
const { getNotifications, markRead, markAllRead } = require('../../services/bp-notifications.service');

function err(res, e) {
  return res.status(e.status || 500).json({ success: false, message: e.message });
}

// GET /api/bp/notifications
router.get('/', ...bpProtect, async (req, res) => {
  try {
    const data = await getNotifications(req.bp.user._id, req.query);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// PATCH /api/bp/notifications/:id/read
router.patch('/:id/read', ...bpProtect, async (req, res) => {
  try {
    await markRead(req.params.id, req.bp.user._id);
    res.json({ success: true });
  } catch (e) { err(res, e); }
});

// POST /api/bp/notifications/read-all
router.post('/read-all', ...bpProtect, async (req, res) => {
  try {
    await markAllRead(req.bp.user._id);
    res.json({ success: true });
  } catch (e) { err(res, e); }
});

module.exports = router;
