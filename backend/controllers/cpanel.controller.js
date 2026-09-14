const axios = require("axios");
const multer = require("multer");
const { getDB, DB } = require("../config/db");
const cardcomConfig = require("../config/cardcom.config");
const { withVAT }   = require("../services/cardcom.service");
const commissionSvc = require("../services/commission.service");
const productsSvc   = require("../services/cpanel-products.service");
commissionSvc.ensureIndexes().catch(err => console.warn("[commission] index:", err.message));
/* productsSvc.seedDefaults() runs from server.js boot after connectDB(). */
const { broadcast } = require("../utils/broadcast");
const { isPhoneOnline } = require("../socketManager");
const { sendPurchaseWebhook } = require("../utils/purchase-webhook");
const { createReceipt } = require("../utils/create-receipt");
const { billingEnabled } = require("../utils/billing");
const { getLatestSessionForPhone: getWowAdsSession } = require("../services/wow-ads.service");
const backblazeSvc = require("../services/backblaze.service");
const { canonicalizeProfileImages } = require("../utils/profileImages");


const agentsCol = () => getDB().collection("agents");
const chatsCol  = () => getDB().collection("support_chats");
const usersCol  = () => getDB().collection("users");
const profilesCol = () => getDB().collection("business_profiles");
const cpanelClientsCol = () => getDB().collection("cpanel_clients");

const FB_GRAPH = "https://graph.facebook.com/v21.0";

// ── Auth middleware ──────────────────────────────────────────────
exports.authMiddleware = async (req, res, next) => {
  try {
    // Support ?token= query param for EventSource / SSE (EventSource can't set headers)
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : (req.query?.token ?? null);

    if (token) {
      const agent = await agentsCol().findOne({ token });
      if (!agent) return res.status(401).json({ error: "Invalid token" });
      if (agent.active === false) return res.status(403).json({ error: "Account inactive" });
      req.agent = agent;
      return next();
    }

    return res.status(401).json({ error: "Token required" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Per-client ownership gate.
 *
 * Until this middleware existed, any logged-in account manager could type
 * another manager's client phone into the URL and operate on that client.
 * That's a leak: managers should only see/touch their own book of business.
 *
 * Rules:
 *   • role === "admin"           → always allowed (full visibility)
 *   • role === "account_manager" → only if cpanel_clients has a row mapping
 *                                  this phone to this agent's _id.
 *
 * On denial we return 403 with a stable `error: "not_your_client"` code and
 * a Hebrew message + the assigned manager's name (when we can resolve it),
 * so the cpanel can render a clear "בטיפול מנהל אחר" popup instead of a
 * generic error.
 *
 * Mounted with `router.use("/clients/:phone", requireClientAccess)` so it
 * fires on every nested `/clients/:phone/...` route. The bare `/clients`
 * listing is unaffected (still scoped per-agent inside getClients).
 */
exports.requireClientAccess = async (req, res, next) => {
  try {
    if (!req.agent) return res.status(401).json({ error: "Not authenticated" });
    if (req.agent.role === "admin") return next();

    const phone = String(req.params.phone || "").trim();
    if (!phone) return next();   // safety: no phone param → nothing to gate

    /* The middleware is mounted on `/clients/:phone`, which Express also
       matches against `POST /clients/add` — capturing `phone = "add"` and
       erroneously gating the add-client flow. Skip any param value that
       doesn't look like a phone number (must contain at least 6 digits).
       This covers /clients/add and any future reserved sub-paths. */
    if (!/\d{6,}/.test(phone)) return next();

    /* The claim endpoint is the one and only ownership-changing operation
       — by definition the caller is NOT the current owner, so gating
       claim by current ownership would make it unreachable. Authentication
       still applies (handled above) — any logged-in manager can claim. */
    if (req.path === "/claim" || req.path.endsWith("/claim")) return next();

    const mapping = await cpanelClientsCol().findOne(
      { phone, agentId: String(req.agent._id) },
      { projection: { _id: 1 } },
    );
    if (mapping) return next();

    /* Owned by another manager (or not assigned yet) — surface who, so the
       cpanel popup can say "בטיפול: סנדי" instead of a vague rejection. */
    let assignedManagerName = null;
    try {
      const otherMapping = await cpanelClientsCol().findOne({ phone }, { projection: { agentId: 1 } });
      if (otherMapping?.agentId) {
        const otherAgent = await agentsCol().findOne(
          { _id: otherMapping.agentId },
          { projection: { name: 1, nickname: 1 } },
        );
        assignedManagerName = otherAgent?.nickname || otherAgent?.name || null;
      }
    } catch (_e) { /* best-effort — denial still fires without the name */ }

    return res.status(403).json({
      error: "not_your_client",
      message: assignedManagerName
        ? `הלקוח בטיפול ${assignedManagerName} — אין לך אישור גישה`
        : "הלקוח בטיפול מנהל אחר — אין לך אישור גישה",
      assignedManagerName,
    });
  } catch (err) {
    console.error("[cpanel] requireClientAccess:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Get all clients linked to this agent (via MongoDB cpanel_clients) ─
exports.getClients = async (req, res) => {
  try {
    const { search } = req.query;
    const agentId = String(req.agent._id);

    const rows = await cpanelClientsCol()
      .find({ agentId })
      .sort({ createdAt: -1 })
      .toArray();

    const phones = rows.map(r => r.phone).filter(Boolean);

    const [chatsData, usersData, profilesData] = await Promise.all([
      phones.length ? chatsCol().find({ phone: { $in: phones } }, { projection: { phone: 1, fireberyName: 1, fireberyLogoUrl: 1, status: 1, updated_at: 1 } }).toArray() : [],
      phones.length ? usersCol().find({ phone: { $in: phones } }, { projection: { phone: 1, paymentToken: 1, paymentLast4: 1 } }).toArray() : [],
      phones.length ? profilesCol().find({ phone: { $in: phones } }, { projection: { phone: 1, businessName: 1, logoUrl: 1 } }).toArray() : [],
    ]);
    const chatMap = Object.fromEntries(chatsData.map(c => [c.phone, c]));
    const userMap = Object.fromEntries(usersData.map(u => [u.phone, u]));
    const profileMap = Object.fromEntries(profilesData.map(p => [p.phone, p]));

    /* cpanel_clients IS the canonical owner of this client — every row
       here belongs to req.agent by construction (the .find query above
       filtered by agentId). Surface that as accountManagerId/Name so the
       "ללא מנהל" filter and the "מנהל" column in ClientListPage stop
       lying. We prefer the row's own agentName but fall back to the
       current agent's display name if it isn't denormalized on the row. */
    const callerDisplayName = req.agent.nickname || req.agent.name || null;
    let clients = rows.map(r => {
      const phone = r.phone;
      const chat = chatMap[phone];
      const user = userMap[phone];
      const profile = profileMap[phone];
      return {
        id: r.firebery1013Id || phone,
        name: chat?.fireberyName || profile?.businessName || r.customerName || phone,
        phone,
        logoUrl: chat?.fireberyLogoUrl || profile?.logoUrl || null,
        status: r.status || chat?.status || "open",
        accountManagerId:   r.agentId || String(req.agent._id),
        accountManagerName: r.agentName || callerDisplayName || null,
        lastActive: chat?.updated_at || null,
        hasPaymentToken: !!(user?.paymentToken),
        paymentLast4: user?.paymentLast4 || null,
        tier: r.tier || "REGULAR",
        tierUpdatedAt: r.tierUpdatedAt || null,
      };
    });

    if (search) {
      const s = search.toLowerCase();
      clients = clients.filter(c =>
        c.phone.includes(s) || c.name.toLowerCase().includes(s)
      );
    }

    res.json(clients);
  } catch (err) {
    console.error("[CPanel] getClients:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Get all clients managed by account_manager agents (admin only) ─
exports.getManagedClients = async (req, res) => {
  try {
    if (req.agent.role !== "admin") {
      return res.status(403).json({ error: "admin only" });
    }

    // Return ALL cpanel_clients regardless of the assigned agent's role.
    // Each row already has agentName denormalized — no extra agents lookup needed.
    const rows = await cpanelClientsCol()
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    if (rows.length === 0) return res.json([]);

    const phones = rows.map(r => r.phone).filter(Boolean);

    const [chatsData, usersData, profilesData] = await Promise.all([
      phones.length ? chatsCol().find({ phone: { $in: phones } }, { projection: { phone: 1, fireberyName: 1, fireberyLogoUrl: 1, status: 1, updated_at: 1 } }).toArray() : [],
      phones.length ? usersCol().find({ phone: { $in: phones } }, { projection: { phone: 1, paymentToken: 1, paymentLast4: 1 } }).toArray() : [],
      phones.length ? profilesCol().find({ phone: { $in: phones } }, { projection: { phone: 1, businessName: 1, logoUrl: 1 } }).toArray() : [],
    ]);

    const chatMap    = Object.fromEntries(chatsData.map(c => [c.phone, c]));
    const userMap    = Object.fromEntries(usersData.map(u => [u.phone, u]));
    const profileMap = Object.fromEntries(profilesData.map(p => [p.phone, p]));

    const clients = rows.map(r => {
      const phone   = r.phone;
      const chat    = chatMap[phone];
      const user    = userMap[phone];
      const profile = profileMap[phone];
      return {
        id:                 r.firebery1013Id || phone,
        name:               chat?.fireberyName || profile?.businessName || r.customerName || phone,
        phone,
        logoUrl:            chat?.fireberyLogoUrl || profile?.logoUrl || null,
        status:             chat?.status || "open",
        accountManagerId:   String(r.agentId),
        accountManagerName: r.agentName || null,
        lastActive:         chat?.updated_at || null,
        hasPaymentToken:    !!(user?.paymentToken),
        paymentLast4:       user?.paymentLast4 || null,
        tier:               r.tier || "REGULAR",
        tierUpdatedAt:      r.tierUpdatedAt || null,
      };
    });

    res.json(clients);
  } catch (err) {
    console.error("[CPanel] getManagedClients:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Legacy / unmanaged clients — have chats but no cpanel_clients row ─
exports.getUnmanagedChats = async (req, res) => {
  try {
    // All phones that have a portfolio manager assigned
    const managedRows = await cpanelClientsCol()
      .find({}, { projection: { phone: 1 } })
      .toArray();
    const managedPhones = new Set(managedRows.map(r => r.phone).filter(Boolean));

    // Chats whose phone is NOT in cpanel_clients
    const allChats = await chatsCol()
      .find({}, { projection: { phone: 1, fireberyName: 1, fireberyLogoUrl: 1, status: 1, updated_at: 1, unread: 1 } })
      .sort({ updated_at: -1 })
      .toArray();

    const unmanagedChats = allChats.filter(c => c.phone && !managedPhones.has(c.phone));

    if (unmanagedChats.length === 0) return res.json([]);

    const phones = unmanagedChats.map(c => c.phone);
    const profilesData = await profilesCol()
      .find({ phone: { $in: phones } }, { projection: { phone: 1, businessName: 1, logoUrl: 1 } })
      .toArray();
    const profileMap = Object.fromEntries(profilesData.map(p => [p.phone, p]));

    const clients = unmanagedChats.map(chat => {
      const profile = profileMap[chat.phone];
      return {
        id:          chat.phone,
        name:        chat.fireberyName || profile?.businessName || chat.phone,
        phone:       chat.phone,
        logoUrl:     chat.fireberyLogoUrl || profile?.logoUrl || null,
        status:      chat.status || "open",
        lastActive:  chat.updated_at || null,
        unread:      chat.unread || false,
      };
    });

    res.json(clients);
  } catch (err) {
    console.error("[CPanel] getUnmanagedChats:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Get single client full profile ────────────────────────────────
exports.getClientDetail = async (req, res) => {
  try {
    const { phone } = req.params;

    const [chat, profile, user, cpanelRow] = await Promise.all([
      chatsCol().findOne({ phone }, { projection: { messages: 0 } }),
      profilesCol().findOne({ phone }),
      usersCol().findOne({ phone }, { projection: { paymentToken: 1, paymentLast4: 1, paymentExpiry: 1, ad_account_id: 1, page_id: 1, coins: 1, coinsUsed: 1 } }),
      cpanelClientsCol().findOne({ phone }, { projection: { status: 1, referralLeadId: 1, referredBy: 1, customerName: 1 } }),
    ]);

    const referralStatuses = ["friend_referral", "friend_referral_approved"];
    const referral = cpanelRow?.referralLeadId ? {
      leadId:     cpanelRow.referralLeadId,
      referredBy: cpanelRow.referredBy || null,
      status:     cpanelRow.status || "friend_referral",
    } : null;

    res.json({
      chat: chat ? {
        id: chat._id,
        name: chat.fireberyName || chat.name || cpanelRow?.customerName || "",
        phone: chat.phone || phone,
        status: cpanelRow?.status || chat.status || "open",
        accountManagerId: chat.accountManagerId || null,
        accountManagerName: chat.accountManagerName || null,
        notes: chat.notes || "",
      } : (cpanelRow ? {
        id: cpanelRow._id || phone,
        name: cpanelRow.customerName || phone,
        phone,
        status: cpanelRow.status || "open",
        accountManagerId: cpanelRow.agentId || null,
        accountManagerName: cpanelRow.agentName || null,
        notes: "",
      } : null),
      profile: profile || null,
      payment: {
        hasToken: !!(user?.paymentToken),
        last4: user?.paymentLast4 || null,
        expiry: user?.paymentExpiry || null,
      },
      adAccountId: user?.ad_account_id || null,
      pageId: user?.page_id || null,
      coins:     Number(user?.coins)     || 0,
      coinsUsed: Number(user?.coinsUsed) || 0,
      referral,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /cpanel/clients/:phone/notes
 * Body: { notes: string }
 *
 * Updates the manager-facing notes field on the client's support_chats
 * row. Notes are free-text — anything the manager wants to remember
 * about this client (preferences, history, gotchas, contact prefs, etc).
 *
 * Returns the saved notes so the frontend can confirm the round-trip.
 */
exports.updateClientNotes = async (req, res) => {
  try {
    const phone = String(req.params.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });

    const notes = typeof req.body?.notes === "string" ? req.body.notes : "";
    /* Soft cap to avoid pathological input — 4000 chars is generous
       for a notes field, anything more belongs in a separate doc. */
    if (notes.length > 4000) {
      return res.status(400).json({ error: "notes too long (max 4000 chars)" });
    }

    /* Match by phone — support_chats is keyed by chat _id (often phone)
       but in the proactive case the doc may have a different _id and a
       phone field. Try both. */
    const result = await getDB().collection("support_chats").updateOne(
      { $or: [{ _id: phone }, { phone }] },
      { $set: { notes, updated_at: new Date() } }
    );
    if (result.matchedCount === 0) {
      /* No chat doc exists yet — create a minimal one so notes can be
         saved before the client has messaged. */
      await getDB().collection("support_chats").insertOne({
        _id: phone, phone, notes,
        status: "open",
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    res.json({ success: true, notes });
  } catch (err) {
    console.error("[cpanel] updateClientNotes:", err.message);
    res.status(500).json({ error: err.message });
  }
};

async function saveClientMapping(agentId, agentName, phone, customerName, firebery1013Id, customerId) {
  await cpanelClientsCol().updateOne(
    { agentId, phone },
    { $set: { agentId, agentName, phone, customerName, firebery1013Id, customerId, createdAt: new Date() } },
    { upsert: true },
  );
  await chatsCol().updateOne(
    { phone },
    { $set: { accountManagerId: String(agentId), accountManagerName: agentName || null } },
  );
}

/**
 * POST /cpanel/clients/:phone/claim
 *
 * Transfer a client from their current manager to the caller. Any
 * logged-in manager may claim — this is the explicit "the client
 * called me, I'll take it" workflow off the access-denied screen.
 *
 * Bypasses requireClientAccess (handled in the middleware) since by
 * definition the caller is not yet the owner.
 *
 * Atomicity: cpanel_clients can in principle have several rows per
 * phone (one per agent that ever owned them — saveClientMapping keys
 * on {agentId, phone}). We collapse to a single row owned by the new
 * manager: preserve fireberry IDs from the latest existing row, then
 * delete all rows for this phone and write one fresh row for the
 * caller. That keeps the gate's `findOne({phone, agentId})` lookup
 * deterministic afterward.
 */
exports.claimClient = async (req, res) => {
  try {
    const phone = String(req.params.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });

    const newAgentId   = String(req.agent._id);
    const newAgentName = (req.agent.nickname || req.agent.name || "").replace(/"/g, "");

    /* If the caller already owns this client (shouldn't normally hit
       this code path, but guard anyway), no-op success. */
    const alreadyMine = await cpanelClientsCol().findOne({ phone, agentId: newAgentId }, { projection: { _id: 1 } });
    if (alreadyMine) {
      return res.json({ success: true, alreadyOwned: true });
    }

    /* Capture Fireberry IDs + previous owner from the latest existing
       row so transfer doesn't lose that linkage. */
    const existing = await cpanelClientsCol()
      .find({ phone })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();

    const previousAgentId   = existing?.agentId || null;
    const previousAgentName = existing?.agentName || null;
    const customerName      = existing?.customerName || phone;
    const firebery1013Id    = existing?.firebery1013Id || null;
    const customerId        = existing?.customerId || null;

    /* Wipe ALL existing rows for this phone (any agent) and write one
       fresh row for the new owner. Doing this in two ops is fine — the
       middleware re-runs on every request, so a brief "no owner" gap
       isn't a leak; admins still bypass, and no one else has a matching
       row during that gap. */
    await cpanelClientsCol().deleteMany({ phone });
    await cpanelClientsCol().insertOne({
      agentId:        newAgentId,
      agentName:      newAgentName,
      phone,
      customerName,
      firebery1013Id,
      customerId,
      createdAt:      new Date(),
      transferredAt:  new Date(),
      transferredFrom: previousAgentId,
    });

    await chatsCol().updateOne(
      { phone },
      { $set: { accountManagerId: newAgentId, accountManagerName: newAgentName } },
    );

    console.log(`[CPanel] claim ${phone}: ${previousAgentName || "(unowned)"} → ${newAgentName} (agentId ${previousAgentId || "n/a"} → ${newAgentId})`);

    res.json({
      success: true,
      phone,
      newAgentId,
      newAgentName,
      previousAgentName,
    });
  } catch (err) {
    console.error("[cpanel] claimClient:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Add a client to this agent (MongoDB only) ────────────────────────
// Previously created/claimed a Fireberry "1013" record. Fireberry is gone:
// a client is now just a cpanel_clients mapping + a support_chats owner,
// exactly what webinarRegister writes.
exports.addClient = async (req, res) => {
  try {
    const phone = (req.body.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const agentId   = String(req.agent._id);
    const agentName = (req.agent.nickname || req.agent.name || "").replace(/"/g, "");
    const name      = (req.body.name || "").trim() || phone;

    const existing = await cpanelClientsCol().findOne({ phone }, { projection: { customerName: 1 } });
    const customerName = existing?.customerName || name;

    await cpanelClientsCol().updateOne(
      { agentId, phone },
      {
        $set: { agentId, agentName, phone, customerName, firebery1013Id: null, customerId: null },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    await chatsCol().updateOne(
      { phone },
      {
        $set: { accountManagerId: agentId, accountManagerName: agentName || null },
        $setOnInsert: { phone, name: customerName, status: "open", created_at: new Date() },
      },
      { upsert: true },
    );

    console.log(`[CPanel] addClient ${phone} → ${agentName} (${existing ? "existing" : "new"})`);
    res.json({ success: true, phone, name: customerName, alreadyExisted: !!existing });
  } catch (err) {
    console.error("[CPanel] addClient:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── FB credentials for a client — MongoDB only ──────────────────────
   These used to be read out of Fireberry custom fields. Fireberry is gone,
   so the only source is the client's own `users` document. `page_id` and
   `ad_account_id` are written by updateClientCredentials (the "פרופיל" tab
   picker); `fb_user_token` / `ig_token` are reserved for whatever stores
   the OAuth result next. Until a token lands there userToken stays null,
   which is exactly what every caller already treats as "not connected". */
async function getClientFbCredentials(phone) {
  const empty = { userToken: null, pageId: null, igToken: null, adAccountId: null };
  try {
    const user = await usersCol().findOne(
      { phone },
      { projection: { ad_account_id: 1, page_id: 1, fb_user_token: 1, ig_token: 1 } },
    );
    if (!user) return empty;
    return {
      userToken:   user.fb_user_token || null,
      pageId:      user.page_id       || null,
      igToken:     user.ig_token      || null,
      adAccountId: user.ad_account_id || null,
    };
  } catch (e) {
    console.error(`[CPanel] getClientFbCredentials failed for phone=${phone}: ${e.message}`);
    return empty;
  }
}

/* Exported so the publish-creatives cron can resolve a client's FB
   credentials when an ai_creation_order arrives with empty facebook/
   instagram fields (the C-panel social-schedule path leaves them
   blank — we hydrate at publish time so the tokens are fresh). */
exports.getClientFbCredentials = getClientFbCredentials;
exports.getPageAccessToken     = getPageAccessToken;
exports.resolveAdAccounts      = resolveAdAccounts;

async function getPageAccessToken(userToken, pageId) {
  if (!userToken || !pageId) return null;
  try {
    const { data } = await axios.get(`${FB_GRAPH}/me/accounts`, {
      params: { access_token: userToken, fields: "id,access_token", limit: 50 },
    });
    const page = (data?.data || []).find(p => String(p.id) === String(pageId));
    if (page?.access_token) {
      console.log(`[CPanel] Got page access token for page ${pageId}`);
      return page.access_token;
    }
    console.warn(`[CPanel] Page ${pageId} not found in /me/accounts — using user token`);
    return null;
  } catch (e) {
    console.error(`[CPanel] getPageAccessToken error: ${e.response?.data?.error?.message || e.message}`);
    return null;
  }
}

async function resolveAdAccounts(userToken, adAccountId) {
  if (adAccountId) return [adAccountId.replace(/^act_/, "")];
  // No stored ad account — fetch all ad accounts for this user token
  try {
    const { data } = await axios.get(`${FB_GRAPH}/me/adaccounts`, {
      params: { access_token: userToken, fields: "id", limit: 20 },
    });
    return (data?.data || []).map(a => a.id.replace(/^act_/, ""));
  } catch (e) {
    const fbMsg = e.response?.data?.error?.message || e.message;
    const fbCode = e.response?.data?.error?.code;
    throw new Error(fbCode ? `[FB ${fbCode}] ${fbMsg}` : fbMsg);
  }
}

// ── Get client campaigns from Facebook ────────────────────────────
exports.getClientCampaigns = async (req, res) => {
  try {
    const { phone } = req.params;
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) {
      return res.json({ campaigns: [], error: "FB credentials not available" });
    }

    const adAccounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
    if (!adAccounts.length) return res.json({ campaigns: [], error: "No ad accounts found" });

    const actIdFinal = (creds.adAccountId || adAccounts[0]).replace(/^act_/, "");
    const tokenPreview = creds.userToken ? creds.userToken.slice(0,10)+'...'+creds.userToken.slice(-6) : 'NONE';
    console.log(`[CPanel] getClientCampaigns: act_${actIdFinal} token=${tokenPreview}`);

    // Diagnostic: verify ad account details
    try {
      const { data: accData } = await axios.get(`${FB_GRAPH}/act_${actIdFinal}`, {
        params: { access_token: creds.userToken, fields: "name,account_status,currency,id" },
      });
      console.log(`[CPanel] FB account details: id=${accData.id} name="${accData.name}" status=${accData.account_status} currency=${accData.currency}`);
    } catch (e) {
      console.error(`[CPanel] FB account lookup failed: ${e.response?.data?.error?.message || e.message}`);
    }

    // Fetch campaigns — capture FB errors instead of swallowing them
    let capturedFbError = null;
    const allCampaignsRaw = (await Promise.all(adAccounts.map(async actId => {
      try {
        const { data } = await axios.get(`${FB_GRAPH}/act_${actId}/campaigns`, {
          params: {
            access_token: creds.userToken,
            fields: "id,name,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,objective",
            filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE","PAUSED","DELETED","ARCHIVED","IN_PROCESS","WITH_ISSUES"] }]),
            limit: 50,
          },
        });
        console.log(`[CPanel] FB act_${actId} raw campaigns count: ${(data.data || []).length}`);
        if ((data.data || []).length === 0) console.log(`[CPanel] FB act_${actId} paging:`, JSON.stringify(data.paging));
        return data.data || [];
      } catch (err) {
        const fbMsg = err.response?.data?.error?.message || err.message;
        const fbCode = err.response?.data?.error?.code;
        capturedFbError = fbCode ? `[${fbCode}] ${fbMsg}` : fbMsg;
        console.error(`[CPanel] FB campaigns error act_${actId}: ${capturedFbError}`);
        return [];
      }
    }))).flat();

    if (!allCampaignsRaw.length && capturedFbError) {
      return res.json({ campaigns: [], error: capturedFbError });
    }

    const rawCampaigns = allCampaignsRaw;

    // Fetch insights (spend + leads) AND first ad's creative image — in parallel per campaign
    const campaigns = await Promise.all(rawCampaigns.map(async (c) => {
      let spend = 0;
      let leads = 0;
      let impressions = 0;
      let clicks = 0;
      let imageUrl;

      const [insightResult, adResult] = await Promise.allSettled([
        axios.get(`${FB_GRAPH}/${c.id}/insights`, {
          params: {
            access_token: creds.userToken,
            fields: "spend,actions,impressions,clicks",
            date_preset: "today",
          },
        }),
        /* First active ad → creative.image_url (or thumbnail_url for video ads) */
        axios.get(`${FB_GRAPH}/${c.id}/ads`, {
          params: {
            access_token: creds.userToken,
            fields: "creative{image_url,thumbnail_url,object_story_spec}",
            limit: 1,
          },
        }),
      ]);

      if (insightResult.status === "fulfilled") {
        const insight = insightResult.value.data?.data?.[0];
        if (insight) {
          spend       = parseFloat(insight.spend || 0);
          impressions = parseInt(insight.impressions || 0, 10);
          clicks      = parseInt(insight.clicks || 0, 10);
          const leadAction = insight.actions?.find(a => a.action_type === "lead");
          leads = leadAction ? parseInt(leadAction.value, 10) : 0;
        }
      }

      if (adResult.status === "fulfilled") {
        const firstAd = adResult.value.data?.data?.[0];
        const cr = firstAd?.creative || {};
        imageUrl = cr.image_url || cr.thumbnail_url
                || cr.object_story_spec?.video_data?.image_url
                || cr.object_story_spec?.link_data?.picture
                || undefined;
      }

      const ctr = impressions > 0 ? (clicks / impressions) * 100 : undefined;

      return {
        id: c.id,
        name: c.name,
        status: c.status,
        effectiveStatus: c.effective_status,
        dailyBudget: c.daily_budget ? parseInt(c.daily_budget, 10) / 100 : null,
        spendToday: spend,
        leadsToday: leads,
        objective: c.objective || null,
        imageUrl,
        impressions: impressions || undefined,
        clicks: clicks || undefined,
        ctr,
      };
    }));

    res.json({ campaigns });
  } catch (err) {
    const fbMsg = err.response?.data?.error?.message || err.message;
    const fbCode = err.response?.data?.error?.code;
    const fullMsg = fbCode ? `[FB ${fbCode}] ${fbMsg}` : fbMsg;
    console.error("[CPanel] getClientCampaigns:", fullMsg);
    res.json({ campaigns: [], error: fullMsg });
  }
};

// ── Get client leads summary ────────────────────────────────────────
exports.getClientLeads = async (req, res) => {
  try {
    const { phone } = req.params;
    const { days = "30" } = req.query;
    const numDays = parseInt(days, 10);
    const datePreset = numDays <= 7 ? "last_7d" : numDays <= 14 ? "last_14d" : "last_30d";

    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) {
      return res.json({ total: 0, trend: [], error: "FB credentials not available" });
    }

    const adAccounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
    if (!adAccounts.length) return res.json({ total: 0, trend: [], error: "No ad accounts found" });
    const actId = adAccounts[0];

    // Fetch all campaigns first (campaign-level insights avoid 403 on some accounts)
    let campaignIds = [];
    try {
      const { data: campData } = await axios.get(`${FB_GRAPH}/act_${actId}/campaigns`, {
        params: { access_token: creds.userToken, fields: "id", limit: 50 },
      });
      campaignIds = (campData?.data || []).map(c => c.id);
    } catch (_) {}

    // Per-campaign daily trend — avoids account-level 403
    const trendMap = {};
    let total = 0;

    await Promise.all(campaignIds.map(async cid => {
      try {
        const { data: insRes } = await axios.get(`${FB_GRAPH}/${cid}/insights`, {
          params: {
            access_token: creds.userToken,
            fields: "date_start,actions,spend",
            time_increment: 1,
            date_preset: datePreset,
          },
        });
        for (const d of insRes?.data || []) {
          const leadAct = d.actions?.find(a => a.action_type === "lead");
          const dayLeads = leadAct ? parseInt(leadAct.value, 10) : 0;
          const daySpend = parseFloat(d.spend || 0);
          if (!trendMap[d.date_start]) trendMap[d.date_start] = { date: d.date_start, leads: 0, spend: 0 };
          trendMap[d.date_start].leads += dayLeads;
          trendMap[d.date_start].spend += daySpend;
          total += dayLeads;
        }
      } catch (_) {}
    }));

    const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ total, trend, days: numDays });
  } catch (err) {
    console.error("[CPanel] getClientLeads:", err.message, err.response?.data);
    // 200 with empty payload — frontend renders empty state cleanly instead of crashing
    res.json({ total: 0, trend: [], error: err.response?.data?.error?.message || err.message });
  }
};

// ── Update campaign budget ──────────────────────────────────────────
exports.updateClientBudget = async (req, res) => {
  try {
    const { phone } = req.params;
    const { campaignId, dailyBudgetIls } = req.body;
    if (!campaignId || !dailyBudgetIls) {
      return res.status(400).json({ error: "campaignId and dailyBudgetIls are required" });
    }

    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.status(400).json({ error: "FB credentials not available" });

    const budgetCents = Math.round(parseFloat(dailyBudgetIls) * 100);
    const { data } = await axios.post(
      `${FB_GRAPH}/${campaignId}`,
      null,
      {
        params: {
          access_token: creds.userToken,
          daily_budget: budgetCents,
        },
      },
    );

    res.json({ success: !!data.success, id: data.id });
  } catch (err) {
    console.error("[CPanel] updateClientBudget:", err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

// ── Toggle campaign status ──────────────────────────────────────────
exports.toggleCampaignStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const { campaignId, status } = req.body;
    if (!campaignId || !["ACTIVE", "PAUSED"].includes(status)) {
      return res.status(400).json({ error: "campaignId and status (ACTIVE|PAUSED) required" });
    }

    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.status(400).json({ error: "FB credentials not available" });

    const { data } = await axios.post(
      `${FB_GRAPH}/${campaignId}`,
      null,
      { params: { access_token: creds.userToken, status } },
    );

    res.json({ success: !!data.success });
  } catch (err) {
    console.error("[CPanel] toggleCampaignStatus:", err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

// ── Get ALL campaigns across all of the manager's clients ───────────
exports.getAllCampaigns = async (req, res) => {
  try {
    const agentId = String(req.agent._id);

    /* 1. List the manager's clients */
    const rows = await cpanelClientsCol().find({ agentId }).toArray();
    const phones = rows.map(r => r.phone).filter(Boolean);
    if (!phones.length) return res.json({ campaigns: [] });

    /* 2. Resolve display names from chats + profiles */
    const [chatsData, profilesData] = await Promise.all([
      chatsCol().find({ phone: { $in: phones } }, { projection: { phone: 1, fireberyName: 1 } }).toArray(),
      profilesCol().find({ phone: { $in: phones } }, { projection: { phone: 1, businessName: 1 } }).toArray(),
    ]);
    const chatMap = Object.fromEntries(chatsData.map(c => [c.phone, c]));
    const profileMap = Object.fromEntries(profilesData.map(p => [p.phone, p]));
    const clientNameFor = (phone) => chatMap[phone]?.fireberyName || profileMap[phone]?.businessName || phone;

    /* 3. For each client in parallel: fetch creds → fetch campaigns + insights + first ad image
          Skip clients without FB credentials silently. */
    const perClient = await Promise.allSettled(phones.map(async (phone) => {
      const creds = await getClientFbCredentials(phone);
      if (!creds?.userToken) return { phone, campaigns: [] };

      const adAccounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
      if (!adAccounts.length) return { phone, campaigns: [] };

      const actIdFinal = (creds.adAccountId || adAccounts[0]).replace(/^act_/, "");

      let raw = [];
      try {
        const { data } = await axios.get(`${FB_GRAPH}/act_${actIdFinal}/campaigns`, {
          params: {
            access_token: creds.userToken,
            fields: "id,name,status,effective_status,daily_budget,objective",
            filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE","PAUSED"] }]),
            limit: 50,
          },
        });
        raw = data.data || [];
      } catch (_) { raw = []; }

      const enriched = await Promise.all(raw.map(async (c) => {
        let spend = 0, leads = 0, impressions = 0, clicks = 0, imageUrl;
        const [ins, ad] = await Promise.allSettled([
          axios.get(`${FB_GRAPH}/${c.id}/insights`, {
            params: { access_token: creds.userToken, fields: "spend,actions,impressions,clicks", date_preset: "today" },
          }),
          axios.get(`${FB_GRAPH}/${c.id}/ads`, {
            params: { access_token: creds.userToken, fields: "creative{image_url,thumbnail_url,object_story_spec}", limit: 1 },
          }),
        ]);
        if (ins.status === "fulfilled") {
          const d = ins.value.data?.data?.[0];
          if (d) {
            spend = parseFloat(d.spend || 0);
            impressions = parseInt(d.impressions || 0, 10);
            clicks = parseInt(d.clicks || 0, 10);
            const la = d.actions?.find(a => a.action_type === "lead");
            leads = la ? parseInt(la.value, 10) : 0;
          }
        }
        if (ad.status === "fulfilled") {
          const cr = ad.value.data?.data?.[0]?.creative || {};
          imageUrl = cr.image_url || cr.thumbnail_url
                  || cr.object_story_spec?.video_data?.image_url
                  || cr.object_story_spec?.link_data?.picture
                  || undefined;
        }
        const ctr = impressions > 0 ? (clicks / impressions) * 100 : undefined;

        return {
          id: c.id,
          name: c.name,
          status: c.status,
          effectiveStatus: c.effective_status,
          dailyBudget: c.daily_budget ? parseInt(c.daily_budget, 10) / 100 : null,
          spendToday: spend,
          leadsToday: leads,
          objective: c.objective || null,
          imageUrl,
          impressions: impressions || undefined,
          clicks: clicks || undefined,
          ctr,
          clientPhone: phone,
          clientName: clientNameFor(phone),
        };
      }));

      return { phone, campaigns: enriched };
    }));

    /* 4. Flatten */
    const campaigns = [];
    for (const r of perClient) {
      if (r.status === "fulfilled") campaigns.push(...r.value.campaigns);
    }

    res.json({ campaigns });
  } catch (err) {
    console.error("[CPanel] getAllCampaigns:", err.response?.data?.error?.message || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

// ── Get all ads inside a campaign (with creatives + insights) ──────
/* Short-lived per-campaign cache so a manager refreshing the campaign
   drawer doesn't re-burn FB quota every click. 30s is short enough
   that real changes (newly created ads finishing propagation) still
   show up quickly, and long enough that the modal can be reopened
   freely without hitting Graph again. Keyed by campaignId — phone is
   indirectly bound via the campaign, so no cross-client leak. */
const _campaignAdsCache = new Map();
const CAMPAIGN_ADS_TTL_MS = 30_000;
function _cacheRead(key) {
  const hit = _campaignAdsCache.get(key);
  if (hit && (Date.now() - hit.ts) < CAMPAIGN_ADS_TTL_MS) return hit.payload;
  return null;
}
function _cacheWrite(key, payload) {
  _campaignAdsCache.set(key, { ts: Date.now(), payload });
  /* Light cleanup so the map doesn't grow forever. */
  if (_campaignAdsCache.size > 200) {
    const cutoff = Date.now() - CAMPAIGN_ADS_TTL_MS;
    for (const [k, v] of _campaignAdsCache) {
      if (v.ts < cutoff) _campaignAdsCache.delete(k);
    }
  }
}

exports.getCampaignAds = async (req, res) => {
  try {
    const { phone, campaignId } = req.params;
    const cached = _cacheRead(campaignId);
    if (cached) return res.json(cached);
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.json({ ads: [], error: "FB credentials not available" });

    /* Fetch ads in this campaign with their creative data. Don't let
       a FB hiccup (e.g. a brand-new campaign that hasn't propagated
       yet, or transient 5xx from Graph) blow up the whole modal —
       return an empty ads list with the error message so the UI can
       render the empty state instead of a generic 500. */
    let rawAds = [];
    try {
      const { data: adsData } = await axios.get(`${FB_GRAPH}/${campaignId}/ads`, {
        params: {
          access_token: creds.userToken,
          fields: "id,name,status,effective_status,adset_id,adset{name},creative{id,image_url,thumbnail_url,video_id,title,body,call_to_action_type,object_story_spec}",
          limit: 50,
        },
      });
      rawAds = adsData?.data || [];
    } catch (err) {
      const fbErr = err.response?.data?.error;
      const fbMsg = fbErr?.message || err.message;
      const fbCode = fbErr?.code;
      const fbSubcode = fbErr?.error_subcode;
      console.error(`[CPanel] getCampaignAds /${campaignId}/ads failed: [${fbCode}/${fbSubcode}] ${fbMsg}`);
      /* Rate limit (code 17 / "User request limit reached") gets a
         dedicated message so the manager understands the empty list is
         transient — FB caps per-user requests per app, and our launch
         flow plus refresh polling can push past it. Don't cache rate-
         limit responses (we want a fresh attempt on the next refresh). */
      const isRateLimit = fbCode === 17 || /request limit/i.test(fbMsg);
      const friendly = isRateLimit
        ? "מכסת קריאות פייסבוק חרגה לטוקן של הלקוח. חזור עוד מספר דקות ויהיה זמין."
        : fbMsg;
      return res.json({ ads: [], error: friendly, rateLimited: isRateLimit });
    }

    /* Two insights calls: ad-level today + ad-level maximum (lifetime).
       Adset-level fallback removed — it doubled the FB quota burn for
       very little value (FB attributes most metrics at the ad level
       when ads exist, and freshly-launched campaigns just need a
       minute to propagate). The launch flow already consumes ~3 FB
       requests per approved ad (image upload + creative + ad create),
       so 30+ per 10-ad launch — adding 4 insights calls on top was
       enough to hit FB's per-user rate limit. */
    const fetchInsights = (datePreset) => axios.get(`${FB_GRAPH}/${campaignId}/insights`, {
      params: {
        access_token: creds.userToken,
        fields: "ad_id,impressions,clicks,spend,reach,ctr,cpm,actions",
        level: "ad",
        date_preset: datePreset,
        limit: 500,
      },
    });

    const insAdToday    = new Map();
    const insAdLifetime = new Map();
    const insSetToday   = new Map();  // kept empty — UI still references the maps
    const insSetLifetime= new Map();

    const [adToday, adLife] = await Promise.allSettled([
      fetchInsights("today"),
      fetchInsights("maximum"),
    ]);

    const collect = (settled, map, keyField) => {
      if (settled.status !== "fulfilled") {
        const e = settled.reason?.response?.data?.error;
        console.error(`[CPanel] getCampaignAds insights err: [${e?.code}/${e?.error_subcode}] ${e?.message || settled.reason?.message}`);
        return;
      }
      for (const row of settled.value.data?.data || []) {
        if (row[keyField]) map.set(row[keyField], row);
      }
    };
    collect(adToday, insAdToday,    "ad_id");
    collect(adLife,  insAdLifetime, "ad_id");
    console.log(`[CPanel] getCampaignAds ${campaignId}: ads=${rawAds.length} adToday=${insAdToday.size} adLife=${insAdLifetime.size}`);

    /* Count how many ads belong to each adset so we can split adset-
       level metrics fairly when an ad has no direct insights row. */
    const adsPerAdSet = new Map();
    for (const ad of rawAds) {
      adsPerAdSet.set(ad.adset_id, (adsPerAdSet.get(ad.adset_id) || 0) + 1);
    }

    /* Different campaign types report leads under different action_type
       values: classic Lead Ads → "lead"; website conversions →
       offsite_conversion.fb_pixel_lead; Messenger → onsite_conversion.
       lead_grouped. Sum across all of them. */
    const LEAD_TYPES = new Set([
      "lead",
      "onsite_conversion.lead_grouped",
      "offsite_conversion.fb_pixel_lead",
    ]);
    const sumLeads = actions => (actions || [])
      .filter(a => LEAD_TYPES.has(a.action_type))
      .reduce((s, a) => s + parseInt(a.value || 0, 10), 0);

    /* Walk the fallback chain and return the first source with
       impressions > 0. peers is how to divide AdSet-level numbers
       across ads in the same AdSet so the totals still reconcile. */
    const pickInsight = (ad) => {
      const sources = [
        { row: insAdToday.get(ad.id),            divide: 1 },
        { row: insAdLifetime.get(ad.id),         divide: 1 },
        { row: insSetToday.get(ad.adset_id),     divide: adsPerAdSet.get(ad.adset_id) || 1 },
        { row: insSetLifetime.get(ad.adset_id),  divide: adsPerAdSet.get(ad.adset_id) || 1 },
      ];
      for (const s of sources) {
        if (s.row && parseInt(s.row.impressions || 0, 10) > 0) return s;
      }
      return null;
    };

    const ads = await Promise.all(rawAds.map(async (ad) => {
      let impressions = 0, clicks = 0, spend = 0, reach = 0, leads = 0;
      let ctr = 0, cpm = 0, costPerLead;

      const picked = pickInsight(ad);
      if (picked) {
        const r = picked.row;
        const d = picked.divide;
        impressions = Math.round(parseInt(r.impressions || 0, 10) / d);
        clicks      = Math.round(parseInt(r.clicks || 0, 10) / d);
        spend       = parseFloat(r.spend || 0) / d;
        reach       = Math.round(parseInt(r.reach || 0, 10) / d);
        ctr         = parseFloat(r.ctr || 0);
        cpm         = parseFloat(r.cpm || 0);
        leads       = Math.round(sumLeads(r.actions) / d);
        if (leads > 0 && spend > 0) costPerLead = spend / leads;
      }

      const cr = ad.creative || {};
      const oss = cr.object_story_spec || {};
      const imageUrl = cr.image_url
                    || oss.video_data?.image_url
                    || oss.link_data?.picture
                    || cr.thumbnail_url;
      const videoUrl = cr.video_id ? `https://www.facebook.com/video.php?v=${cr.video_id}` : undefined;
      const title = cr.title || oss.link_data?.name || oss.video_data?.title;
      const body  = cr.body  || oss.link_data?.message || oss.video_data?.message;
      const callToAction = cr.call_to_action_type
                        || oss.link_data?.call_to_action?.type
                        || oss.video_data?.call_to_action?.type;

      return {
        id:              ad.id,
        name:            ad.name,
        status:          ad.status,
        effectiveStatus: ad.effective_status,
        adSetId:         ad.adset_id,
        adSetName:       ad.adset?.name,
        creative: {
          id:           cr.id,
          imageUrl,
          videoUrl,
          thumbnailUrl: cr.thumbnail_url,
          title,
          body,
          callToAction,
        },
        insights: {
          impressions, clicks, spend, ctr, cpm, reach, leads, costPerLead,
        },
      };
    }));

    const payload = { ads };
    _cacheWrite(campaignId, payload);
    res.json(payload);
  } catch (err) {
    console.error("[CPanel] getCampaignAds:", err.response?.data?.error?.message || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

// ── Update an ad — supports status toggle AND text replacement (creates new creative) ──
exports.updateAd = async (req, res) => {
  try {
    const { phone, adId } = req.params;
    const { status, title, body, callToAction } = req.body;
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.status(400).json({ error: "FB credentials not available" });

    /* 1. Status toggle — simple POST */
    if (status && ["ACTIVE", "PAUSED"].includes(status) && title === undefined && body === undefined && callToAction === undefined) {
      const { data } = await axios.post(`${FB_GRAPH}/${adId}`, null, {
        params: { access_token: creds.userToken, status },
      });
      return res.json({ success: !!data.success });
    }

    /* 2. Text replacement — Meta API doesn't allow editing creative text in place.
          We need to: read existing creative → build a new one with updated fields →
          POST /act_{acct}/adcreatives → POST /{ad_id} { creative: { creative_id: NEW_ID } } */
    if (title !== undefined || body !== undefined || callToAction !== undefined) {
      /* a. Resolve ad's account_id + read existing creative */
      const { data: adData } = await axios.get(`${FB_GRAPH}/${adId}`, {
        params: {
          access_token: creds.userToken,
          fields: "account_id,creative{id,object_story_spec,image_hash,image_url,link_url,name,call_to_action_type}",
        },
      });
      const cr  = adData.creative || {};
      const oss = cr.object_story_spec ? JSON.parse(JSON.stringify(cr.object_story_spec)) : null;
      const accountId = adData.account_id;
      if (!accountId) return res.status(400).json({ error: "ad has no account_id" });

      let creativePayload;

      if (oss && oss.link_data) {
        /* Image-link ad — patch link_data fields */
        if (title        !== undefined) oss.link_data.name    = title;
        if (body         !== undefined) oss.link_data.message = body;
        if (callToAction !== undefined) {
          oss.link_data.call_to_action = oss.link_data.call_to_action || {};
          oss.link_data.call_to_action.type = callToAction;
          if (!oss.link_data.call_to_action.value) {
            oss.link_data.call_to_action.value = { link: oss.link_data.link || "https://iconiqmedia.co.il" };
          }
        }
        creativePayload = { object_story_spec: oss };
      } else if (oss && oss.video_data) {
        /* Video ad — patch video_data fields */
        if (title        !== undefined) oss.video_data.title   = title;
        if (body         !== undefined) oss.video_data.message = body;
        if (callToAction !== undefined) {
          oss.video_data.call_to_action = oss.video_data.call_to_action || {};
          oss.video_data.call_to_action.type = callToAction;
        }
        creativePayload = { object_story_spec: oss };
      } else if (cr.image_url || cr.image_hash) {
        /* Legacy creative without object_story_spec — build minimal new one */
        creativePayload = {
          name: cr.name || `Updated ${Date.now()}`,
          image_url: cr.image_url,
          image_hash: cr.image_hash,
          link_url:  cr.link_url || "https://iconiqmedia.co.il",
          message:   body  ?? "",
          title:     title ?? cr.name,
          call_to_action_type: callToAction ?? cr.call_to_action_type,
        };
      } else {
        return res.status(400).json({ error: "creative shape not supported for inline edit — manual update required" });
      }

      /* b. Create new ad creative on the ad account */
      const { data: createRes } = await axios.post(
        `${FB_GRAPH}/act_${String(accountId).replace(/^act_/, "")}/adcreatives`,
        null,
        { params: { access_token: creds.userToken, ...mapToParams(creativePayload) } }
      );
      const newCreativeId = createRes.id;
      if (!newCreativeId) return res.status(500).json({ error: "Meta did not return new creative_id" });

      /* c. Point the ad to the new creative + optionally update status */
      const adUpdateParams = {
        access_token: creds.userToken,
        creative:     JSON.stringify({ creative_id: newCreativeId }),
      };
      if (status && ["ACTIVE", "PAUSED"].includes(status)) adUpdateParams.status = status;

      const { data: updateRes } = await axios.post(`${FB_GRAPH}/${adId}`, null, { params: adUpdateParams });
      return res.json({ success: !!updateRes.success, creativeId: newCreativeId });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[CPanel] updateAd:", err.response?.data?.error?.message || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

/* Convert nested creative payload → flat axios params (Meta expects JSON-stringified object_story_spec) */
function mapToParams(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    out[k] = typeof v === "object" ? JSON.stringify(v) : v;
  }
  return out;
}

// ── Delete an ad (set status DELETED) ───────────────────────────────
exports.deleteAd = async (req, res) => {
  try {
    const { phone, adId } = req.params;
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.status(400).json({ error: "FB credentials not available" });

    const { data } = await axios.delete(`${FB_GRAPH}/${adId}`, {
      params: { access_token: creds.userToken },
    });
    res.json({ success: !!data.success });
  } catch (err) {
    console.error("[CPanel] deleteAd:", err.response?.data?.error?.message || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

/* ── GET /clients/:phone/fb-targeting/search?type=adgeolocation&q=...
   Proxy to Facebook's targeting search API. Returns FB's real keys so
   the autocomplete on the C-panel side can store them with the audience
   spec instead of free text. `type` is one of:
     adgeolocation  → cities / regions / countries (filter on the
                       response's `type` field client-side)
     adinterest     → interests (also returns behaviors & demographics
                       when the model supports it)
     adlocale       → languages
   `q` is the user's typed query. Locale defaults to he_IL. */
exports.searchFbTargeting = async (req, res) => {
  try {
    const { phone } = req.params;
    const type = String(req.query.type || "adgeolocation");
    const q    = String(req.query.q || "").trim();
    if (!q) return res.json([]);
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.status(400).json({ error: "FB credentials not available" });

    const params = {
      access_token: creds.userToken,
      type,
      q,
      locale: "he_IL",
      limit: 25,
    };
    /* adgeolocation supports an extra `location_types` to narrow the
       result set. By default we accept all so cities, regions, and
       countries can show up in the same dropdown. */
    if (type === "adgeolocation") params.location_types = ["city", "region", "country", "subcity", "neighborhood"];

    const { data } = await axios.get(`${FB_GRAPH}/search`, { params });
    res.json(Array.isArray(data?.data) ? data.data : []);
  } catch (err) {
    console.error("[CPanel] searchFbTargeting:", err.response?.data?.error?.message || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

// ── Update an ad set's audience targeting ───────────────────────────
exports.updateAdAudience = async (req, res) => {
  try {
    const { phone, adSetId } = req.params;
    const { ageMin, ageMax, genders, locations, interests, customAudiences, excludedAudiences, placements } = req.body;
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.status(400).json({ error: "FB credentials not available" });

    const targeting = {};
    if (ageMin != null) targeting.age_min = Number(ageMin);
    if (ageMax != null) targeting.age_max = Number(ageMax);
    /* FB expects numeric gender codes: 1=male, 2=female. The frontend
       sends "all" | "male" | "female". "all" or both selected → omit
       (FB defaults to all). */
    if (Array.isArray(genders) && genders.length) {
      const fbGenders = [];
      if (genders.includes("male"))   fbGenders.push(1);
      if (genders.includes("female")) fbGenders.push(2);
      if (fbGenders.length === 1) targeting.genders = fbGenders;
    }
    /* FB geo_locations is split by type: countries[], regions[{key}],
       cities[{key,radius,distance_unit}], custom_locations[{lat,lng,...}].
       `custom_locations` REQUIRES lat/lng/radius — pushing every location
       there blew up with "Invalid parameter" when a plain city like
       Yehud was selected (no coords). Route by type; honor include=false
       by routing into excluded_geo_locations instead. */
    if (Array.isArray(locations) && locations.length) {
      const empty = () => ({ countries: [], regions: [], cities: [] });
      const inc = empty();
      const exc = empty();
      let incHas = false, excHas = false;
      for (const l of locations) {
        if (!l) continue;
        const bucket = l.include === false ? exc : inc;
        if (l.include === false) excHas = true; else incHas = true;
        if (l.type === "country") {
          if (l.key) bucket.countries.push(l.key);
        } else if (l.type === "region") {
          if (l.key) bucket.regions.push({ key: String(l.key) });
        } else if (l.type === "city" || l.type === "address") {
          if (l.key) bucket.cities.push({
            key: String(l.key),
            radius: Number(l.radiusKm) > 0 ? Number(l.radiusKm) : 17,
            distance_unit: "kilometer",
          });
        }
      }
      const compact = b => {
        const out = {};
        if (b.countries.length) out.countries = b.countries;
        if (b.regions.length)   out.regions   = b.regions;
        if (b.cities.length)    out.cities    = b.cities;
        return out;
      };
      if (incHas) targeting.geo_locations          = compact(inc);
      if (excHas) targeting.excluded_geo_locations = compact(exc);
    }
    if (Array.isArray(interests) && interests.length) {
      targeting.interests = interests.filter(i => i.id).map(i => ({ id: i.id, name: i.name }));
    }
    if (Array.isArray(customAudiences) && customAudiences.length) {
      targeting.custom_audiences = customAudiences.map(a => ({ id: a.id }));
    }
    if (Array.isArray(excludedAudiences) && excludedAudiences.length) {
      targeting.excluded_custom_audiences = excludedAudiences.map(a => ({ id: a.id }));
    }
    if (Array.isArray(placements) && placements.length) {
      targeting.publisher_platforms = placements;
    }

    const { data } = await axios.post(`${FB_GRAPH}/${adSetId}`, null, {
      params: { access_token: creds.userToken, targeting: JSON.stringify(targeting) },
    });
    res.json({ success: !!data.success });
  } catch (err) {
    console.error("[CPanel] updateAdAudience:", err.response?.data?.error?.message || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

// ── Update campaign daily budget (cents) ────────────────────────────
exports.updateCampaignBudget = async (req, res) => {
  try {
    const { phone, campaignId } = req.params;
    const { dailyBudget } = req.body;
    if (!dailyBudget) return res.status(400).json({ error: "dailyBudget required (in cents)" });
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.status(400).json({ error: "FB credentials not available" });

    const { data } = await axios.post(`${FB_GRAPH}/${campaignId}`, null, {
      params: { access_token: creds.userToken, daily_budget: Math.round(Number(dailyBudget)) },
    });
    res.json({ success: !!data.success });
  } catch (err) {
    console.error("[CPanel] updateCampaignBudget:", err.response?.data?.error?.message || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
};

// ── Send payment link to client ─────────────────────────────────────
const { requiredEnv } = require("../utils/required-env");

exports.sendPaymentLink = async (req, res) => {
  try {
    const { phone } = req.params;
    const { amount, description = "חיוב - Iconiq Media", currencyCode } = req.body;
    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: "amount is required" });
    }

    const chat = await chatsCol().findOne({ phone }, { projection: { _id: 1, name: 1, fireberyName: 1 } });
    const clientName = chat?.fireberyName || chat?.name || phone;

    const notifyUrl = `${requiredEnv("SERVER_BASE_URL")}/api/cpanel/payment-notify?phone=${phone}`;

    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,
      Amount: withVAT(parseFloat(amount)),
      ISOCoinId: currencyCode ?? 1,
      ProductName: description,
      SuccessRedirectUrl: `${requiredEnv("CLIENT_APP_URL")}/payment-success`,
      ErrorRedirectUrl: `${requiredEnv("CLIENT_APP_URL")}/payment-error`,
      /* Cardcom v11 LowProfile/Create expects WebHookUrl. Sending NotifyURL
         too is a belt-and-braces — older docs / some flows use that name. */
      WebHookUrl: notifyUrl,
      NotifyURL:  notifyUrl,
      ReturnValue: phone,
      IsCreateToken: true,
      Operation: 2,
      CustomerName: clientName,
      PhoneNumber: phone,
    };

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, requestBody);
    if (cardcomRes.data.ResponseCode !== 0) {
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }

    const paymentUrl = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;

    /* Track this payment link so paymentNotify can attribute the commission
       to the manager who initiated it. */
    if (lowProfileId) {
      await getDB().collection("cpanel_pending_purchases").insertOne({
        lowProfileId,
        phone,
        agentId: String(req.agent._id),
        kind: "payment_link",
        amount: parseFloat(amount),
        description,
        createdAt: new Date(),
      });
    }

    // Send payment link to client via socket/chat system
    if (req.app?.get("io") && chat?._id) {
      const io = req.app.get("io");
      const msgObj = {
        _id: Date.now(),
        type: "text",
        text: `לינק לתשלום: ${paymentUrl}`,
        fromRole: "agent",
        user: { _id: req.agent._id, name: req.agent.nickname || req.agent.name },
        createdAt: new Date(),
      };
      broadcast(io, "receive_message", chat._id, msgObj);
      broadcast(io, "receive_message", "support_team", { ...msgObj, userId: chat._id });
    }

    res.json({ success: true, url: paymentUrl });
  } catch (err) {
    console.error("[CPanel] sendPaymentLink:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Send package payment link (ads + landing pages bundle) ──────────
exports.sendPackagePaymentLink = async (req, res) => {
  try {
    const { phone } = req.params;
    const ads        = parseInt(req.body.adsCount,          10) || 0;
    const lps        = parseInt(req.body.landingPagesCount, 10) || 0;
    const videos     = parseInt(req.body.videosCount,       10) || 0;
    const logos      = parseInt(req.body.logosCount,        10) || 0;
    const socialAds  = parseInt(req.body.socialAdsCount,    10) || 0;

    /* Optional overrides — used by prebuilt-package and coin-package buttons. */
    const overrideTotal       = parseFloat(req.body.totalOverride) || 0;
    const overrideDescription = (req.body.descriptionOverride || "").toString().trim();
    const overrideCoins       = parseInt(req.body.coinsOverride, 10);
    const purchaseKind        = req.body.kind === "coins" ? "coins" : "package";
    const currencyCode        = parseInt(req.body.currencyCode, 10) || 1;

    const calcTotal = ads * 100 + lps * 1000 + videos * 500 + logos * 150 + socialAds * 100;
    const total = overrideTotal > 0 ? overrideTotal : calcTotal;
    if (total <= 0) return res.status(400).json({ error: "חבילה ריקה" });

    const organicPosts = Math.floor(ads / 2);
    let description;
    if (overrideDescription) {
      description = overrideDescription;
    } else {
      const parts = [];
      if (ads > 0)       parts.push(`${ads} מודעות`);
      if (lps > 0)       parts.push(`${lps} דף${lps === 1 ? "" : "י"} נחיתה`);
      if (videos > 0)    parts.push(`${videos} סרטונ${videos === 1 ? "" : "ים"}`);
      if (logos > 0)     parts.push(`${logos} לוגו${logos === 1 ? "" : "אים"}`);
      if (socialAds > 0) parts.push(`${socialAds} מודעות סושיאל`);
      parts.push(`${Number.isFinite(overrideCoins) ? overrideCoins : 700} זיטונים`);
      if (organicPosts > 0) parts.push(`${organicPosts} פוסטים אורגניים`);
      description = parts.join(" + ");
    }

    const chat = await chatsCol().findOne({ phone }, { projection: { _id: 1, name: 1, fireberyName: 1 } });
    const clientName = chat?.fireberyName || chat?.name || phone;
    const notifyUrl = `${requiredEnv("SERVER_BASE_URL")}/api/cpanel/payment-notify?phone=${encodeURIComponent(phone)}`;

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,
      Amount: withVAT(total),
      ISOCoinId: currencyCode,
      ProductName: description,
      SuccessRedirectUrl: `${requiredEnv("CLIENT_APP_URL")}/payment-success`,
      ErrorRedirectUrl: `${requiredEnv("CLIENT_APP_URL")}/payment-error`,
      /* Cardcom v11 LowProfile/Create expects WebHookUrl. Sending NotifyURL
         too is a belt-and-braces — older docs / some flows use that name. */
      WebHookUrl: notifyUrl,
      NotifyURL:  notifyUrl,
      ReturnValue: phone,
      IsCreateToken: true,
      Operation: 2,
      CustomerName: clientName,
      PhoneNumber: phone,
    });

    if (cardcomRes.data.ResponseCode !== 0) {
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }

    const paymentUrl = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;

    if (lowProfileId) {
      await getDB().collection("cpanel_pending_purchases").insertOne({
        lowProfileId, phone,
        agentId: String(req.agent._id),
        kind: purchaseKind,
        adsCount: ads, landingPagesCount: lps, videosCount: videos, logosCount: logos, socialAdsCount: socialAds,
        organicPosts, totalAmount: total, amount: total, description,
        coinsOverride: Number.isFinite(overrideCoins) ? overrideCoins : null,
        createdAt: new Date(),
      });
    }

    // Send to chat
    if (req.app?.get("io") && chat?._id) {
      const io = req.app.get("io");
      const msgObj = {
        _id: Date.now(), type: "text",
        text: `לינק תשלום לחבילה (${description}): ${paymentUrl}`,
        fromRole: "agent",
        user: { _id: req.agent._id, name: req.agent.nickname || req.agent.name },
        createdAt: new Date(),
      };
      broadcast(io, "receive_message", chat._id, msgObj);
      broadcast(io, "receive_message", "support_team", { ...msgObj, userId: chat._id });
    }

    // Send SMS (non-fatal)
    try {
      const { sendSMS } = require("../services/sms4free.service");
      await sendSMS(phone, `שלום, הנה לינק תשלום לחבילה שלך (${description}): ${paymentUrl}`);
    } catch (smsErr) {
      console.warn("[CPanel] SMS send failed (non-fatal):", smsErr.message);
    }

    res.json({ success: true, url: paymentUrl });
  } catch (err) {
    console.error("[CPanel] sendPackagePaymentLink:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Payment notify webhook (called by Cardcom after payment) ────────
/* ── POST /api/cpanel/clients/:phone/redeem-social-package ────────────
   Agent/admin redeems a social-kind plan on behalf of the client by
   debiting the client's coin balance (no Cardcom). Body: { packageKey }.
   200 → { success:true, packageName, coinsCharged, coinsRemaining }
   400 → { success:false, reason:"insufficient_coins", coinsRequired, coinsAvailable } */
exports.redeemSocialPackage = async (req, res) => {
  try {
    const { phone } = req.params;
    const { packageKey, brief } = req.body || {};
    const actor = req.agent
      ? { id: String(req.agent._id), name: req.agent.nickname || req.agent.name || "agent" }
      : null;
    const result = await require("../services/social-redeem.service").redeem({
      phone, packageKey, brief, actor, source: "cpanel",
    });
    if (result.success) return res.json(result);
    const status = result.reason === "insufficient_coins" ? 400
                 : result.reason === "package_not_found"  ? 404
                 : result.reason === "user_not_found"     ? 404
                 : 400;
    return res.status(status).json(result);
  } catch (err) {
    console.error("[cpanel] redeemSocialPackage:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.initiatePackageChargeIframe = async (req, res) => {
  try {
    const { phone } = req.params;
    const ads        = parseInt(req.body.adsCount,          10) || 0;
    const lps        = parseInt(req.body.landingPagesCount, 10) || 0;
    const videos     = parseInt(req.body.videosCount,       10) || 0;
    const logos      = parseInt(req.body.logosCount,        10) || 0;
    const socialAds  = parseInt(req.body.socialAdsCount,    10) || 0;

    /* Optional explicit override for prebuilt packages (let client pass total + label). */
    const overrideTotal       = parseFloat(req.body.totalOverride) || 0;
    const overrideDescription = (req.body.descriptionOverride || "").toString().trim();
    const overrideCoins       = parseInt(req.body.coinsOverride, 10);
    const purchaseKind        = req.body.kind === "coins" ? "coins" : "package";
    const currencyCode        = parseInt(req.body.currencyCode, 10) || 1;

    const calcTotal = ads * 100 + lps * 1000 + videos * 500 + logos * 150 + socialAds * 100;
    const total = overrideTotal > 0 ? overrideTotal : calcTotal;
    if (total <= 0) return res.status(400).json({ error: "חבילה ריקה" });

    const organicPosts = Math.floor(ads / 2);
    let description;
    if (overrideDescription) {
      description = overrideDescription;
    } else {
      const parts = [];
      if (ads > 0)       parts.push(`${ads} מודעות`);
      if (lps > 0)       parts.push(`${lps} דף${lps === 1 ? "" : "י"} נחיתה`);
      if (videos > 0)    parts.push(`${videos} סרטונים`);
      if (logos > 0)     parts.push(`${logos} לוגו`);
      if (socialAds > 0) parts.push(`${socialAds} מודעות סושיאל`);
      parts.push(`${Number.isFinite(overrideCoins) ? overrideCoins : 700} זיטונים`);
      if (organicPosts > 0) parts.push(`${organicPosts} פוסטים אורגניים`);
      description = parts.join(" + ");
    }

    const chat = await chatsCol().findOne({ phone }, { projection: { _id: 1, name: 1, fireberyName: 1 } });
    const clientName = chat?.fireberyName || chat?.name || phone;
    const baseUrl = requiredEnv("SERVER_BASE_URL");
    const notifyUrl = `${baseUrl}/api/cpanel/payment-notify?phone=${encodeURIComponent(phone)}`;

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,
      Amount: withVAT(total),
      ISOCoinId: currencyCode,
      ProductName: description,
      SuccessRedirectUrl: `${baseUrl}/api/cpanel/payment-iframe-result?status=success`,
      ErrorRedirectUrl:   `${baseUrl}/api/cpanel/payment-iframe-result?status=error`,
      /* Cardcom v11 LowProfile/Create expects WebHookUrl. Sending NotifyURL
         too is a belt-and-braces — older docs / some flows use that name. */
      WebHookUrl: notifyUrl,
      NotifyURL:  notifyUrl,
      ReturnValue: phone,
      IsCreateToken: true,
      Operation: 2,
      CustomerName: clientName,
      PhoneNumber: phone,
    });

    if (cardcomRes.data.ResponseCode !== 0) {
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }

    const paymentUrl = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;

    if (lowProfileId) {
      await getDB().collection("cpanel_pending_purchases").insertOne({
        lowProfileId, phone,
        agentId: String(req.agent._id),
        kind: purchaseKind,
        adsCount: ads, landingPagesCount: lps, videosCount: videos, logosCount: logos, socialAdsCount: socialAds,
        organicPosts, totalAmount: total, amount: total, description,
        coinsOverride: Number.isFinite(overrideCoins) ? overrideCoins : null,
        source: "iframe", createdAt: new Date(),
      });
    }

    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[CPanel] initiatePackageChargeIframe:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* Cardcom sends either a flat v10 body { LowProfileId, Token, Last4Digits, ExpDate }
   or a v11 nested body { LowProfileId, TokenInfo: { Token, TokenExDate },
   TranzactionInfo: { Last4CardDigitsString, Last4CardDigits, ... } } — and v11
   sometimes wraps the whole thing in an array. Normalize so the rest of
   paymentNotify can stay simple. */
function normalizeCardcomPayload(body) {
  const root = Array.isArray(body) ? body[0] : body;
  if (!root || typeof root !== "object") return {};

  const LowProfileId = root.LowProfileId || root.lowProfileId || null;

  /* Token can be at top level (v10), under TokenInfo (v11), or under
     TranzactionInfo (v11 includes a duplicate). */
  const Token =
    root.Token ||
    (root.TokenInfo       && root.TokenInfo.Token) ||
    (root.TranzactionInfo && root.TranzactionInfo.Token) ||
    null;

  /* Last4 can be a number, string, or under TranzactionInfo. */
  const last4Raw =
    root.Last4Digits ||
    root.Last4CardDigits ||
    (root.TranzactionInfo && (root.TranzactionInfo.Last4CardDigitsString ||
                              root.TranzactionInfo.Last4CardDigits)) ||
    null;
  const Last4Digits = last4Raw != null ? String(last4Raw) : null;

  /* ExpDate format: v10 sends "MMYY", v11 TokenExDate is "YYYYMMDD". */
  let ExpDate = root.ExpDate || null;
  if (!ExpDate && root.TokenInfo && root.TokenInfo.TokenExDate) {
    const t = String(root.TokenInfo.TokenExDate);
    if (t.length === 8) ExpDate = t.slice(4, 6) + t.slice(2, 4); // MMYY
    else ExpDate = t;
  }

  return { LowProfileId, Token, Last4Digits, ExpDate };
}

exports.paymentNotify = async (req, res) => {
  try {
    const { LowProfileId, Token, Last4Digits, ExpDate } = normalizeCardcomPayload(req.body);
    /* Phone may come via ?phone= (when our code built the WebHookUrl) or via
       ReturnValue in the body (when Cardcom uses the dashboard-default URL,
       which has no query string). */
    const root = Array.isArray(req.body) ? req.body[0] : (req.body || {});
    const phone = req.query.phone || root.ReturnValue || null;
    console.log(`[CPanel] paymentNotify hit phone=${phone} LowProfileId=${LowProfileId} hasToken=${!!Token} last4=${Last4Digits}`);

    if (Token && phone) {
      await usersCol().updateOne(
        { phone },
        { $set: { paymentToken: Token, paymentLast4: Last4Digits || null, paymentExpiry: ExpDate || null } },
        { upsert: true },
      );
      console.log(`[CPanel] Payment token saved for ${phone}`);

      // Fulfill pending purchase if any (package or simple payment-link)
      if (LowProfileId) {
        const pending = await getDB().collection("cpanel_pending_purchases")
          .findOne({ lowProfileId: LowProfileId, completedAt: { $exists: false } });
        if (pending) {
          /* Coin grant: prebuilt / coin-package overrides, default 700 for legacy package flow. */
          const isPackagePurchase =
            pending.kind === "package" ||
            pending.kind === "coins"   ||
            !!pending.adsCount         ||
            !!pending.landingPagesCount ||
            !!pending.videosCount      ||
            !!pending.logosCount       ||
            !!pending.socialAdsCount;

          if (isPackagePurchase) {
            const coins = Number.isFinite(pending.coinsOverride) && pending.coinsOverride > 0
              ? pending.coinsOverride
              : (pending.kind === "coins" ? 0 : 700);

            /* activePackage drives the cpanel "מוצרים" tab — without this set,
               the products tab stays gated forever even though the client paid. */
            const activePackage = {
              id:          pending.kind || "custom",
              name:        pending.description || pending.name || "חבילה",
              purchasedAt: new Date().toISOString(),
              items: {
                paidAds:    pending.adsCount          || 0,
                organicAds: (pending.socialAdsCount   || 0) + (pending.organicPosts || 0),
                videos:     pending.videosCount       || 0,
                lps:        pending.landingPagesCount || 0,
                logos:      pending.logosCount        || 0,
              },
              coins,
              /* Lifecycle: waiting_brief → sent_to_creation → ... → completed.
                 Manager advances via PATCH /api/client/project-detail/:id/status. */
              status: "waiting_brief",
            };

            const update = { $set: { activePackage } };
            if (coins > 0) update.$inc = { coins };
            await usersCol().updateOne({ phone: pending.phone }, update, { upsert: true });
            console.log(`[CPanel] activePackage set for ${pending.phone}: ${activePackage.name} (+${coins} coins, items=${JSON.stringify(activePackage.items)})`);
          }
          await getDB().collection("cpanel_pending_purchases")
            .updateOne({ lowProfileId: LowProfileId }, { $set: { completedAt: new Date() } });

          /* Manager commission — confirmed payment, attribute to the manager
             who initiated the link / iframe. */
          try {
            const baseAmount = pending.amount || pending.totalAmount;
            if (pending.agentId && baseAmount) {
              await commissionSvc.accrueCommission({
                agentId:        pending.agentId,
                clientPhone:    pending.phone,
                baseAmount,
                sourceKind:     pending.kind === "payment_link" ? "payment_link" : "package",
                sourceChargeId: `pending:${LowProfileId}`,
                description:    pending.description || (pending.kind === "package" ? "חבילה" : "תשלום"),
              });
            } else {
              console.warn(`[CPanel] pending ${LowProfileId} missing agentId/amount — no commission`);
            }
          } catch (err) {
            console.warn("[CPanel] commission accrual (paymentNotify) failed:", err.message);
          }

          console.log(`[CPanel] ${pending.kind || "purchase"} fulfilled for ${pending.phone}`);
          createReceipt({ phone: pending.phone, type: pending.kind === "coins" ? "coins" : "package", description: pending.description || pending.name || "חבילה", amount: pending.amount || pending.totalAmount || 0, coinsGranted: isPackagePurchase ? (Number.isFinite(pending.coinsOverride) && pending.coinsOverride > 0 ? pending.coinsOverride : (pending.kind === "coins" ? 0 : 700)) : 0, source: "cpanel", lowProfileId: LowProfileId }).catch(() => {});

          // Fire purchase webhook — fire-and-forget
          Promise.all([
            chatsCol().findOne({ phone: pending.phone }, { projection: { name: 1, fireberyName: 1 } }),
            pending.agentId
              ? getDB().collection("agents").findOne({ _id: pending.agentId }, { projection: { name: 1, nickname: 1, email: 1, phone: 1 } })
              : Promise.resolve(null),
          ]).then(([clientDoc, agentDoc]) => {
            const coinsGranted = Number.isFinite(pending.coinsOverride) && pending.coinsOverride > 0
              ? pending.coinsOverride
              : (pending.kind === "coins" ? 0 : 700);
            return sendPurchaseWebhook({
              event:     "purchase_success",
              source:    "cpanel",
              timestamp: new Date().toISOString(),
              client: {
                phone:        pending.phone,
                name:         clientDoc?.fireberyName || clientDoc?.name || null,
                businessName: clientDoc?.businessName || null,
              },
              manager: {
                id:    pending.agentId || null,
                name:  agentDoc?.nickname || agentDoc?.name || null,
                email: agentDoc?.email || null,
                phone: agentDoc?.phone || null,
              },
              package: {
                name:             pending.description || pending.name || "חבילה",
                kind:             pending.kind || "package",
                amount:           pending.amount || pending.totalAmount || 0,
                coinsGranted,
                adsCount:         pending.adsCount          || 0,
                landingPagesCount: pending.landingPagesCount || 0,
                videosCount:      pending.videosCount        || 0,
                logosCount:       pending.logosCount         || 0,
                socialAdsCount:   pending.socialAdsCount     || 0,
              },
              payment: {
                lowProfileId: LowProfileId,
                last4:        Last4Digits || null,
                expDate:      ExpDate || null,
              },
            });
          }).catch(err => console.warn("[CPanel] purchase webhook failed:", err.message));
        }
      }

      // Notify the client that their card was saved
      if (req.app?.get("io")) {
        const io = req.app.get("io");
        broadcast(io, "payment_token_saved", phone, { last4: Last4Digits });
        const chat = await chatsCol().findOne({ phone }, { projection: { accountManagerId: 1 } });
        if (chat?.accountManagerId) {
          broadcast(io, "client_payment_saved", `am_${chat.accountManagerId}`, { phone, last4: Last4Digits });
        }
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("[CPanel] paymentNotify:", err.message);
    res.status(500).send("Error");
  }
};

exports.paymentIframeResult = async (req, res) => {
  const status = req.query.status === "success" ? "success" : "error";

  // Fire failure webhook when iframe payment is rejected/declined
  if (status === "error") {
    const lowProfileId = req.query.lowProfileId || req.query.LowProfileId || null;
    if (lowProfileId) {
      Promise.all([
        getDB().collection("cpanel_pending_purchases").findOne({ lowProfileId }),
      ]).then(async ([pending]) => {
        const clientDoc = pending?.phone
          ? await chatsCol().findOne({ phone: pending.phone }, { projection: { name: 1, fireberyName: 1 } })
          : null;
        const agentDoc = pending?.agentId
          ? await getDB().collection("agents").findOne({ _id: pending.agentId }, { projection: { name: 1, nickname: 1, email: 1, phone: 1 } })
          : null;
        return sendPurchaseWebhook({
          event:     "purchase_rejected",
          source:    "cpanel",
          timestamp: new Date().toISOString(),
          client: {
            phone: pending?.phone || null,
            name:  clientDoc?.fireberyName || clientDoc?.name || null,
          },
          manager: {
            id:    pending?.agentId || null,
            name:  agentDoc?.nickname || agentDoc?.name || null,
            email: agentDoc?.email || null,
            phone: agentDoc?.phone || null,
          },
          package: {
            name:   pending?.description || pending?.name || null,
            kind:   pending?.kind || null,
            amount: pending?.amount || pending?.totalAmount || null,
          },
          error: "תשלום נדחה על ידי הלקוח או כרטיס האשראי",
          payment: { lowProfileId },
        });
      }).catch(err => console.warn("[CPanel] rejection webhook failed:", err.message));
    }
  }

  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>תשלום</title></head><body><script>window.parent.postMessage({type:"cardcom_payment_result",status:"${status}"},"*");<\/script></body></html>`);
};

// ── Get client FB assets (pages + ad accounts) from Facebook ──────
exports.getClientFbAssets = async (req, res) => {
  try {
    const { phone } = req.params;
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.json({ accounts: [], pages: [], adAccounts: [] });

    const token = creds.userToken;

    // Fetch pages, ad accounts, and businesses in parallel
    const [pagesRes, adAccountsRes, bizRes] = await Promise.allSettled([
      axios.get(`${FB_GRAPH}/me/accounts`, { params: { access_token: token, fields: "id,name", limit: 50 } }),
      axios.get(`${FB_GRAPH}/me/adaccounts`, { params: { access_token: token, fields: "id,account_id,name", limit: 50 } }),
      axios.get(`${FB_GRAPH}/me/businesses`, { params: { access_token: token, fields: "id,name,owned_pages{id,name},owned_ad_accounts{id,account_id,name}", limit: 20 } }),
    ]);

    const pages = pagesRes.status === "fulfilled"
      ? (pagesRes.value.data?.data || []).map(p => ({ id: p.id, name: p.name }))
      : [];

    const adAccounts = adAccountsRes.status === "fulfilled"
      ? (adAccountsRes.value.data?.data || []).map(a => ({ id: (a.account_id || a.id.replace("act_", "")), name: a.name }))
      : [];

    // Build linked pairs from business manager
    const accounts = [];
    if (bizRes.status === "fulfilled") {
      for (const biz of (bizRes.value.data?.data || [])) {
        const bizPages = biz.owned_pages?.data || [];
        const bizAdAccounts = biz.owned_ad_accounts?.data || [];
        for (const page of bizPages) {
          const linkedAd = bizAdAccounts[0]; // pair first ad account
          accounts.push({
            businessName: biz.name,
            page: { id: page.id, name: page.name },
            adAccount: linkedAd ? { id: linkedAd.account_id || linkedAd.id.replace("act_", ""), name: linkedAd.name } : null,
          });
        }
        // Ad accounts without a page
        if (!bizPages.length) {
          for (const ad of bizAdAccounts) {
            accounts.push({
              businessName: biz.name,
              page: null,
              adAccount: { id: ad.account_id || ad.id.replace("act_", ""), name: ad.name },
            });
          }
        }
      }
    }

    console.log(`[CPanel] getClientFbAssets phone=${phone} pages=${pages.length} adAccounts=${adAccounts.length} bizAccounts=${accounts.length}`);
    res.json({ accounts, pages, adAccounts });
  } catch (err) {
    console.error("[CPanel] getClientFbAssets:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Update client FB credentials (page_id + act_id) ────────────────
exports.updateClientCredentials = async (req, res) => {
  try {
    const { phone } = req.params;
    const { pageId, adAccountId } = req.body;
    if (!pageId && !adAccountId) return res.status(400).json({ error: "pageId or adAccountId required" });

    const update = {};
    if (pageId) update.page_id = pageId.trim();
    if (adAccountId) update.ad_account_id = adAccountId.replace(/^act_/, "").trim();

    await usersCol().updateOne({ phone }, { $set: update }, { upsert: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Agent dashboard stats ────────────────────────────────────────────
exports.getStats = async (req, res) => {
  try {
    const agentId = String(req.agent._id);

    const myClients = await cpanelClientsCol().find({ agentId }, { projection: { phone: 1 } }).toArray();
    const phones = myClients.map(c => c.phone).filter(Boolean);

    const chats = phones.length
      ? await chatsCol().find(
          { phone: { $in: phones } },
          { projection: { phone: 1, messages: 1 } }
        ).toArray()
      : [];

    let unreadMessages = 0;
    for (const chat of chats) {
      const msgs = chat.messages || [];
      // Count messages from user that haven't been read (fromRole = "user", read = false/undefined)
      unreadMessages += msgs.filter(m => m.fromRole === "user" && !m.read).length;
    }

    res.json({
      totalClients: myClients.length,
      unreadMessages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Technical app-data for a client — MongoDB only ───────────────────
// Was read from Fireberry custom fields; now read off the client's own
// documents. Missing values simply come back null.
exports.getAppData = async (req, res) => {
  try {
    const { phone } = req.params;
    const [user, chat] = await Promise.all([
      usersCol().findOne({ phone }, { projection: { waSession: 1, wa_session: 1, waAutoMessage: 1, wa_auto_message: 1, status: 1 } }),
      chatsCol().findOne({ phone }, { projection: { status: 1, waSession: 1, waAutoMessage: 1 } }),
    ]);
    res.json({
      status:        chat?.status        || user?.status        || null,
      waSession:     user?.waSession     || user?.wa_session    || chat?.waSession     || null,
      expoToken:     null,
      waAutoMessage: user?.waAutoMessage || user?.wa_auto_message || chat?.waAutoMessage || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Client live presence ─────────────────────────────────────────────
exports.getClientPresence = async (req, res) => {
  try {
    const { phone } = req.params;
    const online = isPhoneOnline(phone);
    const user = await usersCol().findOne({ phone }, { projection: { lastSeenAt: 1 } });
    res.json({ online, lastSeenAt: user?.lastSeenAt || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Client activity feed ─────────────────────────────────────────────
exports.getClientActivity = async (req, res) => {
  try {
    const { phone } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const events = await getDB()
      .collection("app_activity")
      .find({ phone })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Push notification on demand (C-panel calls this after sending a chat
//    message so the customer's mobile gets a notification even if the socket
//    handler's push path failed to resolve the phone). Body: { title?, body? }.
exports.notifyClientPush = async (req, res) => {
  try {
    const { phone } = req.params;
    const { title, body } = req.body || {};
    const pushNotification = require("../services/push-notification.service");
    const ok = await pushNotification.notifyUser(
      phone,
      title || "נציג תמיכה",
      body  || "הודעה חדשה",
      { screen: "ChatScreenAi" },
    );
    res.json({ ok, phone });
  } catch (err) {
    console.error("[cpanel] notifyClientPush:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Get chat messages for a client ──────────────────────────────────
exports.getMessages = async (req, res) => {
  try {
    const { phone } = req.params;
    const chat = await chatsCol().findOne(
      { phone },
      { projection: { _id: 1, messages: 1 } },
    );
    if (!chat) return res.json({ chatId: null, messages: [] });
    const msgs = (chat.messages || []).slice(-60);
    res.json({ chatId: String(chat._id), messages: msgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Get all agents with account_manager role (for assignment UI) ────
exports.getAccountManagers = async (req, res) => {
  try {
    const managers = await agentsCol()
      .find({ role: "account_manager", active: { $ne: false } })
      .project({ password: 0, token: 0 })
      .toArray();
    res.json(managers.map(m => ({ id: m._id, name: m.nickname || m.name, phone: m.phone || "" })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Get characterization (business_profile + ad_brief) ───────────────
// Older characterization docs may embed multi-MB base64 data URLs (legacy
// upload-image fallback path that wrote `data:image/...;base64,…` strings
// into image fields). At scale those docs blow past Mongo's 16MB cap on
// updates, and `res.json` on them is slow enough to timeout the request.
// Strip data URLs to a sentinel placeholder before serializing so the GET
// always succeeds and the client renders a "broken image" hint instead.
exports.getCharacterization = async (req, res) => {
  try {
    const { phone } = req.params;
    const [businessProfile, adBrief] = await Promise.all([
      getDB().collection("business_profiles").findOne({ phone }),
      getDB().collection("ad_briefs").findOne({ phone }),
    ]);
    res.json({
      // Same canonical normalizer the app read uses → cpanel + app stay in sync.
      businessProfile: scrubDataUrls(canonicalizeProfileImages(businessProfile)) || null,
      adBrief:         scrubDataUrls(adBrief)         || null,
    });
  } catch (err) {
    console.error("[cpanel] getCharacterization:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* Recursively replace any string starting with "data:" (base64-embedded
   image) with a placeholder marker. Bounds the response size and avoids
   sending megabytes of legacy inline-image junk over the wire. */
function scrubDataUrls(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(scrubDataUrls);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.startsWith("data:")) {
      out[k] = ""; // drop legacy inline image, client treats as empty
    } else if (v && typeof v === "object") {
      out[k] = scrubDataUrls(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Update characterization ──────────────────────────────────────────
exports.updateCharacterization = async (req, res) => {
  try {
    const { phone } = req.params;
    const { businessProfile, adBriefAnswers } = req.body;

    if (businessProfile && Object.keys(businessProfile).length > 0) {
      // strip immutable / server-managed fields the client may have echoed back
      const { _id, createdAt, updatedAt, phone: _phone, ...clientProfile } = businessProfile;

      /* logoUrl sanitization — mirrors the same guard in
         business-profile.controller.js saveBusinessProfile. The iOS app
         is the more common source of file:// paths but a manager paste
         in cpanel could theoretically do it too; reject anything that
         isn't a fully-qualified web URL / /api path / data: URI so the
         broken-image bug never reappears. */
      if (Object.prototype.hasOwnProperty.call(clientProfile, "logoUrl")) {
        const v = clientProfile.logoUrl;
        const ok = v === "" || v === null || (typeof v === "string" && (
          /^https?:\/\//i.test(v) || v.startsWith("/api") || v.startsWith("data:image/")
        ));
        if (!ok) {
          console.warn(`[cpanel] updateCharacterization dropped non-web logoUrl for phone=${phone}: ${String(v).slice(0, 80)}`);
          delete clientProfile.logoUrl;
        }
      }

      // WOW fields (step 5) — only $set if non-empty so we never overwrite app-saved data with blanks
      const WOW_FIELDS = ["about", "pageGoal", "designStyle", "targetAudience", "promotion", "socialLinks", "preferredColors"];
      const baseFields = {};
      const wowFields = {};
      for (const [k, v] of Object.entries(clientProfile)) {
        if (WOW_FIELDS.includes(k)) {
          const isEmpty = v === undefined || v === null || v === "" ||
            (Array.isArray(v) && v.length === 0) ||
            (typeof v === "object" && !Array.isArray(v) && Object.values(v).every(x => !x));
          if (!isEmpty) wowFields[k] = v;
        } else {
          baseFields[k] = v;
        }
      }
      /* generalImages is RETIRED (folded into images[] on read). Never $set it
         — a stale client may echo it back, and $set + $unset on the same path
         makes Mongo reject the whole update ("conflict at generalImages"),
         which 500s every save. Strip it from the payload, then $unset it when
         we're persisting the unified images[] so deleted photos can't reappear. */
      delete baseFields.generalImages;
      const update = { $set: { ...baseFields, ...wowFields, phone, updatedAt: new Date() } };
      if (Object.prototype.hasOwnProperty.call(baseFields, "images")) {
        update.$unset = { generalImages: "" };
      }
      await getDB().collection("business_profiles").updateOne(
        { phone },
        update,
        { upsert: true }
      );
    }

    if (adBriefAnswers && Object.keys(adBriefAnswers).length > 0) {
      const answerUpdates = {};
      for (const [questionId, raw] of Object.entries(adBriefAnswers)) {
        answerUpdates[`answers.${questionId}`] = { raw, savedAt: new Date() };
      }
      await getDB().collection("ad_briefs").updateOne(
        { phone },
        {
          $set: { ...answerUpdates, updatedAt: new Date() },
          $setOnInsert: { phone, createdAt: new Date() },
        },
        { upsert: true }
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════
//  EXTENDED CPANEL ENDPOINTS
// ══════════════════════════════════════════════════════════════════════

const { generateRawText } = require("../services/ai.service");
const { sendSMS }         = require("../services/sms4free.service");
const greenApi            = require("../services/greenapi.service");
const {
  listFilesByPrefix,
  getUploadCredentials,
} = require("../services/backblaze.service");

// ── Collections ──────────────────────────────────────────────────────
const pipelineCol  = () => getDB().collection("cpanel_pipeline");
const apptCol      = () => getDB().collection("cpanel_appointments");
const digestCol    = () => getDB().collection("cpanel_digest_schedule");
const broadcastCol = () => getDB().collection("cpanel_broadcast_history");
const fbLeadsCol   = () => getDB().collection("cpanel_fb_leads_followup");

// ── FB Lead Forms ────────────────────────────────────────────────────

exports.getClientFbLeadForms = async (req, res) => {
  try {
    const { phone } = req.params;
    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken || !creds?.pageId) {
      return res.json({ forms: [], error: "FB page credentials not configured" });
    }
    const pageToken = await getPageAccessToken(creds.userToken, creds.pageId);
    const token = pageToken || creds.userToken;
    const { data } = await axios.get(`${FB_GRAPH}/${creds.pageId}/leadgen_forms`, {
      params: { access_token: token, fields: "id,name,status,leads_count,created_time", limit: 50 },
    });
    const forms = (data?.data || []).map(f => ({
      id: f.id,
      name: f.name,
      status: f.status,
      leadsCount: f.leads_count || 0,
      createdAt: f.created_time || null,
    }));
    console.log(`[CPanel] getClientFbLeadForms phone=${phone} forms=${forms.length} usingPageToken=${!!pageToken}`);
    res.json({ forms });
  } catch (err) {
    const fbMsg = err.response?.data?.error?.message || err.message;
    const fbCode = err.response?.data?.error?.code;
    console.error(`[CPanel] getClientFbLeadForms [${fbCode}]: ${fbMsg}`);
    res.status(500).json({ error: fbCode ? `[${fbCode}] ${fbMsg}` : fbMsg });
  }
};

exports.getClientFbLeads = async (req, res) => {
  try {
    const { phone } = req.params;
    const { formId, days = "30", limit = "200" } = req.query;

    const creds = await getClientFbCredentials(phone);
    if (!creds?.userToken) return res.json({ leads: [], error: "FB credentials not configured" });

    const pageToken = await getPageAccessToken(creds.userToken, creds.pageId);
    const token = pageToken || creds.userToken;

    const _parsedDays = parseInt(days, 10);
    const numDays = isNaN(_parsedDays) ? 30 : _parsedDays;
    const sinceTs = Math.floor((Date.now() - numDays * 86400_000) / 1000);

    // Build list of form IDs to query
    let formIds = [];
    if (formId) {
      formIds = [formId];
    } else {
      // Fetch all forms for the page and query each
      try {
        const { data: formsData } = await axios.get(`${FB_GRAPH}/${creds.pageId}/leadgen_forms`, {
          params: { access_token: token, fields: "id,name", limit: 50 },
        });
        formIds = (formsData?.data || []).map(f => f.id);
      } catch (_) {}
    }

    if (!formIds.length) return res.json({ leads: [] });

    // Fetch leads from all forms sequentially with full logging
    const allLeads = [];
    for (const fId of formIds) {
      try {
        const { data } = await axios.get(`${FB_GRAPH}/${fId}/leads`, {
          params: {
            access_token: token,
            fields: "id,created_time,field_data,ad_name,campaign_name",
            limit: 200,
          },
        });
        const count = (data?.data || []).length;
        console.log(`[CPanel] form ${fId}: ${count} leads | paging=${JSON.stringify(data?.paging?.cursors)?.slice(0,60)}`);
        for (const l of data?.data || []) allLeads.push({ ...l, _formId: fId });
      } catch (e) {
        const fbMsg = e.response?.data?.error?.message || e.message;
        const fbCode = e.response?.data?.error?.code;
        console.error(`[CPanel] form ${fId} ERROR [${fbCode}]: ${fbMsg}`);
      }
    }
    if (numDays > 0 && allLeads.length > 0) {
      const toMs = (v) => {
        if (typeof v === "number") return v * 1000; // Unix seconds
        const d = new Date(v);
        return isNaN(d.getTime()) ? 0 : d.getTime();
      };
      const before = allLeads.length;
      const filtered = allLeads.filter(l => toMs(l.created_time) >= sinceTs * 1000);
      console.log(`[CPanel] date filter days=${numDays}: ${before} → ${filtered.length}`);
      allLeads.length = 0;
      allLeads.push(...filtered);
    }

    const toMs = (v) => { if (typeof v === "number") return v * 1000; const d = new Date(v); return isNaN(d.getTime()) ? 0 : d.getTime(); };
    allLeads.sort((a, b) => toMs(b.created_time) - toMs(a.created_time));

    const fbIds = allLeads.map(l => l.id);
    const followUps = fbIds.length
      ? await fbLeadsCol().find({ fbLeadId: { $in: fbIds } }, { projection: { fbLeadId: 1, followedUpAt: 1 } }).toArray()
      : [];
    const followUpMap = Object.fromEntries(followUps.map(f => [f.fbLeadId, f.followedUpAt]));

    const leads = allLeads.map(l => {
      const fields = {};
      for (const f of l.field_data || []) fields[f.name] = (f.values || [])[0] || "";
      return {
        id: l.id,
        createdAt: l.created_time,
        formId: l._formId,
        adName: l.ad_name || null,
        campaignName: l.campaign_name || null,
        name:  fields.full_name || fields.name || fields["שם מלא"] || "",
        phone: fields.phone_number || fields.phone || fields["מספר טלפון"] || "",
        email: fields.email || fields["אימייל"] || "",
        fields,
        isFollowedUp: !!(followUpMap[l.id]),
        followedUpAt: followUpMap[l.id] || null,
      };
    });

    console.log(`[CPanel] getClientFbLeads phone=${phone} forms=${formIds.length} leads=${leads.length} days=${numDays}`);
    res.json({ leads });
  } catch (err) {
    const fbMsg = err.response?.data?.error?.message || err.message;
    console.error(`[CPanel] getClientFbLeads: ${fbMsg}`);
    res.status(500).json({ error: fbMsg });
  }
};

exports.markFbLeadFollowedUp = async (req, res) => {
  try {
    const { leadId } = req.params;
    const agentId = String(req.agent._id);
    await fbLeadsCol().updateOne(
      { fbLeadId: leadId },
      { $set: { fbLeadId: leadId, agentId, followedUpAt: new Date() } },
      { upsert: true },
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Pipeline ─────────────────────────────────────────────────────────

exports.getPipeline = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const myClients = await cpanelClientsCol().find({ agentId }, { projection: { phone: 1, customerName: 1 } }).toArray();
    const phones = myClients.map(c => c.phone);

    const [stages, chatsData] = await Promise.all([
      pipelineCol().find({ agentId }).toArray(),
      phones.length
        ? chatsCol().find({ phone: { $in: phones } }, { projection: { phone: 1, fireberyName: 1, fireberyLogoUrl: 1 } }).toArray()
        : [],
    ]);

    const stageMap = Object.fromEntries(stages.map(s => [s.phone, s.stage]));
    const chatMap  = Object.fromEntries(chatsData.map(c => [c.phone, c]));
    const nameMap  = Object.fromEntries(myClients.map(c => [c.phone, c.customerName]));

    const cards = myClients.map(c => {
      const stageDoc = stages.find(s => s.phone === c.phone);
      const name = chatMap[c.phone]?.fireberyName || nameMap[c.phone] || c.phone;
      return {
        /* Frontend canonical names (PipelineCard type in cpanel client.ts) */
        clientId:    c.phone,
        clientPhone: c.phone,
        clientName:  name,
        stage:       stageMap[c.phone] || "new",
        value:       stageDoc?.value || 0,
        notes:       stageDoc?.notes || "",
        updatedAt:   stageDoc?.updatedAt || null,
        movedAt:     stageDoc?.movedAt   || stageDoc?.updatedAt || null,
        /* Legacy aliases — kept so any older consumer doesn't break */
        phone:       c.phone,
        name,
        logoUrl:     chatMap[c.phone]?.fireberyLogoUrl || null,
      };
    });

    res.json({ cards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updatePipelineStage = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    /* Accept phone from URL param (RESTful PUT /pipeline/:phone) or
       from request body (legacy PUT /pipeline/stage). */
    const phone = (req.params.phone || req.body.phone || "").toString().trim();
    const { stage, value, notes } = req.body || {};
    const VALID = ["new", "qualified", "proposal", "won", "lost"];
    if (!phone || !VALID.includes(stage)) {
      return res.status(400).json({ error: "phone and valid stage required" });
    }
    const now = new Date();
    const $set = { agentId, phone, stage, updatedAt: now, movedAt: now };
    if (Number.isFinite(value)) $set.value = value;
    if (typeof notes === "string") $set.notes = notes;
    await pipelineCol().updateOne(
      { agentId, phone },
      { $set },
      { upsert: true },
    );
    res.json({ success: true, phone, stage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Dashboard Summary ────────────────────────────────────────────────

exports.getDashboard = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const days  = Math.min(parseInt(req.query.days) || 7, 90);
    const since = new Date(Date.now() - days * 864e5);

    const myClients = await cpanelClientsCol().find({ agentId }, { projection: { phone: 1 } }).toArray();
    const phones = myClients.map(c => c.phone);

    const [chats, stages] = await Promise.all([
      phones.length ? chatsCol().find({ phone: { $in: phones } }, { projection: { phone: 1, messages: 1, status: 1, updated_at: 1 } }).toArray() : [],
      pipelineCol().find({ agentId }).toArray(),
    ]);

    let unread = 0, sent7d = 0;
    const trendMap = {};
    for (const chat of chats) {
      const msgs = chat.messages || [];
      for (const m of msgs) {
        if (m.fromRole === "user" && !m.read) unread++;
        if (m.fromRole === "agent" && m.createdAt && new Date(m.createdAt) >= since) {
          sent7d++;
          const label = new Date(m.createdAt).toISOString().slice(0, 10);
          trendMap[label] = (trendMap[label] || 0) + 1;
        }
      }
    }

    const stageCount = {};
    for (const s of stages) stageCount[s.stage] = (stageCount[s.stage] || 0) + 1;

    const trendMessages = Object.entries(trendMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, value]) => ({ label, value }));

    res.json({
      clients: {
        total:        phones.length,
        active7d:     chats.filter(c => c.updated_at && new Date(c.updated_at) >= since).length,
        atRisk:       0,
        outOfCredit:  0,
      },
      messages: { unread, sent7d, received7d: 0, missed: 0 },
      pipeline: {
        leads:     (stageCount.lead || 0) + (stageCount.qualified || 0),
        qualified: stageCount.qualified || 0,
        proposals: stageCount.proposal  || 0,
        won:       stageCount.won       || 0,
      },
      spend7d: 0, revenue7d: 0,
      trends: {
        leads: [], spend: [],
        revenue: trendMessages,
      },
      byCategory: [
        { label: "לידים",    value: stageCount.lead        || 0 },
        { label: "מוסמך",    value: stageCount.qualified   || 0 },
        { label: "הצעה",     value: stageCount.proposal    || 0 },
        { label: "סגור",     value: stageCount.won         || 0 },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── AI: Suggest Replies ──────────────────────────────────────────────

exports.aiSuggestReplies = async (req, res) => {
  try {
    const { messages = [], tone = "professional" } = req.body;
    const preview = messages.slice(-10).map(m => `[${m.fromRole}]: ${m.text || m.body || ""}`).join("\n");
    const toneHe  = tone === "friendly" ? "ידידותי וחם" : tone === "formal" ? "רשמי ומקצועי" : "מקצועי ומכבד";
    const prompt  = `אתה עוזר AI לנציג שירות של ICONIQ Media. הצע 3 תגובות קצרות בעברית בסגנון ${toneHe}. החזר JSON: {"suggestions":[{"tone":"professional","text":"..."},{"tone":"friendly","text":"..."},{"tone":"formal","text":"..."}]}`;
    const raw = await generateRawText(prompt, `שיחה:\n${preview}`);
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim());
    res.json(json);
  } catch (err) {
    console.error("[CPanel] aiSuggestReplies:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── AI: Summarize Chat ───────────────────────────────────────────────

exports.aiSummarizeChat = async (req, res) => {
  try {
    let { messages, phone } = req.body || {};

    // If only phone is supplied (current cpanel UI behavior), fetch
    // the last 60 messages from the chat. Keeps backward-compat with
    // callers that pass messages directly.
    if ((!Array.isArray(messages) || !messages.length) && phone) {
      const chat = await chatsCol().findOne({ phone }, { projection: { messages: 1 } });
      messages = chat?.messages || [];
    }
    messages = Array.isArray(messages) ? messages : [];

    const preview = messages.slice(-40)
      .map(m => `[${m.fromRole || "user"}]: ${m.text || m.body || ""}`)
      .filter(line => line.length > 4)
      .join("\n");

    if (!preview.trim()) {
      return res.json({ summary: "אין מספיק הודעות בשיחה לסיכום.", sentiment: "neutral", intents: [] });
    }

    // Ask OpenAI for a structured JSON response so the cpanel UI gets
    // sentiment + intents alongside the prose summary.
    const prompt = `סכם את השיחה הבאה עם לקוח בעברית.
החזר JSON תקני בלבד עם המבנה:
{
  "summary":   "תקציר 3-5 משפטים: נושאים, בקשות לקוח, סטטוס טיפול",
  "sentiment": "positive" | "neutral" | "negative",
  "intents":   ["תיוג קצר", "..."]   // 2-5 תגיות (כוונה / בעיה / נושא)
}
שיחה:
${preview}`;

    const raw = await generateRawText("החזר JSON תקני בלבד.", prompt);
    let parsed = { summary: "", sentiment: "neutral", intents: [] };
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : cleaned);
    } catch {
      // Fallback: treat the whole text as the summary
      parsed = { summary: raw.trim(), sentiment: "neutral", intents: [] };
    }

    res.json({
      summary:   String(parsed.summary || "").trim(),
      sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment) ? parsed.sentiment : "neutral",
      intents:   Array.isArray(parsed.intents) ? parsed.intents.slice(0, 6) : [],
    });
  } catch (err) {
    console.error("[CPanel] aiSummarizeChat:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── AI: Daily Digest ─────────────────────────────────────────────────

/* Tier priority used for digest sorting and severity boosts. */
const TIER_PRIORITY = { GOLD: 100, VIP: 90, PRO: 80, PLUS: 70, SILVER: 60, REGULAR: 0 };
const SEVERITY_RANK  = { high: 3, med: 2, low: 1 };

async function buildDigestItems(phones) {
  if (!phones.length) return [];
  const now = new Date();
  const threeDaysAgo = new Date(now - 3 * 864e5);
  const oneDayAgo    = new Date(now - 864e5);

  const [chats, mappings] = await Promise.all([
    chatsCol().find(
      { phone: { $in: phones } },
      { projection: { phone: 1, fireberyName: 1, messages: 1 } },
    ).toArray(),
    cpanelClientsCol().find(
      { phone: { $in: phones } },
      { projection: { phone: 1, tier: 1 } },
    ).toArray(),
  ]);
  const tierByPhone = Object.fromEntries(mappings.map(m => [m.phone, m.tier || "REGULAR"]));

  const items = [];
  for (const chat of chats) {
    const msgs = chat.messages || [];
    const lastMsg  = msgs[msgs.length - 1];
    const lastDate = lastMsg?.createdAt ? new Date(lastMsg.createdAt) : null;
    const name     = chat.fireberyName || chat.phone;
    const tier     = tierByPhone[chat.phone] || "REGULAR";
    const isPriority = tier === "GOLD" || tier === "VIP";

    if (lastDate && lastDate < threeDaysAgo) {
      let severity = lastDate < new Date(now - 7 * 864e5) ? "high" : "med";
      /* Boost priority clients one level so a 3-day gap on a GOLD jumps to high. */
      if (isPriority && severity === "med") severity = "high";
      items.push({
        kind: "stale_chat", clientPhone: chat.phone, clientName: name, tier,
        reason: `לא הייתה פעילות מאז ${lastDate.toLocaleDateString("he-IL")}`,
        severity,
      });
    }

    const recentUnread = msgs.filter(
      m => m.fromRole === "user" && !m.read && m.createdAt && new Date(m.createdAt) > oneDayAgo,
    );
    if (recentUnread.length >= (isPriority ? 1 : 3)) {
      items.push({
        kind: "high_intent", clientPhone: chat.phone, clientName: name, tier,
        reason: `${recentUnread.length} הודעות לא נקראו ב-24 שעות האחרונות`,
        severity: "high",
      });
    }
  }

  /* Smart ordering: tier priority first, then severity, then most-recent. */
  items.sort((a, b) => {
    const tp = (TIER_PRIORITY[b.tier] || 0) - (TIER_PRIORITY[a.tier] || 0);
    if (tp) return tp;
    return (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  });

  return items;
}

exports.aiRunDigestNow = async (req, res) => {
  try {
    const agentId   = String(req.agent._id);
    const myClients = await cpanelClientsCol().find({ agentId }, { projection: { phone: 1 } }).toArray();
    const phones    = myClients.map(c => c.phone);
    const items     = await buildDigestItems(phones);

    await getDB().collection("cpanel_digest_runs").insertOne({ agentId, items, generatedAt: new Date() });

    res.json({ items, generatedAt: new Date() });
  } catch (err) {
    console.error("[CPanel] aiRunDigestNow:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /cpanel/ai/daily-digest — return latest cached digest, regenerate
   if older than DIGEST_TTL_MS (12h) or if force=1 is passed. */
const DIGEST_TTL_MS = 12 * 60 * 60 * 1000;
exports.getDailyDigest = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const force = req.query.force === "1" || req.query.force === "true";

    const last = await getDB().collection("cpanel_digest_runs")
      .find({ agentId })
      .sort({ generatedAt: -1 })
      .limit(1)
      .next();

    const fresh = last && (Date.now() - new Date(last.generatedAt).getTime() < DIGEST_TTL_MS);
    if (last && fresh && !force) {
      return res.json({ items: last.items, generatedAt: last.generatedAt, cached: true });
    }

    const myClients = await cpanelClientsCol().find({ agentId }, { projection: { phone: 1 } }).toArray();
    const phones    = myClients.map(c => c.phone);
    const items     = await buildDigestItems(phones);

    const generatedAt = new Date();
    await getDB().collection("cpanel_digest_runs").insertOne({ agentId, items, generatedAt });
    res.json({ items, generatedAt, cached: false });
  } catch (err) {
    console.error("[CPanel] getDailyDigest:", err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getDigestSchedule = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const doc = await digestCol().findOne({ agentId });
    res.json(doc || { enabled: true, hour: 8, channels: ["inapp"] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.setDigestSchedule = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const { enabled, hour, channels } = req.body;
    const update = { updatedAt: new Date() };
    if (enabled  !== undefined) update.enabled  = !!enabled;
    if (hour     !== undefined) update.hour      = Math.min(Math.max(parseInt(hour), 0), 23);
    if (channels !== undefined) update.channels  = channels;

    const result = await digestCol().findOneAndUpdate(
      { agentId },
      { $set: update, $setOnInsert: { agentId, createdAt: new Date() } },
      { upsert: true, returnDocument: "after" },
    );
    res.json(result.value ?? result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Broadcast ────────────────────────────────────────────────────────

exports.getBroadcastTemplates = (_req, res) => {
  res.json({
    templates: [
      { id: "promo1", name: "מבצע חודשי",        body: "שלום {name}! יש לנו מבצע מיוחד רק בשבילך 🎁" },
      { id: "check1", name: "בדיקת שביעות רצון",  body: "שלום {name}, איך הולך? נשמח לשמוע ממך 😊" },
      { id: "remind", name: "תזכורת פגישה",       body: "שלום {name}, תזכורת לפגישה שלנו מחר בשעה {time} ✅" },
      { id: "renew",  name: "חידוש מנוי",         body: "שלום {name}, המנוי שלך מסתיים בקרוב. צרו קשר לחידוש 📋" },
    ],
  });
};

exports.getBroadcastHistory = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const history = await broadcastCol().find({ agentId }).sort({ sentAt: -1 }).limit(50).toArray();
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.sendBroadcast = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const { phones = [], message, channel = "sms" } = req.body;
    if (!message?.trim())  return res.status(400).json({ error: "message required" });
    if (!phones.length)    return res.status(400).json({ error: "phones[] required" });

    const results = [];
    for (const phone of phones.slice(0, 200)) {
      try {
        if (channel === "whatsapp") await greenApi.sendMessage(phone, message);
        else                        await sendSMS(phone, message);
        results.push({ phone, ok: true });
      } catch (e) {
        results.push({ phone, ok: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    await broadcastCol().insertOne({
      agentId, phones, message, channel, results, sentAt: new Date(),
      sentCount: results.filter(r => r.ok).length,
      failCount: results.filter(r => !r.ok).length,
    });

    res.json({
      sentCount: results.filter(r => r.ok).length,
      failCount: results.filter(r => !r.ok).length,
      results,
    });
  } catch (err) {
    console.error("[CPanel] sendBroadcast:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Client Files (Backblaze) ─────────────────────────────────────────

exports.getClientFiles = async (req, res) => {
  try {
    const { phone } = req.params;
    const files = await listFilesByPrefix(`cpanel/${phone}/`, 200);
    const B2_DL = "https://f002.backblazeb2.com/b2api/v2/b2_download_file_by_id";
    res.json({
      files: files.map(f => ({
        key:        f.fileName,
        fileId:     f.fileId,
        name:       f.fileName.split("/").pop(),
        size:       f.contentLength,
        uploadedAt: new Date(f.uploadTimestamp),
        url:        `${B2_DL}?fileId=${f.fileId}`,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getClientFileUploadUrl = async (req, res) => {
  try {
    const { phone } = req.params;
    const { filename, mimeType = "application/octet-stream" } = req.query;
    if (!filename) return res.status(400).json({ error: "filename required" });
    const sanitized = filename.replace(/[^a-zA-Z0-9._\- ]/g, "_");
    const fullPath  = `cpanel/${phone}/${Date.now()}_${sanitized}`;
    const creds     = await getUploadCredentials();
    res.json({ ...creds, fullPath, mimeType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteClientFile = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    void ObjectId;
    const { phone } = req.params;
    const fileKey   = decodeURIComponent(req.params.fileKey || req.params[0] || "");
    if (!fileKey.startsWith(`cpanel/${phone}/`)) {
      return res.status(403).json({ error: "Not authorized to delete this file" });
    }
    const B2 = require("backblaze-b2");
    const b2 = new B2({ applicationKeyId: process.env.BACKBLAZE_KEY_ID, applicationKey: process.env.BACKBLAZE_APPLICATION_KEY });
    await b2.authorize();
    const listResp = await b2.listBuckets();
    const bucket   = listResp.data.buckets.find(b => b.bucketName === "iconicMedia");
    const listing  = await b2.listFileNames({ bucketId: bucket.bucketId, prefix: fileKey, maxFileCount: 5 });
    const match    = listing.data.files.find(f => f.fileName === fileKey);
    if (!match) return res.status(404).json({ error: "File not found" });
    await b2.deleteFileVersion({ fileId: match.fileId, fileName: match.fileName });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Direct Charge (CardCom saved token) ──────────────────────────────

exports.chargeClient = async (req, res) => {
  try {
    const { phone } = req.params;
    const { amount, description = "חיוב - ICONIQ Media", currencyCode } = req.body;
    if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: "amount required" });

    const user = await usersCol().findOne({ phone }, { projection: { paymentToken: 1 } });
    if (!user?.paymentToken) return res.status(400).json({ error: "No saved payment token for this client" });

    const chargeRes = await axios.post(cardcomConfig.doTransactionUrl, {
      TerminalNumber: cardcomConfig.terminal,
      ApiName:        cardcomConfig.apiName,
      ApiPassword:    cardcomConfig.apiPassword,
      Token:          user.paymentToken,
      Amount:         withVAT(parseFloat(amount)),
      ISOCoinId:      currencyCode ?? 1,
      ProductName:    description,
      Operation:      1,
    });

    if (chargeRes.data?.ResponseCode !== 0) throw new Error(chargeRes.data?.Description || "שגיאת חיוב");

    const chargeRow = {
      phone, agentId: String(req.agent._id),
      amount: parseFloat(amount), description,
      transactionId: chargeRes.data?.TranzactionId || null,
      chargedAt: new Date(),
    };
    const { insertedId: chargeId } = await getDB().collection("cpanel_charges").insertOne(chargeRow);

    /* Accrue manager commission immediately — direct token charge already settled. */
    try {
      await commissionSvc.accrueCommission({
        agentId:        chargeRow.agentId,
        clientPhone:    phone,
        baseAmount:     chargeRow.amount,
        sourceKind:     "direct_charge",
        sourceChargeId: String(chargeId),
        transactionId:  chargeRow.transactionId,
        description,
      });
    } catch (err) {
      console.warn("[CPanel] commission accrual (direct charge) failed:", err.message);
    }

    res.json({ success: true, transactionId: chargeRes.data?.TranzactionId });
  } catch (err) {
    console.error("[CPanel] chargeClient:", err.message);
    res.status(500).json({ error: err.response?.data?.Description || err.message });
  }
};

// ── CPanel Appointments ──────────────────────────────────────────────

exports.getCpanelAppointments = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const { from, to } = req.query;
    const filter = { agentId };
    if (from || to) {
      filter.startsAt = {};
      if (from) filter.startsAt.$gte = new Date(from);
      if (to)   filter.startsAt.$lte = new Date(to);
    }
    const appts = await apptCol().find(filter).sort({ startsAt: 1 }).toArray();
    res.json({ appointments: appts.map(a => ({ ...a, id: String(a._id) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createCpanelAppointment = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const { clientPhone, startsAt, durationMin = 60, type = "call", notes = "", status = "pending" } = req.body;
    if (!clientPhone || !startsAt) return res.status(400).json({ error: "clientPhone and startsAt required" });
    const doc = {
      agentId, clientPhone,
      startsAt: new Date(startsAt),
      durationMin: parseInt(durationMin),
      type, notes, status,
      createdAt: new Date(),
    };
    const result = await apptCol().insertOne(doc);
    res.json({ success: true, id: String(result.insertedId), ...doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateCpanelAppointment = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const agentId = String(req.agent._id);
    const { id }  = req.params;
    const { startsAt, durationMin, type, notes, status } = req.body;
    const update  = { updatedAt: new Date() };
    if (startsAt)            update.startsAt    = new Date(startsAt);
    if (durationMin)         update.durationMin = parseInt(durationMin);
    if (type)                update.type        = type;
    if (notes !== undefined) update.notes       = notes;
    if (status)              update.status      = status;
    const result = await apptCol().updateOne({ _id: new ObjectId(id), agentId }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ error: "Appointment not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteCpanelAppointment = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const agentId = String(req.agent._id);
    const { id }  = req.params;
    const result  = await apptCol().deleteOne({ _id: new ObjectId(id), agentId });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Appointment not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Agent Wallet ─────────────────────────────────────────────────────

exports.getWallet = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const summary = await commissionSvc.getAgentWalletSummary(agentId);
    /* Backward-compat: legacy `transactions` field maps to recent commissions
       so existing Dashboard wallet KPI keeps working without an update. */
    res.json({
      ...summary,
      transactions: summary.recent.map(c => ({
        id: c.id,
        amount: c.commissionAmount,
        description: c.description || c.sourceKind,
        date: c.earnedAt,
        phone: c.clientPhone,
      })),
      /* Map totalCharged → totalChargedBase for the legacy AgentWallet shape. */
      totalCharged: summary.totalChargedBase,
    });
  } catch (err) {
    console.error("[CPanel] getWallet:", err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.markCommissionPaid = async (req, res) => {
  try {
    if (req.agent.role !== "admin") return res.status(403).json({ error: "admin only" });
    const out = await commissionSvc.markCommissionPaid(req.params.id, req.agent._id);
    res.json({ commission: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Per-client wallet (commissions earned from this specific client) ──

const VALID_TIERS = ["GOLD", "VIP", "PRO", "PLUS", "SILVER", "REGULAR"];

exports.getClientWallet = async (req, res) => {
  try {
    const { phone } = req.params;
    const agentId   = String(req.agent._id);
    const filter    = { agentId, clientPhone: phone };

    const [commissions, charges, mapping] = await Promise.all([
      getDB().collection("cpanel_commissions").find(filter).sort({ earnedAt: -1 }).limit(100).toArray(),
      getDB().collection("cpanel_charges").find({ agentId, phone }).sort({ chargedAt: -1 }).limit(100).toArray(),
      cpanelClientsCol().findOne({ agentId, phone }, { projection: { tier: 1, tierUpdatedAt: 1, tierUpdatedBy: 1 } }),
    ]);

    const totalEarned = commissions.reduce((s, c) => s + (c.commissionAmount || 0), 0);
    const totalCharged = commissions.reduce((s, c) => s + (c.baseAmount || 0), 0)
                       + charges.reduce((s, c) => s + (c.amount || 0), 0);
    const monthEarned = commissions
      .filter(c => isThisMonth(c.earnedAt))
      .reduce((s, c) => s + (c.commissionAmount || 0), 0);

    res.json({
      tier: mapping?.tier || "REGULAR",
      tierUpdatedAt: mapping?.tierUpdatedAt || null,
      totalEarned,
      totalCharged,
      monthEarned,
      currency: "ILS",
      commissionsCount: commissions.length,
      commissions: commissions.map(c => ({
        id: String(c._id),
        baseAmount: c.baseAmount,
        commissionAmount: c.commissionAmount,
        commissionRate: c.commissionRate,
        sourceKind: c.sourceKind,
        description: c.description,
        earnedAt: c.earnedAt,
        status: c.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function isThisMonth(d) {
  if (!d) return false;
  const x = new Date(d);
  const now = new Date();
  return x.getFullYear() === now.getFullYear() && x.getMonth() === now.getMonth();
}

/**
 * Normalize a package `items` object to the C-panel-canonical shape
 * `{ paidAds, organicAds, lps, videos, logos }`. There are two
 * historical schemas living in the database:
 *   - C-panel iframe flow → `{ paidAds, organicAds, lps, videos, logos }`
 *   - Mobile app verifyPayment / cpanel-products.service → `{ ad, social_ad, lp, video, logo }`
 * Either source can land in users.activePackage / users.purchasedPackages /
 * cpanel_pending_purchases, so callers must normalize before reading. This
 * helper is the single source of truth for that mapping.
 */
function normalizePackageItems(raw) {
  const it = raw || {};
  return {
    paidAds:         Number(it.paidAds         ?? it.ad          ?? 0) || 0,
    organicAds:      Number(it.organicAds      ?? it.social_ad   ?? it.socialAd ?? 0) || 0,
    lps:             Number(it.lps             ?? it.lp          ?? 0) || 0,
    videos:          Number(it.videos          ?? it.video       ?? 0) || 0,
    logos:           Number(it.logos           ?? it.logo        ?? 0) || 0,
    campaignTraffic: Number(it.campaign_traffic ?? it.campaignTraffic ?? 0) || 0,
    campaignLeads:   Number(it.campaign_leads   ?? it.campaignLeads   ?? 0) || 0,
    saleWebsite:     Number(it.saleWebsite      ?? it.sale_site       ?? 0) || 0,
  };
}
exports.normalizePackageItems = normalizePackageItems;

/* Build an activePackage object from a completed cpanel_pending_purchases row.
   Same shape paymentNotify writes — keep the two in sync. */
function activePackageFromPending(p) {
  const coins = Number.isFinite(p.coinsOverride) && p.coinsOverride > 0
    ? p.coinsOverride
    : (p.kind === "coins" ? 0 : 700);
  return {
    id:          p.kind || "custom",
    name:        p.description || p.name || "חבילה",
    purchasedAt: (p.completedAt || p.createdAt || new Date()).toISOString
                   ? (p.completedAt || p.createdAt || new Date()).toISOString()
                   : new Date(p.completedAt || p.createdAt || Date.now()).toISOString(),
    items: {
      paidAds:     p.adsCount          || 0,
      organicAds:  (p.socialAdsCount   || 0) + (p.organicPosts || 0),
      videos:      p.videosCount       || 0,
      lps:         p.landingPagesCount || 0,
      logos:       p.logosCount        || 0,
      saleWebsite: p.saleSiteCount     || 0,
    },
    coins,
    /* Lifecycle: waiting_brief → sent_to_creation → ... → completed.
       Manager advances via PATCH /api/client/project-detail/:id/status. */
    status: "waiting_brief",
  };
}

/* POST /cpanel/clients/:phone/replay-cardcom
   Auth-gated rescue endpoint. Body is the raw Cardcom transaction JSON
   (v10 flat or v11 nested, array or object). Runs paymentNotify-equivalent
   logic so a paid-but-stuck customer gets their package, token, commission. */
exports.replayCardcomTransaction = async (req, res) => {
  try {
    const { phone } = req.params;
    const { LowProfileId, Token, Last4Digits, ExpDate } = normalizeCardcomPayload(req.body);

    if (!Token)        return res.status(400).json({ error: "Token missing in payload" });
    if (!LowProfileId) return res.status(400).json({ error: "LowProfileId missing in payload" });

    /* Save card token. */
    await usersCol().updateOne(
      { phone },
      { $set: { paymentToken: Token, paymentLast4: Last4Digits || null, paymentExpiry: ExpDate || null } },
      { upsert: true },
    );

    /* Find the pending row. Allow already-completed rows to be replayed
       (idempotent — won't re-credit coins because we check user.activePackage). */
    const pending = await getDB().collection("cpanel_pending_purchases")
      .findOne({ lowProfileId: LowProfileId });

    if (!pending) {
      return res.status(404).json({
        error: "No cpanel_pending_purchases row matches this LowProfileId.",
        LowProfileId,
        hint:  "The payment-link / iframe was never created on our side, or the LowProfileId doesn't match.",
      });
    }

    if (pending.phone !== phone) {
      return res.status(400).json({
        error: "Phone in URL does not match phone on the pending row.",
        urlPhone:     phone,
        pendingPhone: pending.phone,
      });
    }

    const userBefore = await usersCol().findOne({ phone }, { projection: { activePackage: 1, coins: 1 } });

    const isPackagePurchase =
      pending.kind === "package" || pending.kind === "coins" ||
      !!pending.adsCount || !!pending.landingPagesCount ||
      !!pending.videosCount || !!pending.logosCount || !!pending.socialAdsCount;

    let pkgWritten = null;

    if (isPackagePurchase) {
      const coins = Number.isFinite(pending.coinsOverride) && pending.coinsOverride > 0
        ? pending.coinsOverride
        : (pending.kind === "coins" ? 0 : 700);

      const activePackage = activePackageFromPending(pending);
      activePackage.coins = coins;
      pkgWritten = activePackage;

      const update = { $set: { activePackage } };
      const alreadyHasSamePackage = userBefore && userBefore.activePackage &&
        userBefore.activePackage.id === activePackage.id;
      if (coins > 0 && !alreadyHasSamePackage) update.$inc = { coins };

      await usersCol().updateOne({ phone }, update, { upsert: true });
    }

    if (!pending.completedAt) {
      await getDB().collection("cpanel_pending_purchases")
        .updateOne({ lowProfileId: LowProfileId }, { $set: { completedAt: new Date() } });
    }

    /* Manager commission — same logic as paymentNotify. Idempotent via sourceChargeId. */
    let commissionAccrued = false;
    try {
      const baseAmount = pending.amount || pending.totalAmount;
      if (pending.agentId && baseAmount) {
        await commissionSvc.accrueCommission({
          agentId:        pending.agentId,
          clientPhone:    pending.phone,
          baseAmount,
          sourceKind:     pending.kind === "payment_link" ? "payment_link" : "package",
          sourceChargeId: `pending:${LowProfileId}`,
          description:    pending.description || (pending.kind === "package" ? "חבילה" : "תשלום"),
        });
        commissionAccrued = true;
      }
    } catch (err) {
      console.warn("[CPanel] commission accrual (replay) failed:", err.message);
    }

    res.json({
      success: true,
      phone,
      LowProfileId,
      tokenSaved: true,
      paymentLast4: Last4Digits,
      packageWritten: pkgWritten,
      pendingMarkedComplete: true,
      commissionAccrued,
    });
  } catch (err) {
    console.error("[CPanel] replayCardcomTransaction:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /cpanel/clients/:phone/package-debug
   Lists raw pending-purchase rows + user record for a phone — used to
   diagnose "client paid but products tab empty" cases. Auth-gated. */
exports.getClientPackageDebug = async (req, res) => {
  try {
    const { phone } = req.params;
    const [user, pending] = await Promise.all([
      usersCol().findOne({ phone }, { projection: { activePackage: 1, coins: 1, coinsUsed: 1, paymentToken: 1, paymentLast4: 1 } }),
      getDB().collection("cpanel_pending_purchases").find({ phone }).sort({ createdAt: -1 }).limit(10).toArray(),
    ]);
    res.json({
      phone,
      user: user ? {
        hasActivePackage: !!user.activePackage,
        activePackage:    user.activePackage || null,
        coins:            user.coins || 0,
        coinsUsed:        user.coinsUsed || 0,
        hasPaymentToken:  !!user.paymentToken,
        paymentLast4:     user.paymentLast4 || null,
      } : null,
      pendingPurchases: pending.map(p => ({
        _id:           String(p._id),
        lowProfileId:  p.lowProfileId,
        kind:          p.kind,
        description:   p.description,
        totalAmount:   p.totalAmount,
        adsCount:      p.adsCount,
        landingPagesCount: p.landingPagesCount,
        videosCount:   p.videosCount,
        logosCount:    p.logosCount,
        socialAdsCount: p.socialAdsCount,
        organicPosts:  p.organicPosts,
        coinsOverride: p.coinsOverride,
        createdAt:     p.createdAt,
        completedAt:   p.completedAt || null,
        completed:     !!p.completedAt,
      })),
    });
  } catch (err) {
    console.error("[CPanel] getClientPackageDebug:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /cpanel/clients/:phone/package
   Returns the active package for a client, or 404 if none. Self-heals: if the
   user has a completed cpanel_pending_purchases but no users.activePackage
   (because they paid before paymentNotify was patched), this writes the
   activePackage on read and returns it. */
exports.getClientPackage = async (req, res) => {
  try {
    const { phone } = req.params;
    let user = await usersCol().findOne(
      { phone },
      { projection: { activePackage: 1, coins: 1, coinsUsed: 1 } },
    );

    let pkg = user && user.activePackage;

    /* Self-heal from most recent completed pending purchase. */
    if (!pkg) {
      const pending = await getDB().collection("cpanel_pending_purchases")
        .find({ phone, completedAt: { $exists: true } })
        .sort({ completedAt: -1 })
        .limit(1)
        .toArray();

      if (pending[0]) {
        pkg = activePackageFromPending(pending[0]);
        const update = { $set: { activePackage: pkg } };
        /* Only credit coins on backfill if the user has none — otherwise the
           paymentNotify run that created the (missing) activePackage already
           credited them and we'd double-pay. */
        const hasNoCoins = !user || !Number.isFinite(user.coins) || user.coins === 0;
        if (hasNoCoins && pkg.coins > 0) update.$inc = { coins: pkg.coins };

        await usersCol().updateOne({ phone }, update, { upsert: true });
        console.log(`[CPanel] activePackage self-healed for ${phone}: ${pkg.name} (from pending ${pending[0]._id})`);

        user = await usersCol().findOne(
          { phone },
          { projection: { activePackage: 1, coins: 1, coinsUsed: 1 } },
        );
      }
    }

    if (!pkg) {
      return res.status(404).json({ error: "No active package for this client." });
    }

    const coins         = Number.isFinite(user?.coins)     ? user.coins     : (pkg.coins || 0);
    const coinsUsed     = Number.isFinite(user?.coinsUsed) ? user.coinsUsed : 0;
    const coinsRemaining = Math.max(0, coins - coinsUsed);

    return res.json({
      id:             pkg.id,
      name:           pkg.name,
      purchasedAt:    pkg.purchasedAt,
      items:          normalizePackageItems(pkg.items),
      coins:          pkg.coins || 0,
      coinsUsed,
      coinsRemaining,
      /* Services already redeemed by spending coins. Each entry =
         the manager debited COIN_REDEEM_COSTS[service] from the
         client's balance and tied the new service slot to a
         specific approved-ads slotKey (so the launch button knows
         which creatives to push). */
      coinRedemptions: Array.isArray(pkg.coinRedemptions) ? pkg.coinRedemptions : [],
    });
  } catch (err) {
    console.error("[CPanel] getClientPackage:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/coin-redeem ───────────────────────
   Manager spends the client's existing coin balance on a service
   slot WITHOUT selling a new package. Each redemption costs
   COIN_REDEEM_COSTS[service] (1000 coins per the user's rate card)
   and links to a specific approved-ads slotKey that the launch
   button will use as the creative source.

   Body:
     {
       service: "campaign_leads" | "campaign_traffic" | "social_ad_10",
       sourceAdsSlotKey: string,   // slotKey of an existing wow-ads
                                   // session that has approved ads
     }

   Steps:
     1. Validate user has activePackage.
     2. Validate balance >= cost.
     3. Validate sourceAdsSlotKey has approved ads.
     4. Atomic:
          $inc { coinsUsed: cost }
          $push { activePackage.coinRedemptions: { service,
                  sourceAdsSlotKey, redeemedAt, redeemedBy } }
     5. Return new balance + redemption record. */
const COIN_REDEEM_COSTS = {
  campaign_leads:   1000,
  campaign_traffic: 1000,
  social_ad_10:     1000,
};

/* Map redeem-service → which activePackage.items field to bump and
   by how much. After the increment, the existing ProductsTab logic
   renders a new section for the slot exactly like a package-purchased
   one — manager generates ads, approves, launches, no special
   plumbing needed. */
const COIN_REDEEM_ITEM_INC = {
  campaign_leads:   { "activePackage.items.campaign_leads":   1 },
  campaign_traffic: { "activePackage.items.campaign_traffic": 1 },
  /* Social pack adds 10 organic posts to the existing organicAds
     bucket — that's what the organic panel reads to gate
     generation. */
  social_ad_10:     { "activePackage.items.organicAds":      10 },
};

exports.coinRedeem = async (req, res) => {
  try {
    const { phone } = req.params;
    const service = String(req.body?.service || "").trim();

    // Truthiness on the rate card doubles as the supported-service check, so the
    // table itself must keep its prices — the redemption is zeroed here instead.
    if (!COIN_REDEEM_COSTS[service]) {
      return res.status(400).json({ error: `שירות לא נתמך: ${service}` });
    }
    const cost = billingEnabled() ? COIN_REDEEM_COSTS[service] : 0;

    const usersCol = () => getDB().collection("users");

    const user = await usersCol().findOne(
      { phone },
      { projection: { activePackage: 1, coins: 1, coinsUsed: 1 } },
    );
    if (!user) return res.status(404).json({ error: "לקוח לא נמצא" });

    /* Balance check is on user-level coins/coinsUsed — works whether
       or not the client has an activePackage. If they bought a coin
       pack via the app without an associated service package, the
       coins live on user.coins regardless. */
    const coins = Number(user.coins || user.activePackage?.coins || 0);
    const used  = Number(user.coinsUsed || 0);
    const balance = Math.max(0, coins - used);
    if (balance < cost) {
      return res.status(400).json({
        error: `יתרת מטבעות לא מספיקה (${balance} / נדרש ${cost})`,
        code: "INSUFFICIENT_COINS",
      });
    }

    const itemInc = COIN_REDEEM_ITEM_INC[service] || {};
    const redemption = {
      service,
      cost,
      redeemedAt: new Date(),
      redeemedBy: req.user?.id || req.user?.name || null,
    };

    /* No activePackage yet — auto-init a minimal one so the matching
       items field has somewhere to land. ProductsTab and the
       package-banner UI both key off activePackage.items so without
       this the new section never appears. */
    if (!user.activePackage) {
      await usersCol().updateOne(
        { phone },
        {
          $set: {
            activePackage: {
              id:          "coin_wallet",
              name:        "ארנק מטבעות",
              purchasedAt: new Date(),
              items:       {},
              coins:       coins,
              status:      "waiting_brief",
            },
          },
        },
      );
      console.log(`[CPanel] coin-redeem auto-initialized activePackage for ${phone}`);
    }

    await usersCol().updateOne(
      { phone },
      {
        $inc:  { coinsUsed: cost, ...itemInc },
        $push: { "activePackage.coinRedemptions": redemption },
      },
    );

    console.log(`[CPanel] coin-redeem for ${phone}: -${cost} coins → ${service} (items +${JSON.stringify(itemInc)})`);

    return res.json({
      success:         true,
      service,
      cost,
      coinsRemaining:  balance - cost,
      redemption,
    });
  } catch (err) {
    console.error("[CPanel] coinRedeem:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /cpanel/clients/:phone/coins ────────────────────────────────
   Lightweight coin-balance read that works even when the client has
   no activePackage. The catalog tab uses this to gate the '🪙 מימוש
   מטבעות' button without depending on a full active-package response
   that 404s for coins-only clients. */
exports.getClientCoins = async (req, res) => {
  try {
    const { phone } = req.params;
    const usersCol = () => getDB().collection("users");
    const user = await usersCol().findOne(
      { phone },
      { projection: { coins: 1, coinsUsed: 1, activePackage: 1 } },
    );
    if (!user) return res.json({ coins: 0, coinsUsed: 0, coinsRemaining: 0 });
    const coins = Number(user.coins || user.activePackage?.coins || 0);
    const coinsUsed = Number(user.coinsUsed || 0);
    res.json({
      coins,
      coinsUsed,
      coinsRemaining: Math.max(0, coins - coinsUsed),
    });
  } catch (err) {
    console.error("[CPanel] getClientCoins:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /cpanel/clients/:phone/wow-ads/approved-slots ──────────────
   Enumerate every wow_ads_sessions row for the client and return
   the ones that have ≥1 manager-approved ad. The "redeem coins"
   modal uses this list as the dropdown options for "where do the
   creatives come from". */
exports.getApprovedAdsSlots = async (req, res) => {
  try {
    const { phone } = req.params;
    const sessCol = () => getDB().collection("wow_ads_sessions");
    const rows = await sessCol().find(
      { phone, generatedAds: { $exists: true } },
      { projection: { sessionId: 1, slotKey: 1, generatedAds: 1, campaignName: 1, updatedAt: 1, createdAt: 1 } },
    ).sort({ updatedAt: -1 }).toArray();

    const slots = rows
      .map(r => {
        const approvedCount = (r.generatedAds || []).filter(a => a.managerApproved).length;
        return {
          slotKey:       r.slotKey || "__default__",
          sessionId:     r.sessionId,
          campaignName:  r.campaignName || null,
          approvedCount,
          totalAds:      (r.generatedAds || []).length,
          updatedAt:     r.updatedAt || r.createdAt || null,
        };
      })
      .filter(s => s.approvedCount > 0);

    res.json({ slots });
  } catch (err) {
    console.error("[CPanel] getApprovedAdsSlots:", err);
    res.status(500).json({ error: err.message });
  }
};

/* GET /cpanel/clients/:phone/wow-ads/campaign-sessions
   Lists all "campaign מיוחד" sessions for a client — i.e. wow_ads
   sessions whose slotKey was generated by the manager pressing the
   campaign-מיוחד button. Identified by the slotKey pattern:
     campaign_<base36>_<base36>   — special-campaign slot
   Excludes the predefined package slots:
     campaign_leads_<n>, campaign_traffic_<n>, campaign_brief_*,
     legacy_paid_ads.

   Filtering by slotKey shape rather than by `campaignName` because
   the latter isn't always persisted to the session document by the
   pipeline (would require a pipeline change we're not allowed to
   make). The slotKey, in contrast, lands in the DB the moment the
   session row is created.

   Used by the Products tab to render an independent panel per
   special-campaign session, separate from the package slots. */
exports.listCampaignSessions = async (req, res) => {
  try {
    const { phone } = req.params;
    const sessCol = () => getDB().collection("wow_ads_sessions");
    const rows = await sessCol().find(
      { phone, slotKey: { $regex: /^campaign_/ } },
      {
        projection: {
          sessionId: 1, slotKey: 1, campaignName: 1, status: 1,
          completedCount: 1, generatedAds: 1, createdAt: 1, updatedAt: 1,
        },
      },
    ).sort({ createdAt: -1 }).toArray();

    const isPackageSlot = (k) =>
      /^campaign_(?:leads|traffic|brief)(_|$)/.test(k) ||
      k === "legacy_paid_ads";

    const sessions = rows
      .filter(r => r.slotKey && !isPackageSlot(r.slotKey))
      .map(r => ({
        slotKey:        r.slotKey,
        sessionId:      r.sessionId,
        campaignName:   r.campaignName || "קמפיין מיוחד",
        status:         r.status || null,
        adCount:        (r.generatedAds || []).length,
        completedCount: r.completedCount || (r.generatedAds || []).filter(a => a.imageUrl).length,
        approvedCount:  (r.generatedAds || []).filter(a => a.managerApprovedAt).length,
        createdAt:      r.createdAt || null,
        updatedAt:      r.updatedAt || null,
      }));

    res.json({ sessions });
  } catch (err) {
    console.error("[CPanel] listCampaignSessions:", err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /cpanel/clients/:phone/packages
 *
 * Returns the COMPLETE purchase history for a client — every completed
 * cpanel_pending_purchases row, decorated to look like an activePackage
 * (same shape: id, name, purchasedAt, items, coins). The most recent
 * one is also marked `isActive: true` so the frontend can highlight it.
 *
 * The frontend uses this for the "all the packages I've bought" view —
 * each package gets its own card on the products screen. Drilling into
 * an active package shows live regenerate-able products; drilling into
 * an old one shows a read-only historical record.
 */
exports.listClientPackages = async (req, res) => {
  try {
    const phone = String(req.params.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });

    /* Primary source: cpanel_pending_purchases (the canonical purchase log).
       Secondary source: users.purchasedPackages[] — the mobile-app flow
       pushed here before we taught it to also write to cpanel_pending_purchases,
       so legacy mobile purchases live only on the user doc. We merge both
       and dedupe by purchasedAt so already-lost packages reappear. */
    const [pending, user] = await Promise.all([
      getDB().collection("cpanel_pending_purchases")
        .find({
          phone,
          completedAt: { $exists: true },
          /* Skip pure-coins purchases — no items to drill into. */
          kind: { $in: ["package", "custom"] },
        })
        .sort({ completedAt: -1 })
        .limit(50)
        .toArray(),
      getDB().collection("users")
        .findOne({ phone }, { projection: { purchasedPackages: 1 } }),
    ]);

    const packages = pending.map(p => {
      const pkg = activePackageFromPending(p);
      return {
        ...pkg,
        purchaseId: String(p._id),
        /* Stable client-side ID matching frontend's buildPkgId — this is
           the same convention used by getProjectDetail for per-package
           lifecycle tracking. */
        pkgId: `pkg_${pkg.id || "custom"}_${pkg.purchasedAt.replace(/[:.]/g, "-")}`,
        totalAmount: p.totalAmount || 0,
        kind:        p.kind,
        source:      p.source || "cpanel",
      };
    });

    /* Backfill from users.purchasedPackages[]. Dedupe on purchasedAt
       (ISO string) — that's the only stable identifier shared by both
       collections. Anything within 2s is treated as the same purchase
       to absorb clock-skew between the two write paths. */
    const seenAtMs = new Set(packages.map(p => Date.parse(p.purchasedAt)).filter(Number.isFinite));
    const isDup = (atMs) => {
      for (const m of seenAtMs) if (Math.abs(m - atMs) < 2000) return true;
      return false;
    };
    for (const entry of (user?.purchasedPackages || [])) {
      if (!entry?.purchasedAt) continue;
      const atMs = Date.parse(entry.purchasedAt);
      if (!Number.isFinite(atMs) || isDup(atMs)) continue;
      /* Legacy entries from packages.controller.verifyPayment use the
         mobile-flow item shape `{ ad, social_ad, lp, video, logo }`.
         normalizePackageItems handles both old and new field names so
         the UI's "ללא פריטים" stops lying. */
      const coinsAlsoUnderItems = Number(entry?.items?.coins) || 0;
      packages.push({
        id:          entry.key || "custom",
        name:        entry.name || "חבילה",
        purchasedAt: entry.purchasedAt,
        items:       normalizePackageItems(entry.items),
        coins:       Number(entry.coins) || coinsAlsoUnderItems || 0,
        status:      entry.status || "completed",
        purchaseId:  `legacy_${entry.purchasedAt}`,
        pkgId:       `pkg_${entry.key || "custom"}_${entry.purchasedAt.replace(/[:.]/g, "-")}`,
        totalAmount: 0,
        kind:        "package",
        source:      "mobile_legacy",
      });
      seenAtMs.add(atMs);
    }

    /* Newest first, then mark only the latest as active. */
    packages.sort((a, b) => Date.parse(b.purchasedAt) - Date.parse(a.purchasedAt));
    packages.forEach((p, i) => { p.isActive = i === 0; });

    res.json({ packages, total: packages.length });
  } catch (err) {
    console.error("[CPanel] listClientPackages:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /cpanel/clients/:phone/packages/:pkgId/products
 *
 * Read-only view of the products (ads/organic posts/landing page) that
 * were generated under a SPECIFIC package — the per-package drill-down
 * older-package cards expand into.
 *
 * Matching strategy is two-tiered:
 *   1. PREFERRED — sessions whose `packageId` matches the requested
 *      `pkgId`. This is reliable for any session generated after the
 *      packageId-tagging feature shipped (2026-05-10).
 *   2. FALLBACK — sessions created in the time window between this
 *      package's purchasedAt and the next package's purchasedAt (or
 *      "now" if this is the latest). Covers legacy untagged sessions
 *      from before packageId existed.
 *
 * Returns the LATEST matching session per pipeline. Payload shape mirrors
 * the existing getWowAds / getOrganicAds / getLp endpoints (read-only —
 * the frontend renders thumbnails + copy without regenerate buttons).
 */
exports.getClientPackageProducts = async (req, res) => {
  try {
    const phone = String(req.params.phone || "").trim();
    const pkgId = String(req.params.pkgId || "").trim();
    if (!phone || !pkgId) return res.status(400).json({ error: "phone and pkgId required" });

    /* Step 1 — rebuild the merged package list so we can compute the time
       window for the requested pkgId. We can't trust client-supplied
       window bounds; they must derive from the canonical data. */
    const [pending, user] = await Promise.all([
      getDB().collection("cpanel_pending_purchases")
        .find({ phone, completedAt: { $exists: true }, kind: { $in: ["package", "custom"] } })
        .sort({ completedAt: -1 })
        .limit(50)
        .toArray(),
      getDB().collection("users").findOne({ phone }, { projection: { purchasedPackages: 1 } }),
    ]);

    const itemsSum = (items) => {
      const it = normalizePackageItems(items);
      return it.paidAds + it.organicAds + it.videos + it.lps + it.logos;
    };

    const merged = [];
    for (const p of pending) {
      const pkg = activePackageFromPending(p);
      merged.push({
        pkgId:       `pkg_${pkg.id || "custom"}_${pkg.purchasedAt.replace(/[:.]/g, "-")}`,
        purchasedAt: pkg.purchasedAt,
        hasItems:    itemsSum(pkg.items) > 0,
      });
    }
    const seenAtMs = new Set(merged.map(p => Date.parse(p.purchasedAt)).filter(Number.isFinite));
    for (const entry of (user?.purchasedPackages || [])) {
      if (!entry?.purchasedAt) continue;
      const atMs = Date.parse(entry.purchasedAt);
      if (!Number.isFinite(atMs)) continue;
      let dup = false;
      for (const m of seenAtMs) { if (Math.abs(m - atMs) < 2000) { dup = true; break; } }
      if (dup) continue;
      /* normalizePackageItems makes itemsSum see legacy mobile-shape
         items ({ad, social_ad, ...}). Without it every mobile-purchased
         package looked like a coin top-up and the window-extension logic
         skipped right past them. */
      merged.push({
        pkgId:       `pkg_${entry.key || "custom"}_${entry.purchasedAt.replace(/[:.]/g, "-")}`,
        purchasedAt: entry.purchasedAt,
        hasItems:    itemsSum(entry.items) > 0,
      });
      seenAtMs.add(atMs);
    }
    merged.sort((a, b) => Date.parse(a.purchasedAt) - Date.parse(b.purchasedAt));   // oldest → newest

    const idx = merged.findIndex(p => p.pkgId === pkgId);
    if (idx === -1) return res.status(404).json({ error: "package not found for this client" });

    /* Walk forward past coin-only entries when picking the upper bound
       (a coin top-up between two product packages is a passthrough —
       sessions generated after it still belong to the previous product
       package's allocation).

       For the lower bound: by default this package's own purchasedAt.
       EXCEPTION — if this is the FIRST product-bearing package in the
       client's history, extend lowerMs back to epoch. That's because
       real sales flows have the manager building products *in
       anticipation* of the customer paying (multiple iframe retries,
       quote-then-charge, etc.), and those pre-payment sessions
       legitimately belong to the package that eventually completed.
       Only safe for the first package — for any later one, sessions
       before its purchasedAt belong to an earlier package, not this. */
    let isFirstProductPkg = true;
    for (let i = 0; i < idx; i++) {
      if (merged[i].hasItems) { isFirstProductPkg = false; break; }
    }
    const lowerMs = isFirstProductPkg ? 0 : Date.parse(merged[idx].purchasedAt);
    let upperMs = Date.now() + 365 * 24 * 3600 * 1000;
    for (let i = idx + 1; i < merged.length; i++) {
      if (merged[i].hasItems) {
        upperMs = Date.parse(merged[i].purchasedAt);
        break;
      }
    }
    if (!Number.isFinite(lowerMs)) return res.status(500).json({ error: "invalid purchasedAt on package" });

    /* Step 2 — find the latest session per pipeline that EITHER matches
       packageId exactly OR falls in the time window. Two queries per
       collection (packageId path + time-window path); we then pick the
       newest among them. */
    const pickSession = async (collName) => {
      const col = getDB().collection(collName);
      /* Tagged path: exact packageId match — always reliable. No time
         constraint here so a manager who regenerated a single ad two
         weeks later still sees their per-package view correctly.

         Windowed path: phone + createdAt in window, regardless of
         packageId. Previously this excluded any session with a non-null
         packageId, which silently dropped legacy sessions that got
         mis-tagged (e.g., tagged with the *currently active* package
         instead of the one they were generated under). Now any session
         whose createdAt falls in this package's window is a candidate.

         Dedup happens naturally: if a session matches BOTH queries we
         sort all candidates by createdAt and return the newest. */
      const [tagged, windowed] = await Promise.all([
        col.find({ phone, packageId: pkgId }).sort({ createdAt: -1 }).limit(3).toArray(),
        col.find({
          phone,
          createdAt: { $gte: new Date(lowerMs), $lt: new Date(upperMs) },
        }).sort({ createdAt: -1 }).limit(3).toArray(),
      ]);
      const byId = new Map();
      for (const s of [...tagged, ...windowed]) {
        const k = s.sessionId || String(s._id);
        if (!byId.has(k)) byId.set(k, s);
      }
      const cands = [...byId.values()];
      if (cands.length === 0) return null;
      cands.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return cands[0];
    };

    const [adsSess, organicSess, lpSess] = await Promise.all([
      pickSession("wow_ads_sessions"),
      pickSession("wow_organic_ads_sessions"),
      pickSession("wow_lp_sessions"),
    ]);

    /* If nothing matched in ANY pipeline, run a diagnostic count across
       the same window so we can tell the difference between "no sessions
       exist" and "sessions exist but query missed them." Surface that in
       the response under `debug` so the UI can show a precise hint. */
    let debug = null;
    if (!adsSess && !organicSess && !lpSess) {
      try {
        const winRange = { $gte: new Date(lowerMs), $lt: new Date(upperMs) };
        const [adsAll, adsInWin, orgAll, orgInWin, lpAll, lpInWin] = await Promise.all([
          getDB().collection("wow_ads_sessions").countDocuments({ phone }),
          getDB().collection("wow_ads_sessions").countDocuments({ phone, createdAt: winRange }),
          getDB().collection("wow_organic_ads_sessions").countDocuments({ phone }),
          getDB().collection("wow_organic_ads_sessions").countDocuments({ phone, createdAt: winRange }),
          getDB().collection("wow_lp_sessions").countDocuments({ phone }),
          getDB().collection("wow_lp_sessions").countDocuments({ phone, createdAt: winRange }),
        ]);
        debug = {
          adsTotal: adsAll, adsInWindow: adsInWin,
          organicTotal: orgAll, organicInWindow: orgInWin,
          lpTotal: lpAll, lpInWindow: lpInWin,
        };
        console.warn(`[CPanel] getClientPackageProducts ${phone} ${pkgId} empty: window=[${new Date(lowerMs).toISOString()}, ${new Date(upperMs).toISOString()}) totals ads=${adsAll}/${adsInWin} organic=${orgAll}/${orgInWin} lp=${lpAll}/${lpInWin}`);
      } catch (_e) { /* diagnostics are best-effort */ }
    } else {
      console.log(`[CPanel] getClientPackageProducts ${phone} ${pkgId}: window=[${new Date(lowerMs).toISOString()}, ${new Date(upperMs).toISOString()}) → ads=${adsSess?.sessionId || "none"} organic=${organicSess?.sessionId || "none"} lp=${lpSess?.sessionId || "none"}`);
    }

    res.json({
      pkgId,
      window: { from: new Date(lowerMs).toISOString(), to: new Date(upperMs).toISOString() },
      debug,
      ads: adsSess && {
        sessionId:      adsSess.sessionId,
        status:         adsSess.status,
        totalAds:       adsSess.totalAds,
        completedCount: adsSess.completedCount,
        generatedAds:   adsSess.generatedAds || [],
        createdAt:      adsSess.createdAt,
        packageId:      adsSess.packageId || null,
      },
      organic: organicSess && {
        sessionId:       organicSess.sessionId,
        status:          organicSess.status,
        totalPosts:      organicSess.totalPosts,
        completedCount:  organicSess.completedCount,
        generatedPosts:  organicSess.generatedPosts || [],
        createdAt:       organicSess.createdAt,
        packageId:       organicSess.packageId || null,
      },
      lp: lpSess && {
        sessionId:  lpSess.sessionId,
        status:     lpSess.status,
        lp:         lpSess.lp || null,
        slug:       lpSess.slug || null,
        previewUrl: lpSess.previewUrl || null,
        createdAt:  lpSess.createdAt,
        packageId:  lpSess.packageId || null,
      },
    });
  } catch (err) {
    console.error("[CPanel] getClientPackageProducts:", err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.setClientTier = async (req, res) => {
  try {
    const { phone } = req.params;
    const { tier }  = req.body || {};
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({ error: `tier must be one of ${VALID_TIERS.join(", ")}` });
    }
    const agentId = String(req.agent._id);
    await cpanelClientsCol().updateOne(
      { agentId, phone },
      {
        $set: {
          tier,
          tierUpdatedAt: new Date(),
          tierUpdatedBy: agentId,
        },
      }
    );
    res.json({ success: true, tier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Logs ─────────────────────────────────────────────────────────────

exports.getCpanelLogs = async (req, res) => {
  try {
    const agentId   = String(req.agent._id);
    const limit     = Math.min(parseInt(req.query.limit) || 100, 500);
    const range     = String(req.query.range || "24h");
    const since = (() => {
      const m = range.match(/^(\d+)([hd])$/);
      if (!m) return null;
      const n = parseInt(m[1], 10);
      const ms = m[2] === "h" ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
      return new Date(Date.now() - ms);
    })();

    const myClients = await cpanelClientsCol().find({ agentId }, { projection: { phone: 1, name: 1 } }).toArray();
    const phones    = myClients.map(c => c.phone);
    const nameMap   = Object.fromEntries(myClients.map(c => [c.phone, c.name || ""]));
    if (!phones.length) return res.json({ events: [], scanned: 0, total: 0 });

    const filter = { phone: { $in: phones } };
    if (req.query.clientPhone) filter.phone = String(req.query.clientPhone);
    if (req.query.type) filter.type = String(req.query.type);
    if (since) filter.createdAt = { $gte: since };

    const events = await getDB().collection("app_activity")
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    // Enrich each event with the client name for the unified view
    const enriched = events.map(e => ({ ...e, clientName: nameMap[e.phone] || "" }));
    res.json({ events: enriched, scanned: phones.length, total: phones.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Tasks (manager personal tasks, persisted in Mongo) ──────────────

const tasksCol = () => getDB().collection("cpanel_tasks");

/* Map of status → task UI metadata + minimum elapsed hours before a task
   surfaces. Statuses NOT in this map (client_approved / completed) do not
   produce a task. */
const TASK_DEFS = {
  waiting_brief:               { label: "השלמת איפיון",         desc: "לקוח שילם, האיפיון לא הושלם",     minHours: 0  },
  sent_to_creation:            { label: "יצירת מוצרים",         desc: "איפיון הושלם, מוצרים לא נוצרו",   minHours: 4  },
  waiting_manager_approval:    { label: "אישור תוצרים",         desc: "מוצרים מוכנים לאישור המנהל",      minHours: 0  },
  sent_to_client:              { label: "לקוח לא הגיב",         desc: "שלחנו ללקוח, לא קיבלנו תגובה",   minHours: 24 },
  client_returned_corrections: { label: "תיקוני לקוח ממתינים", desc: "הלקוח החזיר תיקונים — יש לטפל",   minHours: 0  },
  in_correction:               { label: "השלמת תיקונים",        desc: "בתיקון — לא הוחזר ללקוח",         minHours: 24 },
  corrections_done:            { label: "שלח שוב ללקוח",        desc: "תיקונים הושלמו, טרם נשלח",        minHours: 0  },
};

function computeTaskUrgency(h) {
  if (h <  24) return "normal";
  if (h <  48) return "yellow";
  if (h <  72) return "orange";
  if (h < 120) return "red";
  return "blink";
}

/* GET /cpanel/tasks — auto-derived tasks for the calling manager.
   Each client of theirs whose activePackage is in an actionable status
   (and has been there long enough to surface) becomes one task. */
exports.getTasks = async (req, res) => {
  try {
    const agentId = String(req.agent._id);

    const clientRows = await cpanelClientsCol()
      .find({ agentId }, { projection: { phone: 1, customerName: 1 } })
      .toArray();
    if (!clientRows.length) {
      return res.json({ tasks: [], total: 0, byUrgency: { normal: 0, yellow: 0, orange: 0, red: 0, blink: 0 } });
    }

    const phones  = clientRows.map(r => r.phone);
    const nameMap = Object.fromEntries(clientRows.map(r => [r.phone, r.customerName || r.phone]));

    const users = await usersCol()
      .find(
        { phone: { $in: phones }, activePackage: { $exists: true } },
        { projection: { phone: 1, activePackage: 1 } },
      )
      .toArray();

    const now   = Date.now();
    const tasks = [];

    for (const user of users) {
      const pkg    = user.activePackage;
      const status = pkg.status || "waiting_brief";
      const def    = TASK_DEFS[status];
      if (!def) continue;  /* client_approved / completed → no task */

      const since = new Date(pkg.statusUpdatedAt || pkg.purchasedAt || now).getTime();
      const elapsedHours = (now - since) / 3_600_000;
      if (elapsedHours < def.minHours) continue;

      tasks.push({
        id:           `${user.phone}_${status}`,
        clientPhone:  user.phone,
        clientName:   nameMap[user.phone] || user.phone,
        packageName:  pkg.name || "חבילה",
        taskType:     status,
        taskLabel:    def.label,
        description:  def.desc,
        since:        new Date(since).toISOString(),
        elapsedHours: Math.floor(elapsedHours),
        urgency:      computeTaskUrgency(elapsedHours),
      });
    }

    /* blink first → red → orange → yellow → normal · within each, oldest first */
    const URGENCY_ORDER = { blink: 0, red: 1, orange: 2, yellow: 3, normal: 4 };
    tasks.sort((a, b) => {
      const ud = (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9);
      if (ud !== 0) return ud;
      return b.elapsedHours - a.elapsedHours;
    });

    const byUrgency = { normal: 0, yellow: 0, orange: 0, red: 0, blink: 0 };
    tasks.forEach(t => { byUrgency[t.urgency]++; });

    res.json({ tasks, total: tasks.length, byUrgency });
  } catch (err) {
    console.error("[CPanel] getTasks:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* Legacy personal-tasks endpoints (POST/PATCH/DELETE on /tasks). Kept for
   backward compat; UI no longer uses them after the auto-tasks rebuild. */
exports.listTasks = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const tasks = await tasksCol().find({ agentId }).sort({ done: 1, dueAt: 1 }).limit(500).toArray();
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createTask = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const { title, description, dueAt, clientPhone } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    if (!dueAt)         return res.status(400).json({ error: "dueAt required (ISO string)" });

    const doc = {
      agentId,
      title: title.trim(),
      description: (description || "").trim(),
      dueAt: new Date(dueAt),
      clientPhone: clientPhone ? String(clientPhone).trim() : null,
      done: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await tasksCol().insertOne(doc);
    res.json({ task: { ...doc, _id: result.insertedId } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateTask = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const agentId = String(req.agent._id);
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });

    const $set = { updatedAt: new Date() };
    if (req.body?.title       !== undefined) $set.title       = String(req.body.title).trim();
    if (req.body?.description !== undefined) $set.description = String(req.body.description).trim();
    if (req.body?.dueAt       !== undefined) $set.dueAt       = new Date(req.body.dueAt);
    if (req.body?.clientPhone !== undefined) $set.clientPhone = req.body.clientPhone ? String(req.body.clientPhone).trim() : null;
    if (req.body?.done        !== undefined) $set.done        = !!req.body.done;

    const result = await tasksCol().findOneAndUpdate(
      { _id: new ObjectId(id), agentId },
      { $set },
      { returnDocument: "after" }
    );
    const task = result.value ?? result;
    if (!task) return res.status(404).json({ error: "task not found" });
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteTask = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const agentId = String(req.agent._id);
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });

    const result = await tasksCol().deleteOne({ _id: new ObjectId(id), agentId });
    if (!result.deletedCount) return res.status(404).json({ error: "task not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Leads aggregation (across all clients of this agent) ────────────

exports.getCpanelLeadsAggregate = async (req, res) => {
  try {
    const agentId = String(req.agent._id);
    const days    = Math.min(Math.max(parseInt(req.query.days || "30", 10), 1), 90);
    const sample  = Math.min(parseInt(req.query.sample || "25", 10), 60);

    const myClients = await cpanelClientsCol()
      .find({ agentId }, { projection: { phone: 1, name: 1 } })
      .limit(sample)
      .toArray();

    if (!myClients.length) return res.json({ rows: [], scanned: 0, total: 0 });

    // Reuse the per-client logic by calling the helper directly.
    const rows = await Promise.all(myClients.map(async (c) => {
      try {
        const data = await fetchClientLeadsRaw(c.phone, days);
        const spend = (data.trend || []).reduce((s, p) => s + (p.spend || 0), 0);
        const total = data.total || 0;
        return {
          client: { id: String(c._id || c.phone), phone: c.phone, name: c.name || "" },
          total, spend,
          trend: data.trend || [],
          cpl:   total > 0 ? spend / total : null,
          error: data.error,
        };
      } catch (err) {
        return {
          client: { id: String(c._id || c.phone), phone: c.phone, name: c.name || "" },
          total: 0, spend: 0, trend: [], cpl: null,
          error: err.message,
        };
      }
    }));

    const totalCount = await cpanelClientsCol().countDocuments({ agentId });
    res.json({ rows, scanned: rows.length, total: totalCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* Internal helper that mirrors getClientLeads but returns the data
   instead of writing to res. Reused by the aggregation endpoint. */
async function fetchClientLeadsRaw(phone, days) {
  const numDays = parseInt(days, 10) || 30;
  const datePreset = numDays <= 7 ? "last_7d" : numDays <= 14 ? "last_14d" : "last_30d";

  const creds = await getClientFbCredentials(phone);
  if (!creds?.userToken) return { total: 0, trend: [], error: "FB credentials not available" };

  const adAccounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
  if (!adAccounts.length) return { total: 0, trend: [], error: "No ad accounts found" };
  const actId = adAccounts[0];

  let campaignIds = [];
  try {
    const { data: campData } = await axios.get(`${FB_GRAPH}/act_${actId}/campaigns`, {
      params: { access_token: creds.userToken, fields: "id", limit: 50 },
    });
    campaignIds = (campData?.data || []).map(c => c.id);
  } catch (_) {}

  const trendMap = {};
  let total = 0;
  await Promise.all(campaignIds.map(async cid => {
    try {
      const { data: insRes } = await axios.get(`${FB_GRAPH}/${cid}/insights`, {
        params: {
          access_token: creds.userToken,
          fields: "date_start,actions,spend",
          time_increment: 1,
          date_preset: datePreset,
        },
      });
      for (const d of insRes?.data || []) {
        const leadAct = d.actions?.find(a => a.action_type === "lead");
        const dayLeads = leadAct ? parseInt(leadAct.value, 10) : 0;
        const daySpend = parseFloat(d.spend || 0);
        if (!trendMap[d.date_start]) trendMap[d.date_start] = { date: d.date_start, leads: 0, spend: 0 };
        trendMap[d.date_start].leads += dayLeads;
        trendMap[d.date_start].spend += daySpend;
        total += dayLeads;
      }
    } catch (_) {}
  }));

  const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));
  return { total, trend };
}

// Re-export internal helpers needed by jobs (e.g. daily-digest cron)
exports.buildDigestItems = buildDigestItems;

// ──────────────────────────────────────────────────────────────────────
//  PRODUCTS CATALOG — single source of truth for billing items, prebuilt
//  packages, and coin packages. Everything in the BillingTab reads here.
// ──────────────────────────────────────────────────────────────────────

exports.listProducts = async (_req, res) => {
  try {
    const catalog = await productsSvc.listAll();
    res.json(catalog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────────────
//  CONSOLIDATED PRODUCT REVIEWS — one SMS, all approved products.
//  Manager clicks "שלח את כל המוצרים לאישור" → server collects every
//  manager-approved item across ads / organic / lp, mints a single
//  review token, persists to cpanel_product_reviews, sends SMS+WA.
// ──────────────────────────────────────────────────────────────────────

const productReviewsCol = () => getDB().collection("cpanel_product_reviews");
const wowAdsCol         = () => getDB().collection("wow_ads_sessions");
const wowOrganicCol     = () => getDB().collection("wow_organic_ads_sessions");
const wowLpCol          = () => getDB().collection("wow_lp_sessions");

function newReviewToken() {
  /* Short URL-safe token — 16 hex chars is enough for non-guessable. */
  return require("crypto").randomBytes(8).toString("hex");
}

/* POST /cpanel/clients/:phone/products/send-for-approval
   Collects all manager-approved items across the three product kinds and
   sends ONE SMS+WA link to the client covering all of them. */
exports.sendProductsForApproval = async (req, res) => {
  try {
    // checked before any write — the review page lives on the C-panel
    const cpanelBase = requiredEnv("CPANEL_BASE_URL");
    const { phone } = req.params;

    const [adsSessions, organicSessions, lpSessions, chat] = await Promise.all([
      wowAdsCol().find({ phone }).toArray(),
      wowOrganicCol().find({ phone }).toArray(),
      wowLpCol().find({ phone }).toArray(),
      chatsCol().findOne({ phone }, { projection: { name: 1, fireberyName: 1 } }),
    ]);

    /* Gather only items the manager has already approved (managerApprovedAt set). */
    const approvedAds = adsSessions.flatMap(s =>
      (s.generatedAds || s.ads || []).filter(a => a.managerApprovedAt && a.imageUrl)
        .map(a => ({ sessionId: s.sessionId, id: a.id, imageUrl: a.imageUrl, headline: a.headline || "" }))
    );
    const approvedOrganic = organicSessions.flatMap(s =>
      (s.generatedPosts || s.posts || []).filter(p => p.managerApprovedAt)
        .map(p => ({ sessionId: s.sessionId, id: p.id, type: p.type, imageUrl: p.imageUrl, headline: p.headline || "" }))
    );
    const approvedLp = lpSessions.find(s => s.approvalStatus === "approved" || s.clientApprovalStatus === "approved" || s.managerApprovedAt) || null;

    const adsApproved     = approvedAds.length;
    const organicApproved = approvedOrganic.length;
    const lpApproved      = !!approvedLp;

    if (adsApproved === 0 && organicApproved === 0 && !lpApproved) {
      return res.status(400).json({
        error: "אין מוצרים מאושרים לשליחה — אשר לפחות פריט אחד קודם",
      });
    }

    const token = newReviewToken();
    const now   = new Date();

    /* User package — for packageName + lifecycle status. */
    const user = await usersCol().findOne({ phone }, { projection: { activePackage: 1 } });
    const packageName = user?.activePackage?.name || null;

    const reviewDoc = {
      phone,
      token,
      agentId:     String(req.agent._id),
      packageName,
      status:      "sent",
      sentAt:      now,
      respondedAt: null,
      feedback:    null,
      ads:      { count: adsApproved,     items: approvedAds },
      organic:  { count: organicApproved, items: approvedOrganic },
      carousels: { count: approvedOrganic.filter(p => p.type === "carousel").length },
      lp:       { present: lpApproved, sessionId: approvedLp?.sessionId || null },
      logo:     { count: 0 },
      video:    { count: 0 },
      createdAt:   now,
      updatedAt:   now,
    };
    await productReviewsCol().insertOne(reviewDoc);

    /* Update users.activePackage.status — items have been sent to the client. */
    if (user?.activePackage) {
      await usersCol().updateOne(
        { phone },
        { $set: {
            "activePackage.status":          "sent_to_client",
            "activePackage.statusUpdatedAt": now.toISOString(),
          }
        },
      );
    }

    /* Public preview page — /products-review/:token is served by the C-panel. */
    const previewUrl = `${cpanelBase}/products-review/${token}`;

    /* Compose message + send WhatsApp + SMS (best-effort, non-fatal). */
    const businessName = chat?.fireberyName || chat?.name || "";
    /* No link in the message: /products-review/:token needs a public review
       API this server doesn't have yet, so the page would only show an error.
       WhatsApp is queued (not yet sent), so it's reported apart from sentChannels. */
    const clientNotify = require("../services/client-notify.service");
    const message = clientNotify.renderMessage("products_ready", { name: clientNotify.firstName(businessName) });
    const sentChannels = [];
    const queued = await clientNotify.notify.productsReady(phone, { scope: `review:${token}` });
    try {
      const { sendSMS } = require("../services/sms4free.service");
      await sendSMS(phone, message);
      sentChannels.push("sms");
    } catch (e) {
      console.warn("[CPanel] SMS send failed:", e.message);
    }

    res.json({
      success:  true,
      token,
      previewUrl,
      summary: { adsApproved, organicApproved, lpApproved },
      sentChannels,
      whatsappQueued: !!queued?.queued,
    });
  } catch (err) {
    console.error("[CPanel] sendProductsForApproval:", err.message);
    res.status(500).json({ error: err.message });
  }
};

function shapeReview(r) {
  return {
    token:       r.token || String(r._id),
    status:      r.status || "sent",
    sentAt:      r.sentAt || r.createdAt || null,
    respondedAt: r.respondedAt || null,
    feedback:    r.feedback || null,
    summary: {
      ads:     (r.ads     && r.ads.count)     || 0,
      organic: (r.organic && r.organic.count) || 0,
      lp:      !!(r.lp && (r.lp.present || r.lp.count > 0)),
    },
  };
}

/* GET /cpanel/clients/:phone/products/latest-review
   Most recent consolidated review, or { review: null } if none. */
exports.getLatestProductReview = async (req, res) => {
  try {
    const { phone } = req.params;
    let row = null;
    try {
      const rows = await productReviewsCol()
        .find({ phone })
        .sort({ sentAt: -1, createdAt: -1 })
        .limit(1)
        .toArray();
      row = rows[0] || null;
    } catch { /* collection may not exist */ }
    if (!row) return res.json({ review: null });
    res.json({ review: shapeReview(row) });
  } catch (err) {
    console.error("[CPanel] getLatestProductReview:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /cpanel/reviews?status=&limit=
   All consolidated reviews across this manager's clients — sidebar feed. */
exports.listProductReviews = async (req, res) => {
  try {
    const status  = (req.query.status || "all").toString();
    const limit   = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const agentId = String(req.agent._id);

    const filter = { agentId };
    if (status === "pending")  filter.status = "sent";
    if (status === "approved") filter.status = "approved";
    if (status === "rejected") filter.status = "rejected";

    let rows = [];
    try {
      rows = await productReviewsCol()
        .find(filter)
        .sort({ sentAt: -1, createdAt: -1 })
        .limit(limit)
        .toArray();
    } catch { /* collection may not exist */ }

    const phones = [...new Set(rows.map(r => r.phone).filter(Boolean))];
    const chats = phones.length
      ? await chatsCol().find(
          { phone: { $in: phones } },
          { projection: { phone: 1, name: 1, fireberyName: 1 } },
        ).toArray()
      : [];
    const nameByPhone = new Map(chats.map(c => [c.phone, c.fireberyName || c.name || c.phone]));

    const reviews = rows.map(r => ({
      ...shapeReview(r),
      phone:      r.phone,
      clientName: nameByPhone.get(r.phone) || r.phone,
    }));

    res.json({ reviews, total: reviews.length });
  } catch (err) {
    console.error("[CPanel] listProductReviews:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────────────
//  CUSTOM CATEGORIES — managers can add new top-level categories and
//  sub-categories on the fly from the Characterization tab. Stored as
//  a delta on top of the curated frontend list.
// ──────────────────────────────────────────────────────────────────────
const cpanelCategoriesSvc = require("../services/cpanel-categories.service");
cpanelCategoriesSvc.ensureIndexes().catch(err => console.warn("[cpanel-categories] index:", err.message));

exports.listCustomCategories = async (_req, res) => {
  try {
    const docs = await cpanelCategoriesSvc.listAll();
    res.json({ categories: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.addCustomCategory = async (req, res) => {
  try {
    const { label } = req.body || {};
    if (!label?.trim()) return res.status(400).json({ error: "label required" });
    const agentId = req.agent?._id ? String(req.agent._id) : null;
    const doc = await cpanelCategoriesSvc.addCategory(label, agentId);
    res.json({ category: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.addCustomSubCategory = async (req, res) => {
  try {
    const { catKey } = req.params;
    const { label } = req.body || {};
    if (!label?.trim()) return res.status(400).json({ error: "label required" });
    const agentId = req.agent?._id ? String(req.agent._id) : null;
    const doc = await cpanelCategoriesSvc.addSubCategory(catKey, label, agentId);
    res.json({ category: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────────────
//  LOGO GENERATOR — produces a square PNG logo via Gemini and uploads
//  to Backblaze. Used by the Characterization tab when a client has no
//  existing logo and wants the system to create one from a colour palette.
// ──────────────────────────────────────────────────────────────────────
const { generateLogoForClient } = require("../services/logo-generator.service");
const { autoBumpToSentToCreation: bumpStatusOnLogo } = require("../services/package-lifecycle.service");

/* Logo-job store. We persist jobs in Mongo (not in-memory) so a dyno
   restart doesn't lose an in-flight generation — the next poll sees the
   record and the background loop reattaches via the IIFE catch path.
   Each job: { jobId, phone, status, url?, prompt?, error?, createdAt,
   completedAt?, expiresAt }. A TTL index on expiresAt would auto-clean
   old records; we don't depend on it for correctness. */
const logoJobsCol = () => getDB().collection("logo_jobs");

exports.generateLogo = async (req, res) => {
  try {
    const { businessName, tagline, style, colors } = req.body || {};
    let { businessField, businessNiche, about } = req.body || {};
    if (!businessName) return res.status(400).json({ error: "businessName required" });

    /* Phone is optional here — when called from the global manager view we
       partition by manager id; from a client page we use the client phone. */
    const phone = req.body?.phone
      || req.query?.phone
      || (req.user && (req.user.phone || req.user.id))
      || "anonymous";

    /* Pull business context from business_profiles so the prompt can ground
       icon selection in what THIS business actually does, not just its
       broad industry. businessField alone gave us "אינסטלציה" → generic
       wrench+pipe every time; adding `about` + `businessNiche` lets the
       prompt distinguish "תיקון דחוף 24/7" from "התקנת יוקרה" even when
       both share the same field. Soft-fails — if the lookup throws we
       generate with whatever fields were already passed in the body. */
    if (phone && phone !== "anonymous" && (!businessField || !businessNiche || !about)) {
      try {
        const bp = await getDB().collection("business_profiles")
          .findOne(
            { phone: String(phone) },
            { projection: { categoryKey: 1, businessField: 1, subCategoryKeys: 1, businessNiche: 1, about: 1 } },
          );
        if (!businessField) {
          businessField = bp?.businessField
            || bp?.categoryKey
            || (Array.isArray(bp?.subCategoryKeys) ? bp.subCategoryKeys[0] : null)
            || null;
        }
        if (!businessNiche) businessNiche = bp?.businessNiche || null;
        if (!about)         about         = bp?.about         || null;
      } catch (err) {
        console.warn("[cpanel] generateLogo: business_profiles lookup failed:", err.message);
      }
    }

    /* Background job pattern — see header note on logoJobsCol. We MUST
       respond to the client before kicking off the OpenAI call because
       gpt-image-1 at quality:"high" routinely runs 25-45s and Heroku
       kills any HTTP request that exceeds the 30s H12 window, which
       was producing the 503 responses we saw before this refactor. */
    const jobId = require("crypto").randomBytes(16).toString("hex");
    const now = new Date();
    await logoJobsCol().insertOne({
      jobId,
      phone: String(phone),
      status: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000), // 1 hour
    });

    res.json({ jobId, status: "pending" });

    /* Detached background work. Errors are persisted to the job record so
       the polling client surfaces them — they never propagate out because
       the HTTP response is already sent. */
    (async () => {
      try {
        const out = await generateLogoForClient({
          phone: String(phone),
          businessName,
          tagline,
          style,
          colors: Array.isArray(colors) ? colors : undefined,
          businessField,
          businessNiche,
          about,
        });
        await logoJobsCol().updateOne(
          { jobId },
          { $set: { status: "done", url: out.url, prompt: out.prompt, completedAt: new Date() } },
        );
        if (phone && phone !== "anonymous") {
          bumpStatusOnLogo(String(phone), "logo-generate").catch(() => {});
        }
      } catch (err) {
        console.error("[cpanel] generateLogo background failed:", err);
        await logoJobsCol().updateOne(
          { jobId },
          { $set: { status: "error", error: err.message || "Logo generation failed", completedAt: new Date() } },
        ).catch(e => console.warn("[cpanel] generateLogo error persist failed:", e.message));
      }
    })().catch(err => console.error("[cpanel] generateLogo IIFE crashed:", err.message));
  } catch (err) {
    console.error("[cpanel] generateLogo failed:", err);
    res.status(500).json({ error: err.message || "Logo generation failed" });
  }
};

/* POST /api/cpanel/clients/:phone/suggest-services
   "✨ הוסף שירותים עם AI" button on the Characterization → שירותים
   panel. Takes the businessName + about that the manager already
   filled and asks gpt-4o to draft 3 services tailored to that
   business. Each suggestion includes title, description, uniqueFeature,
   and a targeted Hebrew audience array — same shape as the manual
   ServicesPanel produces, so the frontend can just append the array
   to form.services.

   Body: { businessName?: string, about?: string, businessField?: string, businessNiche?: string }
   Returns: { success: true, services: [{ title, description, uniqueFeature, targetAudience }] }
   400 if both businessName and about are empty — the button shouldn't
   have been clickable but we defend anyway. */
exports.suggestServicesWithAI = async (req, res) => {
  try {
    const { businessName, about, businessField, businessNiche } = req.body || {};
    const name  = String(businessName || "").trim();
    const desc  = String(about || "").trim();
    const field = String(businessField || "").trim();
    const niche = String(businessNiche || "").trim();
    if (!name && !desc) {
      return res.status(400).json({ error: "חסר שם עסק או אודות — אין מספיק מידע ליצור שירותים" });
    }

    const { OpenAI } = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

    /* Whitelist for campaignType matching the 7 IDs the manager picks
       in the UI. Mirror the labels so the prompt can ask the model
       to use Hebrew when reasoning. */
    const CAMPAIGN_TYPES = [
      { id: "LEAD_GENERATION", label: "לידים — איסוף פרטים של מתעניינים" },
      { id: "CONVERSIONS",     label: "המרות — פעולה ספציפית באתר/דף נחיתה" },
      { id: "MESSAGES",        label: "הודעות — שיחה בוואטסאפ/מסנג'ר" },
      { id: "TRAFFIC",         label: "תנועה — גלישה לאתר" },
      { id: "REACH",           label: "חשיפה — הצגת הקמפיין לכמה שיותר אנשים" },
      { id: "BRAND_AWARENESS", label: "מודעות למותג — זיהוי המותג" },
      { id: "ENGAGEMENT",      label: "מעורבות — לייקים/תגובות/שיתופים" },
    ];
    const campaignBlock = CAMPAIGN_TYPES.map(c => `- ${c.id} — ${c.label}`).join("\n");

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_ADS_MODEL || "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `אתה אסטרטג שיווקי שעוזר לעסקים בישראל להגדיר את השירותים שלהם. הנתונים שאתה מקבל הם שם העסק, תיאור (אודות), ולפעמים תחום ונישה. עליך להציע 3 שירותים שמתאימים בדיוק לעסק הזה.

חוקים על כל שירות:
- חייב להיגזר ישירות מתיאור העסק או תחומו — אסור להמציא שירותים שלא הוזכרו ולא נובעים בבירור מהקלט.
- title: קצר וברור בעברית (2-5 מילים).
- description: לפחות 3 משפטים בעברית טבעית — מה השירות כולל בפועל, איך הוא מתבצע, ולמי הוא מתאים. ללא קלישאות שיווקיות, ללא markdown.
- uniqueFeature: שורה אחת עד שתיים שמסבירות למה השירות הזה ייחודי / שונה מהמתחרים. אם אין מידע ספציפי בקלט, ציין יתרון סביר (איכות, מחיר, מהירות, פרסונליזציה) — אבל בלי המצאות נטולות בסיס.
- targetAudience: מערך של 2-4 מחרוזות קצרות בעברית שמתארות את הקהל לכל שירות (לדוגמה: "זוגות לפני חתונה", "משפחות צעירות", "עצמאיים בגיל 30-45").

חוקים על השדות הפרסומיים שלכל שירות:
- campaignType: בחר אחד מה-IDs הבאים שמתאים ביותר למטרת השירות:
${campaignBlock}
- targeting: בחר טווח גיל, מגדר, ותחומי עניין מילוליים שמתאימים לקהל. מבנה:
  {
    "ageMin": 18-65 (מספר שלם),
    "ageMax": 18-65 (מספר שלם, גדול או שווה ל-ageMin),
    "genders": ["male"], ["female"], או [] לשניים,
    "interests": מערך של 3-6 תחומי עניין בעברית — לא רחבים מדי, צריך להיות ספציפי לשירות (לדוגמה: ["שיפוץ דירות", "עיצוב הבית", "DIY"] לעסק שיפוצים)
  }
  שים לב: מיקום הוא תמיד "ישראל" — אל תכלול אותו במבנה.

החזר JSON תקני בלבד במבנה:
{
  "services": [
    {
      "title": "...",
      "description": "...",
      "uniqueFeature": "...",
      "targetAudience": ["...", "..."],
      "campaignType": "ID_מהרשימה",
      "targeting": { "ageMin": 25, "ageMax": 55, "genders": [], "interests": ["...", "..."] }
    },
    { ... },
    { ... }
  ]
}

ללא markdown, ללא הסברים, ללא הקדמה. רק ה-JSON.`,
        },
        {
          role: "user",
          content: `שם העסק: ${name || "(לא סופק)"}
תחום: ${field || "(לא סופק)"}
נישה: ${niche || "(לא סופק)"}

אודות העסק:
${desc || "(לא סופק)"}

הצע 3 שירותים מותאמים עם כל השדות.`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return res.status(500).json({ error: "OpenAI החזיר JSON שגוי" }); }

    const services = Array.isArray(parsed.services) ? parsed.services : [];
    if (services.length === 0) return res.status(500).json({ error: "OpenAI לא החזיר שירותים" });

    const VALID_CAMPAIGNS = new Set(CAMPAIGN_TYPES.map(c => c.id));
    const VALID_GENDERS   = new Set(["male", "female"]);
    const clampAge = (n, fallback) => {
      const v = Number.parseInt(n, 10);
      if (!Number.isFinite(v)) return fallback;
      return Math.max(13, Math.min(65, v));
    };

    /* Normalize — clamp to 3, coerce types, strip junk, validate the
       enum-style fields against whitelists so a hallucinated
       campaignType / gender doesn't leak into the form. The frontend
       expects the exact ServiceItem shape so we don't ship objects
       with surprise keys that confuse downstream serialization. */
    const normalized = services.slice(0, 3).map(s => {
      const t = s.targeting || {};
      const ageMin = clampAge(t.ageMin, 18);
      const ageMax = clampAge(t.ageMax, 65);
      const genders = Array.isArray(t.genders)
        ? t.genders.map(g => String(g || "").toLowerCase()).filter(g => VALID_GENDERS.has(g))
        : [];
      const interests = Array.isArray(t.interests)
        ? t.interests.map(i => String(i || "").trim()).filter(Boolean).slice(0, 8)
        : [];

      const campaignType = VALID_CAMPAIGNS.has(s.campaignType) ? s.campaignType : "";

      return {
        title:          String(s.title          || "").trim(),
        description:    String(s.description    || "").trim(),
        uniqueFeature:  String(s.uniqueFeature  || "").trim(),
        targetAudience: Array.isArray(s.targetAudience)
          ? s.targetAudience.map(x => String(x || "").trim()).filter(Boolean).slice(0, 6)
          : [],
        campaignType,
        targetingDetailed: {
          ageMin,
          ageMax: Math.max(ageMin, ageMax),
          genders,
          /* Hard-code Israel as the location — the model can't reliably
             produce FB-API location specs, but Israel is the agency's
             ground truth for every campaign. The frontend's targeting
             editor lets the manager refine to city level. */
          locations: [{ key: "country:IL", name: "ישראל", type: "country" }],
          /* Free-text interests — FB API would need real interest IDs
             which the model can't generate, so we surface them as
             customInterests strings. The targeting editor's interest-
             search will match them to real IDs when the manager opens
             the picker. */
          customInterests: interests,
        },
      };
    }).filter(s => s.title);

    if (normalized.length === 0) return res.status(500).json({ error: "השירותים שחזרו לא היו תקינים" });

    res.json({ success: true, services: normalized });
  } catch (err) {
    console.error("[cpanel] suggestServicesWithAI:", err.message);
    res.status(500).json({ error: err.message || "הצעת שירותים נכשלה" });
  }
};

/* POST /api/cpanel/clients/:phone/spellcheck
   Hebrew spelling/typo correction for characterization free-text (about +
   service title/description/etc.). Takes { texts: string[] } and returns
   { corrected: string[] } in the SAME order/length. Fixes spelling ONLY —
   it must not rewrite, expand, shorten, or change meaning. Typos in the
   איפיון propagate into ad/post generation, so this lets the manager clean
   them before the AI consumes the text. */
exports.spellcheckTexts = async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.texts) ? req.body.texts : null;
    if (!raw || raw.length === 0) {
      return res.status(400).json({ error: "texts (array) required" });
    }
    // Cap to keep the prompt bounded; coerce to strings.
    const items = raw.slice(0, 40).map(t => String(t == null ? "" : t));
    if (items.every(t => !t.trim())) {
      return res.json({ success: true, corrected: items });
    }

    const { OpenAI } = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

    const numbered = items.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_ADS_MODEL || "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `אתה מתקן שגיאות כתיב ודקדוק בסיסי בעברית בלבד. אתה מקבל רשימת מחרוזות ומחזיר אותן מתוקנות, באותו סדר ובאותו מספר פריטים.

חוקים מחייבים:
- תקן אך ורק שגיאות כתיב, אותיות חסרות/מיותרות/הפוכות, רווחים כפולים ופיסוק שגוי ברור.
- אסור לשנות משמעות. אסור להוסיף או להסיר תוכן, מילים, משפטים, מספרים, שמות, אימוג'י או סימני פיסוק (אלא אם זו שגיאת כתיב מובהקת).
- אסור להרחיב, לקצר, לנסח מחדש או לשנות טון/סגנון.
- אם מחרוזת כבר תקינה — החזר אותה כפי שהיא, מילה במילה.
- אסור הקדמות, הסברים או markdown.

החזר JSON תקני בלבד במבנה: { "corrected": ["...", "..."] } — מערך באורך ${items.length} ובאותו סדר של הקלט.`,
        },
        {
          role: "user",
          content: `תקן שגיאות כתיב בכל אחת מ-${items.length} המחרוזות (שמור על הסדר):\n${numbered}\n\nהחזר { "corrected": [...] } עם בדיוק ${items.length} ערכים.`,
        },
      ],
    });

    const out = completion.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try { parsed = JSON.parse(out); } catch (_) {}
    let corrected = Array.isArray(parsed.corrected)
      ? parsed.corrected.map(s => String(s == null ? "" : s))
      : null;
    // Length mismatch → don't risk misaligning fields; return originals.
    if (!corrected || corrected.length !== items.length) {
      console.warn(`[cpanel] spellcheck length mismatch (got ${corrected?.length}, want ${items.length}) — returning originals`);
      corrected = items;
    }
    res.json({ success: true, corrected });
  } catch (err) {
    console.error("[cpanel] spellcheckTexts:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* POST /api/cpanel/clients/:phone/expand-about
   Manager-clicked "✨ הרחב עם AI" button on the Characterization tab.
   Takes the current free-text 'about' the manager (or client) already
   wrote and rewrites it as a richer, more detailed business description
   suitable for AI pipelines (logo, ads, organic posts, landing page).
   Body: { about: string }  Returns: { success, expanded }  400 if empty. */
exports.expandAboutWithAI = async (req, res) => {
  try {
    const { about, categories } = req.body || {};
    const trimmed = String(about || "").trim();
    if (!trimmed) return res.status(400).json({ error: "אודות העסק ריק — אין מה להרחיב" });

    /* Build a compact AI-readable catalog of the canonical category
       list when the frontend sends it. We use it for two extra jobs
       the model does in the same call — picking the best matching
       category + sub-category so the manager doesn't have to. When
       the catalog isn't supplied, fall back to the original
       text-only behavior. */
    const cats = Array.isArray(categories) ? categories : [];
    const catalogLines = cats.map(c => {
      const subs = Array.isArray(c.subCategories) ? c.subCategories : [];
      return `- ${c.label} (key: "${c.key}")\n${subs.map(s => `    • ${s.label} (key: "${s.key}")`).join("\n")}`;
    }).join("\n");
    const useJsonMode = cats.length > 0;

    const { OpenAI } = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_ADS_MODEL || "gpt-4o",
      ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        {
          role: "system",
          content: useJsonMode
            ? `אתה כותב תיאורי עסקים בעברית ומסווג אותם לקטגוריות. עליך לבצע 3 משימות בו-זמנית על קלט אחד:

1. expanded — להרחיב את האודות פי 2-3. כללים:
   - שמור על הטון והעובדות. אסור להמציא שירותים / שנים / מספרים / לקוחות שלא הוזכרו.
   - 3-5 משפטים זורמים בעברית טבעית. ללא markdown / hashtags / אמוג'י.
   - אסור הקדמה ("הנה התיאור..."). רק טקסט נקי.

2. categoryKey — בחר את ה-key של הקטגוריה הראשית שמתאימה ביותר לתיאור, מתוך הרשימה שתקבל למטה. אם אף קטגוריה לא מתאימה — החזר null.

3. subCategoryKey — בחר את ה-key של תת-הקטגוריה המתאימה ביותר מתוך תת-הקטגוריות של הקטגוריה שבחרת בסעיף 2. אם אף אחת לא מתאימה — החזר null.

חוקים על ה-keys: חייבים להיות בדיוק כפי שמופיעים ברשימה (case-sensitive), אסור להמציא keys. עדיף לבחור קטגוריה אמיתית על פני "other"/"other_input" כשיש התאמה סבירה.

החזר JSON תקני בלבד במבנה:
{ "expanded": "...", "categoryKey": "...", "subCategoryKey": "..." }

ללא markdown, ללא הסברים, ללא ציטוט. רק ה-JSON.`
            : `אתה כותב תיאורי עסקים בעברית עבור פייפליין AI שמייצר לוגו, מודעות ופוסטים. כללי כתיבה:
- שמור על הטון, התחום, והעובדות שמופיעים בקלט — אסור להמציא שירותים / שנים / מספרים / לקוחות שלא הוזכרו.
- הרחב את התיאור הקיים פי 2-3 — תוסיף הקשר, תחומי התמחות מפורטים, אופי השירות, סוג הקהל, מיקום אם רלוונטי.
- כתוב ב־3-5 משפטים זורמים בעברית טבעית — לא נקודות, לא רשימות, לא כותרות.
- אם הקלט קצר וכללי, הוסף פירוט. אם ארוך וגדוש, סדר ושפר.
- אסור Markdown, אסור hashtags, אסור אמוג'י. רק טקסט נקי.
- החזר רק את הטקסט המורחב, ללא הקדמה ("הנה התיאור", "התיאור המורחב הוא"), ללא ציטוט.`,
        },
        {
          role: "user",
          content: useJsonMode
            ? `הטקסט המקורי:\n${trimmed}\n\nהקטגוריות הזמינות:\n${catalogLines}\n\nבצע את 3 המשימות והחזר JSON.`
            : `הטקסט המקורי:\n${trimmed}\n\nהרחב אותו לפי הכללים.`,
        },
      ],
    });

    const raw = (completion.choices[0]?.message?.content || "").trim();
    if (!raw) return res.status(500).json({ error: "OpenAI החזיר תוצאה ריקה" });

    /* Legacy/text-only branch — kept for back-compat with callers
       that don't send a categories list. */
    if (!useJsonMode) {
      return res.json({ success: true, expanded: raw, categoryKey: null, subCategoryKey: null });
    }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return res.status(500).json({ error: "OpenAI החזיר JSON שגוי" }); }

    const expanded = String(parsed.expanded || "").trim();
    if (!expanded) return res.status(500).json({ error: "OpenAI לא החזיר תיאור מורחב" });

    /* Validate the keys against the catalog so a hallucinated key
       never reaches the frontend and silently corrupts the form. */
    const proposedCat = parsed.categoryKey ? String(parsed.categoryKey) : null;
    const proposedSub = parsed.subCategoryKey ? String(parsed.subCategoryKey) : null;
    const cat = proposedCat ? cats.find(c => c.key === proposedCat) : null;
    let sub = null;
    if (cat && proposedSub) {
      const subs = Array.isArray(cat.subCategories) ? cat.subCategories : [];
      const match = subs.find(s => s.key === proposedSub);
      sub = match ? match.key : null;
    }

    res.json({
      success:        true,
      expanded,
      categoryKey:    cat ? cat.key : null,
      subCategoryKey: sub,
    });
  } catch (err) {
    console.error("[cpanel] expandAboutWithAI:", err.message);
    res.status(500).json({ error: err.message || "הרחבת אודות נכשלה" });
  }
};

/* GET /api/cpanel/clients/:phone/uploaded-files
   Recovery endpoint — lists every Backblaze file in the per-phone upload
   folder (uploads/${phone}/) AND the shared agent folder. Output:
     { phone, byFolder: { "uploads/PHONE/": [{name, size, uploadedAt,
       proxyUrl}], "uploads/agent/": [...] } }
   Use case: customer's iOS app saved a file:// path as logoUrl because
   the upload-to-Backblaze step had silently succeeded (file exists on
   B2) OR silently failed (file doesn't exist). This endpoint tells the
   manager which: if any image is present near the time the upload was
   attempted, that IS their logo — copy its proxyUrl into the
   characterization logoUrl field to recover. */
exports.listClientUploadedFiles = async (req, res) => {
  try {
    const { phone } = req.params;
    /* Cast a wide net — uploads/PHONE/ and uploads/agent/ are the two
       main paths the regular upload-image endpoint uses, but legacy
       flows wrote to logos/PHONE/, client-logos/PHONE/ (the in-cpanel
       logo generator), and a per-phone profile/ folder. Listing all
       five gives the manager every recoverable trace at once. */
    const prefixes = [
      `uploads/${phone}/`,
      `uploads/agent/`,
      `logos/${phone}/`,
      `client-logos/${phone}/`,
      `profile/${phone}/`,
    ];
    const byFolder = {};
    for (const prefix of prefixes) {
      try {
        const files = await backblazeSvc.listFilesByPrefix(prefix, 200);
        byFolder[prefix] = (files || [])
          .map(f => ({
            name: f.fileName,
            size: f.contentLength,
            uploadedAt: f.uploadTimestamp ? new Date(f.uploadTimestamp).toISOString() : null,
            proxyUrl: `/api/img?url=${encodeURIComponent(f.fileName)}`,
          }))
          .sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
      } catch (e) {
        byFolder[prefix] = { error: e.message };
      }
    }
    res.json({ phone, byFolder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* GET /api/cpanel/logo/job/:jobId — polled by the LogoGenerator modal
   every ~2s after the POST returns a jobId. Returns the live job state:
     { status: "pending" }  → keep polling
     { status: "done", url, prompt } → apply + close modal
     { status: "error", error } → surface to the user and stop polling. */
exports.getLogoJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!jobId) return res.status(400).json({ error: "jobId required" });
    const job = await logoJobsCol().findOne({ jobId });
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json({
      status: job.status,
      ...(job.url    ? { url: job.url }       : {}),
      ...(job.prompt ? { prompt: job.prompt } : {}),
      ...(job.error  ? { error: job.error }   : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── FB User Token (for client-side card tokenization) ────────────
exports.getClientFbUserToken = async (req, res) => {
  try {
    const { phone } = req.params;
    const { userToken, adAccountId } = await getClientFbCredentials(phone);
    if (!userToken)   return res.status(400).json({ error: "אין טוקן פייסבוק מוגדר ללקוח" });
    if (!adAccountId) return res.status(400).json({ error: "אין Ad Account ID מוגדר ללקוח" });
    res.json({ userToken, adAccountId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── Attach tokenized credit card to ad account ────────────────────
exports.attachFbCreditCard = async (req, res) => {
  try {
    const { phone } = req.params;
    const { creditCardId } = req.body;
    if (!creditCardId) return res.status(400).json({ error: "חסר creditCardId" });
    const { userToken, adAccountId } = await getClientFbCredentials(phone);
    if (!userToken)   return res.status(400).json({ error: "אין טוקן פייסבוק" });
    if (!adAccountId) return res.status(400).json({ error: "אין Ad Account ID" });
    const accountId = adAccountId.replace(/^act_/, "");
    const { data } = await axios.post(
      `${FB_GRAPH}/act_${accountId}/ad_credit_cards`,
      null,
      { params: { creditCardNumber_token: creditCardId, access_token: userToken } },
    );
    res.json({ success: true, data });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: msg });
  }
};

// ── FB Token Status — validate the stored user token against Facebook ──
exports.getClientFbTokenStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const { userToken, adAccountId } = await getClientFbCredentials(phone);

    if (!userToken) {
      return res.json({ status: "missing", valid: false, message: "אין טוקן פייסבוק שמור ללקוח זה" });
    }

    try {
      const { data: me } = await axios.get(`${FB_GRAPH}/me`, {
        params: { access_token: userToken, fields: "id,name" },
      });
      return res.json({ status: "valid", valid: true, userId: me.id, name: me.name, adAccountId: adAccountId || null });
    } catch (e) {
      const fbError = e.response?.data?.error;
      return res.json({
        status: "expired",
        valid: false,
        message: fbError?.message || e.message,
        code: fbError?.code,
        errorSubcode: fbError?.error_subcode,
      });
    }
  } catch (err) {
    // Soft-fail — this is a health-check; never break the campaigns tab over it
    console.error("[CPanel] getClientFbTokenStatus:", err.message);
    res.json({ status: "missing", valid: false, message: err.message });
  }
};

// ── FB Page + Act live status check ────────────────────────────────
exports.getClientFbLiveStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const { userToken, pageId, adAccountId } = await getClientFbCredentials(phone);

    const result = { page: null, act: null };

    if (userToken && pageId) {
      try {
        const { data } = await axios.get(`${FB_GRAPH}/${pageId}`, {
          params: { fields: "id,name,category", access_token: userToken },
        });
        result.page = { accessible: true, id: data.id, name: data.name };
      } catch (e) {
        const fbErr = e.response?.data?.error;
        result.page = { accessible: false, message: fbErr?.message || e.message };
      }
    } else {
      result.page = { accessible: false, message: !userToken ? "no_token" : "no_page_id" };
    }

    if (userToken && adAccountId) {
      try {
        const actId = String(adAccountId).replace(/^act_/, "");
        const { data } = await axios.get(`${FB_GRAPH}/act_${actId}`, {
          params: { fields: "id,name,account_status,disable_reason", access_token: userToken },
        });
        result.act = { accessible: data.account_status === 1, id: data.id, name: data.name, account_status: data.account_status };
      } catch (e) {
        const fbErr = e.response?.data?.error;
        result.act = { accessible: false, message: fbErr?.message || e.message };
      }
    } else {
      result.act = { accessible: false, message: !userToken ? "no_token" : "no_act_id" };
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[CPanel] getClientFbLiveStatus:", err.message);
    res.json({ success: false, page: null, act: null });
  }
};

// ── FB Debug — diagnostic for a client's stored Meta credentials ────
// Open to any authenticated agent. Returns only metadata — never a token
// value. Reads MongoDB only (Fireberry is gone).
exports.getClientFbDebug = async (req, res) => {
  try {
    const { phone } = req.params;
    const creds = await getClientFbCredentials(phone);
    res.json({
      phone,
      source: "mongodb:users",
      fbIntegrationEnabled: process.env.FB_INTEGRATION_ENABLED === "true",
      hasUserToken: !!creds.userToken,
      userTokenLength: creds.userToken ? creds.userToken.length : 0,
      pageId: creds.pageId,
      adAccountId: creds.adAccountId,
      hasIgToken: !!creds.igToken,
    });
  } catch (err) {
    console.error("[CPanel] getClientFbDebug:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── FB Ad Account Health ──────────────────────────────────────────
exports.getClientFbAccountHealth = async (req, res) => {
  try {
    const { phone } = req.params;
    const { userToken, adAccountId } = await getClientFbCredentials(phone);
    if (!userToken)   return res.status(400).json({ error: "אין טוקן פייסבוק מוגדר ללקוח" });
    if (!adAccountId) return res.status(400).json({ error: "אין Ad Account ID מוגדר ללקוח" });
    const accountId = adAccountId.replace(/^act_/, "");
    const { data } = await axios.get(`${FB_GRAPH}/act_${accountId}`, {
      params: {
        fields: "amount_spent,balance,account_status,disable_reason,funding_source_details",
        access_token: userToken,
      },
    });
    res.json(data);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: msg });
  }
};

// ── Client Calendar (ai_creation_orders — merged from both DBs) ───────────
exports.getClientCalendar = async (req, res) => {
  try {
    const phone = (req.params.phone || "").toString().trim();

    // Use DB.collection() wrapper (same as every other endpoint) — it handles
    // primary/fallback automatically and is proven to find orders for this phone.
    // The previous direct DB._db?.collection() approach skipped the fallback
    // logic and silently returned empty when the primary had a connectivity issue.
    const orders = await DB.collection('ai_creation_orders')
      .find({ phone })
      .sort({ createdAt: -1 })
      .toArray();

    // Also include posts stored directly in instagram_posts (older flow / webhook-published posts)
    // These are NOT in ai_creation_orders and would otherwise be invisible in the C-Panel calendar.
    const storedPostDocs = await DB.collection('instagram_posts').find({ phone }).toArray();
    const orderPostIds = new Set(
      orders.flatMap((o, _) =>
        (o.creatives || []).map((_, ci) => `order_${String(o._id)}_${ci}`)
      )
    );
    const storedPosts = storedPostDocs
      .map(d => d.post)
      .filter(p => p && !orderPostIds.has(String(p.id)));

    res.json({ success: true, orders, storedPosts });
  } catch (err) {
    console.error('❌ [cpanel] getClientCalendar error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar', details: err.message });
  }
};

exports.rescheduleCreative = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const phone = (req.params.phone || "").toString().trim();
    const { orderId, creativeIndex, specificDate, time } = req.body;

    if (!orderId || creativeIndex == null || !specificDate || !time) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!/^\d{2}\.\d{2}\.\d{2}$/.test(specificDate) && !/^\d{4}-\d{2}-\d{2}$/.test(specificDate)) {
      return res.status(400).json({ error: "specificDate must be DD.MM.YY or YYYY-MM-DD" });
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: "time must be HH:MM" });
    }

    // Normalize to YYYY-MM-DD so the publish cron can match it
    let isoDate = specificDate;
    if (/^\d{2}\.\d{2}\.\d{2}$/.test(specificDate)) {
      const [dd2, mm2, yy2] = specificDate.split(".");
      isoDate = `20${yy2}-${mm2}-${dd2}`;
    }

    const col = getDB().collection("ai_creation_orders");
    const order = await col.findOne({ _id: new ObjectId(orderId), phone });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const pointer = order.publishPointer ?? 0;
    if (creativeIndex < pointer) {
      return res.status(400).json({ error: "Cannot reschedule an already-published creative" });
    }

    const result = await col.updateOne(
      { _id: new ObjectId(orderId) },
      {
        $set: {
          [`publish.slots.${creativeIndex}.specificDate`]: isoDate,
          [`publish.slots.${creativeIndex}.time`]: time,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: "Order not found" });

    // Sync instagram_posts if the app has already cached this post there
    const postId = `order_${orderId}_${creativeIndex}`;
    const newTs = new Date(isoDate + "T00:00:00").getTime();
    await DB.collection("instagram_posts").updateOne(
      { phone, postId },
      { $set: { "post.scheduled_at": newTs, updatedAt: new Date() } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ [cpanel] rescheduleCreative error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* Delete (cancel) a calendar post a client no longer wants. Two sources:
   - source:"order"  → a scheduled creative inside an ai_creation_orders doc.
       We mark creatives[i].status="cancelled" so the publish cron SKIPS it
       (it skips failed/cancelled when advancing the pointer), and clear its
       publish slot so it disappears from the calendar. Already-published
       creatives (index < publishPointer) can't be deleted — they're live.
   - source:"stored" → a standalone instagram_posts doc → delete it.
   Only scheduled (not-yet-published) posts can be removed; a published post
   already went out to FB/IG and can't be unpublished from here. */
exports.cancelCalendarEvent = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const phone = (req.params.phone || "").toString().trim();
    const { source, orderId, creativeIndex, storedPostId } = req.body || {};

    if (source === "order") {
      if (!orderId || creativeIndex == null) {
        return res.status(400).json({ error: "orderId and creativeIndex required" });
      }
      let _id;
      try { _id = new ObjectId(orderId); } catch { return res.status(400).json({ error: "bad orderId" }); }
      const col = getDB().collection("ai_creation_orders");
      const order = await col.findOne({ _id, phone });
      if (!order) return res.status(404).json({ error: "Order not found" });
      const pointer = order.publishPointer ?? 0;
      if (Number(creativeIndex) < pointer) {
        return res.status(400).json({ error: "כבר פורסם — לא ניתן למחוק פוסט שכבר עלה" });
      }
      await col.updateOne(
        { _id },
        {
          $set: {
            [`creatives.${creativeIndex}.status`]: "cancelled",
            [`publish.slots.${creativeIndex}.specificDate`]: null,
            [`publish.slots.${creativeIndex}.days`]: [],
            updatedAt: new Date(),
          },
        }
      );
      // Drop the cached instagram_posts mirror if the app created one.
      await DB.collection("instagram_posts")
        .deleteOne({ phone, postId: `order_${orderId}_${creativeIndex}` })
        .catch(() => {});
      return res.json({ success: true });
    }

    if (source === "stored") {
      if (storedPostId == null || storedPostId === "") {
        return res.status(400).json({ error: "storedPostId required" });
      }
      const col = DB.collection("instagram_posts");
      // post.id may be stored as a string or a number — try both.
      let r = await col.deleteOne({ phone, "post.id": storedPostId });
      if (r.deletedCount === 0 && !Number.isNaN(Number(storedPostId))) {
        r = await col.deleteOne({ phone, "post.id": Number(storedPostId) });
      }
      if (r.deletedCount === 0) return res.status(404).json({ error: "Post not found" });
      return res.json({ success: true });
    }

    return res.status(400).json({ error: "source must be 'order' or 'stored'" });
  } catch (err) {
    console.error("❌ [cpanel] cancelCalendarEvent error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─── Calendar image upload + schedule ─────────────────────────────────────────

const _calUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG/PNG/WEBP images are allowed"));
  },
});
exports.calendarImageUploadMw = _calUpload.single("image");

/* ─── Campaign-מיוחד reference image upload ────────────────────────────
   Stores a single reference photo to B2 and returns its URL. Used by the
   "🎯 קמפיין מיוחד" modal so the manager can attach product / promo
   photos that will be passed to the wow-ads pipeline as image refs
   (via overrides.images). Multer config matches the calendar upload —
   memory storage, 20 MB cap, image MIME whitelist. */
const _campaignSpecialUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG/PNG/WEBP images are allowed"));
  },
});
exports.campaignSpecialImageUploadMw = _campaignSpecialUpload.single("image");

exports.uploadCampaignSpecialImage = async (req, res) => {
  try {
    const { uploadImage } = require("../services/backblaze.service");
    const phone = (req.params.phone || "").toString().trim();
    if (!req.file) return res.status(400).json({ error: "לא הועלה קובץ" });
    if (!phone)    return res.status(400).json({ error: "phone חסר" });

    const ext = ((req.file.originalname || "").split(".").pop() || "png").toLowerCase();
    const safeExt = ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "png";
    const filePath = `wow-ads/${phone}/campaign-special-refs/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${safeExt}`;
    await uploadImage(filePath, req.file.buffer, req.file.mimetype);
    res.json({ url: `/api/img?url=${encodeURIComponent(filePath)}` });
  } catch (err) {
    console.error("[CPanel] uploadCampaignSpecialImage:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.calendarScheduleUpload = async (req, res) => {
  try {
    const { uploadImage } = require("../services/backblaze.service");
    const phone = (req.params.phone || "").toString().trim();
    const { specificDate, time, description } = req.body;

    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    if (!/^\d{2}\.\d{2}\.\d{2}$/.test(specificDate) && !/^\d{4}-\d{2}-\d{2}$/.test(specificDate)) {
      return res.status(400).json({ error: "specificDate must be DD.MM.YY or YYYY-MM-DD" });
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: "time must be HH:MM" });
    }

    // Normalize to YYYY-MM-DD so the publish cron can match it
    let isoDate = specificDate;
    if (/^\d{2}\.\d{2}\.\d{2}$/.test(specificDate)) {
      const [dd, mm, yy] = specificDate.split(".");
      isoDate = `20${yy}-${mm}-${dd}`;
    }

    const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
    const filePath = `calendar-schedule/${phone}/post_${Date.now()}.${ext}`;
    await uploadImage(filePath, req.file.buffer, req.file.mimetype);
    const imageUrl = `/api/img?url=${encodeURIComponent(filePath)}`;

    const now = new Date();
    const order = {
      phone,
      orderType: "social_schedule",
      facebook:  { userToken: null, pageToken: null, pageId: null, pageName: null, adAccountId: null },
      instagram: { token: null, id: null, username: null, name: null },
      status: "pending",
      creatives: [{ type: "post", imageUrl, desc: description || "", status: "completed", publishLog: [] }],
      creativesStatus: "completed",
      publishPointer: 0,
      creativesFullyPublished: false,
      publish: { slots: [{ specificDate: isoDate, time }] },
      createdAt: now,
      updatedAt: now,
    };

    const result = await getDB().collection("ai_creation_orders").insertOne(order);
    const orderId = result.insertedId.toString();

    console.log(`✅ [cpanel] calendarScheduleUpload phone=${phone} orderId=${orderId} date=${isoDate} time=${time}`);
    res.json({ success: true, orderId, imageUrl });
  } catch (err) {
    console.error("❌ [cpanel] calendarScheduleUpload error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─── Referral coin-award helpers (called from client detail page) ─────────────

async function awardReferralCoins(phone, amount, reason) {
  const updated = await DB.collection("users").findOneAndUpdate(
    { phone },
    {
      $inc: { coins: amount },
      $set: { updatedAt: new Date() },
      $setOnInsert: { phone, createdAt: new Date() },
    },
    { returnDocument: "after", upsert: true }
  );
  const newBalance = updated?.coins ?? amount;
  await DB.collection("coin_transactions").insertOne({
    phone, type: "add", amount, reason, balance_after: newBalance, created_at: new Date(),
  });
  return newBalance;
}

// PATCH /cpanel/clients/:phone/referral-approve
exports.approveReferralClient = async (req, res) => {
  try {
    const phone = String(req.params.phone || "").trim();
    const cpanelRow = await cpanelClientsCol().findOne({ phone });
    if (!cpanelRow?.referralLeadId) {
      return res.status(400).json({ error: "לא נמצאו פרטי הפניה עבור לקוח זה" });
    }
    if (cpanelRow.status !== "friend_referral") {
      return res.status(400).json({ error: "הליד כבר עודכן" });
    }
    const { ObjectId } = require("mongodb");
    await DB.collection("leads").updateOne(
      { _id: new ObjectId(cpanelRow.referralLeadId) },
      { $set: { referral_status: 1, updated_at: new Date() } }
    );
    await cpanelClientsCol().updateOne(
      { phone },
      { $set: { status: "friend_referral_approved" } }
    );
    const newBalance = await awardReferralCoins(cpanelRow.referredBy, 100, "referral_approved");
    res.json({ success: true, new_balance: newBalance });
  } catch (err) {
    console.error("❌ [approveReferralClient]", err.message);
    res.status(500).json({ error: err.message });
  }
};

// PATCH /cpanel/clients/:phone/referral-close
exports.closeReferralClient = async (req, res) => {
  try {
    const phone = String(req.params.phone || "").trim();
    const cpanelRow = await cpanelClientsCol().findOne({ phone });
    if (!cpanelRow?.referralLeadId) {
      return res.status(400).json({ error: "לא נמצאו פרטי הפניה עבור לקוח זה" });
    }
    if (cpanelRow.status !== "friend_referral_approved") {
      return res.status(400).json({ error: "יש לאשר את הליד כרלוונטי לפני סגירה" });
    }
    const { ObjectId } = require("mongodb");
    await DB.collection("leads").updateOne(
      { _id: new ObjectId(cpanelRow.referralLeadId) },
      { $set: { referral_status: 2, updated_at: new Date() } }
    );
    await cpanelClientsCol().updateOne(
      { phone },
      { $set: { status: "done" } }
    );
    const newBalance = await awardReferralCoins(cpanelRow.referredBy, 1000, "referral_closed");
    res.json({ success: true, new_balance: newBalance });
  } catch (err) {
    console.error("❌ [closeReferralClient]", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/campaigns/launch ──────────────────────
   Reads all manager-approved WowAds for this client, then creates a
   full Facebook campaign (campaign + adset + ads) via the Graph API.

   Body: { type: "TRAFFIC" | "LEADS", websiteUrl?: string }

   Campaign is set ACTIVE, adset ACTIVE, every individual ad PAUSED
   so the manager can review and enable selectively in Ads Manager.
   Budget: 20 ₪/day at campaign level (CBO). */
exports.launchFacebookCampaign = async (req, res) => {
  const FormData = require("form-data");
  const { phone } = req.params;
  const { type, websiteUrl, slotKey } = req.body || {};

  if (!type || !["TRAFFIC", "LEADS"].includes(type)) {
    return res.status(400).json({ error: "type חייב להיות TRAFFIC או LEADS" });
  }
  if (type === "TRAFFIC" && !websiteUrl) {
    return res.status(400).json({ error: "websiteUrl נדרש עבור קמפיין תנועה לאתר" });
  }

  try {
    // ── 1. FB credentials ──────────────────────────────────────────────
    const creds = await getClientFbCredentials(phone);
    const { userToken, pageId, adAccountId } = creds;
    if (!userToken || !pageId || !adAccountId) {
      return res.status(400).json({ error: "לא נמצאו פרטי פייסבוק ללקוח. יש לוודא שה-Token, ה-Page ID וה-Ad Account ID מוגדרים." });
    }
    const pageToken = await getPageAccessToken(userToken, pageId) || userToken;
    /* adAccountId is sometimes stored with the `act_` prefix already
       (legacy records) and sometimes without (newer flow stores the
       raw numeric id). Normalize before prepending so we never end up
       with `act_act_...` — FB rejects the doubled prefix with
       "Object with ID does not exist" (subcode 33). */
    const numericAdAccountId = String(adAccountId).replace(/^act_/, "");
    const act = `act_${numericAdAccountId}`;

    // ── 2. Approved ads ────────────────────────────────────────────────
    const sess = await getWowAdsSession(phone, slotKey || null);
    const approvedAds = (sess?.generatedAds || []).filter(a => a.managerApprovedAt && a.imageUrl);
    if (approvedAds.length === 0) {
      return res.status(400).json({ error: "אין מודעות מאושרות להעלאה. יש לאשר לפחות מודעה אחת." });
    }

    const campaignName = type === "LEADS" ? `קמפיין לידים - ${phone}` : `קמפיין אתר - ${phone}`;

    console.log(`[launch-campaign] phone=${phone} type=${type} ads=${approvedAds.length}`);

    /* Look up the client's website once — reused for the leadgen form's
       privacy_policy + follow_up_action_url AND, more importantly, as
       the creative's external link for LEADS ads. FB policy 1815316
       rejects Lead Generation Ads whose creative link points at a
       Facebook page (which is what we used to send). External link is
       mandatory even though the click opens the instant form on-platform
       via destination_type=ON_AD. */
    let clientWebsiteUrl = null;
    try {
      const bp = await getDB().collection("business_profiles")
        .findOne({ phone }, { projection: { website: 1 } });
      if (bp?.website && /^https?:\/\//i.test(bp.website)) clientWebsiteUrl = bp.website;
    } catch (_) {}
    const AGENCY_FALLBACK_URL = "https://iconiqmedia.co.il";
    /* Use the client's site if set, otherwise the agency's domain — both
       are real external URLs that FB's Lead Gen policy accepts. */
    const externalLinkUrl = clientWebsiteUrl || AGENCY_FALLBACK_URL;

    // ── 3. Lead form (LEADS only) ─────────────────────────────────────
    let leadFormId = null;
    if (type === "LEADS") {
      try {
        /* Privacy policy URL — uses the same lookup as the creative's
           external link above. Either way it's a real reachable URL,
           which is FB's hard requirement here. */
        const privacyUrl = externalLinkUrl;

        /* Only valid fields for POST /{page}/leadgen_forms:
           name, privacy_policy, questions, locale, follow_up_action_text, thank_you_page.
           "description" and "status" are NOT valid and cause "Invalid parameter". */
        const formFields = new URLSearchParams();
        formFields.append("name", `ליד - ${phone} - ${Date.now()}`);
        formFields.append("privacy_policy", JSON.stringify({ url: privacyUrl, link_text: "מדיניות פרטיות" }));
        formFields.append("questions", JSON.stringify([
          { type: "FULL_NAME" },
          { type: "PHONE" },
        ]));
        /* FB requires BOTH text and URL when supplying a follow-up CTA —
           without follow_up_action_url it returns:
             error_subcode 1892085 "שדות חסרים: FollowUpActionURL"
           Re-use the same privacyUrl fallback chain (client website →
           Facebook page) so we always have a reachable destination. */
        formFields.append("follow_up_action_text", "תודה! ניצור איתך קשר בהקדם.");
        formFields.append("follow_up_action_url", privacyUrl);
        formFields.append("locale", "he_IL");

        console.log(`[launch-campaign] creating lead form for pageId=${pageId} privacyUrl=${privacyUrl}`);
        const formRes = await axios.post(
          `${FB_GRAPH}/${pageId}/leadgen_forms`,
          formFields.toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${pageToken}` } },
        );
        leadFormId = formRes.data?.id;
        console.log(`[launch-campaign] lead form created: ${leadFormId}`);
      } catch (e) {
        const fbErr = e.response?.data?.error;
        /* Log everything — subcode, user_msg, type all help diagnose FB errors */
        console.error("[launch-campaign] ❌ lead form failed:", JSON.stringify(fbErr || e.message));
        const msg = fbErr?.error_user_msg || fbErr?.message || e.message;
        return res.status(400).json({ error: `יצירת טופס לידים נכשלה: ${msg}`, details: fbErr });
      }
    }

    // ── Pre-flight: can this FB ad account actually run ads? ───────────
    /* Without a valid funding source / active status, FB either rejects every
       ad (error 1359188 "add a valid payment method") or creates PAUSED ads
       that never deliver — the campaign then shows up EMPTY in CPANEL + Ads
       Manager with NO visible reason. Fail fast here with a clear message so
       the manager knows exactly what to fix, instead of a silent empty shell.
       (This is FB ad-account billing — separate from the client's iconiq
       "כרטיס" token badge.) A health-check error itself never blocks. */
    try {
      const acctId = String(act).replace(/^act_/, "");
      const { data: acctHealth } = await axios.get(`${FB_GRAPH}/act_${acctId}`, {
        params: { fields: "account_status,disable_reason,funding_source_details", access_token: userToken },
      });
      const acctStatus = Number(acctHealth.account_status);
      const fsd = acctHealth.funding_source_details;
      const hasFunding = !!(fsd && (fsd.id || fsd.display_string));
      // account_status: 1=ACTIVE · 2=DISABLED · 3=UNSETTLED · 7=PENDING_RISK_REVIEW
      //                 · 9=IN_GRACE_PERIOD · 100=PENDING_CLOSURE · 101=CLOSED
      if (acctStatus !== 1) {
        const label = acctStatus === 2 ? "מושבת" : acctStatus === 3 ? "חוב לא משולם"
          : acctStatus === 101 || acctStatus === 100 ? "סגור" : `סטטוס ${acctStatus}`;
        console.warn(`[launch-campaign] pre-flight BLOCK — act_${acctId} account_status=${acctStatus} (${label})`);
        return res.status(400).json({ error: `חשבון המודעות של הלקוח אינו פעיל (${label}). יש לסדר את החשבון ב-Facebook לפני השקת הקמפיין.` });
      }
      if (!hasFunding) {
        console.warn(`[launch-campaign] pre-flight BLOCK — act_${acctId} has no funding_source_details`);
        return res.status(400).json({ error: "אין אמצעי תשלום תקין בחשבון המודעות של הלקוח בפייסבוק. יש להוסיף כרטיס אשראי לחשבון המודעות (Business Settings → Payment Settings) ואז להשיק שוב." });
      }
      console.log(`[launch-campaign] pre-flight OK — act_${acctId} status=1 funding=yes`);
    } catch (e) {
      console.warn(`[launch-campaign] pre-flight health check failed (proceeding): ${e.response?.data?.error?.message || e.message}`);
    }

    // ── 4. Campaign ────────────────────────────────────────────────────
    const campRes = await axios.post(
      `${FB_GRAPH}/${act}/campaigns`,
      JSON.stringify({
        name: campaignName,
        objective: type === "LEADS" ? "OUTCOME_LEADS" : "OUTCOME_TRAFFIC",
        status: "ACTIVE",
        special_ad_categories: [],
        campaign_budget_optimization: true,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        daily_budget: 2000,   // number in agorot (20 ₪), not a string
      }),
      { params: { access_token: userToken }, headers: { "Content-Type": "application/json" } },
    );
    const campaignId = campRes.data.id;
    console.log(`[launch-campaign] campaign: ${campaignId}`);

    // ── 5. Ad set ──────────────────────────────────────────────────────
    /* LANDING_PAGE_VIEWS counts only users who actually loaded the page
       (vs LINK_CLICKS which fires even on immediate back-navigations).
       For LEADS, LEAD_GENERATION is required. */
    const optimizationGoal = type === "LEADS" ? "LEAD_GENERATION" : "LANDING_PAGE_VIEWS";
    const adSetBody = {
      name: `${campaignName} - אדסט`,
      campaign_id: campaignId,
      billing_event: "IMPRESSIONS",
      optimization_goal: optimizationGoal,
      status: "ACTIVE",
      targeting: {
        geo_locations: { countries: ["IL"] },
        locales: [24],
        age_min: 18,
        age_max: 65,
      },
      access_token: userToken,
      /* destination_type tells Meta where clicks land.
         LEADS → ON_AD (instant form opens directly from the ad — the
                 leadgen_form_id is supplied via the creative's CTA).
                 "ON_FACEBOOK" is NOT a valid value and gets rejected
                 with code 100.
         TRAFFIC → WEBSITE (link goes to the client's site). */
      ...(type === "LEADS" ? {
        promoted_object: { page_id: pageId },
        destination_type: "ON_AD",
      } : {
        destination_type: "WEBSITE",
      }),
    };

    const adSetRes = await axios.post(
      `${FB_GRAPH}/${act}/adsets`,
      JSON.stringify(adSetBody),
      { headers: { "Content-Type": "application/json" } },
    );
    const adSetId = adSetRes.data.id;
    console.log(`[launch-campaign] adset: ${adSetId}`);

    // ── 6. Ads ─────────────────────────────────────────────────────────
    /* Ad creation runs in the BACKGROUND, sequentially, with a 10-second
       sleep between ads. Why:
       - Parallel uploads (the old Promise.allSettled approach) sent 30+
         concurrent calls to Graph for a 10-ad batch and tripped the per-
         token rate limit — campaign came up ACTIVE with 0 ads attached.
       - Sequential with a 10s gap fits comfortably under FB's per-token
         calls/hour cap and gives FB time to digest each ad+creative+image
         hash before the next one.
       - 10 ads × 10s gap + per-ad processing ≈ 120s — that's way past
         Heroku's 30s H12 HTTP timeout. So we MUST respond to the client
         FIRST and finish the ad loop in a fire-and-forget background
         promise. The campaign + adset already exist at this point, so
         the user sees ACTIVE in FB immediately and ads trickle in.
       - launchEntry is persisted from inside the background block once
         the loop finishes so downstream surfaces still see launchedCampaigns. */
    const campaignUrl = `https://www.facebook.com/adsmanager/manage/campaigns?act=${adAccountId}`;
    console.log(`[launch-campaign] ✅ infra ready — campaign=${campaignId} adset=${adSetId}, scheduling ${approvedAds.length} ads in background (10s gap)`);

    /* Respond NOW with the planned ad count. Actual per-ad success/failure
       gets logged in the background loop. Frontend toast already says
       "X מודעות הועלו" — using the planned count keeps that message
       sensible without a frontend change. */
    res.json({
      success: true,
      campaignId, adSetId,
      adCount: approvedAds.length,
      campaignUrl,
      backgroundProcessing: true,
    });

    /* Background ad creation. Errors are logged but do not propagate —
       there is no client to surface them to once we've already responded. */
    /* Log the full ad list before starting the background loop so we can
       confirm exactly which ads (and which imageUrls) will be processed. */
    console.log(`[launch-campaign] approved ads to upload:`, JSON.stringify(
      approvedAds.map(a => ({ id: a.id, imageUrl: a.imageUrl || null, headline: (a.headline || "").slice(0, 40) }))
    ));

    (async () => {
      let createdAds = 0;
      const adErrors = [];
      for (let i = 0; i < approvedAds.length; i++) {
        const ad = approvedAds[i];
        console.log(`[launch-campaign] ── ad ${i + 1}/${approvedAds.length} (id=${ad.id}) starting`);
        try {
          let imageHash = null;
          try {
            const rawUrl = ad.imageUrl || "";
            console.log(`[launch-campaign]   imageUrl="${rawUrl}"`);
            const b2Path = rawUrl.startsWith("/api/img?url=")
              ? decodeURIComponent(rawUrl.replace("/api/img?url=", ""))
              : null;
            console.log(`[launch-campaign]   b2Path=${b2Path || "(none — imageUrl did not match /api/img?url= prefix)"}`);

            if (b2Path) {
              console.log(`[launch-campaign]   downloading from Backblaze…`);
              const b2Result = await backblazeSvc.downloadImageByPath(b2Path);
              const imgBuffer = b2Result.buffer;
              console.log(`[launch-campaign]   Backblaze download OK — size=${imgBuffer?.length} contentType=${b2Result.contentType}`);

              if (imgBuffer) {
                /* Use the real content type from Backblaze (PNG/WebP/JPEG)
                   rather than hard-coding JPEG — prevents FB rejecting a
                   PNG payload labelled as image/jpeg. */
                const imgContentType = b2Result.contentType || "image/jpeg";
                const imgFilename = `image.${imgContentType.split("/")[1] || "jpg"}`;
                const form = new FormData();
                form.append(imgFilename, imgBuffer, { filename: imgFilename, contentType: imgContentType });
                form.append("access_token", userToken);
                console.log(`[launch-campaign]   uploading to FB as ${imgFilename} (${imgContentType}) …`);
                const uploadRes = await axios.post(
                  `${FB_GRAPH}/${act}/adimages`,
                  form,
                  { headers: form.getHeaders() },
                );
                imageHash = Object.values(uploadRes.data?.images || {})[0]?.hash || null;
                console.log(`[launch-campaign]   FB image upload OK — hash=${imageHash}`);
              }
            } else {
              console.warn(`[launch-campaign]   ⚠️  ad ${ad.id} has no valid imageUrl — creative will have no image`);
            }
          } catch (imgErr) {
            const imgFbErr = imgErr.response?.data?.error;
            console.error(`[launch-campaign]   ❌ image stage failed for ad ${ad.id}:`, JSON.stringify({
              fbError: imgFbErr || null,
              message: imgErr.message,
              status: imgErr.response?.status,
            }));
          }

          console.log(`[launch-campaign]   imageHash=${imageHash || "(none)"} — building creative`);

          /* FB policy 1815316: Lead Generation Ads MUST link to external
             content at the creative level, even when destination_type=ON_AD
             opens the instant form on-platform. Use the client's website
             (or the agency's domain as fallback) — never a facebook.com URL.
             For TRAFFIC: the link is the campaign destination as expected. */
          const linkUrl = type === "TRAFFIC" ? websiteUrl : externalLinkUrl;
          const objectStorySpec = {
            page_id: pageId,
            link_data: {
              link: linkUrl,
              message: ad.description || ad.primaryText || "",
              name: ad.headline || "",
              ...(imageHash ? { image_hash: imageHash } : {}),
              call_to_action: {
                /* SIGN_UP is the correct CTA for lead gen forms (not LEARN_MORE).
                   lead_gen_form_id tells Facebook which instant form to open. */
                type: type === "LEADS" ? "SIGN_UP" : "LEARN_MORE",
                ...(leadFormId ? { value: { lead_gen_form_id: leadFormId } } : {}),
              },
            },
          };

          const creativeFields = new URLSearchParams({
            name: (ad.headline || `Creative ${i + 1}`).slice(0, 100),
            object_story_spec: JSON.stringify(objectStorySpec),
            access_token: userToken,
          });
          console.log(`[launch-campaign]   POST adcreatives — pageId=${pageId} linkUrl=${linkUrl}`);
          const creativeRes = await axios.post(
            `${FB_GRAPH}/${act}/adcreatives`,
            creativeFields.toString(),
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
          );
          const creativeId = creativeRes.data.id;
          console.log(`[launch-campaign]   creative OK — creativeId=${creativeId}`);

          const adFields = new URLSearchParams({
            name: (ad.headline || `Ad ${i + 1}`).slice(0, 100),
            adset_id: adSetId,
            creative: JSON.stringify({ creative_id: creativeId }),
            status: "PAUSED",
            access_token: userToken,
          });
          console.log(`[launch-campaign]   POST ads — adsetId=${adSetId}`);
          const adRes = await axios.post(
            `${FB_GRAPH}/${act}/ads`,
            adFields.toString(),
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
          );
          // Capture + verify the real ad id — a 2xx without an id means the ad
          // did NOT actually persist. FB often returns 200 with an {error}
          // body (e.g. rate-limit code 17/613) instead of throwing — log the
          // raw response so we see WHY, and surface FB's message to adErrors.
          const newAdId = adRes.data?.id;
          if (!newAdId) {
            const fbErr = adRes.data?.error;
            console.error(`[launch-campaign]   ⚠️ ad ${ad.id} — POST /ads 2xx with NO id. FB response: ${JSON.stringify(adRes.data).slice(0, 800)}`);
            throw new Error(
              fbErr
                ? `FB [${fbErr.code}/${fbErr.error_subcode}] ${fbErr.error_user_msg || fbErr.message}`
                : "FB returned 2xx but no ad id",
            );
          }
          console.log(`[launch-campaign]   ✅ ad ${ad.id} created PAUSED → ${newAdId} (${i + 1}/${approvedAds.length})`);
          createdAds++;
        } catch (err) {
          const fbErr = err.response?.data?.error;
          console.error(`[launch-campaign]   ❌ ad ${i + 1} FAILED:`, JSON.stringify(
            fbErr
              ? { code: fbErr.code, subcode: fbErr.error_subcode, message: fbErr.error_user_msg || fbErr.message, type: fbErr.type, traceId: fbErr.fbtrace_id }
              : { message: err.message || String(err), stack: err.stack?.split("\n")[1] }
          ));
          adErrors.push({ index: i + 1, ...(fbErr ? { code: fbErr.code, message: fbErr.error_user_msg || fbErr.message } : { message: err.message }) });
        }

        /* 10-second pacing between ads — keeps the per-token call rate
           well under FB's hourly cap. Skip the wait after the last ad. */
        if (i < approvedAds.length - 1) {
          console.log(`[launch-campaign]   waiting 10s before next ad…`);
          await new Promise(r => setTimeout(r, 10000));
        }
      }

      console.log(`[launch-campaign] ✅ background done — created ${createdAds}/${approvedAds.length} ads, errors=${JSON.stringify(adErrors)}`);

      /* Persist the outcome on the client so downstream surfaces (funnel,
         dashboard alerts) can detect "campaign launched" without re-querying
         FB — and so a SILENT 0-ad launch leaves a trace (created/total/errors)
         instead of vanishing into the logs. */
      const at = new Date().toISOString();
      const update = {
        $set: {
          "activePackage.lastCampaignLaunchedAt": at,
          "activePackage.lastLaunchResult": {
            campaignId, adSetId, type,
            created: createdAds, total: approvedAds.length,
            errors: adErrors, at,
          },
        },
      };
      if (createdAds > 0) {
        update.$push = {
          "activePackage.launchedCampaigns": {
            campaignId, adSetId, type, slotKey: slotKey || null, adCount: createdAds, at,
          },
        };
      }
      try {
        await usersCol().updateOne({ phone }, update);
      } catch (e) {
        console.warn(`[launch-campaign] could not persist launch result: ${e.message}`);
      }
    })().catch(err => console.error(`[launch-campaign] background loop crashed: ${err.message}`));
    return;

  } catch (err) {
    const fbErr = err.response?.data?.error;
    console.error("[launch-campaign] ❌ FATAL:", JSON.stringify(fbErr || err.message));
    return res.status(500).json({
      error: fbErr?.error_user_msg || fbErr?.message || err.message,
      details: fbErr,
    });
  }
};

// ── One-time sync: copy cpanel_clients.agentId → support_chats.accountManagerId ──
exports.syncManagerAssignments = async (req, res) => {
  try {
    const mappings = await cpanelClientsCol()
      .find({}, { projection: { phone: 1, agentId: 1, agentName: 1 } })
      .toArray();

    let updated = 0, skipped = 0, errors = 0;
    for (const m of mappings) {
      if (!m.phone || !m.agentId) { skipped++; continue; }
      try {
        const result = await chatsCol().updateOne(
          { phone: m.phone },
          { $set: {
              accountManagerId:   String(m.agentId),
              accountManagerName: m.agentName || null,
          }},
        );
        if (result.matchedCount > 0) updated++;
        else skipped++;
      } catch (_e) { errors++; }
    }

    console.log(`[syncManagerAssignments] total=${mappings.length} updated=${updated} skipped=${skipped} errors=${errors}`);
    res.json({ success: true, total: mappings.length, updated, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/clients/:phone/characterization/complete ─────────
   "סיים איפיון" in the panel. Re-checks the fields the איפיון tab requires
   (CharacterizationTab validateForCompletion), stamps briefCompletedAt once
   and WhatsApps the client "איפיון הושלם" (once per client). */
exports.completeCharacterization = async (req, res) => {
  try {
    const { phone } = req.params;
    const bp = await getDB().collection("business_profiles").findOne({ phone });
    const missing = briefMissingFields(bp);
    if (missing.length) return res.status(400).json({ error: "incomplete", missing });
    await getDB().collection("business_profiles").updateOne(
      { phone, briefCompletedAt: { $exists: false } },
      { $set: { briefCompletedAt: new Date() } },
    );
    await require("../services/client-notify.service").notify.briefDone(phone);
    res.json({ success: true });
  } catch (err) {
    console.error("[CPanel] completeCharacterization:", err.message);
    res.status(500).json({ error: err.message });
  }
};

function briefMissingFields(bp) {
  if (!bp) return ["טרם הוזן איפיון"];
  const missing = [];
  const list = v => (Array.isArray(v) ? v : []);
  if (!String(bp.businessName || "").trim()) missing.push("שם העסק");
  if (!bp.categoryKey) missing.push("קטגוריה ראשית");
  if (list(bp.subCategoryKeys).filter(k => k !== "other_input").length === 0) missing.push("תת-קטגוריה");
  if (list(bp.services).length === 0) missing.push("שירות אחד לפחות");
  if (list(bp.targetAudience).length === 0) missing.push("קהל יעד");
  if (!bp.pageGoal) missing.push("מטרת דף");
  if (!bp.logoUrl) missing.push("לוגו");
  if (!bp.preferredColors?.primary) missing.push("צבע ראשי");
  // images[] is canonical; older docs still carry generalImages
  if (list(bp.images).length + list(bp.generalImages).length === 0) missing.push("תמונה אחת לפחות");
  return missing;
}
