const { DB } = require("../config/db");

const adBriefs = () => DB.collection("ad_briefs");

const normalizePhone = (phone) => {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
};

// ─────────────────────────────────────────────
// POST /api/ad-brief/answer
// Save a single question answer (upsert by phone)
// Body: { phone, questionId, raw, score, status, attemptCount }
// ─────────────────────────────────────────────
exports.saveAnswer = async (req, res) => {
  try {
    const { phone: rawPhone, questionId, raw, score, status, attemptCount, sessionId } = req.body;

    if (!rawPhone || !questionId) {
      return res.status(400).json({ error: "phone and questionId are required" });
    }

    const phone = normalizePhone(rawPhone);
    const now = new Date();
    const query = sessionId ? { phone, sessionId } : { phone };

    const answerData = {
      raw,
      score,
      status,
      attemptCount,
      savedAt: now,
    };

    await adBriefs().findOneAndUpdate(
      query,
      {
        $set: {
          [`answers.${questionId}`]: answerData,
          updatedAt: now,
          briefStatus: "in_progress",
        },
        $setOnInsert: { phone, ...(sessionId && { sessionId }), createdAt: now },
      },
      { upsert: true }
    );

    console.log(`✅ [AdBrief] Answer saved: phone=${phone}, question=${questionId}, score=${score}`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [AdBrief] saveAnswer error:", error.message);
    res.status(500).json({ error: "Failed to save answer", details: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/ad-brief/complete
// Mark brief as completed
// Body: { phone }
// ─────────────────────────────────────────────
exports.completeBrief = async (req, res) => {
  try {
    const { phone: rawPhone, sessionId } = req.body;

    if (!rawPhone) {
      return res.status(400).json({ error: "phone is required" });
    }

    const phone = normalizePhone(rawPhone);
    const now = new Date();
    const query = sessionId ? { phone, sessionId } : { phone };

    await adBriefs().findOneAndUpdate(
      query,
      {
        $set: { briefStatus: "completed", completedAt: now, updatedAt: now },
        $setOnInsert: { phone, ...(sessionId && { sessionId }), createdAt: now },
      },
      { upsert: true }
    );

    console.log(`✅ [AdBrief] Brief completed for phone=${phone}`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [AdBrief] completeBrief error:", error.message);
    res.status(500).json({ error: "Failed to complete brief", details: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/ad-brief/by-phone/:phone
// Get full brief by phone
// ─────────────────────────────────────────────
exports.getByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const { sessionId } = req.query;
    const query = sessionId ? { phone, sessionId } : { phone };
    const brief = await adBriefs().findOne(query);

    if (!brief) {
      return res.status(404).json({ error: "Brief not found" });
    }

    console.log(`✅ [AdBrief] Brief fetched for phone=${phone}`);
    res.json({ success: true, data: brief });
  } catch (error) {
    console.error("❌ [AdBrief] getByPhone error:", error.message);
    res.status(500).json({ error: "Failed to fetch brief", details: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/ad-brief/colors
// Save brand colors by phone
// Body: { phone, colors: string[] }
// ─────────────────────────────────────────────
exports.saveColors = async (req, res) => {
  try {
    const { phone: rawPhone, colors, selectedAvatar, sessionId, websiteUrl, logoBase64 } = req.body;

    if (!rawPhone || !Array.isArray(colors)) {
      return res.status(400).json({ error: "phone and colors[] are required" });
    }

    const phone = normalizePhone(rawPhone);
    const now = new Date();
    const query = sessionId ? { phone, sessionId } : { phone };

    await adBriefs().findOneAndUpdate(
      query,
      {
        $set: {
          brandColors: colors,
          ...(selectedAvatar ? { selectedAvatar } : {}),
          ...(websiteUrl ? { websiteUrl } : {}),
          ...(logoBase64 ? { logoBase64 } : {}),
          updatedAt: now,
        },
        $setOnInsert: { phone, ...(sessionId && { sessionId }), createdAt: now },
      },
      { upsert: true }
    );

    console.log(`✅ [AdBrief] Colors saved for phone=${phone}: ${colors.join(", ")}`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [AdBrief] saveColors error:", error.message);
    res.status(500).json({ error: "Failed to save colors", details: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/ad-brief (admin)
// List all briefs
// ─────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const { limit = 50, skip = 0 } = req.query;
    const data = await adBriefs()
      .find({})
      .sort({ updatedAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();
    const total = await adBriefs().countDocuments();
    res.json({ success: true, data, pagination: { total, limit: parseInt(limit), skip: parseInt(skip) } });
  } catch (error) {
    console.error("❌ [AdBrief] getAll error:", error.message);
    res.status(500).json({ error: "Failed to fetch briefs", details: error.message });
  }
};
