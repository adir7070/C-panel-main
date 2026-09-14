const express = require('express');
const router = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const { col } = require('../../services/bp-db');

// GET /api/bp/reports/summary?from=&to=&groupBy=month|category|vendor
router.get('/summary', ...bpProtect, async (req, res) => {
  try {
    const tenantId = req.bp.tenantId;
    const { from, to, groupBy = 'month', clientId } = req.query;

    const match = {
      tenantId,
      status: { $in: ['approved', 'exported', 'pending_review'] },
      deletedAt: { $exists: false },
    };
    if (from) match['extraction.dates.issued'] = { $gte: new Date(from) };
    if (to) match['extraction.dates.issued'] = { ...match['extraction.dates.issued'], $lte: new Date(to) };
    if (clientId) match.clientId = clientId;

    let groupStage;
    if (groupBy === 'vendor') {
      groupStage = { $group: { _id: '$extraction.vendor.name', total: { $sum: '$extraction.amounts.total' }, count: { $sum: 1 } } };
    } else if (groupBy === 'category') {
      groupStage = { $group: { _id: '$category.name', total: { $sum: '$extraction.amounts.total' }, count: { $sum: 1 } } };
    } else {
      // month
      groupStage = {
        $group: {
          _id: {
            year: { $year: { $ifNull: ['$extraction.dates.issued', '$createdAt'] } },
            month: { $month: { $ifNull: ['$extraction.dates.issued', '$createdAt'] } },
          },
          total: { $sum: '$extraction.amounts.total' },
          count: { $sum: 1 },
        },
      };
    }

    const data = await col('documents').aggregate([
      { $match: match },
      groupStage,
      { $sort: { _id: 1 } },
    ]).toArray();

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bp/reports/export — quick CSV export
router.get('/export', ...bpProtect, async (req, res) => {
  try {
    const tenantId = req.bp.tenantId;
    const { from, to, clientId } = req.query;

    const match = {
      tenantId,
      status: { $in: ['approved', 'exported', 'pending_review'] },
      deletedAt: { $exists: false },
    };
    if (from) match['extraction.dates.issued'] = { $gte: new Date(from) };
    if (to) match['extraction.dates.issued'] = { ...match['extraction.dates.issued'], $lte: new Date(to) };
    if (clientId) match.clientId = clientId;

    const docs = await col('documents').find(match).sort({ 'extraction.dates.issued': -1 }).limit(1000).toArray();

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('מסמכים');

    ws.columns = [
      { header: 'ספק', key: 'vendor', width: 25 },
      { header: 'תאריך', key: 'date', width: 15 },
      { header: 'סכום', key: 'amount', width: 12 },
      { header: 'מע"מ', key: 'vat', width: 12 },
      { header: 'סטטוס', key: 'status', width: 15 },
      { header: 'קטגוריה', key: 'category', width: 20 },
      { header: 'מספר מסמך', key: 'docNumber', width: 18 },
    ];

    for (const doc of docs) {
      ws.addRow({
        vendor: doc.extraction?.vendor?.name || '',
        date: doc.extraction?.dates?.issued ? new Date(doc.extraction.dates.issued).toLocaleDateString('he-IL') : '',
        amount: doc.extraction?.amounts?.total || '',
        vat: doc.extraction?.amounts?.vatAmount || '',
        status: doc.status,
        category: doc.category?.name || '',
        docNumber: doc.extraction?.documentNumber || '',
      });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="documents.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
