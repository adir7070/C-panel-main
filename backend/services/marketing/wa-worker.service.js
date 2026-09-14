"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// WaWorkerService — Queue Worker
//
// Polls the MongoDB job queue and processes WhatsApp marketing jobs with:
//   • Feature 2  — Anti-Ban Human Simulator (typing presence + dynamic delay)
//   • Feature 13 — Collision Detection (delay if contact is composing)
//   • Feature 30 — Spintax resolution before sending
//
// The worker loop:
//   1. Claim next pending job from MongoDB queue
//   2. Resolve Spintax variations in the message text
//   3. Check if target is composing (Collision Detection) → delay if yes
//   4. Simulate human typing (presenceUpdate + sleep)
//   5. Send the message
//   6. Mark job done / failed
//   7. Wait inter-message delay before next job
//
// Usage (call once on server startup):
//   const worker = require('./wa-worker.service');
//   worker.start();
//
//   worker.stop();   // graceful shutdown
//   worker.status(); // { running, jobsProcessed, jobsFailed }
// ─────────────────────────────────────────────────────────────────────────────

const queue = require("./wa-queue.service");
const mktSession = require("./wa-marketing-session.service");
const dynamicConfig = require("./dynamic-config.service");
const { dbLogMessage } = require("../wa-session.service");
const { spintax, hasSpintax } = require("./spintax.utils");
const { WaBanRiskError, WaSessionError } = require("../../errors/wa-errors");

// ── State ─────────────────────────────────────────────────────────────────────
let _running = false;
let _timer = null;
let _processing = false;

const _stats = { jobsProcessed: 0, jobsFailed: 0, startedAt: null };

// How often the loop ticks when idle (no jobs found)
const IDLE_POLL_MS = 3_000;
// How often the loop ticks when actively processing (pick next job immediately)
const ACTIVE_POLL_MS = 100;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the worker loop.
 * Safe to call multiple times — only one loop runs at a time.
 */
function start() {
  if (_running) return;
  _running = true;
  _stats.startedAt = new Date();
  console.log("[WaWorker] Started");
  _scheduleNext(IDLE_POLL_MS);
}

/**
 * Stop the worker loop gracefully.
 * Waits for any in-progress job to complete before stopping.
 */
function stop() {
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  console.log("[WaWorker] Stopped");
}

/**
 * Worker health snapshot.
 * @returns {{ running: boolean, processing: boolean, jobsProcessed: number, jobsFailed: number, startedAt: Date|null }}
 */
function status() {
  return {
    running: _running,
    processing: _processing,
    ..._stats,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core loop
// ─────────────────────────────────────────────────────────────────────────────

function _scheduleNext(delayMs) {
  if (!_running) return;
  _timer = setTimeout(_tick, delayMs);
}

async function _tick() {
  if (!_running) return;
  if (_processing) {
    // Another tick is already running (shouldn't happen with setTimeout, but guard anyway)
    _scheduleNext(IDLE_POLL_MS);
    return;
  }

  // Check master on/off switch from DynamicConfig
  const workerEnabled = await dynamicConfig.get("workerEnabled");
  if (!workerEnabled) {
    _scheduleNext(IDLE_POLL_MS);
    return;
  }

  const job = await queue.claimNext();

  if (!job) {
    // No pending jobs — poll slowly
    _scheduleNext(IDLE_POLL_MS);
    return;
  }

  _processing = true;
  try {
    await _processJob(job);
    _stats.jobsProcessed++;
    // Process next job quickly
    _scheduleNext(await _interMessageDelay());
  } catch (err) {
    _stats.jobsFailed++;
    // Error already handled inside _processJob — keep running
    _scheduleNext(IDLE_POLL_MS);
  } finally {
    _processing = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job processor
// ─────────────────────────────────────────────────────────────────────────────

async function _processJob(job) {
  const { _id: jobId, sessionId, jobType, payload, attempts } = job;

  console.log(`[WaWorker] Processing job ${jobId} (type: ${jobType}, session: ${sessionId}, attempt: ${attempts})`);

  // ── Step 1: Resolve Spintax ────────────────────────────────────────────────
  if (payload.text && hasSpintax(payload.text)) {
    payload.text = spintax(payload.text);
  }
  if (payload.caption && hasSpintax(payload.caption)) {
    payload.caption = spintax(payload.caption);
  }

  // ── Step 1b: Replace {שם} / {name} with the lead's name ──────────────────
  const leadName = payload.name || '';
  if (leadName && payload.text) {
    payload.text = payload.text.replace(/\{שם\}/g, leadName).replace(/\{name\}/gi, leadName);
  }
  if (leadName && payload.caption) {
    payload.caption = payload.caption.replace(/\{שם\}/g, leadName).replace(/\{name\}/gi, leadName);
  }

  // ── Step 2: Get socket (will throw WaSessionError if session is gone) ──────
  let socket;
  try {
    socket = mktSession.getSocket(sessionId);
  } catch (err) {
    if (err instanceof WaSessionError) {
      console.warn(`[WaWorker] Session ${sessionId} not active — failing job ${jobId}`);
      await queue.markFailed(jobId, err.message, attempts);
      return;
    }
    throw err;
  }

  // ── Step 3: Collision Detection ────────────────────────────────────────────
  if (payload.phone) {
    const contactJid = _toJid(payload.phone);
    const isCollision = mktSession.isComposing(contactJid);

    if (isCollision) {
      const delayMs = await dynamicConfig.get("collisionDelayMs");
      const maxRetries = await dynamicConfig.get("collisionMaxRetries");

      if (attempts <= maxRetries) {
        console.log(`[WaWorker] Collision detected for ${payload.phone} — delaying job ${jobId} by ${delayMs}ms`);
        await queue.delayJob(jobId, delayMs);
        return; // don't count as a failure
      }
      // Exceeded collision retries — proceed anyway
      console.warn(`[WaWorker] Collision retry limit reached for ${payload.phone} — sending anyway`);
    }
  }

  // ── Step 4: Human Simulator (typing presence) ─────────────────────────────
  if (payload.phone) {
    const contactJid = _toJid(payload.phone);
    await _simulateTyping(socket, contactJid, payload.text || payload.caption || "");
  }

  // ── Step 5: Send the message ──────────────────────────────────────────────
  try {
    await _dispatch(socket, jobType, payload, sessionId);
    await queue.markDone(jobId);
    console.log(`[WaWorker] Job ${jobId} done`);
  } catch (err) {
    // Kill switch tripped → stop worker
    if (err instanceof WaBanRiskError) {
      console.error(`[WaWorker] Ban risk detected — stopping worker. Session: ${sessionId}`);
      stop();
      return;
    }

    console.error(`[WaWorker] Job ${jobId} failed (attempt ${attempts}):`, err.message);
    await queue.markFailed(jobId, err.message, attempts);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch by job type
// ─────────────────────────────────────────────────────────────────────────────

async function _dispatch(socket, jobType, payload, sessionId) {
  const jid = payload.phone ? _toJid(payload.phone) : null;

  switch (jobType) {
    case "send-text": {
      if (!jid) throw new Error("phone is required for send-text");
      if (!payload.text) throw new Error("text is required for send-text");
      await socket.sendMessage(jid, { text: payload.text });
      dbLogMessage(sessionId, payload.phone, payload.text, "sent").catch(() => {});
      break;
    }

    case "send-vcard": {
      // Delegate to WaActionsService to keep VCard logic in one place
      const actions = require("./wa-actions.service");
      await actions.sendVCard(sessionId, payload.phone, payload.contact);
      break;
    }

    case "send-location": {
      const actions = require("./wa-actions.service");
      await actions.sendLocation(sessionId, payload.phone, payload.location);
      break;
    }

    case "send-status": {
      const actions = require("./wa-actions.service");
      await actions.postStatus(sessionId, payload.statusOptions);
      break;
    }

    case "send-group-invite": {
      if (!jid) throw new Error("phone is required for send-group-invite");
      if (!payload.inviteLink) throw new Error("inviteLink is required");
      await socket.sendMessage(jid, { text: payload.inviteLink });
      break;
    }

    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Human Simulator helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate human typing:
 *   1. Send presenceUpdate "composing" to the contact
 *   2. Wait a duration proportional to text length (clamped to min/max)
 *   3. Send presenceUpdate "paused"
 *
 * @param {object} socket    - Baileys socket
 * @param {string} jid       - Contact JID
 * @param {string} text      - Message text (used to calculate duration)
 */
async function _simulateTyping(socket, jid, text) {
  try {
    const perChar = await dynamicConfig.get("typingDelayPerChar");
    const minMs   = await dynamicConfig.get("typingDelayMin");
    const maxMs   = await dynamicConfig.get("typingDelayMax");

    const duration = _clamp(
      (text.length || 10) * perChar,
      minMs,
      maxMs,
    );

    await socket.presenceSubscribe(jid);
    await socket.sendPresenceUpdate("composing", jid);
    await _sleep(duration);
    await socket.sendPresenceUpdate("paused", jid);
  } catch (err) {
    // Typing simulation is best-effort — don't abort the send if it fails
    console.warn(`[WaWorker] Typing simulation error for ${jid}:`, err.message);
  }
}

/**
 * Random delay between messages (anti-pattern detection).
 * @returns {Promise<number>}  The delay in ms (also used by _scheduleNext)
 */
async function _interMessageDelay() {
  const min = await dynamicConfig.get("messageDelayMin");
  const max = await dynamicConfig.get("messageDelayMax");
  const delay = _randInt(min, max);
  await _sleep(delay);
  return ACTIVE_POLL_MS; // return fast-poll interval after sleeping
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function _randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _toJid(phone) {
  let digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "972" + digits.slice(1);
  return `${digits}@s.whatsapp.net`;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { start, stop, status };
