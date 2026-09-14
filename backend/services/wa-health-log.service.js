"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// WaHealthLogService
//
// Records every meaningful WhatsApp session event to MongoDB so we can later
// compute per-account ban-risk scores and identify patterns.
//
// Collection: wa_health_log
//
// Risk scoring (riskScore 0-100 per event):
//   100 — disconnect code 401 (loggedOut / banned)
//    80 — disconnect code 440 (connectionReplaced — two sessions fighting)
//    50 — crypto error (Bad MAC / MessageCounterError — session key corruption)
//    30 — session_cleaned (stale session force-deleted before reconnect)
//    20 — disconnect code 428 (connectionClosed)
//    15 — disconnect code 408 (connectionLost / timeout)
//    10 — reconnect attempt
//     5 — disconnect with unknown code
//     0 — connect (healthy event)
//     0 — qr_ready, pairing, etc.
//
// Usage:
//   const healthLog = require('./wa-health-log.service');
//   await healthLog.logEvent({ phone, sessionId, eventType: 'disconnect', disconnectCode: 440 });
//   const summary = await healthLog.getAccountRisk(phone);
// ─────────────────────────────────────────────────────────────────────────────

const DB = require("../utils/DB");

const COLLECTION = "wa_health_log";

// ── Event types ───────────────────────────────────────────────────────────────
const EVENT = {
  CONNECT:         "connect",          // successful connection open
  DISCONNECT:      "disconnect",       // connection closed
  RECONNECT:       "reconnect",        // reconnect attempt scheduled
  SESSION_CLEANED: "session_cleaned",  // stale session force-deleted
  AUTH_ERROR:      "auth_error",       // Bad MAC / MessageCounterError
  BAN_RISK:        "ban_risk",         // kill switch tripped
  QR_READY:        "qr_ready",         // QR generated
  PAIRING_CODE:    "pairing_code",     // pairing code requested
};

// ── Disconnect code → name map (Baileys DisconnectReason) ─────────────────────
const DISCONNECT_REASON = {
  401: "loggedOut",
  408: "connectionLost",
  411: "multideviceMismatch",
  428: "connectionClosed",
  440: "connectionReplaced",
  500: "badSession",
  515: "restartRequired",
};

// ── Risk score per event ──────────────────────────────────────────────────────
function computeRiskScore(eventType, disconnectCode) {
  if (eventType === EVENT.CONNECT)         return 0;
  if (eventType === EVENT.QR_READY)        return 0;
  if (eventType === EVENT.PAIRING_CODE)    return 0;
  if (eventType === EVENT.BAN_RISK)        return 90;
  if (eventType === EVENT.AUTH_ERROR)      return 50;
  if (eventType === EVENT.SESSION_CLEANED) return 30;
  if (eventType === EVENT.RECONNECT)       return 10;

  if (eventType === EVENT.DISCONNECT) {
    if (disconnectCode === 401) return 100;
    if (disconnectCode === 440) return 80;
    if (disconnectCode === 428) return 20;
    if (disconnectCode === 408) return 15;
    if (disconnectCode === 500) return 60;
    return 5; // unknown code
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log a single health event.
 *
 * @param {object} params
 * @param {string}  params.phone            - Session owner phone (e.g. "0542587070")
 * @param {string}  params.sessionId        - Baileys session UUID
 * @param {string}  params.eventType        - One of EVENT values
 * @param {number}  [params.disconnectCode] - Baileys status code on disconnect
 * @param {number}  [params.reconnectAttempt]
 * @param {object}  [params.meta]           - Extra context (error message, etc.)
 * @returns {Promise<void>}
 */
async function logEvent({ phone, sessionId, eventType, disconnectCode, reconnectAttempt, meta = {} }) {
  try {
    const riskScore = computeRiskScore(eventType, disconnectCode);
    const disconnectReason = disconnectCode ? (DISCONNECT_REASON[disconnectCode] ?? `unknown_${disconnectCode}`) : null;

    await DB.collection(COLLECTION).insertOne({
      phone:            phone || null,
      sessionId:        sessionId || null,
      eventType,
      disconnectCode:   disconnectCode ?? null,
      disconnectReason: disconnectReason,
      reconnectAttempt: reconnectAttempt ?? null,
      riskScore,
      isBanRisk:        riskScore >= 50,
      meta,
      createdAt:        new Date(),
    });
  } catch (err) {
    // Health logging must never crash the main flow
    console.error("[WaHealthLog] Failed to log event:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a risk summary for a phone number over the last N hours.
 *
 * @param {string} phone
 * @param {number} [windowHours=24]
 * @returns {Promise<{
 *   phone: string,
 *   windowHours: number,
 *   totalEvents: number,
 *   maxRiskScore: number,
 *   avgRiskScore: number,
 *   riskLevel: 'safe'|'low'|'medium'|'high'|'critical',
 *   banRiskEvents: number,
 *   lastEvent: object|null,
 *   breakdown: object
 * }>}
 */
async function getAccountRisk(phone, windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const events = await DB.collection(COLLECTION)
    .find({ phone, createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .toArray();

  if (events.length === 0) {
    return _emptyRisk(phone, windowHours);
  }

  // Aggregate
  const totalEvents  = events.length;
  const scores       = events.map(e => e.riskScore);
  const maxRiskScore = Math.max(...scores);
  const avgRiskScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const banRiskEvents = events.filter(e => e.isBanRisk).length;
  const lastEvent    = events[0];

  // Breakdown by eventType
  const breakdown = {};
  for (const e of events) {
    breakdown[e.eventType] = (breakdown[e.eventType] || 0) + 1;
  }

  // Risk level
  const riskLevel = _riskLevel(maxRiskScore, banRiskEvents, totalEvents);

  return {
    phone,
    windowHours,
    totalEvents,
    maxRiskScore,
    avgRiskScore,
    riskLevel,
    banRiskEvents,
    lastEvent,
    breakdown,
    since,
  };
}

/**
 * Get risk summaries for all active sessions (for admin dashboard).
 * Returns top 50 riskiest accounts in the last 24h.
 *
 * @returns {Promise<Array>}
 */
async function getAllAccountRisks(windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const pipeline = [
    { $match: { createdAt: { $gte: since }, phone: { $ne: null } } },
    {
      $group: {
        _id:            "$phone",
        totalEvents:    { $sum: 1 },
        maxRiskScore:   { $max: "$riskScore" },
        avgRiskScore:   { $avg: "$riskScore" },
        banRiskEvents:  { $sum: { $cond: ["$isBanRisk", 1, 0] } },
        lastEventType:  { $last: "$eventType" },
        lastEventAt:    { $last: "$createdAt" },
        sessionId:      { $last: "$sessionId" },
      },
    },
    { $sort: { maxRiskScore: -1, banRiskEvents: -1 } },
    { $limit: 50 },
  ];

  const rows = await DB.collection(COLLECTION).aggregate(pipeline).toArray();

  return rows.map(r => ({
    phone:         r._id,
    sessionId:     r.sessionId,
    totalEvents:   r.totalEvents,
    maxRiskScore:  Math.round(r.maxRiskScore),
    avgRiskScore:  Math.round(r.avgRiskScore),
    banRiskEvents: r.banRiskEvents,
    riskLevel:     _riskLevel(r.maxRiskScore, r.banRiskEvents, r.totalEvents),
    lastEventType: r.lastEventType,
    lastEventAt:   r.lastEventAt,
  }));
}

/**
 * Get raw event timeline for a phone (for detailed view).
 *
 * @param {string} phone
 * @param {number} [limit=100]
 * @returns {Promise<Array>}
 */
async function getEventTimeline(phone, limit = 100) {
  return DB.collection(COLLECTION)
    .find({ phone })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Ensure MongoDB indexes for efficient querying.
 */
async function ensureIndexes() {
  try {
    const col = DB.collection(COLLECTION);
    await col.createIndex({ phone: 1, createdAt: -1 });
    await col.createIndex({ sessionId: 1, createdAt: -1 });
    await col.createIndex({ isBanRisk: 1, createdAt: -1 });
    // TTL: auto-delete events older than 90 days
    await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
  } catch (err) {
    console.warn("[WaHealthLog] Index warning:", err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _riskLevel(maxScore, banRiskEvents, totalEvents) {
  if (maxScore >= 100 || banRiskEvents >= 3)  return "critical";
  if (maxScore >= 80  || banRiskEvents >= 1)  return "high";
  if (maxScore >= 50  || totalEvents >= 20)   return "medium";
  if (maxScore >= 20)                         return "low";
  return "safe";
}

function _emptyRisk(phone, windowHours) {
  return {
    phone, windowHours,
    totalEvents: 0, maxRiskScore: 0, avgRiskScore: 0,
    riskLevel: "safe", banRiskEvents: 0,
    lastEvent: null, breakdown: {}, since: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  logEvent,
  getAccountRisk,
  getAllAccountRisks,
  getEventTimeline,
  ensureIndexes,
  EVENT,
};
