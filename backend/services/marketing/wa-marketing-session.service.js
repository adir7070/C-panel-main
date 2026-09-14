"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// WaMarketingSessionService
//
// Wraps the existing wa-session.service.js and adds two marketing-specific
// capabilities:
//
//   1. Ban-Risk Kill Switch (Feature 29)
//      Monitors Baileys connection events on a session. When disconnect errors
//      (especially HTTP 401) or repeated connectionClosed events exceed the
//      threshold from DynamicConfig, it:
//        a) Pauses all pending queue jobs for the session
//        b) Sends a critical push notification to the session owner
//        c) Emits an 'emergency' event for any listeners (e.g. admin dashboard)
//
//   2. Presence Tracker (Feature 13 — Collision Detection)
//      Listens to Baileys `presence.update` events and keeps a live map of
//      each contact's composing/recording/available status.
//      The worker calls isComposing(jid) before sending to detect collisions.
//
// Usage:
//   const mktSession = require('./wa-marketing-session.service');
//   mktSession.attach(sessionId, socket, ownerPhone);
//   mktSession.onEmergency(cb);                // subscribe to kill switch events
//   const busy = mktSession.isComposing(jid);  // collision check
//   const sock = mktSession.getSocket(sessionId);
// ─────────────────────────────────────────────────────────────────────────────

const EventEmitter = require("events");
const { sessions } = require("../wa-session.service");
const dynamicConfig = require("./dynamic-config.service");
const queue = require("./wa-queue.service");
const pushService = require("../push-notification.service");
const healthLog = require("../wa-health-log.service");
const { WaSessionError, WaBanRiskError } = require("../../errors/wa-errors");

// ── Internal state ────────────────────────────────────────────────────────────

// sessionId → { disconnectCount, paused, ownerPhone, killSwitchTripped }
const _sessionMeta = new Map();

// jid (e.g. "972501234567@s.whatsapp.net") → { status, updatedAt }
// status: 'composing' | 'recording' | 'available' | 'unavailable' | 'paused'
const _presenceMap = new Map();

// Central event bus for kill switch events
const _emitter = new EventEmitter();
_emitter.setMaxListeners(50);

// Presence entries expire after this ms (contacts don't always send "stopped composing")
const PRESENCE_TTL_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach marketing monitoring to an existing Baileys socket.
 * Call this once per session after createSession() succeeds.
 *
 * @param {string} sessionId
 * @param {object} sock         - Baileys socket instance
 * @param {string} [ownerPhone] - Phone number of the session owner (for push alerts)
 */
function attach(sessionId, sock, ownerPhone) {
  if (!sock || !sock.ev) {
    throw new WaSessionError("Cannot attach — invalid socket", sessionId);
  }

  // Init or reset meta for this session
  _sessionMeta.set(sessionId, {
    disconnectCount: 0,
    paused: false,
    ownerPhone: ownerPhone || null,
    killSwitchTripped: false,
  });

  // ── 1. Ban-Risk Kill Switch listener ────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection !== "close") return;

    const meta = _sessionMeta.get(sessionId);
    if (!meta || meta.killSwitchTripped) return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;

    // HTTP 401 = logged out / banned — trip immediately
    const isHardBan = statusCode === 401;

    if (isHardBan) {
      await _tripKillSwitch(sessionId, meta, {
        reason: "HTTP 401 — account logged out or banned",
        statusCode,
      });
      return;
    }

    // Soft disconnect — increment counter and check threshold
    meta.disconnectCount += 1;
    const threshold = await dynamicConfig.get("banRiskThreshold");

    if (meta.disconnectCount >= threshold) {
      await _tripKillSwitch(sessionId, meta, {
        reason: `Disconnect threshold reached (${meta.disconnectCount}/${threshold})`,
        statusCode,
      });
    } else {
      console.warn(
        `[KillSwitch:${sessionId}] Disconnect #${meta.disconnectCount}/${threshold} (code: ${statusCode})`,
      );
    }
  });

  // ── 2. Presence Tracker listener ────────────────────────────────────────────
  sock.ev.on("presence.update", ({ id: jid, presences }) => {
    // presences: { [participantJid]: { lastKnownPresence, lastSeen } }
    for (const [participant, data] of Object.entries(presences)) {
      const key = _presenceKey(jid, participant);
      _presenceMap.set(key, {
        status: data.lastKnownPresence, // 'composing' | 'recording' | 'available' | etc.
        updatedAt: Date.now(),
      });
    }
  });

  console.log(`[WaMarketing:${sessionId}] Monitoring attached (owner: ${ownerPhone || "unknown"})`);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the active Baileys socket for a session.
 * Throws WaSessionError if session is not in memory.
 *
 * @param {string} sessionId
 * @returns {object} Baileys socket
 */
function getSocket(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry?.socket) {
    throw new WaSessionError(`Session "${sessionId}" is not active`, sessionId);
  }
  return entry.socket;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a contact is currently composing (typing) or recording.
 * Used by the worker for Collision Detection (Feature 13).
 *
 * @param {string} contactJid  - e.g. "972501234567@s.whatsapp.net"
 * @returns {boolean}
 */
function isComposing(contactJid) {
  // In 1-to-1 chats, the conversation JID == participant JID
  const key = _presenceKey(contactJid, contactJid);
  const entry = _presenceMap.get(key);

  if (!entry) return false;

  // Expire stale presence entries (contact may have stopped without sending update)
  if (Date.now() - entry.updatedAt > PRESENCE_TTL_MS) {
    _presenceMap.delete(key);
    return false;
  }

  return entry.status === "composing" || entry.status === "recording";
}

/**
 * Get the raw presence status for a contact.
 * @param {string} contactJid
 * @returns {"composing"|"recording"|"available"|"unavailable"|"paused"|null}
 */
function getPresence(contactJid) {
  const key = _presenceKey(contactJid, contactJid);
  const entry = _presenceMap.get(key);
  if (!entry || Date.now() - entry.updatedAt > PRESENCE_TTL_MS) return null;
  return entry.status;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to kill switch emergency events.
 *
 * @param {function} callback  - Called with { sessionId, reason, statusCode, pausedJobCount, at }
 * @returns {function}  Unsubscribe function
 */
function onEmergency(callback) {
  _emitter.on("emergency", callback);
  return () => _emitter.off("emergency", callback);
}

/**
 * Manually reset the kill switch for a session (after investigation).
 * @param {string} sessionId
 */
function resetKillSwitch(sessionId) {
  const meta = _sessionMeta.get(sessionId);
  if (meta) {
    meta.disconnectCount = 0;
    meta.paused = false;
    meta.killSwitchTripped = false;
    console.log(`[KillSwitch:${sessionId}] Manually reset`);
  }
}

/**
 * Return kill switch + presence stats for a session.
 * @param {string} sessionId
 * @returns {object}
 */
function getSessionMeta(sessionId) {
  return _sessionMeta.get(sessionId) || null;
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function _tripKillSwitch(sessionId, meta, { reason, statusCode }) {
  meta.killSwitchTripped = true;
  meta.paused = true;

  console.error(`[KillSwitch:${sessionId}] TRIPPED — ${reason}`);

  // Log ban_risk event
  healthLog.logEvent({
    phone: meta.ownerPhone,
    sessionId,
    eventType: healthLog.EVENT.BAN_RISK,
    disconnectCode: statusCode,
    meta: { reason },
  });

  // 1. Pause all queue jobs for this session
  let pausedCount = 0;
  try {
    pausedCount = await queue.pauseSession(sessionId);
  } catch (err) {
    console.error(`[KillSwitch:${sessionId}] Failed to pause queue:`, err.message);
  }

  // 2. Send push notification to session owner
  if (meta.ownerPhone) {
    pushService.notifyUser(
      meta.ownerPhone,
      "⚠️ WhatsApp Ban Alert",
      `הקמפיין הופסק אוטומטית — ${reason}`,
      { type: "ban_risk", sessionId, statusCode },
    ).catch((err) =>
      console.error(`[KillSwitch:${sessionId}] Push notification failed:`, err.message),
    );
  }

  // 3. Emit emergency event for any listeners (admin dashboard / socket.io)
  const payload = {
    sessionId,
    reason,
    statusCode: statusCode || null,
    pausedJobCount: pausedCount,
    at: new Date().toISOString(),
  };
  _emitter.emit("emergency", payload);

  // 4. Throw error so caller (if any) knows what happened
  // Note: this is also caught gracefully in the worker
  throw new WaBanRiskError(reason, sessionId, { statusCode, pausedCount });
}

function _presenceKey(jid, participant) {
  return `${jid}::${participant}`;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  attach,
  getSocket,
  isComposing,
  getPresence,
  onEmergency,
  resetKillSwitch,
  getSessionMeta,
};
