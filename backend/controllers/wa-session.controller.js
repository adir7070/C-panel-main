const waService = require("../services/wa-session.service");
const fireberry = require("../services/fireberry.service");
const healthLog = require("../services/wa-health-log.service");
const { getDB } = require("../config/db");

/**
 * POST /api/wa/session/get-or-create
 * Body: { phone, name } OR { waPhone, ownerPhone, name }
 * Returns existing session or creates a new one and starts Baileys.
 */
exports.getOrCreateSession = async (req, res) => {
  try {
    const { phone, name, waPhone, ownerPhone } = req.body;

    if (!phone && !waPhone) {
      return res.status(400).json({ success: false, error: "phone or waPhone is required" });
    }

    const io = req.app.get("io");
    const session = waPhone
      ? await waService.getOrCreateByWaPhone(waPhone, ownerPhone || null, name, io)
      : await waService.getOrCreateByPhone(phone, name, io);

    const proto = req.get("x-forwarded-proto") || req.protocol;
    const serverUrl =
      process.env.SERVER_URL ||
      `${proto}://${req.get("host")}`;

    res.json({
      success: true,
      data: {
        session_id: session.session_id,
        status: session.status,
        connect_url: `${serverUrl}/wa/connect/${session.session_id}`,
        api_key: session.api_key,
        wa_phone: session.wa_phone || null,
      },
    });
  } catch (err) {
    console.error("[WA Controller] getOrCreateSession error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/wa/session/status/:phone
 * Returns connection status for a given phone number.
 */
exports.getSessionStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const session = await waService.dbGetSessionByPhone(phone);

    if (!session) {
      return res.json({
        success: true,
        data: { status: "not_found", wa_phone: null, last_active: null },
      });
    }

    // Check if actually active in memory
    const inMemory = waService.sessions.has(session.session_id);
    const effectiveStatus =
      session.status === "connected" && !inMemory
        ? "disconnected"
        : session.status;

    res.json({
      success: true,
      data: {
        status: effectiveStatus,
        wa_phone: session.wa_phone || null,
        last_active: session.last_active,
        session_id: session.session_id,
      },
    });
  } catch (err) {
    console.error("[WA Controller] getSessionStatus error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * DELETE /api/wa/session/:phone
 * Disconnect and delete the session for a given phone.
 */
exports.deleteSessionByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    const session = await waService.dbGetSessionByPhone(phone);

    if (!session) {
      return res.status(404).json({ success: false, error: "Session not found" });
    }

    await waService.deleteSession(session.session_id);

    res.json({ success: true, message: "Session deleted" });
  } catch (err) {
    console.error("[WA Controller] deleteSession error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/wa/session/status/wa-phone/:waPhone
 * Returns connection status for a given connected WhatsApp number.
 */
exports.getSessionStatusByWaPhone = async (req, res) => {
  try {
    const { waPhone } = req.params;
    const normalized = waPhone.replace(/\D/g, "");
    const session = await waService.dbGetSessionByWaPhone(normalized);

    if (!session) {
      return res.json({
        success: true,
        data: { status: "not_found", wa_phone: null, last_active: null },
      });
    }

    const inMemory = waService.sessions.has(session.session_id);
    const effectiveStatus =
      session.status === "connected" && !inMemory ? "disconnected" : session.status;

    res.json({
      success: true,
      data: {
        status: effectiveStatus,
        wa_phone: session.wa_phone || null,
        owner_phone: session.phone || null,
        last_active: session.last_active,
        session_id: session.session_id,
        api_key: session.api_key,
      },
    });
  } catch (err) {
    console.error("[WA Controller] getSessionStatusByWaPhone error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/wa/session/wa-phone/:waPhone/send
 * Body: { phone, message }
 * Send a WhatsApp message by looking up the session via the connected WA number.
 */
exports.sendMessageByWaPhone = async (req, res) => {
  try {
    const { waPhone } = req.params;
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ success: false, error: "phone and message are required" });
    }
    if (message.length > 4096) {
      return res.status(400).json({ success: false, error: "Message exceeds 4096 character limit" });
    }

    const normalized = waPhone.replace(/\D/g, "");
    const session = await waService.dbGetSessionByWaPhone(normalized);
    if (!session) {
      return res.status(404).json({ success: false, error: "No session found for this WhatsApp number" });
    }

    const result = await waService.sendMessage(session.session_id, phone, message);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[WA Controller] sendMessageByWaPhone error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Panel endpoints (admin) ────────────────────────────────────────────────

/**
 * GET /api/wa/panel/sessions
 * Returns all WhatsApp sessions (admin only).
 */
exports.getAllSessions = async (req, res) => {
  try {
    const sessions = await waService.dbGetAllSessions();
    res.json({ success: true, data: sessions });
  } catch (err) {
    console.error("[WA Controller] getAllSessions error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/wa/panel/sessions/:id/status
 * Returns session details by session_id (admin only).
 */
exports.getSessionStatusById = async (req, res) => {
  try {
    const { id } = req.params;
    const session = await waService.dbGetSession(id);

    if (!session) {
      return res.status(404).json({ success: false, error: "Session not found" });
    }

    const inMemory = waService.sessions.has(session.session_id);
    const effectiveStatus =
      session.status === "connected" && !inMemory
        ? "disconnected"
        : session.status;

    res.json({
      success: true,
      data: {
        session_id: session.session_id,
        phone: session.phone,
        name: session.name,
        status: effectiveStatus,
        wa_phone: session.wa_phone || null,
        api_key: session.api_key,
        last_active: session.last_active,
        created_at: session.created_at,
      },
    });
  } catch (err) {
    console.error("[WA Controller] getSessionStatusById error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * DELETE /api/wa/panel/sessions/:id
 * Delete a session by its session_id (admin only).
 */
exports.deleteSessionById = async (req, res) => {
  try {
    const { id } = req.params;
    const session = await waService.dbGetSession(id);

    if (!session) {
      return res.status(404).json({ success: false, error: "Session not found" });
    }

    await waService.deleteSession(session.session_id);

    res.json({ success: true, message: "Session deleted" });
  } catch (err) {
    console.error("[WA Controller] deleteSessionById error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/wa/panel/sessions/:id/messages
 * Returns message history for a session (admin only).
 */
exports.getMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const messages = await waService.dbGetMessages(id, limit);
    res.json({ success: true, data: messages });
  } catch (err) {
    console.error("[WA Controller] getMessages error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/wa/session/:sessionId/send
 * Body: { phone, message }
 * Send a WhatsApp message via the connected session.
 */
/**
 * POST /api/wa/session/pairing-code
 * Body: { phone, waPhone }
 *   phone   – the user's Iconiq phone (used to find session)
 *   waPhone – the WhatsApp number to pair with (digits like "972501234567")
 */
exports.requestPairingCode = async (req, res) => {
  try {
    const { phone, waPhone } = req.body;

    if (!phone || !waPhone) {
      return res.status(400).json({
        success: false,
        error: "phone and waPhone are required",
      });
    }

    // Use the existing session (created when modal opened via get-or-create)
    const session = await waService.dbGetSessionByPhone(phone);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: "Session not found. Open the WhatsApp modal first.",
      });
    }

    const code = await waService.requestPairingCode(session.session_id, waPhone);

    res.json({
      success: true,
      data: { code },
    });
  } catch (err) {
    console.error("[WA Controller] requestPairingCode error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Auto-reply settings ────────────────────────────────────────────────────

/**
 * PUT /api/wa/session/auto-reply
 * Body: { phone, enabled, message, pageId }
 */
exports.updateAutoReply = async (req, res) => {
  try {
    const { phone, enabled, message, pageId } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: "phone is required" });
    }

    const session = await waService.dbGetSessionByPhone(phone);
    if (!session) {
      return res.status(404).json({ success: false, error: "Session not found" });
    }

    await waService.dbUpdateAutoReply(phone, {
      enabled,
      message,
      page_id: pageId || null,
    });

    // Save auto-reply message to Fireberry
    fireberry.updateWaFields(phone, { message: message || "" }).catch((err) =>
      console.error("[Fireberry] Failed to save auto-reply message:", err.message),
    );

    res.json({ success: true });
  } catch (err) {
    console.error("[WA Controller] updateAutoReply error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/wa/session/:phone/auto-reply
 */
exports.getAutoReply = async (req, res) => {
  try {
    const { phone } = req.params;
    const session = await waService.dbGetSessionByPhone(phone);

    if (!session) {
      return res.json({
        success: true,
        data: { enabled: false, message: "" },
      });
    }

    res.json({
      success: true,
      data: {
        enabled: session.auto_reply_enabled || false,
        message: session.auto_reply_message || "",
      },
    });
  } catch (err) {
    console.error("[WA Controller] getAutoReply error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/wa/session/:phone/messages
 */
exports.getMessagesByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 200);

    const session = await waService.dbGetSessionByPhone(phone);
    if (!session) {
      return res.json({ success: true, data: [] });
    }

    const messages = await waService.dbGetMessages(session.session_id, limit);
    res.json({ success: true, data: messages });
  } catch (err) {
    console.error("[WA Controller] getMessagesByPhone error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res
        .status(400)
        .json({ success: false, error: "phone and message are required" });
    }

    if (message.length > 4096) {
      return res
        .status(400)
        .json({ success: false, error: "Message exceeds 4096 character limit" });
    }

    const result = await waService.sendMessage(sessionId, phone, message);

    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[WA Controller] sendMessage error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/wa/session/:phone/trust-score
 * Computes a health/warmup trust score (0–100) for the connected WA number.
 *
 * Score components:
 *   1. Account age (days since first message sent)  — up to 30 pts
 *   2. Messages sent successfully (log scale)        — up to 40 pts
 *   3. Success rate (done / done+failed)             — up to 20 pts
 *   4. Risk penalty (based on health log events)     — up to -30 pts
 *
 * daily_limit:  cold(<40)=20, warming(40-79)=80, ready(>=80)=250
 */
exports.getTrustScore = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ success: false, error: "phone is required" });

    const WA_JOBS = "wa_marketing_jobs";
    const now = new Date();
    const window30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

    // 1. Session info — find by phone
    const session = await getDB().collection("wa_sessions").findOne(
      { phone },
      { projection: { created_at: 1, session_id: 1 } }
    );
    const sessionId = session?.session_id ?? null;
    const sessionCreatedAt = session?.created_at ?? null;

    // 2. Job stats for this session (last 30 days)
    const [doneCount, failedCount, firstJob] = await Promise.all([
      getDB().collection(WA_JOBS).countDocuments({
        ...(sessionId ? { sessionId } : {}),
        status: "done",
        updatedAt: { $gte: window30d },
      }),
      getDB().collection(WA_JOBS).countDocuments({
        ...(sessionId ? { sessionId } : {}),
        status: "failed",
        updatedAt: { $gte: window30d },
      }),
      getDB().collection(WA_JOBS)
        .findOne(
          { ...(sessionId ? { sessionId } : {}), status: "done" },
          { sort: { createdAt: 1 }, projection: { createdAt: 1 } }
        ),
    ]);

    // 3. Health log risk
    const risk = await healthLog.getAccountRisk(phone, 72); // last 72h

    // ── Score calculation ──────────────────────────────────────────────────────

    // Component 1: Age (days since first successful send, or session creation)
    const firstActivity = firstJob?.createdAt ?? sessionCreatedAt;
    const ageDays = firstActivity
      ? Math.floor((now - new Date(firstActivity)) / (1000 * 60 * 60 * 24))
      : 0;
    const ageScore = Math.min(30, Math.round(ageDays * 1.5)); // 20 days = 30pts

    // Component 2: Volume (log scale — 0 msgs=0, 10=12, 100=24, 1000=36, 3000+=40)
    const volumeScore = doneCount === 0
      ? 0
      : Math.min(40, Math.round(Math.log10(doneCount + 1) / Math.log10(3001) * 40));

    // Component 3: Success rate
    const totalJobs = doneCount + failedCount;
    const successRate = totalJobs === 0 ? 1 : doneCount / totalJobs;
    const successScore = Math.round(successRate * 20);

    // Component 4: Risk penalty
    const riskPenalty = Math.min(30, Math.round(
      (risk.banRiskEvents * 10) + (risk.maxRiskScore > 80 ? 20 : risk.maxRiskScore > 50 ? 10 : 0)
    ));

    const rawScore = ageScore + volumeScore + successScore - riskPenalty;
    const score = Math.max(0, Math.min(100, rawScore));

    // Status + daily limit
    let status, daily_limit, title, description;
    if (score >= 80) {
      status = "ready";
      daily_limit = 250;
      title = "המספר מוכן לשיווק";
      description = `מדד בריאות גבוה — ניתן לשלוח עד ${daily_limit} הודעות ביום בבטחה`;
    } else if (score >= 40) {
      status = "warming";
      daily_limit = 80;
      title = "המספר בשלב חימום";
      description = `מומלץ לשלוח עד ${daily_limit} הודעות ביום כדי לשמור על המוניטין`;
    } else {
      status = "cold";
      daily_limit = 20;
      title = "המספר עדיין קר";
      description = `המספר חדש יחסית — שלח עד ${daily_limit} הודעות ביום לחימום הדרגתי`;
    }

    res.json({
      success: true,
      data: {
        score,
        status,
        daily_limit,
        title,
        description,
        _debug: { ageScore, volumeScore, successScore, riskPenalty, ageDays, doneCount, failedCount },
      },
    });
  } catch (err) {
    console.error("[WA] getTrustScore error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
