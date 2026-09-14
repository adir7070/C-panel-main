/**
 * Public client-facing endpoint:
 *   GET /api/client/projects?phone=<phone>
 *
 * Aggregates every "approval batch" the manager has sent to this client
 * across the three product kinds (ads / organic / LP), normalises each
 * into a single project card shape, and returns them sorted newest-first.
 *
 * NO auth header — phone IS the identifier (matches the existing
 * pattern for client-app endpoints).
 */

const { getDB } = require("../config/db");
const axios          = require("axios");
const cardcomConfig  = require("../config/cardcom.config");
const { withVAT }    = require("../services/cardcom.service");
const { sendPurchaseWebhook } = require("../utils/purchase-webhook");
const { requiredEnv } = require("../utils/required-env");


const adsCol     = () => getDB().collection("wow_ads_sessions");
const organicCol = () => getDB().collection("wow_organic_ads_sessions");
const lpCol      = () => getDB().collection("wow_lp_sessions");

/* ── Helpers ──────────────────────────────────────────────────────── */

function pickName(packageName, summaryText) {
  // Server-stored package name takes precedence; otherwise build from content
  if (packageName && String(packageName).trim()) return String(packageName).trim();
  return summaryText || "חבילה";
}

function emptyContents() {
  return {
    ads_sponsored: 0,
    ads_social:    0,
    carousels:     0,
    logo:          0,
    landing_page:  0,
    video:         0,
  };
}

/** Combine summary parts into a fallback name like "10 ממומן + 3 קרוסלות". */
function buildSummaryString(contents) {
  const parts = [];
  if (contents.ads_sponsored > 0) parts.push(`${contents.ads_sponsored} ממומן`);
  if (contents.ads_social    > 0) parts.push(`${contents.ads_social} סושיאל`);
  if (contents.carousels     > 0) parts.push(`${contents.carousels} קרוסלות`);
  if (contents.logo          > 0) parts.push(`לוגו`);
  if (contents.landing_page  > 0) parts.push(`דף נחיתה`);
  if (contents.video         > 0) parts.push(`${contents.video} וידאו`);
  return parts.join(" + ") || "חבילה";
}

function buildAdsProject(sess) {
  const ads     = sess.generatedAds || sess.ads || [];
  const sentAds = ads.filter(a => a.managerApprovedAt).length || ads.length;
  const contents = { ...emptyContents(), ads_sponsored: sentAds };
  return {
    id:       String(sess.clientApprovalToken || sess.sessionId || sess._id),
    name:     pickName(sess.packageName, buildSummaryString(contents)),
    date:     sess.sentForApprovalAt || sess.updatedAt || sess.createdAt,
    status:   sess.clientApprovalStatus || "sent",
    contents,
  };
}

function buildOrganicProject(sess) {
  const posts     = sess.generatedPosts || sess.posts || [];
  const sentPosts = posts.filter(p => p.managerApprovedAt);
  const carousels = sentPosts.filter(p => p.type === "carousel").length;
  const regular   = sentPosts.length - carousels;
  const contents = { ...emptyContents(), ads_social: regular, carousels };
  return {
    id:       String(sess.clientApprovalToken || sess.sessionId || sess._id),
    name:     pickName(sess.packageName, buildSummaryString(contents)),
    date:     sess.sentForApprovalAt || sess.updatedAt || sess.createdAt,
    status:   sess.clientApprovalStatus || "sent",
    contents,
  };
}

function buildLpProject(sess) {
  const contents = { ...emptyContents(), landing_page: 1 };
  return {
    id:       String(sess.approvalToken || sess.clientApprovalToken || sess.sessionId || sess._id),
    name:     pickName(sess.packageName, buildSummaryString(contents)),
    date:     sess.sentForApprovalAt || sess.updatedAt || sess.createdAt,
    status:   sess.approvalStatus || sess.clientApprovalStatus || "sent",
    contents,
  };
}

/**
 * Find a session by id across the three kinds. id may be either the
 * sessionId (prefix-style: wat_*, wlp_*, wo_*) OR the clientApprovalToken
 * (UUID). Returns { kind, session } or null.
 */
async function findSessionById(phone, id) {
  // Try ads
  let s = await adsCol().findOne({
    phone,
    $or: [{ sessionId: id }, { clientApprovalToken: id }],
  });
  if (s) return { kind: "ads", session: s };

  // Try organic
  s = await organicCol().findOne({
    phone,
    $or: [{ sessionId: id }, { clientApprovalToken: id }],
  });
  if (s) return { kind: "organic", session: s };

  // Try LP
  s = await lpCol().findOne({
    phone,
    $or: [
      { sessionId: id },
      { clientApprovalToken: id },
      { approvalToken: id },
    ],
  });
  if (s) return { kind: "lp", session: s };

  return null;
}

function itemStatus(item, sessionStatus) {
  if (item.clientApproved === true) return "approved";
  if (item.clientApproved === false) return "rejected";
  if (sessionStatus === "approved") return "approved";
  if (sessionStatus === "rejected") return "rejected";
  return "pending";
}

/**
 * Given the array of items (generatedAds / generatedPosts), compute the
 * overall session status from individual per-item flags:
 *   - ANY item rejected     → "rejected"
 *   - ALL items approved    → "approved"
 *   - otherwise (mixed/pending) → "sent"
 *
 * Returns the new overall status. Caller writes it back to the session.
 */
function computeOverallStatus(items) {
  const approved = items.filter(i => i.clientApproved === true).length;
  const rejected = items.filter(i => i.clientApproved === false).length;
  const total    = items.length;
  if (rejected > 0) return "rejected";
  if (approved === total && total > 0) return "approved";
  return "sent";
}

/**
 * Mutate a single item's per-client approval state.
 * Returns the matched item, or null if not found.
 *
 * Writes both the legacy boolean (`clientApproved`) and the newer
 * lifecycle fields (`clientStatus`, `clientApprovedAt`, `clientRejectedAt`)
 * defined in CPANEL-EDIT-TRACKING-SPEC.md.
 */
function updateItemApproval(items, itemId, approved, feedback) {
  const numericId = isNaN(Number(itemId)) ? itemId : Number(itemId);
  const idx = items.findIndex(i => i.id === numericId || String(i.id) === String(itemId));
  if (idx === -1) return null;
  const now = new Date();
  items[idx].clientApproved    = approved;
  items[idx].clientFeedback    = approved ? null : (feedback || null);
  items[idx].clientResponseAt  = now.toISOString();
  /* Edit-tracking spec fields */
  items[idx].clientStatus      = approved ? "approved" : "rejected";
  items[idx].clientApprovedAt  = approved ? now : null;
  items[idx].clientRejectedAt  = approved ? null : now;
  return items[idx];
}

/**
 * Translate the public-API `kind` value (the new spec uses ads_sponsored /
 * ads_social / carousels / logo / landing_page / video) into the internal
 * kind ("ads" / "organic" / "lp") that findSessionById returns.
 * Returns null for unknown values.
 */
function publicKindToInternal(kind) {
  if (!kind) return null;
  const k = String(kind).toLowerCase();
  if (k === "ads_sponsored" || k === "ads")          return "ads";
  if (k === "ads_social"    || k === "organic" || k === "carousels") return "organic";
  if (k === "landing_page"  || k === "lp")           return "lp";
  if (k === "logo" || k === "video")                 return null; // not yet supported on server
  return null;
}

/* ── Controller ───────────────────────────────────────────────────── */

exports.getClientProjects = async (req, res) => {
  try {
    const phone = (req.query.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const user = await getDB().collection("users").findOne(
      { phone },
      { projection: { activePackage: 1, purchasedPackages: 1 } },
    ).catch(() => null);

    // Use purchasedPackages array (newest first) when available;
    // fall back to the single activePackage field for existing users.
    const pkgList = Array.isArray(user?.purchasedPackages) && user.purchasedPackages.length > 0
      ? [...user.purchasedPackages].reverse()
      : user?.activePackage ? [user.activePackage] : [];

    const projects = pkgList.map((pkg) => {
      const safeDate = (pkg.purchasedAt || "").toString().replace(/[:.]/g, "-");
      return {
        id:       `pkg_${pkg.key || pkg.id || "custom"}_${safeDate}`,
        name:     pkg.name || "חבילה",
        date:     pkg.purchasedAt,
        status:   pkg.status || "waiting_brief",
        contents: {
          ads_sponsored: pkg.items?.paidAds    || pkg.items?.ad          || 0,
          ads_social:    pkg.items?.organicAds || pkg.items?.social_ad   || 0,
          carousels:     pkg.items?.carousels  || 0,
          logo:          pkg.items?.logos      || pkg.items?.logo        || 0,
          landing_page:  pkg.items?.lps        || pkg.items?.lp          || 0,
          video:         pkg.items?.videos     || pkg.items?.video       || 0,
        },
        ...(pkg.images?.length ? { images: pkg.images } : {}),
      };
    });

    res.json({ projects });
  } catch (err) {
    console.error("[ClientProjects] getClientProjects:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* ── GET /api/client/project-detail?phone=&projectId= ────────────── */

exports.getClientProjectDetail = async (req, res) => {
  try {
    const phone     = (req.query.phone || "").toString().trim();
    const projectId = (req.query.projectId || "").toString().trim();
    if (!phone || !projectId) {
      return res.status(400).json({ error: "phone and projectId are required" });
    }

    // Package-level detail: collect ALL sessions for this phone
    if (projectId.startsWith("pkg_")) {
      const [user, adsRows, organicRows, lpRows] = await Promise.all([
        getDB().collection("users").findOne({ phone }, { projection: { activePackage: 1 } }).catch(() => null),
        adsCol().find({ phone }).toArray().catch(() => []),
        organicCol().find({ phone }).toArray().catch(() => []),
        lpCol().find({ phone }).toArray().catch(() => []),
      ]);

      const pkg = user?.activePackage;
      const overallStatus = pkg?.status || "waiting_brief";

      const mapItem = (a, sessStatus, sessKey) => ({
        id:       `${sessKey}_${String(a.id != null ? a.id : a._id)}`,
        imageUrl: a.imageUrl || null,
        headline: a.headline || a.title || "",
        body:     a.description || a.body || a.caption || "",
        status:   itemStatus(a, sessStatus),
        /* Edit-tracking spec (CPANEL-EDIT-TRACKING-SPEC.md sec 3): expose
           per-item lifecycle so cpanel can show the badge + edit history. */
        clientStatus:     a.clientStatus     || (a.clientApproved === true ? "approved"
                                                : a.clientApproved === false ? "rejected"
                                                : "pending"),
        clientApprovedAt: a.clientApprovedAt || null,
        clientRejectedAt: a.clientRejectedAt || null,
        editCount:        Number.isFinite(a.editCount) ? a.editCount : 0,
        editRequests:     Array.isArray(a.editRequests) ? a.editRequests : [],
      });

      /* No managerApprovedAt filter on the pkg_* path — package status
         (sent_to_client / sent_to_creation / etc.) is the gate, not
         per-item approval. Filtering here would hide every item from the
         client whenever the manager pushes the package via "שלח לאישור". */
      const ads_sponsored = adsRows.flatMap(s => {
        const st     = s.clientApprovalStatus || "sent";
        const sKey   = String(s._id || s.sessionId);
        return (s.generatedAds || s.ads || [])
          .map(a => mapItem(a, st, sKey));
      });

      const posts = organicRows.flatMap(s => {
        const st   = s.clientApprovalStatus || "sent";
        const sKey = String(s._id || s.sessionId);
        return (s.generatedPosts || s.posts || [])
          .map(p => ({ ...mapItem(p, st, sKey), type: p.type }));
      });

      /* The LP preview is rendered as HTML by the SERVER (server.js
         registers `/lp-preview/:token` → wow-lp.controller publicPreviewHtml).
         It is NOT a route on the client-app domain. So previewUrl must
         resolve against SERVER_BASE_URL. We also auto-mint an approval
         token if the LP has one but no previewUrl yet. */
      const SERVER_BASE = process.env.SERVER_BASE_URL || "https://api.iconiqmedia.co.il";
      const lp_items = lpRows.map(s => {
        const tok = s.approvalToken || s.clientApprovalToken || null;
        const previewUrl =
             s.previewUrl
          || s.publishedUrl
          || (tok ? `${SERVER_BASE}/lp-preview/${tok}` : null);
        return {
          id:       `lp_${String(s.sessionId || s._id)}`,
          imageUrl: previewUrl,
          headline: s.pageTitle || "דף נחיתה",
          body:     s.subtitle || s.tagline || "",
          status:   itemStatus(s, s.approvalStatus || s.clientApprovalStatus || "sent"),
        };
      });

      return res.json({
        id:            projectId,
        name:          pkg?.name || "חבילה",
        date:          pkg?.purchasedAt,
        overallStatus,
        ads_sponsored,
        ads_social:    posts.filter(p => p.type !== "carousel"),
        carousels:     posts.filter(p => p.type === "carousel").map(({ type, ...p }) => p),
        logo:          [],
        landing_page:  lp_items,
        video:         [],
      });
    }

    const found = await findSessionById(phone, projectId);
    if (!found) return res.status(404).json({ error: "Project not found" });

    const { kind, session } = found;
    const overallStatus = session.clientApprovalStatus || session.approvalStatus || "sent";

    // Six product-type arrays — fill only the ones this session contains
    const out = {
      id:            String(session.clientApprovalToken || session.approvalToken || session.sessionId || session._id),
      name:          session.packageName || null,
      date:          session.sentForApprovalAt || session.updatedAt || session.createdAt,
      overallStatus,
      ads_sponsored: [],
      ads_social:    [],
      carousels:     [],
      logo:          [],
      landing_page:  [],
      video:         [],
    };

    if (kind === "ads") {
      const ads = (session.generatedAds || session.ads || []).filter(a => a.managerApprovedAt);
      out.ads_sponsored = ads.map(a => ({
        id:        String(a.id != null ? a.id : a._id),
        imageUrl:  a.imageUrl || null,
        headline:  a.headline || "",
        status:    itemStatus(a, overallStatus),
      }));
    } else if (kind === "organic") {
      const posts = (session.generatedPosts || session.posts || []).filter(p => p.managerApprovedAt);
      const carousels = posts.filter(p => p.type === "carousel");
      const regular   = posts.filter(p => p.type !== "carousel");
      out.ads_social = regular.map(p => ({
        id:        String(p.id != null ? p.id : p._id),
        imageUrl:  p.imageUrl || null,
        headline:  p.headline || "",
        status:    itemStatus(p, overallStatus),
      }));
      out.carousels = carousels.map(p => ({
        id:        String(p.id != null ? p.id : p._id),
        imageUrl:  p.imageUrl || (p.slides && p.slides[0]?.imageUrl) || null,
        headline:  p.headline || "",
        status:    itemStatus(p, overallStatus),
      }));
    } else if (kind === "lp") {
      /* `/lp-preview/:token` is a SERVER route (wow-lp.controller), not the
         client app — must resolve against SERVER_BASE_URL. Also accept
         either approvalToken (the canonical field set by setApprovalToken)
         or the legacy clientApprovalToken if it exists. */
      const SERVER_BASE = process.env.SERVER_BASE_URL || "https://api.iconiqmedia.co.il";
      const tok = session.approvalToken || session.clientApprovalToken || null;
      const previewUrl =
           session.previewUrl
        || session.publishedUrl
        || (tok ? `${SERVER_BASE}/lp-preview/${tok}` : null);
      out.landing_page = [{
        id:        String(session.sessionId || session._id),
        imageUrl:  previewUrl,
        headline:  "",
        status:    itemStatus(session, overallStatus),
      }];
    }
    // logo + video kinds — server doesn't generate these yet; arrays stay empty.

    res.json(out);
  } catch (err) {
    console.error("[ClientProjects] getClientProjectDetail:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * Shared respond-to-project handler. Used by both approve and reject —
 * `decision` is the boolean (true = approve, false = reject).
 *
 * Behavior:
 *   - With `itemId`: only that item's status flips; overall session
 *     status recomputed from all items.
 *   - Without `itemId`: legacy whole-session response — every item gets
 *     the same status; overall = approved/rejected.
 */
async function respondToProject(req, res, decision) {
  const id         = (req.params.id || "").toString().trim();
  const phone      = (req.body?.phone || "").toString().trim();
  const kind       = (req.body?.kind || "").toString().trim();
  const itemIdRaw  = req.body?.itemId != null ? String(req.body.itemId) : null;
  const feedback   = decision ? null : ((req.body?.feedback || "").toString().trim() || null);
  if (!id || !phone) return res.status(400).json({ error: "id and phone are required" });

  /* itemIdRaw is in compound format: "{sessionObjectId}_{rawItemId}", e.g. "69fb07e7587a409d4cf2899a_3".
     Extract the session _id to find the session directly, bypassing the pkg_* projectId. */
  const { ObjectId } = require("mongodb");
  let found = null;
  let rawItemId = itemIdRaw;

  if (itemIdRaw) {
    const lastUnderscore = itemIdRaw.lastIndexOf("_");
    const sessionOidStr  = lastUnderscore > 0 ? itemIdRaw.substring(0, lastUnderscore) : null;
    rawItemId            = lastUnderscore > 0 ? itemIdRaw.substring(lastUnderscore + 1) : itemIdRaw;

    if (sessionOidStr && ObjectId.isValid(sessionOidStr)) {
      const oid = new ObjectId(sessionOidStr);
      let s = await adsCol().findOne({ _id: oid, phone });
      if (s) { found = { kind: "ads", session: s }; }
      if (!found) {
        s = await organicCol().findOne({ _id: oid, phone });
        if (s) { found = { kind: "organic", session: s }; }
      }
    }
  }
  if (!found) found = await findSessionById(phone, id);
  if (!found) return res.status(404).json({ error: "Project not found" });

  if (kind) {
    const expected = publicKindToInternal(kind);
    if (expected && expected !== found.kind) {
      return res.status(400).json({ error: `Project kind is ${found.kind}, not ${kind}` });
    }
  }

  const stamp = new Date().toISOString();

  // Per-item path — for ads + organic only (LP is single-instance)
  if (rawItemId && (found.kind === "ads" || found.kind === "organic")) {
    const itemsField = found.kind === "ads" ? "generatedAds" : "generatedPosts";
    const items = (found.session[itemsField] || []).slice();
    const updated = updateItemApproval(items, rawItemId, decision, feedback);
    if (!updated) return res.status(404).json({ error: "Item not found in project" });

    // Per-item: only save the updated items array.
    // Do NOT update clientApprovalStatus — writing session-level "rejected" when any single
    // item is rejected would contaminate all other items that haven't been responded to yet.
    const update = {
      [itemsField]: items,
      updatedAt:    stamp,
    };

    const col = found.kind === "ads" ? adsCol() : organicCol();
    await col.updateOne({ _id: found.session._id }, { $set: update });

    pushManagerNotification(req, phone, {
      status: decision ? "approved" : "rejected",
      kind:   found.kind,
      itemId: rawItemId,
      feedback,
    });
    return res.json({ success: true, itemId: rawItemId, status: decision ? "approved" : "rejected" });
  }

  // Whole-session path (legacy + LP)
  const newStatus = decision ? "approved" : "rejected";
  const update = {
    clientApprovalStatus: newStatus,
    clientApprovedAt:     stamp,
    clientFeedback:       feedback,
    updatedAt:            stamp,
    productStatus:           decision ? "client_approved" : "client_returned_corrections",
    productStatusUpdatedAt:  stamp,
  };
  if (found.kind === "lp") {
    Object.assign(update, { approvalStatus: newStatus, clientResponseAt: stamp });
    await lpCol().updateOne({ _id: found.session._id }, { $set: update });
  } else if (found.kind === "ads") {
    await adsCol().updateOne({ _id: found.session._id }, { $set: update });
  } else {
    await organicCol().updateOne({ _id: found.session._id }, { $set: update });
  }

  pushManagerNotification(req, phone, {
    status: newStatus,
    kind:   found.kind,
    feedback,
  });
  res.json({ success: true });
}

/** Best-effort socket push to the manager — never throws. */
async function pushManagerNotification(req, phone, payload) {
  try {
    const io = req.app?.get("io");
    if (!io) return;
    const chat = await getDB().collection("support_chats")
      .findOne({ phone }, { projection: { accountManagerId: 1 } });
    if (chat?.accountManagerId) {
      io.to(`am_${chat.accountManagerId}`).emit("client_review_responded", { phone, ...payload });
    }
  } catch { /* non-fatal */ }
}

/* Lifecycle status values for an active package. Mirror of the spec. */
const PACKAGE_STATUSES = [
  "waiting_brief",
  "sent_to_creation",
  "waiting_manager_approval",
  "sent_to_client",
  "client_returned_corrections",
  "in_correction",
  "corrections_done",
  "client_approved",
  "completed",
];

/* ── PATCH /api/client/project-detail/:id/status ──────────────────────
   Manager-side lifecycle update for a package project. id must start
   with "pkg_" (so it points at users.activePackage). Body: { phone, status }. */
exports.updateClientProjectStatus = async (req, res) => {
  try {
    const id     = (req.params.id || "").toString().trim();
    const phone  = (req.body?.phone  || "").toString().trim();
    const status = (req.body?.status || "").toString().trim();
    if (!id || !phone || !status) {
      return res.status(400).json({ error: "id, phone, and status are required" });
    }
    if (!PACKAGE_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${PACKAGE_STATUSES.join(", ")}`,
      });
    }
    if (!id.startsWith("pkg_")) {
      return res.status(400).json({
        error: "Status updates are only supported for package projects (id starts with 'pkg_').",
      });
    }

    const usersCol = () => getDB().collection("users");
    const user = await usersCol().findOne({ phone }, { projection: { activePackage: 1 } });
    if (!user?.activePackage) {
      return res.status(404).json({ error: "No active package for this client." });
    }

    const result = await usersCol().updateOne(
      { phone },
      { $set: {
          "activePackage.status":          status,
          "activePackage.statusUpdatedAt": new Date().toISOString(),
        }
      },
    );

    pushManagerNotification(req, phone, { kind: "package", status, pkgId: id });

    /* Products went out to the client ("אשר ושלח ללקוח" / "שלח שוב ללקוח") —
       tell them on WhatsApp. */
    if (status === "sent_to_client" && user.activePackage.status !== "sent_to_client") {
      // dedupe on the stored package, never on the id in the URL
      const pkg = user.activePackage;
      await require("../services/client-notify.service").notify.productsReady(phone, { scope: `${pkg.key || "package"}:${pkg.purchasedAt || ""}` });
    }

    res.json({
      success:  true,
      id,
      status,
      matched:  result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (err) {
    console.error("[ClientProjects] updateClientProjectStatus:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* ── POST /api/client/project-detail/:id/approve ──────────────────── */

exports.approveClientProject = async (req, res) => {
  try {
    await respondToProject(req, res, true);
  } catch (err) {
    console.error("[ClientProjects] approveClientProject:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* ── POST /api/client/project-detail/:id/reject ───────────────────── */

exports.rejectClientProject = async (req, res) => {
  try {
    await respondToProject(req, res, false);
  } catch (err) {
    console.error("[ClientProjects] rejectClientProject:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* ── POST /api/client/project-detail/:projectId/items/:itemId/edit-request
   Spec: CPANEL-EDIT-TRACKING-SPEC.md sec 2C. Client app sends edit
   instructions for one item; server calls Gemini with image + instructions,
   optionally calls Imagen for a new image, persists the request to the
   item's editRequests[] array, and returns Gemini's text response. */

const COLLECTION_BY_KIND = {
  ads_sponsored: { col: () => adsCol(),     itemsField: "generatedAds"   },
  ads_social:    { col: () => organicCol(), itemsField: "generatedPosts" },
  carousels:     { col: () => organicCol(), itemsField: "generatedPosts" },
};

function buildEditPrompt(instructions = {}, hasReferenceImage = false) {
  const lines = ["שנה לי את המודעה הזאת לפי ההנחיות הבאות:"];
  if (instructions.title)    lines.push(`- כותרת: ${instructions.title}`);
  if (instructions.subtitle) lines.push(`- תת כותרת: ${instructions.subtitle}`);
  if (instructions.cta)      lines.push(`- הנעה לפעולה: ${instructions.cta}`);
  if (instructions.image)    lines.push(`- שינוי תמונה: ${instructions.image}`);
  if (hasReferenceImage)     lines.push("- תמונת התייחסות: ראה את התמונה השנייה המצורפת והשתמש בה כהשראה לשינוי התמונה");
  lines.push("");
  lines.push('החזר JSON בלבד (ללא markdown):');
  lines.push('{ "headline": "...", "subtitle": "...", "cta": "...", "imageNote": "..." }');
  return lines.join("\n");
}

async function fetchImageAsInlinePart(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") || "image/png";
    return { inlineData: { mimeType, data: buf.toString("base64") } };
  } catch (err) {
    console.warn("[edit-request] image fetch failed:", err.message);
    return null;
  }
}

function safeJsonParse(text) {
  if (!text) return null;
  /* Strip markdown code-fence if Gemini ignored the "no markdown" instruction. */
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(clean); } catch { return null; }
}

exports.saveCampaign = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { phone, campaignId, formId, adsetId, adIds = [] } = req.body;

    if (!phone || !campaignId) {
      return res.status(400).json({ success: false, error: "חסרים phone ו-campaignId" });
    }

    const facebookCampaign = { campaignId, formId, adsetId, adIds, createdAt: new Date() };

    // Try ObjectId lookup first (most sessions)
    const { ObjectId } = require("mongodb");
    let updated = false;

    if (ObjectId.isValid(projectId)) {
      const oid = new ObjectId(projectId);
      let r = await adsCol().updateOne({ _id: oid }, { $set: { facebookCampaign } });
      if (r.matchedCount === 0) r = await organicCol().updateOne({ _id: oid }, { $set: { facebookCampaign } });
      if (r.matchedCount === 0) r = await lpCol().updateOne({ _id: oid }, { $set: { facebookCampaign } });
      updated = r.matchedCount > 0;
    }

    if (!updated) {
      // Fallback: token/sessionId lookup
      const found = await findSessionById(phone, projectId);
      if (found) {
        const col = found.kind === "ads" ? adsCol() : found.kind === "organic" ? organicCol() : lpCol();
        await col.updateOne({ _id: found.session._id }, { $set: { facebookCampaign } });
        updated = true;
      }
    }

    console.log(`[saveCampaign] project=${projectId} phone=${phone} campaignId=${campaignId} updated=${updated}`);
    res.json({ success: true, updated });
  } catch (err) {
    console.error("[ClientProjects] saveCampaign:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/* ── Access gates ─────────────────────────────────────────────────────
   הסושיאל והממומן פתוחים לכל הלקוחות. הגייטים בתשלום נשמרו מאחורי
   ACCESS_GATES_ENABLED=true כדי שאפשר יהיה להחזיר אותם בלי דיפלוי —
   כל ערך אחר (כולל לא-מוגדר) פותח את האזורים לכולם.
*/
const accessGatesEnabled = () => process.env.ACCESS_GATES_ENABLED === "true";

/* ── GET /api/client/social-access?phone= ─────────────────────────────
   Returns { hasSocialAccess: boolean }
   Open to everyone unless ACCESS_GATES_ENABLED=true, in which case
   access requires socialAccess.purchased, or a purchased package
   (catalog or personal_*) carrying social_ad > 0.
*/
exports.getSocialAccess = async (req, res) => {
  try {
    const phone = (req.query.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    if (!accessGatesEnabled()) return res.json({ hasSocialAccess: true });

    const db = getDB();

    // Collect all purchased package keys from the user document
    const user = await db.collection("users").findOne(
      { phone },
      { projection: { activePackage: 1, purchasedPackages: 1, socialAccess: 1 } }
    );
    const packageKeys = [];
    if (user?.activePackage?.key) packageKeys.push(user.activePackage.key);
    (user?.purchasedPackages ?? []).forEach(p => { if (p.key) packageKeys.push(p.key); });

    // גישה דרך רכישה ישירה (500 מטבעות)
    if (user?.socialAccess?.purchased === true) {
      return res.json({ hasSocialAccess: true });
    }

    if (packageKeys.length === 0) {
      return res.json({ hasSocialAccess: false });
    }

    // Grant access if any purchased package includes social_ad > 0 in cpanel_products
    const found = await db.collection("cpanel_products").findOne({
      key: { $in: packageKeys },
      "items.social_ad": { $gt: 0 },
    });
    if (found) return res.json({ hasSocialAccess: true });

    // Personal packages store items directly in purchasedPackages entries (not in cpanel_products)
    const hasPersonalSocial = (user?.purchasedPackages ?? []).some(
      p => p.key?.startsWith("personal_") && (p.items?.social_ad > 0)
    );
    return res.json({ hasSocialAccess: hasPersonalSocial });
  } catch (err) {
    console.error("[ClientProjects] getSocialAccess:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* ── POST /api/client/social-access ──────────────────────────────────
   body: { phone }
   רושם רכישת גישה לסושיאל באובייקט המשתמש.
*/
exports.saveSocialAccessPurchase = async (req, res) => {
  try {
    const phone = (req.body.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const db = getDB();
    await db.collection("users").updateOne(
      { phone },
      { $set: { socialAccess: { purchased: true, purchasedAt: new Date() } } }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[ClientProjects] saveSocialAccessPurchase:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* ── POST /api/client/campaign-access ────────────────────────────────
   body: { phone, campaignType: "web_cmp" | "lead_cmp" }
   רושם רכישת גישה לסוג קמפיין — משלים את ניכוי המטבעות שנעשה לפניו.
*/
exports.saveCampaignAccessPurchase = async (req, res) => {
  try {
    const phone        = (req.body.phone || "").toString().trim();
    const campaignType = req.body.campaignType;
    if (!phone || !campaignType) return res.status(400).json({ error: "phone and campaignType are required" });
    if (!["web_cmp", "lead_cmp"].includes(campaignType)) return res.status(400).json({ error: "campaignType must be web_cmp or lead_cmp" });

    const fieldName = campaignType === "web_cmp" ? "webCmpAccess" : "leadCmpAccess";
    await getDB().collection("users").updateOne(
      { phone },
      { $set: { [fieldName]: { purchased: true, purchasedAt: new Date() } } }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[ClientProjects] saveCampaignAccessPurchase:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.editRequestForItem = async (req, res) => {
  try {
    const projectId      = (req.params.projectId || "").toString().trim();
    const itemId         = (req.params.itemId    || "").toString().trim();
    const phone          = (req.body?.phone      || "").toString().trim();
    const kind           = (req.body?.kind       || "").toString().trim();
    const imageUrl       = (req.body?.imageUrl   || "").toString().trim();
    const instructions   = req.body?.instructions || {};
    const refImageBase64 = (instructions.referenceImageBase64 || "").toString().trim();
    const refImageMime   = (instructions.referenceImageMime   || "image/jpeg").toString().trim();

    if (!projectId || !itemId || !phone || !kind) {
      return res.status(400).json({ success: false, error: "projectId, itemId, phone, kind required" });
    }

    /* Resolve and validate kind */
    const internalKind = publicKindToInternal(kind);
    if (!internalKind || internalKind === "lp") {
      return res.status(400).json({ success: false, error: `unsupported kind: ${kind}` });
    }

    console.log(`[edit-request] phone="${phone}" projectId="${projectId}" itemId="${itemId}" kind="${kind}"`);

    /* The itemId from the client is in the format "{sessionObjectId}_{rawItemId}",
       e.g. "69fb07e7587a409d4cf2899a_3". Extract the session _id from it and
       look up the session directly — no need for clientApprovalToken/sessionId. */
    const { ObjectId } = require("mongodb");
    const lastUnderscore  = itemId.lastIndexOf("_");
    const sessionOidStr   = lastUnderscore > 0 ? itemId.substring(0, lastUnderscore) : null;
    const rawItemId       = lastUnderscore > 0 ? itemId.substring(lastUnderscore + 1) : itemId;

    let found = null;
    if (sessionOidStr && ObjectId.isValid(sessionOidStr)) {
      const oid = new ObjectId(sessionOidStr);
      let s = await adsCol().findOne({ _id: oid, phone });
      if (s) { found = { kind: "ads", session: s }; }
      if (!found) {
        s = await organicCol().findOne({ _id: oid, phone });
        if (s) { found = { kind: "organic", session: s }; }
      }
    }
    /* Fallback: try the standard session lookup */
    if (!found) found = await findSessionById(phone, projectId);

    if (!found) {
      console.warn(`[edit-request] 404 — sessionOidStr="${sessionOidStr}" rawItemId="${rawItemId}"`);
      return res.status(404).json({ success: false, error: "Project not found" });
    }
    console.log(`[edit-request] found session _id=${found.session._id} kind=${found.kind} rawItemId="${rawItemId}"`);

    const hasAnyInstruction = !!(instructions.title || instructions.subtitle || instructions.cta || instructions.image || refImageBase64);
    if (!hasAnyInstruction) {
      return res.status(400).json({ success: false, error: "at least one instruction required" });
    }

    const { GoogleGenAI, Modality } = require("@google/genai");
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: "GOOGLE_AI_API_KEY not configured" });
    }
    const gemini = new GoogleGenAI({ apiKey });

    /* Fetch the original ad image once — both calls need it */
    const origImgPart = await fetchImageAsInlinePart(imageUrl);

    /* ── Build image prompt from raw instructions (no text pre-pass needed) ── */
    const specificChanges = [];
    if (instructions.title)    specificChanges.push(`- Change the headline text to: "${instructions.title}"`);
    if (instructions.subtitle) specificChanges.push(`- Change the subtitle text to: "${instructions.subtitle}"`);
    if (instructions.cta)      specificChanges.push(`- Change the call-to-action button text to: "${instructions.cta}"`);
    if (instructions.image)    specificChanges.push(`- Visual change: ${instructions.image}`);
    if (refImageBase64) {
      specificChanges.push(
        `- IMPORTANT: The second image provided is a reference photo of a person/model. ` +
        `Replace the person or model in the original advertisement with the person shown in the reference photo. ` +
        `Maintain their face, body, and appearance exactly as shown in the reference photo. ` +
        `Keep all other brand elements (logo, colors, text, layout) unchanged.`
      );
    }

    const imagePrompt = specificChanges.length > 0
      ? (refImageBase64
          ? `I am providing two images:\n1. The original advertisement (first image)\n2. A reference photo of a person/model (second image)\n\nPlease create a new advertisement based on image 1, applying these changes:\n${specificChanges.join("\n")}\n\nHigh quality commercial advertisement output.`
          : `Edit this advertisement image with these specific changes:\n${specificChanges.join("\n")}\n\nKeep the brand colors, logo, and overall layout. High quality commercial advertisement.`)
      : `Recreate this advertisement image with improved quality, keeping the same brand identity and style.`;

    /* ── Run text call and image call in PARALLEL ───────────────────── */
    const needsTextSuggestions = !!(instructions.title || instructions.subtitle || instructions.cta);

    const textCallPromise = needsTextSuggestions
      ? (async () => {
          const textParts = [{ text: buildEditPrompt(instructions, !!refImageBase64) }];
          if (origImgPart) textParts.push(origImgPart);
          if (refImageBase64) textParts.push({ inlineData: { mimeType: refImageMime, data: refImageBase64 } });
          const response = await gemini.models.generateContent({
            model: process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash",
            contents: [{ role: "user", parts: textParts }],
          });
          return response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        })()
      : Promise.resolve("");

    const editParts = [];
    if (origImgPart) editParts.push(origImgPart);
    if (refImageBase64) editParts.push({ inlineData: { mimeType: refImageMime, data: refImageBase64 } });
    editParts.push({ text: imagePrompt });

    console.log("[edit-request] firing text+image calls in parallel, editParts:", editParts.length, "textCall:", needsTextSuggestions);

    const imageCallPromise = (async () => {
      const imgResponse = await gemini.models.generateContent({
        model: process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview",
        contents: [{ role: "user", parts: editParts }],
        config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
      });
      const responseParts = imgResponse.candidates?.[0]?.content?.parts ?? [];
      console.log("[edit-request] image response parts:", responseParts.map(p => p.inlineData ? "image" : "text"));
      return responseParts;
    })();

    let geminiText = "";
    let newImageUrl = null;
    let imageGenError = null;

    const [textResult, imgParts] = await Promise.allSettled([textCallPromise, imageCallPromise]);

    if (textResult.status === "fulfilled") {
      geminiText = textResult.value || "";
      console.log("[edit-request] text response:", geminiText?.substring(0, 200));
    } else {
      console.warn("[edit-request] text call failed (non-fatal):", textResult.reason?.message);
    }

    let imageDataUri = null; // base64 data URI for immediate client display

    try {
      const backblazeService = require("../services/backblaze.service");
      if (imgParts.status === "rejected") throw imgParts.reason;
      for (const part of imgParts.value) {
        if (part.inlineData?.data) {
          const rawData  = part.inlineData.data;
          const b64Str   = typeof rawData === "string" ? rawData : Buffer.from(rawData).toString("base64");
          const buf      = Buffer.from(b64Str, "base64");
          const mime     = part.inlineData.mimeType || "image/jpeg";
          const ext      = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
          const fileName = `ad-edit/${phone}/${rawItemId}-${Date.now()}.${ext}`;

          // Return base64 data URI immediately — client displays without a proxy round-trip
          imageDataUri = `data:${mime};base64,${b64Str}`;

          // Upload to Backblaze in background for persistence
          const SERVER_BASE = process.env.BASE_URL || "https://api.iconiqmedia.co.il";
          const proxyUrl    = `${SERVER_BASE}/api/img?url=${encodeURIComponent(fileName)}`;
          backblazeService.uploadImage(fileName, buf, mime)
            .then(() => { newImageUrl = proxyUrl; })
            .catch(e  => console.warn("[edit-request] background upload failed:", e.message));

          newImageUrl = proxyUrl; // optimistically set — MongoDB save below uses this
          console.log("[edit-request] image ready, data URI length:", imageDataUri.length);
          break;
        }
      }
      if (!imageDataUri) console.warn("[edit-request] Gemini returned no image data");
    } catch (err) {
      imageGenError = err.message || String(err);
      console.error("[edit-request] image generation failed:", imageGenError);
    }

    const geminiJson = safeJsonParse(geminiText);

    /* ── Step 3: Persist — same pattern as approve/reject ───────────── */
    const itemsField = found.kind === "ads" ? "generatedAds" : "generatedPosts";
    const session    = found.session;
    const items      = (session[itemsField] || []).slice();
    const numericId  = isNaN(Number(rawItemId)) ? rawItemId : Number(rawItemId);
    const idx        = items.findIndex(i => i.id === numericId || String(i.id) === String(rawItemId));
    console.log(`[edit-request] looking for item rawItemId="${rawItemId}" numericId=${numericId}, found idx=${idx}, total items=${items.length}`);

    if (idx !== -1) {
      if (!Array.isArray(items[idx].editRequests)) items[idx].editRequests = [];
      if (typeof items[idx].editCount !== "number")  items[idx].editCount  = 0;
      items[idx].editCount += 1;
      items[idx].editRequests.push({
        requestedAt:  new Date(),
        instructions,
        geminiResult: geminiText || null,
        newImageUrl,
      });
      if (newImageUrl) items[idx].imageUrl = newImageUrl;

      const col = found.kind === "ads" ? adsCol() : organicCol();
      await col.updateOne({ _id: session._id }, { $set: { [itemsField]: items } });
      console.log(`[edit-request] saved edit for item ${itemId} in session ${session._id}`);
    } else {
      console.warn(`[edit-request] item ${itemId} not found in session ${session._id} (${itemsField})`);
    }

    res.json({
      success:        true,
      text:           geminiText,
      imageUrl:       newImageUrl,
      imageGenError:  imageGenError || undefined,
      debug: {
        origImgFetched:  !!origImgPart,
        refImgReceived:  !!refImageBase64,
        refImgBytes:     refImageBase64 ? refImageBase64.length : 0,
        rawItemId,
        sessionId: String(found?.session?._id),
      },
    });
  } catch (err) {
    console.error("[ClientProjects] editRequestForItem:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/* ── POST /api/client/campaign-access/create-payment ─────────────────
   body: { phone, campaignType: "web_cmp" | "lead_cmp" }
   יוצר דף תשלום Cardcom ל-1,000 ₪ עבור גישה לקמפיין.
*/
exports.createCampaignAccessPayment = async (req, res) => {
  try {
    const phone        = (req.body.phone || "").toString().trim();
    const campaignType = req.body.campaignType;
    console.log(`[CampaignAccess] create-payment | phone=${phone} campaignType=${campaignType}`);

    if (!phone || !campaignType) return res.status(400).json({ error: "phone and campaignType are required" });
    if (!["web_cmp", "lead_cmp"].includes(campaignType)) return res.status(400).json({ error: "campaignType must be web_cmp or lead_cmp" });

    const db         = getDB();
    const baseUrl    = requiredEnv("SERVER_BASE_URL");

    const [user, accessProduct] = await Promise.all([
      db.collection("users").findOne({ phone }, { projection: { name: 1 } }),
      db.collection("cpanel_products").findOne({ key: campaignType }),
    ]);

    console.log(`[CampaignAccess] product lookup | key=${campaignType} found=${!!accessProduct} unitPrice=${accessProduct?.unitPrice} price=${accessProduct?.price}`);

    if (!accessProduct) throw new Error(`מוצר לא נמצא בקטלוג: ${campaignType}`);
    const CAMPAIGN_PRICE = accessProduct.unitPrice || accessProduct.price;
    if (!CAMPAIGN_PRICE) throw new Error(`מחיר לא הוגדר בקטלוג: ${campaignType}`);

    const clientName  = user?.name || phone;
    const productName = campaignType === "web_cmp" ? "גישה לקמפיין לאתר" : "גישה לקמפיין לידים";
    const amountWithVat = withVAT(CAMPAIGN_PRICE);

    console.log(`[CampaignAccess] creating Cardcom iframe | product=${productName} price=${CAMPAIGN_PRICE} withVAT=${amountWithVat}`);

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, {
      TerminalNumber:     cardcomConfig.terminal,
      ApiName:            cardcomConfig.apiName,
      ApiPassword:        cardcomConfig.apiPassword,
      Amount:             amountWithVat,
      ISOCoinId:          1,
      ProductName:        productName,
      SuccessRedirectUrl: `${cardcomConfig.successURL}?type=campaign_access&campaignType=${campaignType}`,
      ErrorRedirectUrl:   `${cardcomConfig.errorURL}?type=campaign_access`,
      NotifyURL:          `${baseUrl}/api/client/campaign-access/notify?phone=${encodeURIComponent(phone)}&campaignType=${campaignType}`,
      ReturnValue:        `${phone}|campaign_access|${campaignType}`,
      CreateInvoice:      false,
      IsCreateToken:      false,
      Operation:          1,
      IsApplePay:         true,
      IsBit:              true,
      IsGooglePay:        true,
      CustomerName:       clientName,
      PhoneNumber:        phone,
    });

    if (cardcomRes.data.ResponseCode !== 0) {
      console.error(`[CampaignAccess] Cardcom error | code=${cardcomRes.data.ResponseCode} desc=${cardcomRes.data.Description}`);
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }

    const paymentUrl   = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;
    console.log(`[CampaignAccess] iframe created | lowProfileId=${lowProfileId}`);

    if (lowProfileId) {
      await db.collection("pending_campaign_payments").insertOne({
        lowProfileId, phone, campaignType, productName,
        amount: CAMPAIGN_PRICE, amountWithVat,
        source: "mobile_personal", createdAt: new Date(),
      });
    }

    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[CampaignAccess] create-payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/client/campaign-access/verify-payment ─────────────────
   body: { phone, campaignType, lowProfileId }
   מוודא תשלום מול Cardcom, שומר גישה ושולח webhook.
*/
exports.verifyCampaignAccessPayment = async (req, res) => {
  try {
    const { phone, campaignType, lowProfileId } = req.body;
    console.log(`[CampaignAccess] verify-payment | phone=${phone} campaignType=${campaignType} lowProfileId=${lowProfileId}`);

    if (!phone || !campaignType || !lowProfileId) return res.status(400).json({ error: "חסרים שדות" });

    const db = getDB();

    const existing = await db.collection("purchase_transactions").findOne({ lowProfileId });
    if (existing) {
      console.log(`[CampaignAccess] already processed | lowProfileId=${lowProfileId}`);
      return res.json({ success: true, alreadyProcessed: true });
    }

    const verifyRes = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      {
        TerminalNumber: cardcomConfig.terminal,
        ApiName:        cardcomConfig.apiName,
        ApiPassword:    cardcomConfig.apiPassword,
        LowProfileId:   lowProfileId,
      },
    );

    const data = verifyRes.data;
    console.log(`[CampaignAccess] Cardcom verify response | ResponseCode=${data?.ResponseCode} desc=${data?.Description}`);

    if (!data || data.ResponseCode !== 0) {
      return res.json({ success: false, message: data?.Description || "התשלום לא אושר" });
    }

    const fieldName   = campaignType === "web_cmp" ? "webCmpAccess" : "leadCmpAccess";
    const productName = campaignType === "web_cmp" ? "גישה לקמפיין לאתר" : "גישה לקמפיין לידים";
    const txnInfo     = data.TranzactionInfo;
    const tokenInfo   = data.TokenInfo;

    const accessProduct = await db.collection("cpanel_products").findOne({ key: campaignType });
    const campaignPrice = accessProduct?.unitPrice || accessProduct?.price || 0;

    await db.collection("users").updateOne(
      { phone },
      { $set: { [fieldName]: { purchased: true, purchasedAt: new Date() } } }
    );
    console.log(`[CampaignAccess] ✅ access granted | phone=${phone} field=${fieldName}`);

    await db.collection("purchase_transactions").insertOne({
      lowProfileId, phone, campaignType, productName,
      amount: campaignPrice, source: "mobile_personal", createdAt: new Date(),
    });

    sendPurchaseWebhook({
      event:     "purchase_success",
      source:    "mobile_personal",
      timestamp: new Date().toISOString(),
      client:    { phone, name: null, businessName: null },
      manager:   { id: null, name: null, email: null, phone: null },
      package:   { name: productName, kind: "personal", amount: campaignPrice, coinsGranted: 0, items: {} },
      payment:   {
        lowProfileId,
        last4:   txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || ""),
        expDate: tokenInfo ? String(tokenInfo.CardMonth).padStart(2, "0") + String(tokenInfo.CardYear).slice(-2) : "",
      },
    }).catch(() => {});

    res.json({ success: true, productName });
  } catch (err) {
    console.error("[ClientProjects] verifyCampaignAccessPayment:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/client/social-access/create-payment ───────────────────
   body: { phone }
   יוצר דף תשלום Cardcom לרכישת גישה לסושיאל (1,000 ₪).
*/
exports.createSocialAccessPayment = async (req, res) => {
  try {
    const phone   = (req.body.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const db      = getDB();
    const baseUrl = requiredEnv("SERVER_BASE_URL");

    const [user, accessProduct] = await Promise.all([
      db.collection("users").findOne({ phone }, { projection: { name: 1 } }),
      db.collection("cpanel_products").findOne({ key: "social_access" }),
    ]);

    const PRICE         = accessProduct?.unitPrice || accessProduct?.price || 1000;
    const clientName    = user?.name || phone;
    const productName   = "גישה לסושיאל";
    const amountWithVat = withVAT(PRICE);

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, {
      TerminalNumber:     cardcomConfig.terminal,
      ApiName:            cardcomConfig.apiName,
      ApiPassword:        cardcomConfig.apiPassword,
      Amount:             amountWithVat,
      ISOCoinId:          1,
      ProductName:        productName,
      SuccessRedirectUrl: `${cardcomConfig.successURL}?type=social_access`,
      ErrorRedirectUrl:   `${cardcomConfig.errorURL}?type=social_access`,
      NotifyURL:          `${baseUrl}/api/client/social-access/notify?phone=${encodeURIComponent(phone)}`,
      ReturnValue:        `${phone}|social_access`,
      CreateInvoice:      false,
      IsCreateToken:      false,
      Operation:          1,
      IsApplePay:         true,
      IsBit:              true,
      IsGooglePay:        true,
      CustomerName:       clientName,
      PhoneNumber:        phone,
    });

    if (cardcomRes.data.ResponseCode !== 0) {
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }

    const paymentUrl   = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;

    if (lowProfileId) {
      await db.collection("pending_campaign_payments").insertOne({
        lowProfileId, phone, campaignType: "social_access", productName,
        amount: PRICE, amountWithVat, source: "mobile_personal", createdAt: new Date(),
      });
    }

    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[SocialAccess] create-payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/client/social-access/verify-payment ───────────────────
   body: { phone, lowProfileId }
   מוודא תשלום מול Cardcom ומעניק גישה לסושיאל.
*/
exports.verifySocialAccessPayment = async (req, res) => {
  try {
    const { phone, lowProfileId } = req.body;
    if (!phone || !lowProfileId) return res.status(400).json({ error: "חסרים שדות" });

    const db = getDB();

    const existing = await db.collection("purchase_transactions").findOne({ lowProfileId });
    if (existing) return res.json({ success: true, alreadyProcessed: true });

    const verifyRes = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      {
        TerminalNumber: cardcomConfig.terminal,
        ApiName:        cardcomConfig.apiName,
        ApiPassword:    cardcomConfig.apiPassword,
        LowProfileId:   lowProfileId,
      },
    );

    const data = verifyRes.data;
    if (!data || data.ResponseCode !== 0) {
      return res.json({ success: false, message: data?.Description || "התשלום לא אושר" });
    }

    const txnInfo     = data.TranzactionInfo;
    const tokenInfo   = data.TokenInfo;
    const productName = "גישה לסושיאל";

    await db.collection("users").updateOne(
      { phone },
      { $set: { socialAccess: { purchased: true, purchasedAt: new Date() } } }
    );

    await db.collection("purchase_transactions").insertOne({
      lowProfileId, phone, campaignType: "social_access", productName,
      amount: 1, source: "mobile_personal", createdAt: new Date(),
    });

    sendPurchaseWebhook({
      event:     "purchase_success",
      source:    "mobile_personal",
      timestamp: new Date().toISOString(),
      client:    { phone, name: null, businessName: null },
      manager:   { id: null, name: null, email: null, phone: null },
      package:   { name: productName, kind: "personal", amount: 1, coinsGranted: 0, items: {} },
      payment:   {
        lowProfileId,
        last4:   txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || ""),
        expDate: tokenInfo ? String(tokenInfo.CardMonth).padStart(2, "0") + String(tokenInfo.CardYear).slice(-2) : "",
      },
    }).catch(() => {});

    res.json({ success: true, productName });
  } catch (err) {
    console.error("[SocialAccess] verify-payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/client/permissions?phone=xxx ────────────────────────────
   Returns a flat feature-flag map for the given phone.
   Used by the mobile app at startup to gate feature visibility.
   No auth — phone is the identifier (same pattern as all client endpoints).

   Every access flag is true for everyone unless ACCESS_GATES_ENABLED=true,
   which restores the paid gates described below.

   Response:
   {
     hasPersonalPackage: bool,   // has an un-purchased personal package waiting
     hasSocialAccess: bool,      // socialAccess.purchased, or a package with social_ad/organicAds > 0
     hasAdsAccess: bool,         // any purchased package with ads > 0
     hasOrganicAccess: bool,     // any purchased package with organicAds > 0
     hasLpAccess: bool,          // any purchased package with lp > 0
     hasWebCmpAccess: bool,      // webCmpAccess.purchased, or a package with campaign_traffic > 0
     hasLeadCmpAccess: bool,     // leadCmpAccess.purchased, or a package with campaign_leads > 0
   }
*/
exports.getPermissions = async (req, res) => {
  try {
    const phone = (req.query.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const db = getDB();

    // hasPersonalPackage is not an access gate — it flags a package awaiting
    // purchase, so it keeps reporting real state even when the areas are open.
    if (!accessGatesEnabled()) {
      const personalPkg = await db.collection("personal_packages").findOne({ phone, active: true, purchased: false });
      return res.json({
        hasPersonalPackage: !!personalPkg,
        subscriptionActive: true,
        hasSocialAccess:    true,
        hasAdsAccess:       true,
        hasOrganicAccess:   true,
        hasLpAccess:        true,
        hasWebCmpAccess:    true,
        hasLeadCmpAccess:   true,
      });
    }

    /* New pricing model: full app access is granted by an ACTIVE subscription
       (any tier — REGULAR/PRO/VIP — or a legacy webinar sub). No active sub →
       every gate is false, which puts the client in VIEW-ONLY mode (they can
       browse campaigns but every "create" action is blocked). The per-action
       coin quota (hidden from the client) caps usage within an active sub. */
    const { hasActiveSubscription } = require("../services/tier-subscription.service");
    const [active, personalPkg] = await Promise.all([
      hasActiveSubscription(phone),
      db.collection("personal_packages").findOne({ phone, active: true, purchased: false }),
    ]);

    res.json({
      hasPersonalPackage: !!personalPkg,
      subscriptionActive: active,
      hasSocialAccess:   active,
      hasAdsAccess:      active,
      hasOrganicAccess:  active,
      hasLpAccess:       active,
      hasWebCmpAccess:   active,
      hasLeadCmpAccess:  active,
    });
  } catch (err) {
    console.error("[ClientProjects] getPermissions:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};
