/**
 * WOW job queue — Mongo-backed, resumable on process restart.
 *
 * Collection: wow_jobs
 *   { sessionId, briefId, kind: 'gemini' | 'ads',
 *     status: 'pending' | 'running' | 'completed' | 'failed',
 *     attempts, heartbeatAt, createdAt, updatedAt, lastError? }
 *
 * Kind = 'gemini'  → runs the HTML + images pipeline
 * Kind = 'ads'     → runs the 10-ad generation pipeline
 *
 * Flow:
 *   enqueue()              → insert {status:'pending'} + fire run() (fire-and-forget)
 *   run()                  → mark 'running', heartbeat, invoke pipeline, mark 'completed'/'failed'
 *   resumePendingJobs()    → called at server boot; finds stale ('running' with no heartbeat)
 *                            + any leftover 'pending' jobs and re-invokes run() for each.
 */

const { DB } = require("../../config/db");

const COL = "wow_jobs";
const HEARTBEAT_MS = 10_000;       // pipeline updates this field while running
const STALE_AFTER_MS = 90_000;     // any 'running' older than this is considered dead
const MAX_ATTEMPTS = 5;

let _runners = null; // injected via register() to avoid circular require

/**
 * Register the functions that execute each job kind.
 * Called once at server boot.
 *
 * @param {{
 *   gemini: (sessionId: string, opts?: object) => Promise<any>,
 *   ads:    (sessionId: string, opts?: object) => Promise<any>,
 * }} runners
 */
const register = (runners) => {
  _runners = runners;
};

const now = () => new Date();
const col = () => DB.collection(COL);

/**
 * Create or update a job row and fire the runner async.
 * Returns the created/existing job doc.
 */
const enqueue = async ({ sessionId, briefId, kind }) => {
  if (!sessionId || !kind) throw new Error("sessionId and kind required");
  await col().updateOne(
    { sessionId, kind },
    {
      $setOnInsert: {
        sessionId,
        briefId: briefId || null,
        kind,
        attempts: 0,
        createdAt: now(),
        lastError: null,
      },
      $set: { status: "pending", updatedAt: now(), heartbeatAt: now() },
    },
    { upsert: true },
  );
  const doc = await col().findOne({ sessionId, kind });
  // fire-and-forget
  _invoke(doc).catch((err) => console.error(`[wow/jobs] unhandled runner error`, err));
  return doc;
};

/** Touch heartbeat — called periodically by the runner while working. */
const heartbeat = async (sessionId, kind) => {
  await col().updateOne({ sessionId, kind }, { $set: { heartbeatAt: now() } });
};

const markRunning = async (sessionId, kind) => {
  await col().updateOne(
    { sessionId, kind },
    { $set: { status: "running", heartbeatAt: now(), updatedAt: now() }, $inc: { attempts: 1 } },
  );
};

const markCompleted = async (sessionId, kind) => {
  await col().updateOne(
    { sessionId, kind },
    { $set: { status: "completed", heartbeatAt: now(), updatedAt: now(), lastError: null } },
  );
};

const markFailed = async (sessionId, kind, errMessage) => {
  await col().updateOne(
    { sessionId, kind },
    { $set: { status: "failed", heartbeatAt: now(), updatedAt: now(), lastError: errMessage } },
  );
};

const getJob = (sessionId, kind) => col().findOne({ sessionId, kind });

/**
 * Core runner: runs the pipeline for a single job row.
 * Keeps a heartbeat ticking so we can distinguish live jobs from dead ones.
 */
const _invoke = async (job) => {
  const { sessionId, kind, briefId, attempts } = job;

  if (!_runners || !_runners[kind]) {
    console.warn(`[wow/jobs] no runner registered for kind=${kind} (session=${sessionId})`);
    await markFailed(sessionId, kind, `no runner for kind=${kind}`);
    return;
  }
  if ((attempts ?? 0) >= MAX_ATTEMPTS) {
    console.warn(`[wow/jobs] ${kind}/${sessionId} exceeded MAX_ATTEMPTS=${MAX_ATTEMPTS}`);
    await markFailed(sessionId, kind, `exceeded MAX_ATTEMPTS`);
    return;
  }

  await markRunning(sessionId, kind);
  const heartbeatTimer = setInterval(() => {
    heartbeat(sessionId, kind).catch(() => { /* best-effort */ });
  }, HEARTBEAT_MS);

  try {
    console.log(`[wow/jobs] ▶ ${kind}/${sessionId} (attempt ${(attempts ?? 0) + 1})`);
    await _runners[kind](sessionId, { briefId });
    clearInterval(heartbeatTimer);
    await markCompleted(sessionId, kind);
    console.log(`[wow/jobs] ✅ ${kind}/${sessionId} completed`);
  } catch (err) {
    clearInterval(heartbeatTimer);
    const msg = (err && err.message) || String(err);
    console.error(`[wow/jobs] ❌ ${kind}/${sessionId} failed:`, msg);
    await markFailed(sessionId, kind, msg);
  }
};

/**
 * Resume pending + stale-running jobs at server boot.
 * Designed to be called from server.js after DB connect.
 */
const resumePendingJobs = async () => {
  if (!_runners) {
    console.warn(`[wow/jobs] resumePendingJobs called before register() — skipping`);
    return;
  }
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);

  // Find all pending jobs + running jobs whose heartbeat is too old.
  const cursor = col().find({
    $or: [
      { status: "pending" },
      { status: "running", heartbeatAt: { $lt: staleBefore } },
    ],
    attempts: { $lt: MAX_ATTEMPTS },
  });
  const stuck = await cursor.toArray();
  if (stuck.length === 0) {
    console.log(`[wow/jobs] no pending/stale jobs to resume`);
    return;
  }
  console.log(`[wow/jobs] resuming ${stuck.length} pending/stale job(s)`);
  for (const job of stuck) {
    // Fire each async — don't await serially so a slow one doesn't block others.
    _invoke(job).catch((err) => console.error(`[wow/jobs] resume error ${job.kind}/${job.sessionId}:`, err));
  }
};

module.exports = {
  register,
  enqueue,
  heartbeat,
  getJob,
  markCompleted,
  markFailed,
  resumePendingJobs,
};
