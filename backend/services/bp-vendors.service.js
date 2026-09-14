'use strict';

const { col, oid, BpError } = require('./bp-db');
const { ObjectId } = require('mongodb');

// ─── Upsert Vendor ────────────────────────────────────────────────────────────

/**
 * Upserts a vendor record for a tenant by normalized name.
 * Increments totalDocuments on every call.
 * @param {string} tenantId
 * @param {{ name: string, normalizedName: string, taxId?: string, address?: string, phone?: string, email?: string }} vendorData
 * @returns {Promise<ObjectId>} The vendor's _id
 */
async function upsertVendor(tenantId, vendorData) {
  const now = new Date();
  const result = await col('vendors').findOneAndUpdate(
    {
      tenantId: oid(tenantId),
      normalizedName: vendorData.normalizedName,
    },
    {
      $set: {
        name: vendorData.name,
        ...(vendorData.taxId !== undefined && { taxId: vendorData.taxId }),
        ...(vendorData.address !== undefined && { 'contact.address': vendorData.address }),
        ...(vendorData.phone !== undefined && { 'contact.phone': vendorData.phone }),
        ...(vendorData.email !== undefined && { 'contact.email': vendorData.email }),
        'stats.lastSeen': now,
        updatedAt: now,
      },
      $setOnInsert: {
        tenantId: oid(tenantId),
        normalizedName: vendorData.normalizedName,
        'stats.firstSeen': now,
        'stats.totalAmount': 0,
        isVerified: false,
        createdAt: now,
      },
      $inc: { 'stats.totalDocuments': 1 },
    },
    { upsert: true, returnDocument: 'after' }
  );

  // MongoDB driver v4+ returns { value } or the doc directly depending on version
  const doc = result && result.value ? result.value : result;
  return doc._id;
}

// ─── List Vendors ─────────────────────────────────────────────────────────────

/**
 * Lists vendors for a tenant with optional search and pagination.
 * @param {string} tenantId
 * @param {{ search?: string, page?: number, limit?: number }} [query={}]
 * @returns {Promise<{ vendors: object[], total: number, page: number, limit: number }>}
 */
async function listVendors(tenantId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const filter = { tenantId: oid(tenantId) };

  if (query.search) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = { $regex: escaped, $options: 'i' };
  }

  const [vendors, total] = await Promise.all([
    col('vendors').find(filter).sort({ 'stats.lastSeen': -1 }).skip(skip).limit(limit).toArray(),
    col('vendors').countDocuments(filter),
  ]);

  return { vendors, total, page, limit };
}

// ─── Get Vendor by ID ─────────────────────────────────────────────────────────

/**
 * Fetches a single vendor by id, scoped to a tenant.
 * @param {string} tenantId
 * @param {string} vendorId
 * @returns {Promise<object>}
 */
async function getVendorById(tenantId, vendorId) {
  const vendor = await col('vendors').findOne({
    _id: oid(vendorId),
    tenantId: oid(tenantId),
  });

  if (!vendor) {
    throw new BpError('Vendor not found', 404, 'VENDOR_NOT_FOUND');
  }

  return vendor;
}

// ─── Update Vendor Stats ──────────────────────────────────────────────────────

/**
 * Increments document count, adds to total amount, and updates lastSeen for a vendor.
 * @param {string} tenantId
 * @param {string} normalizedName
 * @param {number} amount - Amount to add to totalAmount
 * @param {Date|string} [docDate] - Date of the document (used for lastSeen if more recent)
 * @returns {Promise<void>}
 */
async function updateVendorStats(tenantId, normalizedName, amount, docDate) {
  const now = docDate ? new Date(docDate) : new Date();

  await col('vendors').updateOne(
    { tenantId: oid(tenantId), normalizedName },
    {
      $inc: {
        'stats.totalDocuments': 1,
        'stats.totalAmount': amount || 0,
      },
      $max: { 'stats.lastSeen': now },
      $set: { updatedAt: new Date() },
    }
  );
}

async function updateVendor(tenantId, vendorId, updates) {
  const allowed = ['name', 'taxId', 'contact', 'suggestedCategory', 'isVerified', 'aliases'];
  const set = { updatedAt: new Date() };
  for (const k of allowed) if (updates[k] !== undefined) set[k] = updates[k];
  if (updates.name) set.normalizedName = require('./bp-ocr.service').normalizeName(updates.name);
  const result = await col('vendors').findOneAndUpdate(
    { _id: oid(vendorId), tenantId: oid(tenantId) },
    { $set: set },
    { returnDocument: 'after' }
  );
  if (!result) throw new BpError('Vendor not found', 404, 'NOT_FOUND');
  return result;
}

module.exports = { upsertVendor, listVendors, getVendorById, updateVendorStats, updateVendor };
