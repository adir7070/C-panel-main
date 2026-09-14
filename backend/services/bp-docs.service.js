'use strict';

const { col, oid, BpError } = require('./bp-db');
const { normalizeName } = require('./bp-ocr.service');
const { upsertVendor } = require('./bp-vendors.service');
const { suggestCategory } = require('./bp-categories.service');
const { createNotification } = require('./bp-notifications.service');
const { ObjectId } = require('mongodb');

const MAX_PROCESSING_ATTEMPTS = 2;

// ─── List Documents ───────────────────────────────────────────────────────────

/**
 * Lists documents for a tenant with filters and pagination.
 * @param {string} tenantId
 * @param {{
 *   clientId?: string,
 *   allowedClientIds?: string[],
 *   status?: string,
 *   dateFrom?: string,
 *   dateTo?: string,
 *   page?: number,
 *   limit?: number,
 *   search?: string,
 *   year?: number,
 *   month?: number,
 *   vendorName?: string
 * }} filters
 * @returns {Promise<{ documents: object[], total: number, page: number, limit: number }>}
 */
async function listDocuments(tenantId, filters = {}) {
  const {
    clientId,
    allowedClientIds,
    status,
    dateFrom,
    dateTo,
    page = 1,
    limit = 20,
    search,
    year,
    month,
    vendorName,
  } = filters;

  const filter = {
    tenantId: oid(tenantId),
    deletedAt: { $exists: false },
  };

  if (clientId) {
    filter.clientId = oid(clientId);
  } else if (Array.isArray(allowedClientIds) && allowedClientIds.length > 0) {
    filter.clientId = { $in: allowedClientIds.map((id) => oid(id)) };
  }

  if (status) filter.status = status;
  if (year) filter.year = year;
  if (month) filter.month = month;

  if (dateFrom || dateTo) {
    const dateFilter = {};
    if (dateFrom) dateFilter.$gte = new Date(dateFrom);
    if (dateTo) dateFilter.$lte = new Date(dateTo);
    filter.createdAt = dateFilter;
  }

  if (vendorName) {
    const normalized = normalizeName(vendorName);
    if (normalized) {
      filter['extraction.vendor.normalizedName'] = normalized;
    } else {
      const escaped = vendorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter['extraction.vendor.name'] = { $regex: `^${escaped}$`, $options: 'i' };
    }
  }

  if (search) {
    filter.$or = [
      { 'extraction.vendor.name': { $regex: search, $options: 'i' } },
      { 'extraction.documentNumber': { $regex: search, $options: 'i' } },
      { notes: { $regex: search, $options: 'i' } },
      { tags: { $in: [new RegExp(search, 'i')] } },
    ];
  }

  const skip = (Math.max(1, page) - 1) * limit;

  const [documents, total] = await Promise.all([
    col('documents')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    col('documents').countDocuments(filter),
  ]);

  return { documents, total, page, limit };
}

// ─── Get Single Document ──────────────────────────────────────────────────────

/**
 * Fetches a single document by id, scoped to a tenant.
 * @param {string} tenantId
 * @param {string} docId
 * @returns {Promise<object>}
 */
async function getDocument(tenantId, docId) {
  const doc = await col('documents').findOne({
    _id: oid(docId),
    tenantId: oid(tenantId),
    deletedAt: { $exists: false },
  });

  if (!doc) {
    throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  }

  return doc;
}

// ─── Create Document Record ───────────────────────────────────────────────────

/**
 * Stores document metadata and file info; does NOT trigger OCR (caller queues job).
 * @param {string} tenantId
 * @param {string} clientId
 * @param {string} uploadedBy
 * @param {{
 *   b2Key: string,
 *   b2FileId: string,
 *   b2Bucket: string,
 *   fileName: string,
 *   mimeType: string,
 *   sizeBytes: number
 * }} fileData
 * @param {string} [source='web_upload'] - Source type: web_upload | mobile_upload | email | api
 * @param {{ notes?: string, tags?: string[] }} [metadata={}]
 * @returns {Promise<object>}
 */
async function createDocumentRecord(tenantId, clientId, uploadedBy, fileData, source = 'web_upload', metadata = {}) {
  const now = new Date();
  const doc = {
    tenantId: oid(tenantId),
    clientId: oid(clientId),
    uploadedBy: oid(uploadedBy),
    source: { type: source },
    files: [
      {
        b2Key: fileData.b2Key,
        b2FileId: fileData.b2FileId,
        b2Bucket: fileData.b2Bucket,
        fileName: fileData.fileName,
        mimeType: fileData.mimeType,
        sizeBytes: fileData.sizeBytes,
        uploadedAt: now,
      },
    ],
    extraction: { status: 'pending' },
    status: 'pending_processing',
    flags: { needsReview: false, isDuplicate: false, isRecurring: false },
    notes: metadata.notes || undefined,
    tags: metadata.tags || [],
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    processingAttempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  const result = await col('documents').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

// ─── Update Document ──────────────────────────────────────────────────────────

/**
 * Updates document overrides, category, tags, or notes.
 * If a client edits an approved document, it reverts to pending_review.
 * @param {string} tenantId
 * @param {string} docId
 * @param {{
 *   overrides?: object,
 *   categoryId?: string,
 *   tags?: string[],
 *   notes?: string,
 *   updatedBy?: string,
 *   updatedByRole?: string
 * }} updates
 * @returns {Promise<object>}
 */
async function updateDocument(tenantId, docId, updates) {
  const { overrides, categoryId, tags, notes, updatedBy, updatedByRole } = updates;

  const existing = await col('documents').findOne(
    { _id: oid(docId), tenantId: oid(tenantId), deletedAt: { $exists: false } },
    { projection: { status: 1, clientId: 1 } }
  );
  if (!existing) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');

  const setData = { updatedAt: new Date() };
  const isClientRole = updatedByRole === 'client' || updatedByRole === 'team_member';

  if (overrides) {
    setData.overrides = {
      ...overrides,
      ...(updatedBy && { editedBy: oid(updatedBy) }),
      editedAt: new Date(),
      ...(updatedByRole && { editedByRole: updatedByRole }),
    };
  }

  if (categoryId) {
    const category = await col('categories').findOne({ _id: oid(categoryId) });
    setData.category = {
      categoryId: oid(categoryId),
      name: category ? category.name : undefined,
      accountingCode: category ? category.accountingCode : undefined,
      ...(updatedBy && { assignedBy: oid(updatedBy) }),
      assignedAt: new Date(),
    };
  }

  if (tags !== undefined) setData.tags = tags;
  if (notes !== undefined) setData.notes = notes;

  // Client editing an approved doc → revert to pending_review
  if (existing.status === 'approved' && isClientRole) {
    setData.status = 'pending_review';
    setData['review.previousStatus'] = 'approved';
    if (updatedBy) {
      setData['review.reviewedBy'] = oid(updatedBy);
    }
    setData['review.reviewedAt'] = new Date();
  } else if (existing.status === 'approved' && !isClientRole) {
    throw new BpError('Cannot edit an approved document', 409, 'DOCUMENT_APPROVED');
  }

  const doc = await col('documents').findOneAndUpdate(
    { _id: oid(docId), tenantId: oid(tenantId), deletedAt: { $exists: false } },
    { $set: setData },
    { returnDocument: 'after' }
  );

  const updated = doc && doc.value ? doc.value : doc;
  if (!updated) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');

  // Notify accountant if client pushed back to review
  if (existing.status === 'approved' && isClientRole) {
    const client = await col('users').findOne(
      { _id: existing.clientId },
      { projection: { parentAccountantId: 1, profile: 1 } }
    );
    if (client && client.parentAccountantId) {
      const firstName = client.profile ? client.profile.firstName : '';
      const lastName = client.profile ? client.profile.lastName : '';
      await createNotification({
        tenantId,
        recipientId: client.parentAccountantId.toString(),
        type: 'document_needs_review',
        title: 'לקוח ערך מסמך מאושר',
        body: `${firstName} ${lastName} ערך מסמך שכבר אושר — נדרשת בדיקה מחדש`,
        data: { documentId: docId },
        sendPush: true,
      });
    }
  }

  return updated;
}

// ─── Approve Document ─────────────────────────────────────────────────────────

/**
 * Sets document status to approved.
 * @param {string} tenantId
 * @param {string} docId
 * @param {string} approvedById
 * @param {string} [notes]
 * @returns {Promise<object>}
 */
async function approveDocument(tenantId, docId, approvedById, notes) {
  const result = await col('documents').findOneAndUpdate(
    { _id: oid(docId), tenantId: oid(tenantId), deletedAt: { $exists: false } },
    {
      $set: {
        status: 'approved',
        approval: {
          approvedBy: oid(approvedById),
          approvedAt: new Date(),
          ...(notes && { notes }),
        },
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  const doc = result && result.value ? result.value : result;
  if (!doc) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  return doc;
}

// ─── Reject Document ──────────────────────────────────────────────────────────

/**
 * Sets document status to rejected.
 * @param {string} tenantId
 * @param {string} docId
 * @param {string} rejectedById
 * @param {string} reason
 * @param {string} [reasonText]
 * @param {boolean} [reuploadRequested=false]
 * @returns {Promise<object>}
 */
async function rejectDocument(tenantId, docId, rejectedById, reason, reasonText, reuploadRequested = false) {
  const result = await col('documents').findOneAndUpdate(
    { _id: oid(docId), tenantId: oid(tenantId), deletedAt: { $exists: false } },
    {
      $set: {
        status: 'rejected',
        rejection: {
          rejectedBy: oid(rejectedById),
          rejectedAt: new Date(),
          reason,
          ...(reasonText && { reasonText }),
          reuploadRequested,
        },
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  const doc = result && result.value ? result.value : result;
  if (!doc) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  return doc;
}

// ─── Soft Delete ──────────────────────────────────────────────────────────────

/**
 * Soft-deletes a document by setting deletedAt.
 * @param {string} tenantId
 * @param {string} docId
 * @param {string} [requesterId]
 * @param {string} [requesterRole]
 * @returns {Promise<void>}
 */
async function deleteDocument(tenantId, docId, requesterId, requesterRole) {
  const filter = {
    _id: oid(docId),
    tenantId: oid(tenantId),
    deletedAt: { $exists: false },
  };

  // Clients can only delete their own documents
  if (requesterRole === 'client' || requesterRole === 'team_member') {
    if (!requesterId) throw new BpError('Unauthorized', 401, 'AUTH_REQUIRED');
    filter.clientId = oid(requesterId);
  }

  const result = await col('documents').updateOne(filter, {
    $set: { deletedAt: new Date(), updatedAt: new Date() },
  });

  if (result.matchedCount === 0) {
    throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  }
}

// ─── Reprocess Document ───────────────────────────────────────────────────────

/**
 * Resets a document back to pending_processing so the OCR job can run again.
 * @param {string} tenantId
 * @param {string} docId
 * @returns {Promise<void>}
 */
async function reprocessDocument(tenantId, docId) {
  const doc = await col('documents').findOne({
    _id: oid(docId),
    tenantId: oid(tenantId),
    deletedAt: { $exists: false },
  });

  if (!doc) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');

  if (!doc.files || doc.files.length === 0) {
    throw new BpError('Document has no files to reprocess', 400, 'NO_FILES');
  }

  const attempts = doc.processingAttempts || 0;
  if (attempts >= MAX_PROCESSING_ATTEMPTS) {
    throw new BpError(
      'Maximum processing attempts reached. Document cannot be reprocessed.',
      409,
      'MAX_RETRIES_EXCEEDED'
    );
  }

  await col('documents').updateOne(
    { _id: oid(docId) },
    {
      $set: {
        status: 'pending_processing',
        'extraction.status': 'pending',
        'extraction.errorMessage': null,
        updatedAt: new Date(),
      },
      $inc: { processingAttempts: 1 },
    }
  );
}

// ─── Fill Manually ────────────────────────────────────────────────────────────

/**
 * Manually fills extraction data on a failed document and moves it to review.
 * @param {string} tenantId
 * @param {string} docId
 * @param {{
 *   vendorName?: string,
 *   documentNumber?: string,
 *   dateIssued?: string,
 *   dateDue?: string,
 *   total?: number,
 *   vatAmount?: number,
 *   vatRate?: number,
 *   currency?: string,
 *   categoryId?: string,
 *   notes?: string,
 *   filledBy?: string,
 *   filledByRole?: string
 * }} data
 * @returns {Promise<object>}
 */
async function fillManually(tenantId, docId, data) {
  const existing = await col('documents').findOne(
    { _id: oid(docId), tenantId: oid(tenantId), deletedAt: { $exists: false } },
    { projection: { status: 1 } }
  );

  if (!existing) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');

  const setData = {
    status: 'pending_review',
    'extraction.status': 'completed',
    'extraction.engine': 'manual',
    'extraction.overallConfidence': 100,
    updatedAt: new Date(),
    overrides: {
      ...(data.filledBy && { editedBy: oid(data.filledBy) }),
      editedAt: new Date(),
      ...(data.filledByRole && { editedByRole: data.filledByRole }),
      ...(data.vendorName ? { vendor: { name: data.vendorName } } : {}),
      ...(data.documentNumber ? { documentNumber: data.documentNumber } : {}),
      ...(data.dateIssued || data.dateDue
        ? {
            dates: {
              ...(data.dateIssued ? { issued: new Date(data.dateIssued) } : {}),
              ...(data.dateDue ? { due: new Date(data.dateDue) } : {}),
            },
          }
        : {}),
      ...(data.total !== undefined || data.vatAmount !== undefined || data.vatRate !== undefined
        ? {
            amounts: {
              ...(data.total !== undefined ? { total: data.total } : {}),
              ...(data.vatAmount !== undefined ? { vatAmount: data.vatAmount } : {}),
              ...(data.vatRate !== undefined ? { vatRate: data.vatRate } : {}),
            },
          }
        : {}),
    },
  };

  if (data.categoryId) {
    const category = await col('categories').findOne({ _id: oid(data.categoryId) });
    setData.category = {
      categoryId: oid(data.categoryId),
      name: category ? category.name : undefined,
      accountingCode: category ? category.accountingCode : undefined,
      ...(data.filledBy && { assignedBy: oid(data.filledBy) }),
      assignedAt: new Date(),
    };
  }

  if (data.notes !== undefined) setData.notes = data.notes;
  if (data.currency) setData['extraction.currency'] = data.currency;

  const result = await col('documents').findOneAndUpdate(
    { _id: oid(docId), tenantId: oid(tenantId) },
    { $set: setData },
    { returnDocument: 'after' }
  );

  const doc = result && result.value ? result.value : result;
  if (!doc) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  return doc;
}

// ─── Revert Client Edit ───────────────────────────────────────────────────────

/**
 * Reverts client overrides and restores the previous approved status.
 * @param {string} tenantId
 * @param {string} docId
 * @param {string} rejectedById
 * @param {{ reason: string, reasonText?: string }} rejection
 * @returns {Promise<object>}
 */
async function revertClientEdit(tenantId, docId, rejectedById, rejection) {
  const existing = await col('documents').findOne(
    { _id: oid(docId), tenantId: oid(tenantId), deletedAt: { $exists: false } },
    { projection: { status: 1, review: 1, clientId: 1 } }
  );

  if (!existing) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');

  const restoreStatus = (existing.review && existing.review.previousStatus) || 'approved';

  const result = await col('documents').findOneAndUpdate(
    { _id: oid(docId), tenantId: oid(tenantId) },
    {
      $set: {
        status: restoreStatus,
        rejection: {
          rejectedBy: oid(rejectedById),
          rejectedAt: new Date(),
          reason: rejection.reason,
          ...(rejection.reasonText && { reasonText: rejection.reasonText }),
        },
        updatedAt: new Date(),
      },
      $unset: {
        overrides: '',
        'review.previousStatus': '',
      },
    },
    { returnDocument: 'after' }
  );

  const doc = result && result.value ? result.value : result;
  if (!doc) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');

  // Notify client of rejection
  if (existing.clientId) {
    await createNotification({
      tenantId,
      recipientId: existing.clientId.toString(),
      type: 'document_rejected',
      title: 'העריכה שלך נדחתה',
      body: rejection.reasonText || rejection.reason,
      data: { documentId: docId },
    }).catch(() => {}); // non-fatal
  }

  return doc;
}

// ─── Vendors Summary ──────────────────────────────────────────────────────────

/**
 * Returns a vendor-level summary (document count, total amount) for a tenant/client.
 * @param {string} tenantId
 * @param {{ clientId?: string }} [options={}]
 * @returns {Promise<Array<{ vendorName: string, currency: string, documentCount: number, totalAmount: number, lastSeen: Date }>>}
 */
async function getVendorsSummary(tenantId, options = {}) {
  const match = {
    tenantId: oid(tenantId),
    status: { $nin: ['failed', 'rejected'] },
    deletedAt: { $exists: false },
    'extraction.vendor.name': { $exists: true, $ne: '' },
  };

  if (options.clientId) {
    match.clientId = oid(options.clientId);
  }

  const results = await col('documents')
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            vendorName: '$extraction.vendor.name',
            currency: { $ifNull: ['$extraction.currency', 'ILS'] },
          },
          documentCount: { $sum: 1 },
          totalAmount: { $sum: '$extraction.amounts.total' },
          lastSeen: { $max: '$createdAt' },
        },
      },
      { $sort: { '_id.vendorName': 1, totalAmount: -1 } },
      {
        $project: {
          _id: 0,
          vendorName: '$_id.vendorName',
          currency: '$_id.currency',
          documentCount: 1,
          totalAmount: 1,
          lastSeen: 1,
        },
      },
    ])
    .toArray();

  return results;
}

// ─── Post-Process Document (after OCR) ───────────────────────────────────────

/**
 * Called after OCR completes. Updates the document with extraction data,
 * upserts the vendor, suggests a category, and determines final status.
 * @param {string} tenantId
 * @param {string} docId
 * @param {{ engine: string, overallConfidence: number, extraction: object }} ocrResult
 * @returns {Promise<object>}
 */
async function postProcessDocument(tenantId, docId, ocrResult) {
  const { engine, overallConfidence, extraction } = ocrResult;

  // 1. Determine status based on confidence
  // < 70 → needs client review, otherwise → pending_review (accountant review)
  const status = overallConfidence < 70 ? 'needs_client_review' : 'pending_review';

  // 2. Upsert vendor if vendor name was extracted
  let vendorId;
  let suggestedCategoryName;

  if (extraction.vendor && extraction.vendor.name) {
    try {
      vendorId = await upsertVendor(tenantId, {
        name: extraction.vendor.name,
        normalizedName: extraction.vendor.normalizedName || normalizeName(extraction.vendor.name),
        taxId: extraction.vendor.taxId,
        address: extraction.vendor.address,
        phone: extraction.vendor.phone,
        email: extraction.vendor.email,
      });
    } catch (err) {
      console.error('[Docs] upsertVendor failed', err);
    }

    // 3. Suggest category based on vendor name
    try {
      suggestedCategoryName = await suggestCategory(tenantId, extraction.vendor.name, extraction.documentType);
    } catch (err) {
      console.error('[Docs] suggestCategory failed', err);
    }
  }

  // 4. Resolve category document if we have a suggestion
  let categoryData;
  if (suggestedCategoryName) {
    const categoryDoc = await col('categories').findOne({
      tenantId: oid(tenantId),
      name: suggestedCategoryName,
      isActive: true,
    });
    if (categoryDoc) {
      categoryData = {
        categoryId: categoryDoc._id,
        name: categoryDoc.name,
        accountingCode: categoryDoc.accountingCode,
        assignedAt: new Date(),
        assignedBy: null, // system-assigned
      };
    }
  }

  // 5. Build the update payload
  const setData = {
    status,
    'extraction.status': 'completed',
    'extraction.engine': engine,
    'extraction.overallConfidence': overallConfidence,
    updatedAt: new Date(),
  };

  // Spread all extracted fields under extraction.*
  const fieldMap = [
    'documentType', 'vendor', 'customer', 'documentNumber', 'referenceNumber',
    'currency', 'exchangeRate', 'dates', 'amounts', 'paymentMethod', 'paymentReference', 'lineItems',
  ];
  for (const field of fieldMap) {
    if (extraction[field] !== undefined) {
      setData[`extraction.${field}`] = extraction[field];
    }
  }

  if (vendorId) {
    setData.vendorId = vendorId;
  }

  if (categoryData) {
    setData.category = categoryData;
  }

  const result = await col('documents').findOneAndUpdate(
    { _id: oid(docId), tenantId: oid(tenantId) },
    { $set: setData },
    { returnDocument: 'after' }
  );

  const doc = result && result.value ? result.value : result;
  if (!doc) throw new BpError('Document not found after OCR update', 404, 'DOCUMENT_NOT_FOUND');

  return doc;
}

const VALID_STATUSES = ['pending_processing', 'needs_client_review', 'pending_review', 'approved', 'rejected', 'exported', 'duplicate', 'failed'];

async function setDocumentStatus(tenantId, docId, status) {
  if (!VALID_STATUSES.includes(status)) throw new BpError('Invalid status', 400, 'INVALID_STATUS');
  const result = await col('documents').findOneAndUpdate(
    { _id: oid(docId), tenantId: oid(tenantId), deletedAt: { $exists: false } },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  const updated = result && result.value ? result.value : result;
  if (!updated) throw new BpError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  return updated;
}

module.exports = {
  listDocuments,
  getDocument,
  createDocumentRecord,
  updateDocument,
  approveDocument,
  rejectDocument,
  deleteDocument,
  reprocessDocument,
  fillManually,
  revertClientEdit,
  getVendorsSummary,
  postProcessDocument,
  setDocumentStatus,
};
