const makeWASocket =
  require("@whiskeysockets/baileys").default ||
  require("@whiskeysockets/baileys");
const {
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const { useMongoAuthState, authDeleteAll } = require("./wa-auth-state.service");
const fireberry = require("./fireberry.service");
const DB = require("../utils/DB");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const healthLog = require("./wa-health-log.service");
const waQueue = require("./marketing/wa-queue.service");

const SESSIONS_COLLECTION = "wa_sessions";
const MESSAGES_COLLECTION = "wa_messages";

// Map of sessionId -> { socket, reconnectCount }
const sessions = new Map();

// Cache of last QR data URL per sessionId (for late-joining WebViews)
const lastQrCache = new Map();

// Per-phone creation lock — prevents race conditions when multiple concurrent
// requests call getOrCreateByPhone for the same phone at the same time.
const creationLocks = new Map(); // phone -> Promise

const logger = pino({ level: "silent" });

// ─── Phone helpers ──────────────────────────────────────────────────────────

function formatPhoneNumber(phone) {
  let digits = phone.replace(/\D/g, "");
  if (!digits) throw new Error("Phone number contains no digits");
  if (digits.startsWith("0")) digits = "972" + digits.slice(1);
  if (digits.length < 10) throw new Error("Phone number is too short");
  if (digits.length === 10 && !digits.startsWith("972"))
    digits = "972" + digits;
  if (digits.length < 10 || digits.length > 15)
    throw new Error(`Invalid phone number length: ${digits.length} digits`);
  return `${digits}@s.whatsapp.net`;
}

function generateApiKey() {
  return crypto.randomBytes(16).toString("hex");
}

// ─── MongoDB helpers ────────────────────────────────────────────────────────

async function dbCreateSession(session) {
  await DB.collection(SESSIONS_COLLECTION).insertOne({
    session_id: session.id,
    phone: session.phone || null,
    wa_phone: null,
    name: session.name || "",
    status: session.status || "disconnected",
    api_key: session.api_key,
    webhook_url: session.webhook_url || null,
    auto_reply_enabled: false,
    auto_reply_message: "",
    page_id: null,
    created_at: new Date(),
    last_active: new Date(),
  });
  return dbGetSession(session.id);
}

async function dbGetSession(sessionId) {
  return DB.collection(SESSIONS_COLLECTION).findOne({
    session_id: sessionId,
  });
}

async function dbGetSessionByPhone(phone) {
  return DB.collection(SESSIONS_COLLECTION).findOne({ phone });
}

async function dbGetSessionByWaPhone(waPhone) {
  return DB.collection(SESSIONS_COLLECTION).findOne({ wa_phone: waPhone });
}

async function dbUpdateSessionStatus(sessionId, status, waPhone = null) {
  const update = { status, last_active: new Date() };
  if (waPhone !== null) update.wa_phone = waPhone;
  await DB.collection(SESSIONS_COLLECTION).updateOne(
    { session_id: sessionId },
    { $set: update },
  );
}

async function dbDeleteSession(sessionId) {
  await DB.collection(MESSAGES_COLLECTION).deleteMany({
    session_id: sessionId,
  });
  await DB.collection(SESSIONS_COLLECTION).deleteOne({
    session_id: sessionId,
  });
}

async function dbGetConnectedSessions() {
  return DB.collection(SESSIONS_COLLECTION)
    .find({ status: "connected" })
    .toArray();
}

async function dbGetAllSessions() {
  return DB.collection(SESSIONS_COLLECTION)
    .find({})
    .sort({ created_at: -1 })
    .toArray();
}

async function dbGetMessages(sessionId, limit = 50) {
  return DB.collection(MESSAGES_COLLECTION)
    .find({ session_id: sessionId })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
}

async function dbLogMessage(
  sessionId,
  toNumber,
  messageText,
  status = "pending",
) {
  const result = await DB.collection(MESSAGES_COLLECTION).insertOne({
    session_id: sessionId,
    to_number: toNumber,
    message_text: messageText,
    status,
    error: null,
    created_at: new Date(),
  });
  return result.insertedId;
}

async function dbUpdateMessageStatus(id, status, error = null) {
  await DB.collection(MESSAGES_COLLECTION).updateOne(
    { _id: id },
    { $set: { status, error } },
  );
}

// ─── Webhook helper ─────────────────────────────────────────────────────────

async function fireWebhook(url, payload) {
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => console.error("[webhook] Failed to send:", err.message));
}

// ─── Core session management ────────────────────────────────────────────────

async function createSession(sessionId, io) {
  const { state, saveCreds } = await useMongoAuthState(sessionId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ["WhatsApp API", "Chrome", "1.0.0"],
  });

  let resolveReady, rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readyPromise.catch(() => {}); // prevent unhandled rejection crash when session disconnects after ready

  const existingEntry = sessions.get(sessionId);
  const currentReconnectCount = existingEntry?.reconnectCount || 0;
  sessions.set(sessionId, { socket: sock, reconnectCount: currentReconnectCount, readyPromise });

  const sessionRecord = await dbGetSession(sessionId);
  const webhookUrl = sessionRecord?.webhook_url || null;
  const apiKey = sessionRecord?.api_key || null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;

    const ownerPhone = sessionRecord?.phone || null;
    const ts = () => new Date().toISOString();

    if (qr) {
      try {
        resolveReady();
        const qrDataUrl = await QRCode.toDataURL(qr);
        lastQrCache.set(sessionId, qrDataUrl);
        await dbUpdateSessionStatus(sessionId, "qr_ready");
        io.to(`session:${sessionId}`).emit("qr", { qr: qrDataUrl });
        io.to(`session:${sessionId}`).emit("status", { status: "qr_ready" });
        fireWebhook(webhookUrl, { type: "qr", sessionId, qr: qrDataUrl });
        console.log(`[WA:${sessionId}] [${ts()}] QR generated for owner=${ownerPhone}`);
        healthLog.logEvent({ phone: ownerPhone, sessionId, eventType: healthLog.EVENT.QR_READY });
      } catch (err) {
        console.error(`[WA:${sessionId}] [${ts()}] QR generation error:`, err.message);
      }
    }

    if (connection === "open") {
      resolveReady();
      lastQrCache.delete(sessionId);
      const sessionEntry = sessions.get(sessionId);
      if (sessionEntry) sessionEntry.reconnectCount = 0;

      const waPhone = sock.user?.id?.split(":")[0] || null;
      await dbUpdateSessionStatus(sessionId, "connected", waPhone);

      io.to(`session:${sessionId}`).emit("status", { status: "connected", phone: waPhone });
      fireWebhook(webhookUrl, { type: "connected", sessionId, phone: waPhone, apiKey });

      console.log(`[WA:${sessionId}] [${ts()}] ✅ Connected. wa_phone=${waPhone} owner=${ownerPhone} isNewLogin=${!!isNewLogin}`);
      healthLog.logEvent({ phone: ownerPhone, sessionId, eventType: healthLog.EVENT.CONNECT, meta: { waPhone } });

      // Save session_id to Fireberry so Make.com can send messages
      const userPhone = sessionRecord?.phone;
      if (userPhone) {
        fireberry.updateWaFields(userPhone, { sessionId }).catch((err) =>
          console.error(`[WA:${sessionId}] [${ts()}] [Fireberry] Failed to save WA token:`, err.message),
        );
      }
    }

    if (connection === "close") {
      const err = lastDisconnect?.error;
      const statusCode = err?.output?.statusCode;
      const errMessage = err?.message || "unknown";
      const errData = err?.output?.payload || {};

      // Disconnect code policy:
      //   401 (loggedOut)          — banned/logged out. Auth keys invalid → no reconnect, require QR.
      //   440 (connectionReplaced) — another WA Web client opened with same creds.
      //                              Auth keys are still valid. Reconnect after 15s delay
      //                              (gives time for the other client to close / WA to settle).
      //                              Reconnecting immediately causes Bad MAC / infinite loop.
      //   everything else          — transient error, reconnect after 3s (up to 3 attempts).
      const hardBanCodes = new Set([DisconnectReason.loggedOut]); // 401 only
      const shouldReconnect = !hardBanCodes.has(statusCode);
      const reconnectDelayMs = statusCode === 440 ? 15_000 : 3_000;

      const sessionEntry = sessions.get(sessionId);
      const reconnectCount = sessionEntry?.reconnectCount || 0;

      console.log(
        `[WA:${sessionId}] [${ts()}] ❌ Disconnected.\n` +
        `  owner=${ownerPhone}\n` +
        `  code=${statusCode} | shouldReconnect=${shouldReconnect} | attempt=${reconnectCount} | retryIn=${reconnectDelayMs}ms\n` +
        `  reason="${errMessage}"\n` +
        `  payload=${JSON.stringify(errData)}`
      );

      healthLog.logEvent({
        phone: ownerPhone,
        sessionId,
        eventType: healthLog.EVENT.DISCONNECT,
        disconnectCode: statusCode,
        reconnectAttempt: reconnectCount,
        meta: { shouldReconnect, errorMessage: errMessage, payload: errData },
      });

      if (shouldReconnect && reconnectCount < 3) {
        if (sessionEntry) sessionEntry.reconnectCount = reconnectCount + 1;
        try { sock.end(); } catch {}
        await dbUpdateSessionStatus(sessionId, "qr_ready");
        console.log(`[WA:${sessionId}] [${ts()}] 🔄 Scheduling reconnect attempt ${reconnectCount + 1}/3 in ${reconnectDelayMs / 1000}s...`);
        healthLog.logEvent({ phone: ownerPhone, sessionId, eventType: healthLog.EVENT.RECONNECT, reconnectAttempt: reconnectCount + 1 });
        setTimeout(() => createSession(sessionId, io), reconnectDelayMs);
      } else {
        const isHardBan = statusCode === DisconnectReason.loggedOut; // 401
        const reason = isHardBan ? `hard-ban/logout (401)` : `max reconnects (${reconnectCount}) reached`;
        console.log(`[WA:${sessionId}] [${ts()}] 🔴 Marked as disconnected. Reason: ${reason}`);
        rejectReady(new Error(`Connection closed (code: ${statusCode})`));
        sessions.delete(sessionId);
        await dbUpdateSessionStatus(sessionId, "disconnected");

        // 401 = account logged out or banned. Auth keys are no longer valid.
        // Delete them immediately so the next get-or-create triggers a fresh QR scan.
        if (isHardBan) {
          console.log(`[WA:${sessionId}] [${ts()}] 🗑️  Deleting auth keys (401 — credentials invalidated).`);
          await authDeleteAll(sessionId);
        }

        io.to(`session:${sessionId}`).emit("status", { status: "disconnected", requiresQr: isHardBan });
        fireWebhook(webhookUrl, { type: "disconnected", sessionId, requiresQr: isHardBan });
      }
    }

    // Log unexpected partial updates for debugging
    if (!qr && !connection) {
      const keys = Object.keys(update).filter(k => update[k] !== undefined);
      if (keys.length > 0) {
        console.log(`[WA:${sessionId}] [${ts()}] connection.update (partial): ${keys.join(", ")}`);
      }
    }
  });

  return sock;
}

async function sendMessage(sessionId, phone, text) {
  const sessionEntry = sessions.get(sessionId);

  if (!sessionEntry || !sessionEntry.socket) {
    throw new Error("Session not active");
  }

  const jid = formatPhoneNumber(phone);
  const msgId = await dbLogMessage(sessionId, phone, text, "pending");

  try {
    await sessionEntry.socket.sendMessage(jid, { text });
    await dbUpdateMessageStatus(msgId, "sent");
    return { success: true, messageId: msgId };
  } catch (err) {
    await dbUpdateMessageStatus(msgId, "failed", err.message);
    throw err;
  }
}

function getSessionStatus(sessionId) {
  const sessionEntry = sessions.get(sessionId);
  return sessionEntry ? "active" : "inactive";
}

async function deleteSession(sessionId) {
  const sessionEntry = sessions.get(sessionId);

  if (sessionEntry?.socket) {
    try {
      await sessionEntry.socket.logout();
    } catch {
      // ignore logout errors
    }
    try {
      sessionEntry.socket.end();
    } catch {
      // ignore
    }
  }

  sessions.delete(sessionId);
  lastQrCache.delete(sessionId);
  await authDeleteAll(sessionId);
  await dbDeleteSession(sessionId);
}

async function restoreSessions(io) {
  try {
    const connectedSessions = await dbGetConnectedSessions();
    console.log(
      `[WA] Restoring ${connectedSessions.length} session(s)...`,
    );

    for (const session of connectedSessions) {
      try {
        await createSession(session.session_id, io);
        console.log(`[WA:${session.session_id}] Restored.`);
      } catch (err) {
        console.error(
          `[WA:${session.session_id}] Failed to restore:`,
          err.message,
        );
        await dbUpdateSessionStatus(session.session_id, "disconnected");
      }
    }
  } catch (err) {
    console.error("[WA] Error restoring sessions:", err.message);
  }
}

async function disconnectAll() {
  for (const [sessionId, sessionEntry] of sessions.entries()) {
    try {
      sessionEntry.socket?.end();
    } catch {
      // ignore
    }
    console.log(`[WA:${sessionId}] Disconnected on shutdown.`);
  }
  sessions.clear();
}

// ─── Higher-level: get or create by phone ───────────────────────────────────

async function getOrCreateByPhone(phone, name, io) {
  // ── Serialize concurrent calls for the same phone ───────────────────────
  // Without this, two simultaneous requests (e.g. rapid frontend retries) both
  // see the session as missing/stale and race to insert — causing duplicate-key errors.
  if (creationLocks.has(phone)) {
    console.log(`[WA] [${phone}] Waiting for in-flight creation to finish...`);
    await creationLocks.get(phone);
    // After the other call finished, re-read and return whatever it created
    return dbGetSessionByPhone(phone);
  }

  let resolveLock;
  const lock = new Promise(r => { resolveLock = r; });
  creationLocks.set(phone, lock);

  try {
    return await _doGetOrCreateByPhone(phone, name, io);
  } finally {
    resolveLock();
    creationLocks.delete(phone);
  }
}

async function _doGetOrCreateByPhone(phone, name, io) {
  const ts = () => new Date().toISOString();
  let session = await dbGetSessionByPhone(phone);

  if (session) {
    // Connected AND in memory → reuse (healthy session)
    if (session.status === "connected" && sessions.has(session.session_id)) {
      console.log(`[WA] [${ts()}] Reusing healthy session ${session.session_id} for ${phone}`);
      return session;
    }

    // QR in progress AND in memory → reuse (actively connecting, don't interrupt)
    if (session.status === "qr_ready" && sessions.has(session.session_id)) {
      console.log(`[WA] [${ts()}] Reusing in-progress session ${session.session_id} for ${phone} (qr_ready)`);
      return session;
    }

    // If the DB still says "connected" but the socket is gone, the disconnect
    // event handler may not have finished writing "disconnected" to the DB yet.
    // Wait briefly and re-read — if it updates to "disconnected" we skip cleanup
    // and fall through to create a fresh session cleanly.
    if (session.status === "connected" && !sessions.has(session.session_id)) {
      console.log(`[WA] [${ts()}] Session ${session.session_id} connected in DB but not in memory — waiting 2s for DB to settle...`);
      await new Promise(r => setTimeout(r, 2000));
      session = await dbGetSessionByPhone(phone);
    }

    // Stale session (not in memory). Before wiping auth keys, check if they still
    // exist in the DB. If they do, the credentials are likely still valid (e.g. after
    // a server restart, a transient disconnect, or a 440 that has since settled).
    // In that case, reconnect with the SAME session_id — no QR needed.
    // Only delete everything and start fresh if auth keys are gone (e.g. after 401).
    const staleSessionId = session.session_id;
    const authKeyCount = await DB.collection("wa_auth_keys").countDocuments({ session_id: staleSessionId });

    if (authKeyCount > 0) {
      // Auth keys intact → reconnect with same session (preserves credentials)
      console.log(
        `[WA] [${ts()}] Stale session ${staleSessionId} for ${phone} has ${authKeyCount} auth keys — reconnecting (no QR).\n` +
        `  status=${session.status} | last_active=${session.last_active?.toISOString?.() || session.last_active}`
      );
      const entry = sessions.get(staleSessionId);
      if (entry?.socket) { try { entry.socket.end(); } catch {} }
      sessions.delete(staleSessionId);
      lastQrCache.delete(staleSessionId);
      await dbUpdateSessionStatus(staleSessionId, "qr_ready");
      await createSession(staleSessionId, io);
      return dbGetSession(staleSessionId);
    }

    // No auth keys → full cleanup, start fresh (QR required)
    console.log(
      `[WA] [${ts()}] Cleaning stale session ${staleSessionId} for ${phone} (no auth keys — QR required).\n` +
      `  status=${session.status} | last_active=${session.last_active?.toISOString?.() || session.last_active}`
    );
    healthLog.logEvent({
      phone,
      sessionId: staleSessionId,
      eventType: healthLog.EVENT.SESSION_CLEANED,
      meta: { previousStatus: session.status, inMemory: sessions.has(staleSessionId) },
    });
    const entry = sessions.get(staleSessionId);
    if (entry?.socket) { try { entry.socket.end(); } catch {} }
    sessions.delete(staleSessionId);
    lastQrCache.delete(staleSessionId);
    await authDeleteAll(staleSessionId);
    await dbDeleteSession(staleSessionId);

    // Create fresh session with new UUID
    const sessionId = uuidv4();
    const apiKey = generateApiKey();
    session = await dbCreateSession({ id: sessionId, phone, name: name || phone, status: "disconnected", api_key: apiKey });

    // Migrate any pending/failed marketing jobs from old session → new session
    waQueue.migrateJobs(staleSessionId, sessionId).catch(err =>
      console.error(`[WA] Failed to migrate jobs from ${staleSessionId}:`, err.message)
    );

    await createSession(sessionId, io);
    console.log(`[WA] [${ts()}] Fresh session ${sessionId} created for ${phone} (replaced ${staleSessionId})`);
    return session;
  }

  // Create fresh session (new UUID = guaranteed clean auth state)
  const sessionId = uuidv4();
  const apiKey = generateApiKey();

  session = await dbCreateSession({
    id: sessionId,
    phone,
    name: name || phone,
    status: "disconnected",
    api_key: apiKey,
  });

  await createSession(sessionId, io);
  console.log(`[WA] [${ts()}] Fresh session ${sessionId} created for ${phone}`);
  return session;
}

// ─── Higher-level: get or create by wa_phone ────────────────────────────────

async function getOrCreateByWaPhone(waPhone, ownerPhone, name, io) {
  // Normalize: strip + and spaces, keep digits only
  const normalized = waPhone.replace(/\D/g, "");

  // 1. Check if a connected session already exists for this WA number
  let session = await dbGetSessionByWaPhone(normalized);

  if (session) {
    if (session.status === "connected" && sessions.has(session.session_id)) {
      console.log(`[WA] Reusing healthy session ${session.session_id} for wa_phone ${normalized}`);
      return session;
    }
    if (session.status === "qr_ready" && sessions.has(session.session_id)) {
      console.log(`[WA] Reusing in-progress session ${session.session_id} for wa_phone ${normalized}`);
      return session;
    }

    // Stale — clean up and fall through to create fresh
    console.log(`[WA] Cleaning stale session ${session.session_id} (wa_phone=${normalized}, status=${session.status})`);
    const entry = sessions.get(session.session_id);
    if (entry?.socket) {
      try { entry.socket.end(); } catch {}
    }
    sessions.delete(session.session_id);
    lastQrCache.delete(session.session_id);
    await authDeleteAll(session.session_id);
    await dbDeleteSession(session.session_id);
  }

  // 2. Also check if the owner already has an active session (before creating duplicate)
  if (ownerPhone) {
    session = await dbGetSessionByPhone(ownerPhone);
    if (session) {
      if (session.status === "connected" && sessions.has(session.session_id)) {
        return session;
      }
      // Stale owner session — clean up
      const entry = sessions.get(session.session_id);
      if (entry?.socket) { try { entry.socket.end(); } catch {} }
      sessions.delete(session.session_id);
      lastQrCache.delete(session.session_id);
      await authDeleteAll(session.session_id);
      await dbDeleteSession(session.session_id);
    }
  }

  // 3. Create fresh session
  const sessionId = uuidv4();
  const apiKey = generateApiKey();
  session = await dbCreateSession({
    id: sessionId,
    phone: ownerPhone || null,
    name: name || ownerPhone || normalized,
    status: "disconnected",
    api_key: apiKey,
  });

  await createSession(sessionId, io);
  console.log(`[WA] Fresh session ${sessionId} created for wa_phone ${normalized} (owner: ${ownerPhone})`);
  return session;
}

// ─── Auto-reply helpers ──────────────────────────────────────────────────────

async function dbUpdateAutoReply(phone, { enabled, message, page_id }) {
  const update = { last_active: new Date() };
  if (typeof enabled === "boolean") update.auto_reply_enabled = enabled;
  if (typeof message === "string") update.auto_reply_message = message;
  if (page_id) update.page_id = page_id;
  await DB.collection(SESSIONS_COLLECTION).updateOne(
    { phone },
    { $set: update },
  );
}

async function dbGetSessionByPageId(pageId) {
  return DB.collection(SESSIONS_COLLECTION).findOne({
    page_id: pageId,
    status: "connected",
    auto_reply_enabled: true,
  });
}

async function dbGetMessagesByPhone(phone, limit = 100) {
  const session = await dbGetSessionByPhone(phone);
  if (!session) return [];
  return DB.collection(MESSAGES_COLLECTION)
    .find({ session_id: session.session_id })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
}

// ─── Pairing code (phone number linking) ─────────────────────────────────────

async function requestPairingCode(sessionId, waPhoneNumber) {
  const sessionEntry = sessions.get(sessionId);

  if (!sessionEntry || !sessionEntry.socket) {
    throw new Error("Session not active. Create session first.");
  }

  // Wait for socket to be ready (WS connected to WhatsApp)
  if (sessionEntry.readyPromise) {
    await Promise.race([
      sessionEntry.readyPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Socket timeout — try again")), 15000)
      ),
    ]);
  }

  const digits = waPhoneNumber.replace(/\D/g, "");
  if (!digits || digits.length < 10 || digits.length > 15) {
    throw new Error("Invalid WhatsApp phone number");
  }

  try {
    const code = await sessionEntry.socket.requestPairingCode(digits);
    console.log(`[WA:${sessionId}] Pairing code requested for ${digits}: ${code}`);
    return code;
  } catch (err) {
    console.error(`[WA:${sessionId}] Pairing code error:`, err.message);
    throw err;
  }
}

module.exports = {
  createSession,
  sendMessage,
  getSessionStatus,
  deleteSession,
  restoreSessions,
  disconnectAll,
  getOrCreateByPhone,
  getOrCreateByWaPhone,
  requestPairingCode,
  dbGetSession,
  dbGetSessionByPhone,
  dbGetSessionByWaPhone,
  dbGetSessionByPageId,
  dbGetAllSessions,
  dbGetMessages,
  dbGetMessagesByPhone,
  dbLogMessage,
  dbUpdateSessionStatus,
  dbUpdateAutoReply,
  sessions,
  lastQrCache,
};
