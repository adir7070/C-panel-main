const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return `972${digits.slice(1)}`;
  return digits;
}

function col(name) {
  return getDB().collection(name);
}

async function ensureUser(phone, name) {
  const p = normalizePhone(phone);
  const now = new Date();
  const result = await col('billpilot_users').findOneAndUpdate(
    { phone: p },
    {
      $setOnInsert: { phone: p, name: name || '', createdAt: now },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return result;
}

async function createDocument(phone, { b2Key, b2FileId, fileName, mimeType, sizeBytes }) {
  const p = normalizePhone(phone);
  const now = new Date();
  const doc = {
    phone: p,
    status: 'pending_processing',
    files: [{ b2Key, b2FileId, fileName, mimeType, sizeBytes, uploadedAt: now }],
    extraction: null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await col('billpilot_documents').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

async function updateDocument(docId, update) {
  await col('billpilot_documents').updateOne(
    { _id: new ObjectId(docId) },
    { $set: { ...update, updatedAt: new Date() } },
  );
}

async function getDocuments(phone, { page = 1, limit = 50 } = {}) {
  const p = normalizePhone(phone);
  const lim = Math.min(Number(limit) || 50, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;

  const [docs, total] = await Promise.all([
    col('billpilot_documents')
      .find({ phone: p, deletedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .toArray(),
    col('billpilot_documents').countDocuments({ phone: p, deletedAt: { $exists: false } }),
  ]);

  return { data: { data: docs, total, page: Number(page), limit: lim } };
}

async function getDocument(phone, docId) {
  const p = normalizePhone(phone);
  const doc = await col('billpilot_documents').findOne({
    _id: new ObjectId(docId),
    phone: p,
    deletedAt: { $exists: false },
  });
  if (!doc) throw Object.assign(new Error('Document not found'), { status: 404 });
  return { data: doc };
}

async function getDashboardStats(phone) {
  const p = normalizePhone(phone);
  const docs = await col('billpilot_documents')
    .find({ phone: p, deletedAt: { $exists: false } })
    .project({ status: 1 })
    .toArray();

  const stats = { totalDocuments: docs.length, pendingReview: 0, approved: 0, rejected: 0 };
  for (const d of docs) {
    if (d.status === 'pending_review' || d.status === 'needs_client_review' || d.status === 'pending_processing') {
      stats.pendingReview++;
    } else if (d.status === 'approved' || d.status === 'exported') {
      stats.approved++;
    } else if (d.status === 'rejected' || d.status === 'failed') {
      stats.rejected++;
    }
  }
  return { success: true, data: stats };
}

module.exports = { normalizePhone, ensureUser, createDocument, updateDocument, getDocuments, getDocument, getDashboardStats };
