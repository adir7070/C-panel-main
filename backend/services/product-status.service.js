/**
 * product-status.service — single source of truth for the
 * `productStatus` lifecycle on wow-ads / wow-organic / wow-lp sessions.
 *
 * Each session has its own status, independent of the package-level
 * `users.activePackage.status`. The 9 values mirror the spec:
 *
 *   pending_characterization → sent_for_creation → pending_manager_approval
 *   → sent_to_client
 *      → client_returned_corrections → in_correction → corrections_completed
 *                                                       → pending_manager_approval (loop)
 *      → client_approved → completed
 */

const { getDB } = require("../config/db");

const COLLECTIONS = {
  ads:     "wow_ads_sessions",
  organic: "wow_organic_ads_sessions",
  lp:      "wow_lp_sessions",
};

const PRODUCT_STATUSES = [
  "pending_characterization",
  "sent_for_creation",
  "pending_manager_approval",
  "sent_to_client",
  "client_returned_corrections",
  "in_correction",
  "corrections_completed",
  "client_approved",
  "completed",
];

/* Whitelisted manager-driven manual transitions (sec 1.3 in spec).
   All other transitions are driven by automatic events (generate, done,
   send-to-client, client approve/reject). */
const MANUAL_TRANSITIONS = {
  client_returned_corrections: ["in_correction"],
  in_correction:               ["corrections_completed"],
  corrections_completed:       ["pending_manager_approval"],
  client_approved:             ["completed"],
};

function isValidStatus(s) {
  return PRODUCT_STATUSES.includes(s);
}

function isValidType(t) {
  return Object.prototype.hasOwnProperty.call(COLLECTIONS, t);
}

function colFor(type) {
  const name = COLLECTIONS[type];
  if (!name) throw new Error(`Unknown product type: ${type}`);
  return getDB().collection(name);
}

/* Look up the most recent session for a phone, regardless of status. */
async function latestSession(type, phone) {
  return colFor(type)
    .find({ phone })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray()
    .then(rows => rows[0] || null);
}

/* Read the current productStatus for a phone+type. If the document was
   created before the productStatus field existed (or the field is missing
   for any other reason), infer from the legacy fields:
     - session.status (generating_* / done / error)
     - session.clientApprovalStatus (sent / approved / rejected)
     - session.approvalStatus (LP only — same values)
   Falls back to "pending_characterization" if nothing matches.

   IMPORTANT: only sessions created at-or-after the active package's
   purchasedAt count. Without this, a client who bought a new package
   would see "נשלח לאישור הלקוח" carried over from their PREVIOUS
   package's work — the status panel would lie about the new package's
   actual state. Symmetric with the per-package scoping in the WOW
   get* controllers. */
/* Count how many items inside an ads/organic session the manager has
   approved (managerApprovedAt set) vs the total. Returns {approved,total}.
   For lp sessions there is no per-item list — we return null so callers
   can render a single-flag UI instead of a fraction. The output is used
   by the front-end ProductStatusTable to give the manager a visible
   signal that their approval clicks "did something" — without it the
   status badge stays on pending_manager_approval whether 0 or all-N
   items are approved (the badge advances to sent_to_client only on the
   explicit 'שלח ללקוח' click). */
function approvalProgressFor(type, sess) {
  if (!sess) return null;
  if (type === "ads") {
    const items = Array.isArray(sess.generatedAds) ? sess.generatedAds : [];
    return { approved: items.filter(a => !!a.managerApprovedAt).length, total: items.length };
  }
  if (type === "organic") {
    const items = Array.isArray(sess.generatedPosts) ? sess.generatedPosts : [];
    return { approved: items.filter(p => !!p.managerApprovedAt).length, total: items.length };
  }
  return null;
}

async function getStatus(type, phone) {
  const sess = await latestSession(type, phone);
  if (!sess) return { productStatus: "pending_characterization", sessionExists: false, approval: null };

  /* Active-package window check. Best-effort: if we can't read the
     active package for any reason, fall back to the unscoped behavior
     (better than incorrectly hiding a session). */
  try {
    const u = await getDB().collection("users").findOne(
      { phone },
      { projection: { activePackage: 1 } },
    );
    const t = u?.activePackage?.purchasedAt;
    const sinceMs = t
      ? (typeof t === "string" ? Date.parse(t) : new Date(t).getTime())
      : null;
    if (Number.isFinite(sinceMs) && sess.createdAt) {
      const ct = new Date(sess.createdAt).getTime();
      if (Number.isFinite(ct) && ct < sinceMs) {
        return { productStatus: "pending_characterization", sessionExists: false, approval: null };
      }
    }
  } catch (_e) { /* ignore — fall through to normal path */ }

  const approval = approvalProgressFor(type, sess);
  if (sess.productStatus) {
    return { productStatus: sess.productStatus, sessionExists: true, approval };
  }
  return { productStatus: inferStatusFromSession(sess), sessionExists: true, approval };
}

/* Best-effort inference for legacy sessions (no productStatus field).
   Order matters: client decisions trump session.status. */
function inferStatusFromSession(sess) {
  const approval = sess.clientApprovalStatus || sess.approvalStatus || null;
  if (approval === "approved") return "client_approved";
  if (approval === "rejected") return "client_returned_corrections";
  if (approval === "sent")     return "sent_to_client";

  /* No client decision → use the AI pipeline state. */
  const s = sess.status || null;
  if (s === "done")  return "pending_manager_approval";
  if (s && s.startsWith("generating_")) return "sent_for_creation";
  if (s === "error") return "pending_characterization";

  return "pending_characterization";
}

/* Set productStatus on the most recent session (or by sessionId if given). */
async function setStatus(type, phone, status, opts = {}) {
  if (!isValidStatus(status)) throw new Error(`Invalid productStatus: ${status}`);
  const filter = opts.sessionId
    ? { sessionId: opts.sessionId }
    : await latestSession(type, phone).then(s => s ? { _id: s._id } : null);
  if (!filter) return { ok: false, reason: "no_session" };

  const $set = { productStatus: status, productStatusUpdatedAt: new Date() };
  /* Mirror to clientApprovalStatus where it makes sense (backward compat). */
  const mirror = mirrorStatus(status);
  if (mirror) {
    if (type === "lp") $set.approvalStatus = mirror;
    $set.clientApprovalStatus = mirror;
  }

  const r = await colFor(type).updateOne(filter, { $set });
  return { ok: r.matchedCount > 0, modified: r.modifiedCount };
}

/* spec table sec 1.1: map productStatus → existing clientApprovalStatus */
function mirrorStatus(productStatus) {
  switch (productStatus) {
    case "sent_to_client":              return "sent";
    case "client_returned_corrections": return "rejected";
    case "client_approved":             return "approved";
    default: return null;
  }
}

/* Manager manual transition (PUT endpoint). Validates whitelist. */
async function applyManualTransition(type, phone, nextStatus) {
  if (!isValidType(type))   return { ok: false, code: "BAD_TYPE" };
  if (!isValidStatus(nextStatus)) return { ok: false, code: "BAD_STATUS" };

  const { productStatus: current } = await getStatus(type, phone);
  const allowed = MANUAL_TRANSITIONS[current] || [];
  if (!allowed.includes(nextStatus)) {
    return { ok: false, code: "TRANSITION_NOT_ALLOWED", current, allowed };
  }

  const r = await setStatus(type, phone, nextStatus);
  return { ok: r.ok, current: nextStatus };
}

module.exports = {
  COLLECTIONS,
  PRODUCT_STATUSES,
  MANUAL_TRANSITIONS,
  isValidStatus,
  isValidType,
  getStatus,
  setStatus,
  applyManualTransition,
  latestSession,
};
