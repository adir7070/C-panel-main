const express = require('express');
const router = express.Router();
const { bpProtect } = require('../../middlewares/bp.middleware');
const { col, oid, paginate } = require('../../services/bp-db');

// GET /api/bp/review-queue
router.get('/', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const { status = 'OPEN' } = req.query;
    const { page, limit, skip } = paginate(req.query);

    const [items, total] = await Promise.all([
      col('review_queue').find({ userId, status }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      col('review_queue').countDocuments({ userId, status }),
    ]);

    res.json({ success: true, data: { items, total, page, limit } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bp/review-queue/counts
router.get('/counts', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const counts = await col('review_queue').aggregate([
      { $match: { userId } },
      { $group: { _id: { status: '$status', reviewType: '$reviewType' }, count: { $sum: 1 } } },
    ]).toArray();

    const result = {};
    for (const c of counts) {
      const { status, reviewType } = c._id;
      if (!result[status]) result[status] = {};
      result[status][reviewType] = c.count;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/bp/review-queue/:id/resolve
router.patch('/:id/resolve', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const { action } = req.body;
    const result = await col('review_queue').findOneAndUpdate(
      { _id: oid(req.params.id), userId },
      { $set: { status: 'RESOLVED', resolvedAction: action, resolvedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// PATCH /api/bp/review-queue/:id/dismiss
router.patch('/:id/dismiss', ...bpProtect, async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const result = await col('review_queue').findOneAndUpdate(
      { _id: oid(req.params.id), userId },
      { $set: { status: 'DISMISSED', resolvedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
