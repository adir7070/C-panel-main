const express = require('express');
const router = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const { col, oid } = require('../../services/bp-db');

// GET /api/bp/dashboard/stats
router.get('/stats', ...bpProtect, async (req, res) => {
  try {
    const tenantId = req.bp.tenantId;
    const userId = req.bp.user._id;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalClients, pendingApproval, duplicates, needsClientReview, monthlyAgg] = await Promise.all([
      col('users').countDocuments({ parentAccountantId: userId, deletedAt: { $exists: false } }),
      col('documents').countDocuments({ tenantId, status: 'pending_review', deletedAt: { $exists: false } }),
      col('documents').countDocuments({ tenantId, 'flags.isDuplicate': true, status: 'pending_review', deletedAt: { $exists: false } }),
      col('documents').countDocuments({ tenantId, status: 'needs_client_review', deletedAt: { $exists: false } }),
      col('documents').aggregate([
        {
          $match: {
            tenantId,
            $or: [
              { 'extraction.dates.issued': { $gte: startOfMonth } },
              { 'extraction.dates.issued': { $exists: false }, createdAt: { $gte: startOfMonth } },
            ],
            status: { $in: ['pending_review', 'approved', 'exported'] },
            deletedAt: { $exists: false },
          },
        },
        { $group: { _id: { $ifNull: ['$extraction.currency', 'ILS'] }, total: { $sum: '$extraction.amounts.total' } } },
      ]).toArray(),
    ]);

    const byCurrency = {};
    for (const row of monthlyAgg) byCurrency[row._id] = row.total;
    const thisMonthTotal = byCurrency['ILS'] ?? Object.values(byCurrency)[0] ?? 0;

    res.json({
      success: true,
      data: { totalClients, pendingApproval, duplicates, needsClientReview, thisMonthTotal, thisMonthByCurrency: byCurrency },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bp/dashboard/activity
router.get('/activity', ...bpProtect, async (req, res) => {
  try {
    const tenantId = req.bp.tenantId;
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    const docs = await col('documents').find(
      { tenantId, deletedAt: { $exists: false } },
      { projection: { status: 1, createdAt: 1, updatedAt: 1, 'extraction.vendor.name': 1, 'extraction.amounts.total': 1, clientId: 1 } }
    ).sort({ updatedAt: -1 }).limit(limit).toArray();

    res.json({ success: true, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bp/dashboard/email-engine
router.get('/email-engine', ...bpProtect, bpRequireRole('accountant', 'team_member', 'super_admin'), async (req, res) => {
  try {
    const userId = req.bp.user._id;
    const [connections, recentRun, queueStats] = await Promise.all([
      col('email_connections').find({ userId, isActive: true }).toArray(),
      col('sync_runs').findOne({ userId }, { sort: { startedAt: -1 } }),
      col('email_sync_items').aggregate([
        { $match: { userId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const queueByStatus = {};
    for (const s of queueStats) queueByStatus[s._id] = s.count;

    res.json({ success: true, data: { connections, recentRun, queueByStatus } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
