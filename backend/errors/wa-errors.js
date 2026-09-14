"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Marketing — Custom Error Hierarchy
//
// Usage:
//   const { WaSessionError, WaBanRiskError } = require('../errors/wa-errors');
//   throw new WaSessionError('Session not found', 'sess_abc123');
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base error for all WhatsApp marketing errors.
 * Adds `code` (machine-readable) and `context` (debug payload) to standard Error.
 */
class WaBaseError extends Error {
  /**
   * @param {string} message      - Human-readable description
   * @param {string} code         - Snake_case machine-readable code
   * @param {object} [context={}] - Extra debug data (sessionId, jid, etc.)
   */
  constructor(message, code, context = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    // Preserve original stack trace in V8 
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a Baileys session is missing, inactive, or not yet connected.
 *
 * @example
 *   throw new WaSessionError('Session not active', sessionId);
 */
class WaSessionError extends WaBaseError {
  /**
   * @param {string} message
   * @param {string} [sessionId] - The session that caused the error
   */
  constructor(message, sessionId) {
    super(message, "WA_SESSION_ERROR", { sessionId });
    this.sessionId = sessionId;
    this.statusCode = 503; // Service Unavailable — caller can use for HTTP response
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown (or emitted) when the Ban-Risk Kill Switch trips.
 * The worker will catch this and halt the queue.
 *
 * @example
 *   throw new WaBanRiskError('Too many disconnects', sessionId, { disconnectCount: 6 });
 */
class WaBanRiskError extends WaBaseError {
  /**
   * @param {string} message
   * @param {string} [sessionId]
   * @param {object} [meta]       - { disconnectCount, statusCode, triggeredAt }
   */
  constructor(message, sessionId, meta = {}) {
    super(message, "WA_BAN_RISK", { sessionId, ...meta });
    this.sessionId = sessionId;
    this.meta = meta;
    this.statusCode = 503;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a queue job fails to enqueue, process, or exceeds max attempts.
 *
 * @example
 *   throw new WaQueueError('Job enqueue failed', jobId, { reason: err.message });
 */
class WaQueueError extends WaBaseError {
  /**
   * @param {string} message
   * @param {string} [jobId]
   * @param {object} [meta]  - { reason, attempts, jobType }
   */
  constructor(message, jobId, meta = {}) {
    super(message, "WA_QUEUE_ERROR", { jobId, ...meta });
    this.jobId = jobId;
    this.meta = meta;
    this.statusCode = 500;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a WhatsApp action (group creation, vcard, location, etc.) fails.
 *
 * @example
 *   throw new WaActionError('Failed to create group', 'create_group', sessionId, { participants });
 */
class WaActionError extends WaBaseError {
  /**
   * @param {string} message
   * @param {string} [action]    - e.g. 'create_group', 'send_vcard', 'post_status'
   * @param {string} [sessionId]
   * @param {object} [meta]
   */
  constructor(message, action, sessionId, meta = {}) {
    super(message, "WA_ACTION_ERROR", { action, sessionId, ...meta });
    this.action = action;
    this.sessionId = sessionId;
    this.meta = meta;
    this.statusCode = 500;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express error-handler helper.
 * Use in your global error middleware:
 *
 *   app.use((err, req, res, next) => {
 *     const { status, body } = formatWaError(err);
 *     res.status(status).json(body);
 *   });
 */
function formatWaError(err) {
  if (err instanceof WaBaseError) {
    return {
      status: err.statusCode || 500,
      body: { success: false, ...err.toJSON() },
    };
  }
  // Unknown error — generic fallback
  return {
    status: 500,
    body: { success: false, code: "INTERNAL_ERROR", message: err.message },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  WaBaseError,
  WaSessionError,
  WaBanRiskError,
  WaQueueError,
  WaActionError,
  formatWaError,
};
