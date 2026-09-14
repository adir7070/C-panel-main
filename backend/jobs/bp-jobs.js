/**
 * BillPilot background job queue — powered by Agenda (MongoDB-backed).
 * All jobs run inside iconiq-server's process, sharing the same MongoDB connection.
 */

const Agenda = require('agenda');
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { col, oid, normalizePhone } = require('../services/bp-db');

let agenda = null;

// ─── Init ────────────────────────────────────────────────────────────────────

async function initBpJobs() {
  if (agenda) return agenda;

  // Agenda runs on Atlas only. AWS Mongo (13.62.249.237) was retired from
  // Heroku-reachable paths because its Security Group only allows the
  // office IP — Heroku traffic was getting silently dropped, hanging
  // agenda's background poll, and crashing the dyno.
  const mongoUri = process.env.MONGO_URI;
  agenda = new Agenda({
    db: { address: mongoUri, collection: 'bp_jobs' },
    processEvery: '10 seconds',
    defaultConcurrency: 2,
    maxConcurrency: 10,
  });

  // Trap agenda's internal errors so a MongoDB blip during background polling
  // doesn't crash the whole web dyno. Without this, the underlying MongoDB
  // driver throws an unhandled MongoServerSelectionError and Node exits 1.
  agenda.on('error', (err) => {
    console.error('[BpJobs] Agenda error (non-fatal):', err?.message || err);
  });

  registerAllJobs(agenda);

  await agenda.start();

  // Recurring schedules
  await agenda.every('0 2 * * *',    'bp:detect-recurring');
  await agenda.every('0 8 * * 1',    'bp:alert-inactive');
  await agenda.every('0 * * * *',    'bp:cleanup-tokens');
  await agenda.every('0 */6 * * *',  'bp:email-sync');
  await agenda.every('*/1 * * * *',  'bp:unlock-stale-emails');

  console.log('[BpJobs] Agenda started, recurring jobs scheduled');
  return agenda;
}

function getAgenda() {
  return agenda;
}

// ─── Queue helpers ────────────────────────────────────────────────────────────

async function queueProcessDocument(documentId) {
  if (!agenda) return;
  await agenda.now('bp:process-document', { documentId: documentId.toString() });
}

async function queueCheckDuplicate(documentId) {
  if (!agenda) return;
  await agenda.now('bp:check-duplicate', { documentId: documentId.toString() });
}

async function queueExportDocuments(exportJobId) {
  if (!agenda) return;
  await agenda.now('bp:export-documents', { exportJobId: exportJobId.toString() });
}

async function queueEmailSync(connectionId) {
  if (!agenda) return;
  if (connectionId) {
    await agenda.now('bp:email-sync', { connectionId: connectionId.toString() });
  } else {
    await agenda.now('bp:email-sync', {});
  }
}

// ─── Job Definitions ─────────────────────────────────────────────────────────

function registerAllJobs(ag) {
  registerProcessDocumentJob(ag);
  registerCheckDuplicateJob(ag);
  registerEmailSyncJob(ag);
  registerExportDocumentsJob(ag);
  registerDetectRecurringJob(ag);
  registerAlertInactiveJob(ag);
  registerCleanupTokensJob(ag);
  registerUnlockStaleEmailsJob(ag);
}

// ─── process-document ─────────────────────────────────────────────────────────

function registerProcessDocumentJob(ag) {
  ag.define('bp:process-document', { priority: 10, concurrency: 3 }, async (job) => {
    const { documentId } = job.attrs.data;
    const startTime = Date.now();
    console.log(`[bp:process-document] started ${documentId}`);

    const doc = await col('documents').findOne({ _id: oid(documentId) });
    if (!doc) { console.warn(`[bp:process-document] not found ${documentId}`); return; }
    if (doc.files?.length === 0) { console.warn(`[bp:process-document] no files ${documentId}`); return; }

    // Mark processing
    await col('documents').updateOne({ _id: oid(documentId) }, {
      $inc: { processingAttempts: 1 },
      $set: { 'extraction.status': 'processing', 'extraction.startedAt': new Date() },
    });

    try {
      // Lazy-load services to avoid circular deps at startup
      const { runOcrPipeline, normalizeName } = require('../services/bp-ocr.service');
      const { downloadFileById } = require('../services/backblaze.service');
      const { upsertVendor } = require('../services/bp-vendors.service');
      const { suggestCategory } = require('../services/bp-categories.service');
      const { notifyDocument } = require('../services/bp-notifications.service');

      const file = doc.files[0];
      let buffer;
      try {
        const result = await downloadFileById(file.b2FileId);
        buffer = result.buffer;
      } catch (e) {
        throw new Error(`Failed to download file: ${e.message}`);
      }

      // Run OCR
      const ocrResult = await runOcrPipeline(buffer, file.mimeType);
      const { extraction } = ocrResult;
      const confidence = ocrResult.overallConfidence;

      // Upsert vendor
      let vendorId;
      let isNewVendor = false;
      if (extraction.vendor?.name) {
        const normalizedName = extraction.vendor.normalizedName || normalizeName(extraction.vendor.name);
        const existing = await col('vendors').findOne({ tenantId: doc.tenantId, normalizedName });
        isNewVendor = !existing;
        vendorId = await upsertVendor(doc.tenantId.toString(), {
          name: extraction.vendor.name,
          normalizedName,
          taxId: extraction.vendor.taxId,
          address: extraction.vendor.address,
          phone: extraction.vendor.phone,
          email: extraction.vendor.email,
        });
        if (vendorId) extraction.vendor.vendorId = vendorId;
      }

      // Suggest category
      const categorySuggestion = await suggestCategory(
        doc.tenantId.toString(),
        extraction.vendor?.name
      );

      // Determine status
      const newStatus = confidence >= 80 && !isNewVendor ? 'pending_review' : 'needs_client_review';
      const needsReview = confidence < 70 || isNewVendor;
      let reviewReason = '';
      if (confidence < 70) reviewReason = 'low_confidence';
      else if (isNewVendor) reviewReason = 'new_vendor';

      const updateData = {
        extraction: {
          ...extraction,
          status: 'completed',
          engine: ocrResult.engine,
          overallConfidence: confidence,
          processingMs: Date.now() - startTime,
          completedAt: new Date(),
        },
        status: newStatus,
        'flags.needsReview': needsReview,
        'flags.reviewReason': reviewReason,
        updatedAt: new Date(),
      };
      if (categorySuggestion) {
        updateData.category = {
          name: categorySuggestion.name,
          accountingCode: categorySuggestion.accountingCode,
          autoSuggested: true,
          suggestionConfidence: categorySuggestion.confidence,
        };
      }
      await col('documents').updateOne({ _id: oid(documentId) }, { $set: updateData });

      // Notify accountant
      if (needsReview) {
        const client = await col('users').findOne({ _id: doc.clientId });
        if (client?.parentAccountantId) {
          await notifyDocument(
            doc.tenantId.toString(),
            client.parentAccountantId.toString(),
            'document_needs_review',
            documentId,
            'מסמך ממתין לבדיקה',
            `מסמך חדש מ-${client.profile?.firstName || ''} דורש בדיקה`,
          );
        }
      }

      // Queue duplicate check
      await ag.now('bp:check-duplicate', { documentId });

      console.log(`[bp:process-document] done ${documentId} confidence=${confidence} status=${newStatus}`);
    } catch (err) {
      const msg = err?.message || 'Unknown error';
      console.error(`[bp:process-document] FAILED ${documentId}:`, msg);
      await col('documents').updateOne({ _id: oid(documentId) }, {
        $set: {
          'extraction.status': 'failed',
          'extraction.errorMessage': msg,
          status: 'failed',
          updatedAt: new Date(),
        },
      });
    }
  });
}

// ─── check-duplicate ──────────────────────────────────────────────────────────

function registerCheckDuplicateJob(ag) {
  ag.define('bp:check-duplicate', { concurrency: 5 }, async (job) => {
    const { documentId } = job.attrs.data;
    try {
      await checkDuplicate(documentId);
    } catch (err) {
      console.error('[bp:check-duplicate] failed:', err.message);
    }
  });
}

async function checkDuplicate(documentId) {
  const doc = await col('documents').findOne({ _id: oid(documentId) });
  if (!doc || doc.flags?.isDuplicate) return;

  const vendorName = doc.extraction?.vendor?.normalizedName;
  const total = doc.extraction?.amounts?.total;
  if (!vendorName || !total) return;

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - 30);

  const recentDocs = await col('documents').find({
    _id: { $ne: oid(documentId) },
    tenantId: doc.tenantId,
    clientId: doc.clientId,
    createdAt: { $gte: windowStart },
    deletedAt: { $exists: false },
    'extraction.status': 'completed',
  }).project({ 'extraction.vendor.normalizedName': 1, 'extraction.amounts.total': 1, 'extraction.dates.issued': 1 }).toArray();

  const thisFingerprint = computeFingerprint(vendorName, total, doc.extraction?.dates?.issued);
  let maxScore = 0, duplicateId = null;

  for (const other of recentDocs) {
    const otherFp = computeFingerprint(
      other.extraction?.vendor?.normalizedName || '',
      other.extraction?.amounts?.total || 0,
      other.extraction?.dates?.issued,
    );
    const score = fingerprintSimilarity(thisFingerprint, otherFp);
    if (score > maxScore) { maxScore = score; if (score >= 80) duplicateId = other._id; }
  }

  if (duplicateId && maxScore >= 80) {
    await col('documents').updateOne({ _id: oid(documentId) }, {
      $set: {
        'flags.isDuplicate': true,
        'flags.duplicateOfId': duplicateId,
        'flags.duplicateScore': maxScore,
        'flags.needsReview': true,
        'flags.reviewReason': 'duplicate',
        status: 'pending_review',
        updatedAt: new Date(),
      },
    });
    console.log(`[bp:check-duplicate] duplicate found for ${documentId} score=${maxScore}`);
  }
}

function computeFingerprint(vendor, total, date) {
  const d = date ? new Date(date).toISOString().slice(0, 10) : 'nodate';
  return `${vendor}|${Math.round(total)}|${d}`;
}

function fingerprintSimilarity(fp1, fp2) {
  if (fp1 === fp2) return 100;
  const [v1, a1, d1] = fp1.split('|');
  const [v2, a2, d2] = fp2.split('|');
  let score = 0;
  if (v1 === v2) score += 50; else if (v1.includes(v2) || v2.includes(v1)) score += 35;
  if (a1 === a2) score += 30;
  if (d1 === d2) score += 20;
  return score;
}

// ─── email-sync ───────────────────────────────────────────────────────────────

function registerEmailSyncJob(ag) {
  ag.define('bp:email-sync', { concurrency: 2 }, async (job) => {
    const { connectionId } = job.attrs.data || {};
    try {
      const { syncGmailConnection } = require('../services/bp-gmail.service');
      const query = connectionId
        ? { _id: oid(connectionId), isActive: true }
        : { 'syncSettings.enabled': true, isActive: true };
      const connections = await col('email_connections').find(query).toArray();
      console.log(`[bp:email-sync] syncing ${connections.length} connections`);
      for (const conn of connections) {
        try {
          if (conn.provider === 'gmail') {
            await syncGmailConnection(conn._id.toString());
          }
        } catch (err) {
          console.error(`[bp:email-sync] connection ${conn._id} failed:`, err.message);
          await col('email_connections').updateOne({ _id: conn._id }, {
            $set: { 'syncSettings.lastSyncError': err.message, updatedAt: new Date() },
          });
        }
      }
    } catch (err) {
      console.error('[bp:email-sync] job failed:', err.message);
    }
  });
}

// ─── export-documents ─────────────────────────────────────────────────────────

function registerExportDocumentsJob(ag) {
  ag.define('bp:export-documents', { concurrency: 2 }, async (job) => {
    const { exportJobId } = job.attrs.data;
    console.log(`[bp:export-documents] started ${exportJobId}`);
    try {
      const { runExportJob } = require('../services/bp-export.service');
      await runExportJob(exportJobId);
      console.log(`[bp:export-documents] done ${exportJobId}`);
    } catch (err) {
      console.error(`[bp:export-documents] failed ${exportJobId}:`, err.message);
      await col('export_jobs').updateOne({ _id: oid(exportJobId) }, {
        $set: { status: 'failed', error: err.message, updatedAt: new Date() },
      });
    }
  });
}

// ─── detect-recurring ─────────────────────────────────────────────────────────

function registerDetectRecurringJob(ag) {
  ag.define('bp:detect-recurring', { concurrency: 1 }, async () => {
    console.log('[bp:detect-recurring] started');
    // Group vendors by tenantId and check for monthly recurrence
    const vendors = await col('vendors').find({}).toArray();
    for (const vendor of vendors) {
      try {
        const docs = await col('documents').find({
          tenantId: vendor.tenantId,
          'extraction.vendor.normalizedName': vendor.normalizedName,
          deletedAt: { $exists: false },
        }).sort({ 'extraction.dates.issued': -1 }).limit(6).toArray();

        if (docs.length >= 3) {
          const amounts = docs.map(d => d.extraction?.amounts?.total || 0).filter(Boolean);
          const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
          await col('vendors').updateOne({ _id: vendor._id }, {
            $set: {
              'stats.isRecurring': docs.length >= 3,
              'stats.avgMonthlyAmount': Math.round(avgAmount),
              'stats.totalDocuments': docs.length,
              updatedAt: new Date(),
            },
          });
        }
      } catch (err) {
        console.error('[bp:detect-recurring] vendor error:', err.message);
      }
    }
  });
}

// ─── alert-inactive ───────────────────────────────────────────────────────────

function registerAlertInactiveJob(ag) {
  ag.define('bp:alert-inactive', { concurrency: 1 }, async () => {
    console.log('[bp:alert-inactive] started');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { notifyDocument } = require('../services/bp-notifications.service');

    // Find accountants
    const accountants = await col('users').find({ role: 'accountant', deletedAt: { $exists: false } }).toArray();
    for (const accountant of accountants) {
      const clients = await col('users').find({ parentAccountantId: accountant._id, deletedAt: { $exists: false } }).toArray();
      for (const client of clients) {
        const recentDoc = await col('documents').findOne({
          clientId: client._id,
          createdAt: { $gte: thirtyDaysAgo },
          deletedAt: { $exists: false },
        });
        if (!recentDoc) {
          await notifyDocument(
            accountant.organizationId?.toString() || '',
            accountant._id.toString(),
            'client_inactive',
            null,
            'לקוח לא פעיל',
            `${client.profile?.firstName || 'לקוח'} לא העלה מסמכים ב-30 הימים האחרונים`,
          );
        }
      }
    }
  });
}

// ─── cleanup-tokens ───────────────────────────────────────────────────────────

function registerCleanupTokensJob(ag) {
  ag.define('bp:cleanup-tokens', { concurrency: 1 }, async () => {
    const result = await col('email_connections').updateMany(
      { tokenExpiresAt: { $lt: new Date() }, connectionStatus: 'CONNECTED' },
      { $set: { connectionStatus: 'TOKEN_EXPIRED', updatedAt: new Date() } },
    );
    if (result.modifiedCount > 0) {
      console.log(`[bp:cleanup-tokens] expired ${result.modifiedCount} tokens`);
    }
  });
}

// ─── unlock-stale-emails ──────────────────────────────────────────────────────

function registerUnlockStaleEmailsJob(ag) {
  ag.define('bp:unlock-stale-emails', { concurrency: 1 }, async () => {
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 min
    const result = await col('email_sync_items').updateMany(
      { lockedAt: { $lt: staleThreshold }, status: 'PROCESSING' },
      { $set: { status: 'RETRY_PENDING', lockedAt: null, lockedBy: null, updatedAt: new Date() } },
    );
    if (result.modifiedCount > 0) {
      console.log(`[bp:unlock-stale] unlocked ${result.modifiedCount} stale emails`);
    }
  });
}

module.exports = { initBpJobs, getAgenda, queueProcessDocument, queueCheckDuplicate, queueExportDocuments, queueEmailSync };
