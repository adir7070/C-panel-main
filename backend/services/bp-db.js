'use strict';

const { getDB } = require('../config/db');
const { ObjectId } = require('mongodb');

/**
 * Returns a MongoDB collection with the `bp_` prefix applied.
 * @param {string} name - Collection name without prefix (e.g. 'users' → 'bp_users')
 */
function col(name) {
  return getDB().collection('bp_' + name);
}

/**
 * Converts a string to a MongoDB ObjectId.
 * Throws a BpError with status 400 if the string is not a valid ObjectId.
 * @param {string} str
 * @returns {ObjectId}
 */
function oid(str) {
  try {
    return new ObjectId(str);
  } catch {
    throw new BpError(`Invalid id: ${str}`, 400, 'INVALID_ID');
  }
}

/**
 * Normalizes a raw phone string to the 972XXXXXXXXX format.
 * - Strips all non-digit characters
 * - If already starts with '972' → keep as-is
 * - If starts with '0' → replace leading '0' with '972'
 * - Otherwise → keep digits as-is
 * @param {string} raw
 * @returns {string}
 */
function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return `972${digits.slice(1)}`;
  return digits;
}

/**
 * Returns the current date/time as a native Date object.
 * @returns {Date}
 */
function nowISO() {
  return new Date();
}

/**
 * Extracts pagination parameters from a query object.
 * @param {object} query - e.g. req.query
 * @returns {{ page: number, limit: number, skip: number }}
 */
function paginate(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/**
 * Application-level error class for BillPilot routes.
 * Carries an HTTP status code and a short error code string.
 */
class BpError extends Error {
  /**
   * @param {string} message
   * @param {number} [status=400]
   * @param {string} [code='ERROR']
   */
  constructor(message, status = 400, code = 'ERROR') {
    super(message);
    this.name = 'BpError';
    this.status = status;
    this.code = code;
  }
}

module.exports = { col, oid, normalizePhone, nowISO, paginate, BpError };
