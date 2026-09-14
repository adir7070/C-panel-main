"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// WaQueueService — MongoDB-backed Job Queue (Feature 33)
//
// Replaces Redis/BullMQ with a MongoDB collection as the persistent job store.
// The worker (wa-worker.service.js) polls this collection on an interval.
//
// MongoDB collection: wa_marketing_jobs
// Job lifecycle:  pending → processing → done | failed
//
// Usage:
//   const queue = require('./wa-queue.service');
//   const jobId = await queue.enqueue({ sessionId, jobType: 'send-text', payload: { phone, text } });
//   const stats = await queue.getStats();
// ─────────────────────────────────────────────────────────────────────────────

const { ObjectId } = require("mongodb");
const DB = require("../../utils/DB");
const { WaQueueError } = require("../../errors/wa-errors");

const COLLECTION = "wa_marketing_jobs";

// ── Job types ─────────────────────────────────────────────────────────────────
const JOB_TYPES = {
  SEND_TEXT:      "send-text",
  SEND_VCARD:     "send-vcard",
  SEND_LOCATION:  "send-location",
  SEND_STATUS:    "send-status",
  GROUP_INVITE:   "send-group-invite",
};

const MAX_ATTEMPTS = 3;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a new job to the queue.
 *
 * @param {object} params
 * @param {string} params.sessionId   - Baileys session to use for sending
 * @param {string} params.jobType     - One of JOB_TYPES values
 * @param {object} params.payload     - Job-specific data (phone, text, lat/lng, etc.)
 * @param {number} [params.priority]  - Lower = higher priority (default 10)
 * @param {Date}   [params.runAt]     - Schedule for a future time (default: now)
 * @param {string} [params.campaignId] - Optional campaign grouping ID
 * @returns {Promise<string>}  Inserted MongoDB _id as string
 */
async function enqueue({ sessionId, jobType, payload, priority = 10, runAt, campaignId }) {
  if (!sessionId) throw new WaQueueError("sessionId is required");
  if (!JOB_TYPES[jobType.toUpperCase().replace(/-/g, "_")] && !Object.values(JOB_TYPES).includes(jobType)) {
    throw new WaQueueError(`Unknown jobType: ${jobType}`, null, { validTypes: Object.values(JOB_TYPES) });
  }
  if (!payload || typeof payload !== "object") throw new WaQueueError("payload must be an object");

  try {
    const result = await DB.collection(COLLECTION).insertOne({
      sessionId,
      jobType,
      payload,
      priority,
      campaignId: campaignId || null,
      status: "pending",
      attempts: 0,
      lastError: null,
      runAt: runAt || new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = result.insertedId.toString();
    return jobId;
  } catch (err) {
    throw new WaQueueError("Failed to enqueue job", null, { reason: err.message, jobType });
  }
}

/**
 * Bulk-enqueue an array of jobs (e.g. a full campaign blast).
 *
 * @param {object[]} jobs  - Array of params objects (same shape as enqueue())
 * @returns {Promise<string[]>}  Array of inserted job IDs
 */
async function enqueueBulk(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return [];

  const now = new Date();
  const docs = jobs.map(({ sessionId, jobType, payload, priority = 10, runAt, campaignId }) => ({
    sessionId,
    jobType,
    payload,
    priority,
    campaignId: campaignId || null,
    status: "pending",
    attempts: 0,
    lastError: null,
    runAt: runAt || now,
    createdAt: now,
    updatedAt: now,
  }));

  try {
    const result = await DB.collection(COLLECTION).insertMany(docs);
    return Object.values(result.insertedIds).map((id) => id.toString());
  } catch (err) {
    throw new WaQueueError("Bulk enqueue failed", null, { reason: err.message, count: jobs.length });
  }
}

/**
 * Atomically claim the next available job for processing.
 * Returns null if no job is ready.
 *
 * @param {string[]} [sessionIds]  - Only claim jobs for these sessions (optional filter)
 * @returns {Promise<object|null>}
 */
async function claimNext(sessionIds) {
  const filter = {
    status: "pending",
    attempts: { $lt: MAX_ATTEMPTS },
    runAt: { $lte: new Date() },
  };
  if (sessionIds && sessionIds.length > 0) {
    filter.sessionId = { $in: sessionIds };
  }

  try {
    const job = await DB.collection(COLLECTION).findOneAndUpdate(
      filter,
      {
        $set: { status: "processing", updatedAt: new Date() },
        $inc: { attempts: 1 },
      },
      {
        sort: { priority: 1, runAt: 1 },   // lowest priority number first, then oldest
        returnDocument: "after",
      },
    );

    return job || null;
  } catch (err) {
    console.error("[WaQueue] claimNext error:", err.message);
    return null;
  }
}

/**
 * Mark a job as successfully completed.
 * @param {string|ObjectId} jobId
 */
async function markDone(jobId) {
  await DB.collection(COLLECTION).updateOne(
    { _id: _toObjectId(jobId) },
    { $set: { status: "done", updatedAt: new Date() } },
  );
}

/**
 * Mark a job as failed. If attempts < MAX_ATTEMPTS, resets to pending for retry.
 *
 * @param {string|ObjectId} jobId
 * @param {string}          errorMessage
 * @param {number}          attempts  - Current attempt count (from the job doc)
 * @param {number}          [retryDelayMs=30000]  - How long before retry is eligible
 */
async function markFailed(jobId, errorMessage, attempts, retryDelayMs = 30_000) {
  const willRetry = attempts < MAX_ATTEMPTS;
  await DB.collection(COLLECTION).updateOne(
    { _id: _toObjectId(jobId) },
    {
      $set: {
        status: willRetry ? "pending" : "failed",
        lastError: errorMessage,
        updatedAt: new Date(),
        // If retrying, push runAt forward so it doesn't get picked immediately
        ...(willRetry && { runAt: new Date(Date.now() + retryDelayMs) }),
      },
    },
  );
}

/**
 * Delay a specific job (used by Collision Detection — Feature 13).
 * Resets status to pending and pushes runAt forward.
 *
 * @param {string|ObjectId} jobId
 * @param {number}          delayMs
 */
async function delayJob(jobId, delayMs) {
  await DB.collection(COLLECTION).updateOne(
    { _id: _toObjectId(jobId) },
    {
      $set: {
        status: "pending",
        runAt: new Date(Date.now() + delayMs),
        updatedAt: new Date(),
      },
      $inc: { attempts: -1 }, // don't count collision delay as a failed attempt
    },
  );
}

/**
 * Pause all pending jobs for a session (used by Kill Switch — Feature 29).
 * Sets status to 'paused' — they won't be claimed until resumed.
 *
 * @param {string} sessionId
 * @returns {Promise<number>}  Count of paused jobs
 */
async function pauseSession(sessionId) {
  const result = await DB.collection(COLLECTION).updateMany(
    { sessionId, status: "pending" },
    { $set: { status: "paused", updatedAt: new Date() } },
  );
  return result.modifiedCount;
}

/**
 * Resume all paused jobs for a session.
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
async function resumeSession(sessionId) {
  const result = await DB.collection(COLLECTION).updateMany(
    { sessionId, status: "paused" },
    { $set: { status: "pending", updatedAt: new Date() } },
  );
  return result.modifiedCount;
}

/**
 * Cancel (delete) all pending/paused jobs for a session or campaign.
 *
 * @param {object} filter  - { sessionId } or { campaignId }
 * @returns {Promise<number>}
 */
async function cancelJobs(filter) {
  const query = { status: { $in: ["pending", "paused"] } };
  if (filter.sessionId) query.sessionId = filter.sessionId;
  if (filter.campaignId) query.campaignId = filter.campaignId;

  const result = await DB.collection(COLLECTION).deleteMany(query);
  return result.deletedCount;
}

/**
 * Return queue statistics snapshot.
 * @param {string} [sessionId]  - Scope to one session (optional)
 * @returns {Promise<object>}
 */
async function getStats(sessionId) {
  const match = sessionId ? { sessionId } : {};

  const pipeline = [
    { $match: match },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ];

  const rows = await DB.collection(COLLECTION).aggregate(pipeline).toArray();
  const stats = { pending: 0, processing: 0, done: 0, failed: 0, paused: 0 };
  for (const row of rows) {
    if (row._id in stats) stats[row._id] = row.count;
  }
  stats.total = Object.values(stats).reduce((a, b) => a + b, 0);
  return stats;
}

/**
 * Clean up completed/failed jobs older than `maxAgeDays` days.
 * Call periodically (e.g. via node-cron) to prevent collection bloat.
 *
 * @param {number} [maxAgeDays=7]
 * @returns {Promise<number>}  Deleted count
 */
async function purgeOldJobs(maxAgeDays = 7) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const result = await DB.collection(COLLECTION).deleteMany({
    status: { $in: ["done", "failed"] },
    updatedAt: { $lt: cutoff },
  });
  return result.deletedCount;
}

/**
 * Ensure MongoDB indexes exist for efficient queue queries.
 * Safe to call on every startup (createIndex is idempotent).
 */
async function ensureIndexes() {
  try {
    const col = DB.collection(COLLECTION);
    await col.createIndex({ status: 1, runAt: 1, priority: 1 });
    await col.createIndex({ sessionId: 1, status: 1 });
    await col.createIndex({ campaignId: 1, status: 1 });
    await col.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // TTL: 30 days
  } catch (err) {
    console.warn("[WaQueue] Index creation warning:", err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _toObjectId(id) {
  if (id instanceof ObjectId) return id;
  try { return new ObjectId(id); } catch {
    throw new WaQueueError(`Invalid job ID: ${id}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Migrate all pending/paused jobs from an old sessionId to a new one.
 * Called when a session is replaced (e.g. after disconnect + new UUID created).
 *
 * @param {string} oldSessionId
 * @param {string} newSessionId
 * @returns {Promise<number>} Number of jobs migrated
 */
async function migrateJobs(oldSessionId, newSessionId) {
  const result = await DB.collection(COLLECTION).updateMany(
    { sessionId: oldSessionId, status: { $in: ["pending", "paused", "failed"] } },
    { $set: { sessionId: newSessionId, status: "pending", attempts: 0, updatedAt: new Date() } },
  );
  if (result.modifiedCount > 0) {
    console.log(`[WaQueue] Migrated ${result.modifiedCount} job(s) from ${oldSessionId} → ${newSessionId}`);
  }
  return result.modifiedCount;
}

module.exports = {
  enqueue,
  enqueueBulk,
  claimNext,
  markDone,
  markFailed,
  delayJob,
  pauseSession,
  resumeSession,
  cancelJobs,
  migrateJobs,
  getStats,
  purgeOldJobs,
  ensureIndexes,
  JOB_TYPES,
  MAX_ATTEMPTS,
};
