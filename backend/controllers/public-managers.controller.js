/**
 * public-managers.controller — mobile-facing endpoints for the
 * choose-your-manager onboarding flow.
 *
 *   GET  /api/public/managers           — list of pickable managers
 *   POST /api/public/managers/:id/choose — client picks a manager
 *
 * No auth. The mobile app hits these BEFORE the client has any account
 * mapping — that's the whole point. Responses expose only fields safe
 * to show to the public (no email, no password, no token, no team
 * details that the company considers internal).
 */
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const wowNotify = require("../services/wow-manager-notify.service");
const ratingsSvc = require("../services/manager-ratings.service");

/* The bucket is private; the direct b2_download_file_by_id URL returns
   401 to an unauth'd browser/<img>. Old agent rows still carry that
   broken URL — return null for them so the mobile UI shows the initial
   placeholder until the admin re-uploads via the proxy-aware flow. */
function safeAvatarUrl(url) {
  if (typeof url !== "string" || !url) return null;
  if (url.includes("b2api/v2/b2_download_file_by_id")) return null;
  return url;
}

/* Match an agent _id whether it's stored as string or ObjectId. */
function agentIdFilter(id) {
  const s = String(id);
  const filters = [{ _id: s }];
  try {
    if (ObjectId.isValid(s) && s.length === 24) filters.push({ _id: new ObjectId(s) });
  } catch (_e) { /* ignore */ }
  return filters.length === 1 ? filters[0] : { $or: filters };
}

/* GET /api/public/managers
   Returns every active account_manager. Rating fields are placeholders
   for the upcoming step 5 (real ratings); they're already in the
   payload so the mobile app can render the star UI from day one. */
exports.listPublicManagers = async (_req, res) => {
  try {
    const db = getDB();
    const agents = await db.collection("agents")
      .find(
        { role: "account_manager", active: { $ne: false } },
        { projection: { name: 1, nickname: 1, avatarUrl: 1, bio: 1, station: 1, team: 1 } },
      )
      .sort({ nickname: 1, name: 1 })
      .toArray();

    const ids = agents.map(a => String(a._id));
    const [counts, ratings] = await Promise.all([
      db.collection("cpanel_clients").aggregate([
        { $match: { agentId: { $in: ids } } },
        { $group: { _id: "$agentId", count: { $sum: 1 } } },
      ]).toArray(),
      ratingsSvc.statsForManagers(ids),
    ]);
    const countByAgent = new Map(counts.map(c => [String(c._id), c.count]));

    res.json({
      managers: agents.map(a => {
        const id = String(a._id);
        const r = ratings.get(id);
        return {
          id,
          name:         a.nickname || a.name || null,
          avatarUrl:    safeAvatarUrl(a.avatarUrl),
          bio:          a.bio || null,
          clientCount:  countByAgent.get(id) || 0,
          rating:       r ? r.avg   : null,
          ratingCount:  r ? r.count : 0,
        };
      }),
      total: agents.length,
    });
  } catch (err) {
    console.error("[public-managers] listPublicManagers:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* POST /api/public/managers/:id/choose
   Body: { phone: string }

   Creates the cpanel_clients mapping that ties this client to the
   chosen manager. Idempotent — if the client already chose someone
   (this manager or a different one), we re-point the mapping to the
   newly-chosen manager. Same atomicity discipline as the claim
   endpoint: wipe rows for this phone, write one fresh row.

   On success, emits a socket event to the manager's room so the
   c-panel can show a real-time "לקוח חדש בחר בך" popup. */
exports.chooseManager = async (req, res) => {
  try {
    const db  = getDB();
    const id  = String(req.params.id || "").trim();
    const phone = String(req.body?.phone || "").trim();
    if (!id)    return res.status(400).json({ error: "manager id required" });
    if (!phone) return res.status(400).json({ error: "phone required" });
    /* Minimal phone hygiene — reject obvious junk. We don't enforce
       country code here since the rest of the system accepts both
       "05XXXXXXXX" and "972XXXXXXXXX". */
    if (!/\d{6,}/.test(phone)) return res.status(400).json({ error: "phone must contain digits" });

    const agent = await db.collection("agents").findOne(
      agentIdFilter(id),
      { projection: { name: 1, nickname: 1, role: 1, active: 1, avatarUrl: 1 } },
    );
    if (!agent)                       return res.status(404).json({ error: "manager not found" });
    if (agent.active === false)       return res.status(403).json({ error: "manager is inactive" });
    if (agent.role !== "account_manager") {
      return res.status(403).json({ error: "agent is not an account manager" });
    }
    const newAgentId   = String(agent._id);
    const newAgentName = (agent.nickname || agent.name || "").replace(/"/g, "");

    /* Preserve any existing fireberry linkage we already had for this
       phone, then collapse all rows into a single one owned by the
       newly-chosen manager. */
    const existing = await db.collection("cpanel_clients")
      .find({ phone })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    const customerName   = existing?.customerName   || phone;
    const firebery1013Id = existing?.firebery1013Id || null;
    const customerId     = existing?.customerId     || null;
    const previousAgentId = existing?.agentId || null;

    await db.collection("cpanel_clients").deleteMany({ phone });
    await db.collection("cpanel_clients").insertOne({
      agentId:        newAgentId,
      agentName:      newAgentName,
      phone,
      customerName,
      firebery1013Id,
      customerId,
      createdAt:      new Date(),
      choseAt:        new Date(),
      choseSource:    "mobile_choose_manager",
      transferredFrom: previousAgentId,
    });

    /* Sync the accountManagerId on the support_chats document so that
       socket routing (am_<agentId> rooms) and any chat-level filter
       that reads accountManagerId stay consistent with cpanel_clients. */
    await db.collection("support_chats").updateOne(
      { phone },
      { $set: {
          accountManagerId:   newAgentId,
          accountManagerName: newAgentName,
      }},
    );

    /* Fetch a user-doc snapshot to enrich the popup if available. */
    let businessName = null;
    try {
      const profile = await db.collection("business_profiles").findOne(
        { phone },
        { projection: { businessName: 1 } },
      );
      businessName = profile?.businessName || null;
    } catch (_e) { /* not fatal */ }

    /* Real-time popup: tell the chosen manager they were picked.
       Uses the same socket plumbing as the existing manager
       notifications (room `am_<agentId>`). Sync call but internally
       fire-and-forget — never throws. */
    wowNotify.notifyManagerOfClientChose({
      managerAgentId: newAgentId,
      clientPhone:    phone,
      businessName,
    });

    console.log(`[public-managers] choose ${phone} → ${newAgentName} (agentId ${newAgentId})${previousAgentId ? ` (was ${previousAgentId})` : ""}`);

    res.json({
      success:   true,
      phone,
      managerId: newAgentId,
      managerName: newAgentName,
      avatarUrl: safeAvatarUrl(agent.avatarUrl),
    });
  } catch (err) {
    console.error("[public-managers] chooseManager:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /api/public/my-manager?phone=05XXXXXXXX
   Returns the manager assigned to this phone, with the same public-
   safe fields used by the picker — so the mobile app can render the
   exact same card on a "your manager" home-screen widget. Returns
   { manager: null } when there's no assignment yet (lets the client
   know to open the choose-manager flow). */
exports.getMyManager = async (req, res) => {
  try {
    const phone = String(req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });

    const db = getDB();
    const mapping = await db.collection("cpanel_clients").findOne(
      { phone },
      { projection: { agentId: 1, createdAt: 1, choseAt: 1 } },
    );
    if (!mapping?.agentId) return res.json({ manager: null });

    // Check whether this client has purchased a website product (lp / katlog_web / sale_site)
    let hasWebsiteProduct = false;
    try {
      const user = await db.collection("users").findOne(
        { phone },
        { projection: { activePackage: 1, purchasedPackages: 1 } },
      );
      const checkItems = (items) =>
        ["lp", "katlog_web", "sale_site"].some(k => Number(items?.[k] ?? 0) > 0);
      if (checkItems(user?.activePackage?.items)) {
        hasWebsiteProduct = true;
      } else {
        hasWebsiteProduct = (user?.purchasedPackages ?? []).some(pkg => checkItems(pkg.items));
      }
    } catch (_e) { /* non-fatal — default false */ }

    const agent = await db.collection("agents").findOne(
      agentIdFilter(mapping.agentId),
      { projection: { name: 1, nickname: 1, avatarUrl: 1, bio: 1, phone: 1, role: 1, active: 1 } },
    );
    /* If the assigned agent is inactive or no longer a manager, treat
       as unassigned — the client should be prompted to re-pick. */
    if (!agent || agent.active === false || agent.role !== "account_manager") {
      return res.json({ manager: null });
    }

    const stats = await ratingsSvc.statsForManagers([String(agent._id)]);
    const r = stats.get(String(agent._id));

    /* Also fetch THIS client's own rating (if any) so the mobile app
       can render either "Rate your manager" or "Your rating: ★★★★☆"
       without a second round-trip. */
    let myRating = null;
    try {
      const rating = await db.collection("manager_ratings").findOne(
        { managerAgentId: String(agent._id), clientPhone: phone },
        { projection: { stars: 1, comment: 1, updatedAt: 1 } },
      );
      if (rating) {
        myRating = {
          stars:     rating.stars,
          comment:   rating.comment || null,
          updatedAt: rating.updatedAt || null,
        };
      }
    } catch (_e) { /* non-fatal */ }

    res.json({
      manager: {
        id:           String(agent._id),
        name:         agent.nickname || agent.name || null,
        avatarUrl:    safeAvatarUrl(agent.avatarUrl),
        bio:          agent.bio || null,
        /* Contact phone so the client can tap-to-call or open WhatsApp.
           This is the MANAGER's phone, not the client's. */
        phone:        agent.phone || null,
        rating:       r ? r.avg   : null,
        ratingCount:  r ? r.count : 0,
        assignedAt:   mapping.choseAt || mapping.createdAt || null,
      },
      myRating,
      hasWebsiteProduct,
    });
  } catch (err) {
    console.error("[public-managers] getMyManager:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /api/public/user-type?phone=XXXXXXXX
   Returns the client type so the mobile app can decide whether to
   show the choose-manager screen on first login:
     { type: "managed",  managerId: "..." }  — already in cpanel_clients
     { type: "legacy"  }                     — old user, no manager needed
     { type: "new"     }                     — brand-new client, must pick
*/
exports.getUserType = async (req, res) => {
  try {
    const phone = String(req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });

    const db = getDB();

    const mapping = await db.collection("cpanel_clients").findOne(
      { phone },
      { projection: { agentId: 1 } },
    );
    if (mapping?.agentId) {
      return res.json({ type: "managed", managerId: String(mapping.agentId) });
    }

    const user = await db.collection("users").findOne(
      { phone },
      { projection: { isLegacy: 1 } },
    );
    if (user?.isLegacy) {
      return res.json({ type: "legacy" });
    }

    return res.json({ type: "new" });
  } catch (err) {
    console.error("[public-managers] getUserType:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* POST /api/public/managers/:id/rate
   Body: { phone, stars (1..5), comment? }

   Authorization rule: the calling client must be the manager's actual
   client — i.e. cpanel_clients has a row with { phone, agentId: id }.
   Without this check anyone could spam ratings for any manager. We
   intentionally accept the phone in the body (no token) since the
   mobile flow is pre-auth, but cross-reference against the
   cpanel_clients mapping which is the canonical assignment record. */
exports.rateManager = async (req, res) => {
  try {
    const db = getDB();
    const id     = String(req.params.id || "").trim();
    const phone  = String(req.body?.phone || "").trim();
    const stars  = req.body?.stars;
    const comment = typeof req.body?.comment === "string" ? req.body.comment : null;

    if (!id)    return res.status(400).json({ error: "manager id required" });
    if (!phone) return res.status(400).json({ error: "phone required" });

    /* Validate the rater actually has a relationship with this
       manager. Without it ratings would be wide open to spam. */
    const mapping = await db.collection("cpanel_clients").findOne(
      { phone, agentId: id },
      { projection: { _id: 1 } },
    );
    if (!mapping) {
      return res.status(403).json({
        error: "not_your_manager",
        message: "ניתן לדרג רק את המנהל המשויך אליך",
      });
    }

    let doc;
    try {
      ({ doc } = await ratingsSvc.rate({
        managerAgentId: id,
        clientPhone:    phone,
        stars,
        comment,
      }));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    /* Recompute aggregate so the response carries the up-to-date avg
       (mobile UI uses it immediately for the new rating overlay). */
    const stats = await ratingsSvc.statsForManagers([id]);
    const s = stats.get(String(id)) || { avg: null, count: 0 };

    console.log(`[public-managers] rate ${phone} → ${id}: ${doc?.stars}★${comment ? ` "${comment.slice(0, 40)}…"` : ""}`);

    res.json({
      success:     true,
      managerId:   id,
      stars:       doc?.stars ?? null,
      comment:     doc?.comment ?? null,
      avg:         s.avg,
      ratingCount: s.count,
    });
  } catch (err) {
    console.error("[public-managers] rateManager:", err.message);
    res.status(500).json({ error: err.message });
  }
};
