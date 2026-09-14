'use strict';

const { col, oid, BpError } = require('./bp-db');

// ─── List Clients ─────────────────────────────────────────────────────────────

/**
 * Returns all non-deleted clients linked to an accountant.
 * @param {string} tenantId
 * @param {string} accountantId
 * @returns {Promise<object[]>}
 */
async function listClients(tenantId, accountantId) {
  const clients = await col('users')
    .find({
      role: 'client',
      parentAccountantId: oid(accountantId),
      deletedAt: { $exists: false },
    })
    .project({ passwordHash: 0, refreshToken: 0 })
    .sort({ 'profile.firstName': 1 })
    .toArray();

  return clients;
}

// ─── Get Client by ID ─────────────────────────────────────────────────────────

/**
 * Returns a single client with aggregated document statistics.
 * @param {string} tenantId
 * @param {string} clientId
 * @returns {Promise<object>}
 */
async function getClientById(tenantId, clientId) {
  const client = await col('users').findOne(
    { _id: oid(clientId), role: 'client', deletedAt: { $exists: false } },
    { projection: { passwordHash: 0, refreshToken: 0 } }
  );

  if (!client) {
    throw new BpError('Client not found', 404, 'CLIENT_NOT_FOUND');
  }

  // Aggregate document stats for this client in this tenant
  const [statsResult] = await col('documents')
    .aggregate([
      {
        $match: {
          tenantId: oid(tenantId),
          clientId: oid(clientId),
          deletedAt: { $exists: false },
        },
      },
      {
        $group: {
          _id: null,
          totalDocuments: { $sum: 1 },
          pendingDocuments: {
            $sum: { $cond: [{ $eq: ['$status', 'pending_review'] }, 1, 0] },
          },
          approvedDocuments: {
            $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] },
          },
          rejectedDocuments: {
            $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] },
          },
          totalAmount: { $sum: '$extraction.amounts.total' },
          lastDocumentAt: { $max: '$createdAt' },
        },
      },
    ])
    .toArray();

  const stats = statsResult || {
    totalDocuments: 0,
    pendingDocuments: 0,
    approvedDocuments: 0,
    rejectedDocuments: 0,
    totalAmount: 0,
    lastDocumentAt: null,
  };

  // Remove the aggregation _id
  delete stats._id;

  return { ...client, stats };
}

// ─── Update Client ────────────────────────────────────────────────────────────

/**
 * Updates profile fields on a client user.
 * @param {string} clientId
 * @param {{
 *   name?: string,
 *   phone?: string,
 *   taxId?: string,
 *   address?: { street?: string, city?: string, zip?: string, country?: string }
 * }} updates
 * @returns {Promise<object>}
 */
async function updateClient(clientId, updates) {
  const setData = { updatedAt: new Date() };

  if (updates.name) setData['profile.firstName'] = updates.name;
  if (updates.phone) setData['profile.phone'] = updates.phone;
  if (updates.taxId) setData['profile.taxId'] = updates.taxId;

  if (updates.address) {
    if (updates.address.street !== undefined) setData['profile.address.street'] = updates.address.street;
    if (updates.address.city !== undefined) setData['profile.address.city'] = updates.address.city;
    if (updates.address.zip !== undefined) setData['profile.address.zip'] = updates.address.zip;
    if (updates.address.country !== undefined) setData['profile.address.country'] = updates.address.country;
  }

  const result = await col('users').findOneAndUpdate(
    { _id: oid(clientId), role: 'client', deletedAt: { $exists: false } },
    { $set: setData },
    { returnDocument: 'after', projection: { passwordHash: 0, refreshToken: 0 } }
  );

  const client = result && result.value ? result.value : result;
  if (!client) {
    throw new BpError('Client not found', 404, 'CLIENT_NOT_FOUND');
  }

  return client;
}

// ─── Delete Client ────────────────────────────────────────────────────────────

/**
 * Soft-deletes a client by setting deletedAt.
 * @param {string} clientId
 * @returns {Promise<void>}
 */
async function deleteClient(clientId) {
  const result = await col('users').updateOne(
    { _id: oid(clientId), role: 'client', deletedAt: { $exists: false } },
    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
  );

  if (result.matchedCount === 0) {
    throw new BpError('Client not found', 404, 'CLIENT_NOT_FOUND');
  }
}

module.exports = { listClients, getClientById, updateClient, deleteClient };
