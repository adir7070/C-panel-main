'use strict';

const ExcelJS = require('exceljs');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const { col, oid, nowISO, BpError } = require('./bp-db');
const { uploadImage, downloadFileById } = require('./backblaze.service');

const STATUS_LABELS = {
  pending_processing: 'בעיבוד',
  needs_client_review: 'ממתין ללקוח',
  pending_review: 'ממתין לאישור',
  approved: 'אושר',
  rejected: 'נדחה',
  exported: 'יוצא',
  failed: 'נכשל',
};

function getVendorName(doc) {
  return doc.overrides?.vendor?.name ?? doc.extraction?.vendor?.name ?? '';
}
function getDocNumber(doc) {
  return doc.overrides?.documentNumber ?? doc.extraction?.documentNumber ?? '';
}
function getIssuedDate(doc) {
  return doc.overrides?.dates?.issued ?? doc.extraction?.dates?.issued;
}
function getTotal(doc) {
  return doc.overrides?.amounts?.total ?? doc.extraction?.amounts?.total ?? 0;
}
function getVatAmount(doc) {
  return doc.overrides?.amounts?.vatAmount ?? doc.extraction?.amounts?.vatAmount ?? 0;
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('he-IL');
}

async function buildExcel(docs) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('מסמכים', { views: [{ rightToLeft: true }] });

  ws.columns = [
    { header: 'ספק', key: 'vendor', width: 28 },
    { header: 'תאריך', key: 'date', width: 14 },
    { header: 'סכום', key: 'total', width: 14 },
    { header: 'מע"מ', key: 'vat', width: 12 },
    { header: 'מטבע', key: 'currency', width: 10 },
    { header: 'סטטוס', key: 'status', width: 18 },
    { header: 'קטגוריה', key: 'category', width: 20 },
    { header: 'מספר מסמך', key: 'docNumber', width: 18 },
    { header: 'ח.פ. / ע.מ.', key: 'taxId', width: 16 },
  ];

  // Header style
  ws.getRow(1).eachCell(cell => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0000B2' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center' };
  });

  for (const doc of docs) {
    ws.addRow({
      vendor: getVendorName(doc),
      date: fmtDate(getIssuedDate(doc)),
      total: getTotal(doc),
      vat: getVatAmount(doc),
      currency: doc.extraction?.currency || 'ILS',
      status: STATUS_LABELS[doc.status] || doc.status,
      category: doc.category?.name || '',
      docNumber: getDocNumber(doc),
      taxId: doc.extraction?.vendor?.taxId || '',
    });
  }

  // Auto-filter
  ws.autoFilter = { from: 'A1', to: 'I1' };

  return wb.xlsx.writeBuffer();
}

async function createExportJob(tenantId, createdById, filters = {}) {
  const now = nowISO();
  const result = await col('export_jobs').insertOne({
    tenantId,
    createdBy: createdById,
    status: 'pending',
    filters,
    progress: { total: 0, current: 0, phase: 'queued' },
    createdAt: now,
    updatedAt: now,
  });
  return { _id: result.insertedId, status: 'pending' };
}

async function runExportJob(exportJobId) {
  const job = await col('export_jobs').findOne({ _id: oid(exportJobId) });
  if (!job) throw new BpError('Export job not found', 404);

  await col('export_jobs').updateOne({ _id: job._id }, {
    $set: { status: 'processing', startedAt: new Date(), 'progress.phase': 'fetching', updatedAt: new Date() },
  });

  try {
    const { filters = {} } = job;
    const match = {
      tenantId: job.tenantId,
      status: { $nin: ['rejected', 'failed'] },
      deletedAt: { $exists: false },
    };
    if (filters.from) match['extraction.dates.issued'] = { $gte: new Date(filters.from) };
    if (filters.to) match['extraction.dates.issued'] = { ...match['extraction.dates.issued'], $lte: new Date(filters.to) };
    if (filters.clientId) match.clientId = oid(filters.clientId);
    if (filters.statuses?.length) match.status = { $in: filters.statuses };

    const docs = await col('documents').find(match).sort({ 'extraction.dates.issued': -1 }).limit(2000).toArray();

    await col('export_jobs').updateOne({ _id: job._id }, {
      $set: { 'progress.total': docs.length, 'progress.phase': 'building', updatedAt: new Date() },
    });

    // Build Excel
    const excelBuffer = await buildExcel(docs);

    // Build ZIP
    const zipBuffer = await buildZip(docs, excelBuffer);

    // Upload to B2
    const ts = Date.now();
    const b2Key = `billpilot/${job.tenantId}/exports/export_${ts}.zip`;
    const b2Result = await uploadImage(b2Key, zipBuffer, 'application/zip');

    // 7-day expiry
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await col('export_jobs').updateOne({ _id: job._id }, {
      $set: {
        status: 'completed',
        completedAt: new Date(),
        result: {
          b2Key,
          b2FileId: b2Result.fileId,
          fileSize: zipBuffer.length,
          documentCount: docs.length,
          expiresAt,
        },
        'progress.current': docs.length,
        'progress.phase': 'done',
        updatedAt: new Date(),
      },
    });

    // Mark docs as exported
    await col('documents').updateMany(
      { _id: { $in: docs.filter(d => d.status === 'approved').map(d => d._id) } },
      { $set: { status: 'exported', updatedAt: new Date() } }
    );

    console.log(`[bp-export] job ${exportJobId} done — ${docs.length} docs, ${zipBuffer.length} bytes`);
  } catch (err) {
    await col('export_jobs').updateOne({ _id: job._id }, {
      $set: { status: 'failed', error: err.message, updatedAt: new Date() },
    });
    throw err;
  }
}

async function buildZip(docs, excelBuffer) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    archive.append(excelBuffer, { name: 'documents.xlsx' });

    // Download and add PDF files (best effort — skip failures)
    const filePromises = docs
      .filter(doc => doc.files?.length > 0 && doc.files[0].b2FileId)
      .map(async (doc) => {
        try {
          const file = doc.files[0];
          const result = await downloadFileById(file.b2FileId);
          const safeName = (getVendorName(doc) || 'doc').replace(/[<>:"/\\|?*]/g, '_').slice(0, 40);
          const ext = file.fileName?.split('.').pop() || 'pdf';
          archive.append(result.buffer, { name: `docs/${safeName}_${doc._id}.${ext}` });
        } catch { /* skip on error */ }
      });

    Promise.all(filePromises).then(() => archive.finalize()).catch(reject);
  });
}

async function getExport(tenantId, jobId) {
  const job = await col('export_jobs').findOne({ _id: oid(jobId), tenantId });
  if (!job) throw new BpError('Export job not found', 404);
  return job;
}

async function listExports(tenantId, createdById) {
  const query = { tenantId };
  if (createdById) query.createdBy = createdById;
  return col('export_jobs').find(query).sort({ createdAt: -1 }).limit(50).toArray();
}

async function previewExport(tenantId, filters = {}) {
  const match = { tenantId, status: { $nin: ['rejected', 'failed'] }, deletedAt: { $exists: false } };
  if (filters.from) match['extraction.dates.issued'] = { $gte: new Date(filters.from) };
  if (filters.to) match['extraction.dates.issued'] = { ...match['extraction.dates.issued'], $lte: new Date(filters.to) };

  const [count, totalAgg] = await Promise.all([
    col('documents').countDocuments(match),
    col('documents').aggregate([
      { $match: match },
      { $group: { _id: null, totalAmount: { $sum: '$extraction.amounts.total' } } },
    ]).toArray(),
  ]);

  return { documentCount: count, totalAmount: totalAgg[0]?.totalAmount || 0 };
}

module.exports = { createExportJob, runExportJob, getExport, listExports, previewExport };
