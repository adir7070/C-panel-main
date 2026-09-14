const express = require('express');
const router = express.Router();
const { bpProtect } = require('../../middlewares/bp.middleware');
const { col, oid, nowISO } = require('../../services/bp-db');

// GET /api/bp/users/me
router.get('/me', ...bpProtect, async (req, res) => {
  try {
    res.json({ success: true, data: req.bp.user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/bp/users/me
router.patch('/me', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const { firstName, lastName, language, timezone } = req.body;
    const update = {};
    if (firstName) update['profile.firstName'] = firstName;
    if (lastName) update['profile.lastName'] = lastName;
    if (language) update['profile.language'] = language;
    if (timezone) update['profile.timezone'] = timezone;
    update.updatedAt = nowISO();

    const result = await col('users').findOneAndUpdate(
      { _id: userId },
      { $set: update },
      { returnDocument: 'after' }
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/bp/users/me/push-token
router.post('/me/push-token', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const { token, platform = 'ios', deviceId } = req.body;
    if (!token || !deviceId) return res.status(400).json({ success: false, message: 'token and deviceId required' });

    // Remove any existing token for this device, then add new one
    await col('users').updateOne({ _id: userId }, {
      $pull: { pushTokens: { deviceId } },
    });
    await col('users').updateOne({ _id: userId }, {
      $push: { pushTokens: { token, platform, deviceId, registeredAt: nowISO() } },
      $set: { updatedAt: nowISO() },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/bp/users/me/push-token/:deviceId
router.delete('/me/push-token/:deviceId', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    await col('users').updateOne({ _id: userId }, {
      $pull: { pushTokens: { deviceId: req.params.deviceId } },
      $set: { updatedAt: nowISO() },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
