'use strict';

const express = require('express');
const router = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const bpExport = require('../../services/bp-export.service');
const { queueExportDocuments } = require('../../jobs/bp-jobs');
const { downloadFileById } = require('../../services/backblaze.service');

function err(res, e) {
  return res.status(e.status || 500).json({ success: false, message: e.message });
}

// GET /api/bp/export/preview
router.get('/preview', ...bpProtect, async (req, res) => {
  try {
    const data = await bpExport.previewExport(req.bp.tenantId, req.query);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/export
router.post('/', ...bpProtect, async (req, res) => {
  try {
    const job = await bpExport.createExportJob(req.bp.tenantId, req.bp.user._id, req.body.filters || req.body);
    res.status(201).json({ success: true, data: job });
    // Queue async
    await queueExportDocuments(job._id).catch(() => {
      bpExport.runExportJob(job._id.toString()).catch(e => console.error('[bp export] failed:', e.message));
    });
  } catch (e) { err(res, e); }
});

// GET /api/bp/export
router.get('/', ...bpProtect, async (req, res) => {
  try {
    const data = await bpExport.listExports(req.bp.tenantId, req.bp.user._id);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// GET /api/bp/export/:id
router.get('/:id', ...bpProtect, async (req, res) => {
  try {
    const data = await bpExport.getExport(req.bp.tenantId, req.params.id);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// GET /api/bp/export/:id/download — accepts X-Phone header OR ?phone= query param (for Linking.openURL)
router.get('/:id/download', async (req, res) => {
  try {
    const { normalizePhone, col, oid } = require('../../services/bp-db');
    const rawPhone = req.headers['x-phone'] || req.query.phone;
    if (!rawPhone) return res.status(401).json({ success: false, message: 'phone required' });
    const phone = normalizePhone(rawPhone);
    const user = await col('users').findOne({ phone, deletedAt: { $exists: false } });
    if (!user) return res.status(401).json({ success: false, message: 'unauthorized' });
    let tenantId = user.organizationId;
    if (user.role === 'client' && user.parentAccountantId) {
      const accountant = await col('users').findOne({ _id: user.parentAccountantId });
      if (accountant) tenantId = accountant.organizationId;
    }

    const job = await bpExport.getExport(tenantId, req.params.id);
    if (job.status !== 'completed') {
      return res.status(400).json({ success: false, message: `Export status: ${job.status}` });
    }
    if (job.result?.expiresAt && new Date(job.result.expiresAt) < new Date()) {
      return res.status(410).json({ success: false, message: 'Export expired' });
    }
    const result = await downloadFileById(job.result.b2FileId);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="export_${job._id}.zip"`);
    res.send(result.buffer);
  } catch (e) { err(res, e); }
});

module.exports = router;
