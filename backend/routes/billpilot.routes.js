'use strict';

/**
 * /api/billpilot/* — backward-compat layer for the mobile app.
 * Delegates to the new bp-* services. Phone comes from query/body (no X-Phone header needed here).
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { col, normalizePhone, oid } = require('../services/bp-db');
const bpDocs = require('../services/bp-docs.service');
const { uploadImage } = require('../services/backblaze.service');
const { queueProcessDocument } = require('../jobs/bp-jobs');
const { seedDefaultCategories } = require('../services/bp-categories.service');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function getPhone(req) {
  return (req.query.phone || req.body?.phone || '').toString().trim();
}

async function ensureUserByPhone(rawPhone, name) {
  const phone = normalizePhone(rawPhone);
  const existing = await col('users').findOne({ phone, deletedAt: { $exists: false } });
  if (existing) return existing;

  const now = new Date();
  const orgResult = await col('orgs').insertOne({
    type: 'business', name: name || phone,
    settings: { defaultVatRate: 17, currency: 'ILS', autoApproveEnabled: false, duplicateWindowDays: 30 },
    createdAt: now, updatedAt: now,
  });
  const userResult = await col('users').insertOne({
    phone, role: 'client',
    organizationId: orgResult.insertedId,
    profile: { firstName: name || 'משתמש', lastName: '-', language: 'he', timezone: 'Asia/Jerusalem' },
    auth: { loginCount: 0 }, pushTokens: [], permissions: [],
    createdAt: now, updatedAt: now,
  });
  // Seed default categories for new org
  seedDefaultCategories(orgResult.insertedId.toString()).catch(() => {});
  return { _id: userResult.insertedId, phone, organizationId: orgResult.insertedId };
}

// POST /api/billpilot/provision
router.post('/provision', async (req, res) => {
  try {
    const { phone: p, name } = req.body;
    if (!p) return res.status(400).json({ success: false, message: 'phone required' });
    const user = await ensureUserByPhone(p, name);
    res.json({ success: true, data: { userId: user._id, phone: normalizePhone(p) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/billpilot/documents
router.get('/documents', async (req, res) => {
  try {
    const p = getPhone(req);
    if (!p) return res.status(400).json({ success: false, message: 'phone required' });
    const user = await col('users').findOne({ phone: normalizePhone(p), deletedAt: { $exists: false } });
    if (!user) return res.json({ data: { data: [], total: 0 } });
    const result = await bpDocs.listDocuments(user.organizationId, { ...req.query, clientId: user._id.toString() });
    res.json({ data: { data: result.documents || [], total: result.total || 0 } });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// GET /api/billpilot/documents/:id
router.get('/documents/:id', async (req, res) => {
  try {
    const p = getPhone(req);
    if (!p) return res.status(400).json({ success: false, message: 'phone required' });
    const user = await col('users').findOne({ phone: normalizePhone(p), deletedAt: { $exists: false } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const data = await bpDocs.getDocument(user.organizationId, req.params.id);
    res.json({ data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST /api/billpilot/documents/upload
router.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    const p = getPhone(req);
    if (!p) return res.status(400).json({ success: false, message: 'phone required' });
    if (!req.file) return res.status(400).json({ success: false, message: 'file required' });

    const user = await ensureUserByPhone(p);
    const ts = Date.now();
    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const b2Key = `billpilot/${user.organizationId}/${normalizePhone(p)}/${ts}.${ext}`;

    const b2Result = await uploadImage(b2Key, req.file.buffer, req.file.mimetype);
    const doc = await bpDocs.createDocumentRecord(
      user.organizationId, user._id, user._id,
      { b2Key, b2FileId: b2Result.fileId, fileName: req.file.originalname, mimeType: req.file.mimetype, sizeBytes: req.file.size },
      'mobile_scan',
    );

    res.json({ success: true, data: doc });

    const fileBuffer = req.file.buffer;
    const fileMime = req.file.mimetype;
    queueProcessDocument(doc._id).catch(() => {
      const { runOcrPipeline } = require('../services/bp-ocr.service');
      runOcrPipeline(fileBuffer, fileMime)
        .then(ocrResult => bpDocs.postProcessDocument(user.organizationId.toString(), doc._id.toString(), ocrResult))
        .catch(e => console.error('[billpilot upload] OCR failed:', e.message));
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// GET /api/billpilot/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const p = getPhone(req);
    if (!p) return res.status(400).json({ success: false, message: 'phone required' });
    const user = await col('users').findOne({ phone: normalizePhone(p), deletedAt: { $exists: false } });
    if (!user) return res.json({ success: true, data: { totalDocuments: 0, pendingReview: 0, approved: 0, rejected: 0 } });

    const docs = await col('documents').find(
      { clientId: user._id, deletedAt: { $exists: false } },
      { projection: { status: 1 } }
    ).toArray();

    const stats = { totalDocuments: docs.length, pendingReview: 0, approved: 0, rejected: 0 };
    for (const d of docs) {
      if (['pending_processing', 'needs_client_review', 'pending_review'].includes(d.status)) stats.pendingReview++;
      else if (['approved', 'exported'].includes(d.status)) stats.approved++;
      else if (['rejected', 'failed'].includes(d.status)) stats.rejected++;
    }
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// GET /api/billpilot/gmail-auth
router.get('/gmail-auth', async (req, res) => {
  try {
    const p = getPhone(req);
    if (!p) return res.status(400).json({ success: false, message: 'phone required' });
    const user = await col('users').findOne({ phone: normalizePhone(p), deletedAt: { $exists: false } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { getAuthUrl } = require('../services/bp-gmail.service');
    const url = await getAuthUrl(user._id.toString(), user.organizationId?.toString() || '');
    res.json({ success: true, data: { authUrl: url, redirectUrl: url } });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
