/**
 * Creation-progress tracking for the app's home-screen "פרויקטים בהכנה" circle.
 *
 * One document per AI-creation run, in the `creation_jobs` collection, updated
 * at natural points inside each generation pipeline. Read by
 * GET /api/app/creations (creations.controller.js).
 *
 * Every function here is BEST-EFFORT: a progress write must never break a
 * generation pipeline, so all errors are swallowed (warn-logged) and a null
 * jobId turns every call into a no-op.
 */
const axios = require("axios");
const { ObjectId } = require("mongodb");
const { DB } = require("../config/db");
const { normalizePhone } = require("../utils/phone");

const KINDS = ["quick_ad", "campaign", "social_batch", "social_day", "post_gen"];
const ERROR_MAX_LEN = 300;

const creationJobs = () => DB.collection("creation_jobs");

// ── Completion webhook → Make.com (notify the client the creation is ready) ──
const COMPLETION_WEBHOOK_URL =
  process.env.CREATION_DONE_WEBHOOK_URL ||
  "https://hook.eu2.make.com/uxb6yhzy96881pr6bt6t2zefm36dh5hm";
const SIGNATURE = "\n\nצוות קליק";
const COMPLETION_MESSAGES = {
  quick_ad:     "המודעה שלך מוכנה וכבר עלתה! 🎉",
  campaign:     "הסתיימה בניית הקמפיין שלך — איזה כיף! 🎉",
  social_batch: "חבילת הסושיאל שלך מוכנה ומתוזמנת! 🎉",
  social_day:   "הפוסט שלך לסושיאל מוכן! 🎉",
  post_gen:     "הפוסט שלך מוכן! 🎉",
};

/** Fire-and-forget: tell Make to message the client. Never throws. */
function fireCompletionWebhook(phone, kind) {
  try {
    if (!phone) return;
    const masseg = (COMPLETION_MESSAGES[kind] || "היצירה שלך מוכנה! 🎉") + SIGNATURE;
    axios
      .get(COMPLETION_WEBHOOK_URL, { params: { phone, masseg }, timeout: 10000 })
      .then(() => console.log(`[creation-progress] webhook sent (${kind}) → ${phone}`))
      .catch((e) => console.warn("[creation-progress] webhook failed:", e.message));
  } catch (e) {
    console.warn("[creation-progress] webhook error:", e.message);
  }
}

/**
 * Single phone key shared by writers (startJob) and the read endpoint, so jobs
 * always match the query. Prefers the strict 05XXXXXXXX form; falls back to a
 * loose digits-only form for legacy/odd formats instead of dropping tracking.
 */
function toPhoneKey(phone) {
  if (!phone) return null;
  const cleaned = String(phone).trim().replace(/[\s-]/g, "");
  const strict = normalizePhone(cleaned);
  if (strict) return strict;
  const digits = cleaned.replace(/^\+/, "");
  if (!/^\d{7,15}$/.test(digits)) return null;
  return digits.replace(/^972/, "0");
}

let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await creationJobs().createIndex({ phone: 1, status: 1, updatedAt: -1 });
    // Self-cleaning: nothing older than 7 days is ever shown, so let Mongo drop it.
    await creationJobs().createIndex({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
  } catch (err) {
    indexesEnsured = false; // retry on next startJob
    console.warn("[creation-progress] ensureIndexes failed:", err.message);
  }
}

const percentOf = (completed, total) =>
  Math.min(99, Math.max(0, Math.round((100 * completed) / Math.max(1, total))));

/**
 * Open a progress document. Returns its id (string) or null — callers pass the
 * id straight into the other functions without guarding.
 */
async function startJob({ phone, kind, total = 1, label = null, refId = null }) {
  try {
    const normalized = toPhoneKey(phone);
    if (!normalized || !KINDS.includes(kind)) return null;
    await ensureIndexes();
    const now = new Date();
    const { insertedId } = await creationJobs().insertOne({
      phone: normalized,
      kind,
      label: label ? String(label).slice(0, 120) : null,
      status: "processing",
      total: Math.max(1, Number(total) || 1),
      completed: 0,
      percent: 0,
      error: null,
      refId: refId ? String(refId) : null,
      createdAt: now,
      updatedAt: now,
    });
    return insertedId.toString();
  } catch (err) {
    console.warn("[creation-progress] startJob failed:", err.message);
    return null;
  }
}

/** Advance a job. `total` may be corrected once the real unit count is known. */
async function setProgress(id, completed, { total } = {}) {
  if (!id) return;
  try {
    const doc = { completed: Math.max(0, Number(completed) || 0), updatedAt: new Date() };
    if (total != null) doc.total = Math.max(1, Number(total) || 1);
    // percent needs the (possibly unchanged) total — compute via pipeline-free
    // two-step: read current total only when not provided.
    if (doc.total == null) {
      const current = await creationJobs().findOne(
        { _id: new ObjectId(id) },
        { projection: { total: 1 } },
      );
      if (!current) return;
      doc.total = current.total;
    }
    doc.percent = percentOf(doc.completed, doc.total);
    await creationJobs().updateOne(
      { _id: new ObjectId(id), status: "processing" },
      { $set: doc },
    );
  } catch (err) {
    console.warn("[creation-progress] setProgress failed:", err.message);
  }
}

async function completeJob(id) {
  if (!id) return;
  try {
    const _id = new ObjectId(id);
    // Status-guarded transition so the completion webhook fires exactly once,
    // even if completeJob is called more than once for the same job.
    const doc = await creationJobs().findOneAndUpdate(
      { _id, status: { $ne: "completed" } },
      {
        $set: {
          status: "completed",
          percent: 100,
          error: null,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "before", projection: { total: 1, phone: 1, kind: 1 } },
    );
    if (!doc) return; // already completed — don't notify twice
    // Fill completed:=total (separate write since we read the "before" doc).
    await creationJobs().updateOne({ _id }, { $set: { completed: doc.total } });
    fireCompletionWebhook(doc.phone, doc.kind);
  } catch (err) {
    console.warn("[creation-progress] completeJob failed:", err.message);
  }
}

/** error: free text, or the reserved codes "TIMEOUT" / "FALLBACK_MANAGER". */
async function failJob(id, error) {
  if (!id) return;
  try {
    await creationJobs().updateOne(
      { _id: new ObjectId(id), status: { $ne: "completed" } },
      {
        $set: {
          status: "failed",
          error: error ? String(error).slice(0, ERROR_MAX_LEN) : "unknown",
          updatedAt: new Date(),
        },
      },
    );
  } catch (err) {
    console.warn("[creation-progress] failJob failed:", err.message);
  }
}

module.exports = { startJob, setProgress, completeJob, failJob, toPhoneKey, KINDS };
