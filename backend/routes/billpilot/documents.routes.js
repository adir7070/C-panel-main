'use strict';

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const { col, oid, nowISO, paginate } = require('../../services/bp-db');
const bpDocs = require('../../services/bp-docs.service');
const { uploadImage } = require('../../services/backblaze.service');
const { queueProcessDocument } = require('../../jobs/bp-jobs');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function err(res, e) {
  return res.status(e.status || 500).json({ success: false, message: e.message });
}

// GET /api/bp/documents
router.get('/', ...bpProtect, async (req, res) => {
  try {
    const result = await bpDocs.listDocuments(req.bp.tenantId, req.query);
    res.json({ success: true, ...result });
  } catch (e) { err(res, e); }
});

// GET /api/bp/documents/vendors-summary
router.get('/vendors-summary', ...bpProtect, async (req, res) => {
  try {
    const data = await bpDocs.getVendorsSummary(req.bp.tenantId, req.query);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/upload
router.post('/upload', ...bpProtect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'file required' });

    const phone = req.bp.user.phone;
    const ts = Date.now();
    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const b2Key = `billpilot/${req.bp.tenantId}/${phone}/${ts}.${ext}`;

    const b2Result = await uploadImage(b2Key, req.file.buffer, req.file.mimetype);

    const doc = await bpDocs.createDocumentRecord(
      req.bp.tenantId,
      req.bp.user._id,
      req.bp.user._id,
      {
        b2Key,
        b2FileId: b2Result.fileId,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
      },
      'web_upload',
    );

    res.status(201).json({ success: true, data: doc });

    // Queue OCR async
    const fileBuffer = req.file.buffer;
    const fileMime = req.file.mimetype;
    try { await queueProcessDocument(doc._id); } catch {
      // Fallback: inline OCR if Agenda not ready
      const { runOcrPipeline } = require('../../services/bp-ocr.service');
      runOcrPipeline(fileBuffer, fileMime)
        .then(ocrResult => bpDocs.postProcessDocument(req.bp.tenantId.toString(), doc._id.toString(), ocrResult))
        .catch(e => console.error('[bp upload] OCR failed:', e.message));
    }
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/manual
router.post('/manual', ...bpProtect, async (req, res) => {
  try {
    const doc = await bpDocs.createDocumentRecord(
      req.bp.tenantId, req.bp.user._id, req.bp.user._id,
      null, 'manual_entry', req.body,
    );
    res.status(201).json({ success: true, data: doc });
  } catch (e) { err(res, e); }
});

// GET /api/bp/documents/:id
router.get('/:id', ...bpProtect, async (req, res) => {
  try {
    const data = await bpDocs.getDocument(req.bp.tenantId, req.params.id);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// PATCH /api/bp/documents/:id
router.patch('/:id', ...bpProtect, async (req, res) => {
  try {
    const data = await bpDocs.updateDocument(req.bp.tenantId, req.params.id, req.body);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/:id/approve
router.post('/:id/approve', ...bpProtect, bpRequireRole('accountant', 'team_member', 'super_admin'), async (req, res) => {
  try {
    const data = await bpDocs.approveDocument(req.bp.tenantId, req.params.id, req.bp.user._id, req.body.notes);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/:id/reject
router.post('/:id/reject', ...bpProtect, bpRequireRole('accountant', 'team_member', 'super_admin'), async (req, res) => {
  try {
    const { reason, reasonText, reuploadRequested } = req.body;
    const data = await bpDocs.rejectDocument(req.bp.tenantId, req.params.id, req.bp.user._id, reason, reasonText, reuploadRequested);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/:id/status
router.post('/:id/status', ...bpProtect, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, message: 'status required' });
    const data = await bpDocs.setDocumentStatus(req.bp.tenantId, req.params.id, status);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/:id/reprocess
router.post('/:id/reprocess', ...bpProtect, async (req, res) => {
  try {
    const data = await bpDocs.reprocessDocument(req.bp.tenantId, req.params.id);
    await queueProcessDocument(req.params.id).catch(() => {});
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/:id/fill-manually
router.post('/:id/fill-manually', ...bpProtect, async (req, res) => {
  try {
    const data = await bpDocs.fillManually(req.bp.tenantId, req.params.id, req.body);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/:id/revert-edit
router.post('/:id/revert-edit', ...bpProtect, bpRequireRole('accountant', 'team_member', 'super_admin'), async (req, res) => {
  try {
    const data = await bpDocs.revertClientEdit(req.bp.tenantId, req.params.id, req.bp.user._id);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// DELETE /api/bp/documents/:id
router.delete('/:id', ...bpProtect, async (req, res) => {
  try {
    await bpDocs.deleteDocument(req.bp.tenantId, req.params.id, req.bp.user._id, req.bp.user.role);
    res.json({ success: true });
  } catch (e) { err(res, e); }
});

// GET /api/bp/documents/:id/file
router.get('/:id/file', async (req, res) => {
  try {
    // Accept phone via header OR query param (for direct browser/Linking.openURL)
    const { normalizePhone, col } = require('../../services/bp-db');
    const rawPhone = req.headers['x-phone'] || req.query.phone;
    if (!rawPhone) return res.status(401).json({ success: false, message: 'phone required' });
    const phone = normalizePhone(rawPhone);
    const user = await col('users').findOne({ phone, deletedAt: { $exists: false } });
    if (!user) return res.status(401).json({ success: false, message: 'unauthorized' });
    // Resolve tenantId
    let tenantId = user.organizationId;
    if (user.role === 'client' && user.parentAccountantId) {
      const accountant = await col('users').findOne({ _id: user.parentAccountantId });
      if (accountant) tenantId = accountant.organizationId;
    }

    const doc = await bpDocs.getDocument(tenantId, req.params.id);
    const file = doc.files?.[0];
    if (!file) return res.status(404).json({ success: false, message: 'No file' });
    const { downloadFileById } = require('../../services/backblaze.service');
    const result = await downloadFileById(file.b2FileId);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`);
    res.send(result.buffer);
  } catch (e) { err(res, e); }
});

// ─── Comments ─────────────────────────────────────────────────────────────────

// GET /api/bp/documents/:id/comments
router.get('/:id/comments', ...bpProtect, async (req, res) => {
  try {
    const comments = await col('comments').find({
      documentId: oid(req.params.id),
      deletedAt: { $exists: false },
    }).sort({ createdAt: 1 }).toArray();
    res.json({ success: true, data: comments });
  } catch (e) { err(res, e); }
});

// POST /api/bp/documents/:id/comments
router.post('/:id/comments', ...bpProtect, async (req, res) => {
  try {
    const { text, isInternal = false } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'text required' });
    const now = nowISO();
    const result = await col('comments').insertOne({
      documentId: oid(req.params.id),
      tenantId: req.bp.tenantId,
      authorId: req.bp.user._id,
      authorRole: req.bp.user.role,
      text: text.trim().slice(0, 2000),
      isInternal: !!isInternal,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ success: true, data: { _id: result.insertedId } });
  } catch (e) { err(res, e); }
});

// PATCH /api/bp/documents/:id/comments/:cid
router.patch('/:id/comments/:cid', ...bpProtect, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'text required' });
    const result = await col('comments').findOneAndUpdate(
      { _id: oid(req.params.cid), authorId: req.bp.user._id, deletedAt: { $exists: false } },
      { $set: { text: text.trim().slice(0, 2000), editedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: result });
  } catch (e) { err(res, e); }
});

// DELETE /api/bp/documents/:id/comments/:cid
router.delete('/:id/comments/:cid', ...bpProtect, async (req, res) => {
  try {
    await col('comments').updateOne(
      { _id: oid(req.params.cid), authorId: req.bp.user._id },
      { $set: { deletedAt: new Date(), updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (e) { err(res, e); }
});

module.exports = router;
