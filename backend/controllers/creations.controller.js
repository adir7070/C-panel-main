/**
 * GET /api/app/creations?phone=05XXXXXXXX
 *
 * Feeds the app's home-screen "פרויקטים בהכנה" progress circle: every
 * in-flight AI creation (quick ad / campaign / social / post) plus recent
 * failures and just-completed jobs. Documents are written by
 * services/creation-progress.service.js from inside the generation pipelines.
 */
const { DB } = require("../config/db");
const { toPhoneKey } = require("../services/creation-progress.service");

const creationJobs = () => DB.collection("creation_jobs");

// A job whose pipeline died (dyno restart, hang) stops touching updatedAt —
// after this much silence we surface it as failed instead of hanging forever.
const INACTIVITY_TIMEOUT_MS = {
  quick_ad: 8 * 60e3,
  campaign: 12 * 60e3,
  social_day: 15 * 60e3,
  post_gen: 15 * 60e3,
  social_batch: 20 * 60e3,
};

const FAILED_RETENTION_MS = 24 * 3600e3; // failed jobs visible for 24h (until dismissed app-side)
const COMPLETED_RETENTION_MS = 10 * 60e3; // completed shown briefly so the app can flash 100%

exports.listCreations = async (req, res) => {
  try {
    const phone = toPhoneKey(req.query.phone);
    if (!phone) return res.status(400).json({ success: false, error: "Invalid phone" });

    const now = Date.now();

    // Lazy stale sweep (same idea as ad-images quick-status): one updateMany
    // per kind, only touching this phone's processing jobs.
    for (const [kind, timeoutMs] of Object.entries(INACTIVITY_TIMEOUT_MS)) {
      await creationJobs().updateMany(
        { phone, kind, status: "processing", updatedAt: { $lt: new Date(now - timeoutMs) } },
        { $set: { status: "failed", error: "TIMEOUT", updatedAt: new Date() } },
      );
    }

    const jobs = await creationJobs()
      .find({
        phone,
        $or: [
          { status: "processing" },
          { status: "failed", updatedAt: { $gte: new Date(now - FAILED_RETENTION_MS) } },
          { status: "completed", updatedAt: { $gte: new Date(now - COMPLETED_RETENTION_MS) } },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    res.json({
      success: true,
      jobs: jobs.map((j) => ({
        id: j._id.toString(),
        kind: j.kind,
        label: j.label ?? null,
        status: j.status,
        total: j.total,
        completed: j.completed,
        percent: j.percent,
        error: j.error ?? null,
        refId: j.refId ?? null,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      })),
    });
  } catch (err) {
    console.error("[creations] listCreations error:", err.message);
    res.status(500).json({ success: false, error: "Internal error" });
  }
};
