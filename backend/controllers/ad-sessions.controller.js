const crypto = require("crypto");
const { DB } = require("../config/db");

const sessions = () => DB.collection("ad_sessions");
const adBriefs = () => DB.collection("ad_briefs");
const adPlans = () => DB.collection("ad_plans");
const adImageJobs = () => DB.collection("ad_image_jobs");

const normalizePhone = (phone) => {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
};

// ─── Compute live status for one session ─────────────────────────────────────

async function computeStatus(phone, sessionId) {
  const query = sessionId ? { phone, sessionId } : { phone };

  const [brief, plan, imageJob] = await Promise.all([
    adBriefs().findOne(query, { projection: { briefStatus: 1, answers: 1, websiteUrl: 1 } }),
    adPlans().findOne(query, { projection: { status: 1 } }),
    adImageJobs()
      .find(query)
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray()
      .then((r) => r[0] || null),
  ]);

  let status = "new";
  let thumbnailUrl = null;
  let businessHint = null;

  if (brief) {
    status = brief.briefStatus === "completed" ? "brief_done" : "brief_in_progress";
    // Grab business hint from answers
    const answers = brief.answers || {};
    const firstAnswer = Object.values(answers)[0];
    businessHint = brief.websiteUrl || firstAnswer?.raw?.slice(0, 40) || null;
  }
  if (plan) {
    status = plan.status === "approved" ? "plan_approved" : "plan_generated";
  }
  if (imageJob) {
    status = imageJob.status === "completed" ? "images_done" : "images_generating";
    const firstDone = (imageJob.images || []).find((img) => img.status === "done" && img.imageUrl);
    if (firstDone) thumbnailUrl = firstDone.imageUrl;
  }

  return { status, thumbnailUrl, businessHint };
}

// ─────────────────────────────────────────────
// POST /api/ad-sessions/create
// Body: { phone }
// ─────────────────────────────────────────────
exports.createSession = async (req, res) => {
  try {
    const { phone: rawPhone } = req.body;
    if (!rawPhone) return res.status(400).json({ error: "phone is required" });

    const phone = normalizePhone(rawPhone);
    const sessionId = crypto.randomBytes(12).toString("hex");
    const now = new Date();

    await sessions().insertOne({ sessionId, phone, createdAt: now, updatedAt: now });

    console.log(`✅ [AdSessions] New session ${sessionId} for phone=${phone}`);
    res.json({ success: true, sessionId });
  } catch (error) {
    console.error("❌ [AdSessions] createSession:", error.message);
    res.status(500).json({ error: "Failed to create session" });
  }
};

// ─────────────────────────────────────────────
// GET /api/ad-sessions/by-phone/:phone
// Returns all sessions with computed status
// ─────────────────────────────────────────────
exports.getByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);

    let sessionDocs = await sessions()
      .find({ phone })
      .sort({ createdAt: -1 })
      .toArray();

    // ── Backward compat: if existing brief/plan/images but no sessions, surface them ──
    if (sessionDocs.length === 0) {
      const oldBrief = await adBriefs().findOne({ phone, sessionId: { $exists: false } });
      if (oldBrief) {
        // Create a legacy session so it appears in the dashboard
        const now = new Date();
        const legacySessionId = "legacy_" + phone;
        await sessions().updateOne(
          { sessionId: legacySessionId },
          { $setOnInsert: { sessionId: legacySessionId, phone, createdAt: oldBrief.createdAt || now, updatedAt: now } },
          { upsert: true }
        );
        sessionDocs = await sessions().find({ phone }).sort({ createdAt: -1 }).toArray();
      }
    }

    // Compute status for each session in parallel
    const results = await Promise.all(
      sessionDocs.map(async (s) => {
        const realSessionId = s.sessionId.startsWith("legacy_") ? null : s.sessionId;
        const { status, thumbnailUrl, businessHint } = await computeStatus(phone, realSessionId);
        return {
          sessionId: s.sessionId,
          phone: s.phone,
          createdAt: s.createdAt,
          status,
          thumbnailUrl,
          businessHint,
        };
      })
    );

    res.json({ success: true, sessions: results });
  } catch (error) {
    console.error("❌ [AdSessions] getByPhone:", error.message);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
};

// ─────────────────────────────────────────────
// GET /api/ad-sessions/:sessionId
// ─────────────────────────────────────────────
exports.getOne = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await sessions().findOne({ sessionId });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const realSessionId = sessionId.startsWith("legacy_") ? null : sessionId;
    const { status, thumbnailUrl, businessHint } = await computeStatus(session.phone, realSessionId);

    res.json({
      success: true,
      session: { sessionId, phone: session.phone, createdAt: session.createdAt, status, thumbnailUrl, businessHint },
    });
  } catch (error) {
    console.error("❌ [AdSessions] getOne:", error.message);
    res.status(500).json({ error: "Failed to fetch session" });
  }
};
