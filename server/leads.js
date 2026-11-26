import crypto from "crypto";
import express from "express";
import { ObjectId } from "mongodb";
import { getDb } from "./db.js";
import { requireAuth, requireAdmin, serverError, agentIdQuery } from "./auth.js";
/* CommonJS (backend/package.json) — shared with the backend's payment path,
   so a lead converted by a status change and one converted by a payment get
   exactly the same client records. */
import leadClient from "../backend/services/lead-client.service.js";

/* ── Lead model ───────────────────────────────────────────────────────
   {
     _id, name, phone (normalized digits), phoneRaw, email, business,
     field (תחום עיסוק), source, message, campaign,
     status: one of LEAD_STATUSES,
     assignedTo: agentId | null, assignedToName,
     notes: [{ id, text, by, byName, at }],
     statusHistory: [{ from, to, by, byName, at }],
     activatedAt, activatedBy,
     duplicateOf: id of an earlier lead with the same phone (intake only),
     answers: [{ question, answer }] — what the lead filled in (intake only),
     tracking: { utm_source, fbclid, … } — ad/form tracking fields (intake only),
     clientPhone, convertedAt: set once the lead became a client,
     raw: sanitized original intake payload (capped),
     createdAt, updatedAt
   } */

export const LEAD_STATUSES = ["new", "call_again", "not_relevant", "in_process", "to_charge", "active_client"];

const LEADS_INTAKE_KEY = process.env.LEADS_INTAKE_KEY || "";
const RAW_MAX_BYTES = 8 * 1024;

export function normalizePhone(v) {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (!digits) return "";
  // 972XXXXXXXXX → 0XXXXXXXXX (Israeli numbers), leave others as-is
  if (digits.startsWith("972") && digits.length >= 11) return "0" + digits.slice(3);
  return digits;
}

function serialize(doc, { withRaw = false } = {}) {
  if (!doc) return null;
  const { _id, raw, ...rest } = doc;
  return withRaw ? { id: String(_id), ...rest, raw } : { id: String(_id), ...rest };
}

function str(v, max = 500) {
  if (v === undefined || v === null) return "";
  return String(v).trim().slice(0, max);
}

/* Drop Mongo-operator-looking keys ($foo, a.b) recursively and cap size so
   an arbitrary inbound payload can neither smuggle operators nor bloat
   every list response. */
function sanitizeRaw(v, depth = 0) {
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.slice(0, 100).map(x => sanitizeRaw(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith("$") || k.includes(".")) continue;
      const s = sanitizeRaw(val, depth + 1);
      if (s !== undefined) out[k.slice(0, 100)] = s;
    }
    return out;
  }
  if (typeof v === "string") return v.slice(0, 2000);
  return v;
}

function cappedRaw(body) {
  const clean = sanitizeRaw(body) ?? {};
  const json = JSON.stringify(clean);
  if (json.length <= RAW_MAX_BYTES) return clean;
  return { _truncated: true, _bytes: json.length, preview: json.slice(0, RAW_MAX_BYTES) };
}

/* Extract the fields we understand from an arbitrary inbound payload
   (Hebrew or English aliases). Returns null when there is nothing usable. */
function extractLead(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const name = str(b.name ?? b.fullName ?? b.full_name ?? b["שם"] ?? b["שם מלא"] ?? "", 200);
  const phoneRaw = str(b.phone ?? b.phone_number ?? b.tel ?? b.telephone ?? b.mobile ?? b["טלפון"] ?? b["נייד"] ?? b["מספר טלפון"] ?? "", 50);
  const phone = normalizePhone(phoneRaw);
  if (!name && !phone) return null;
  return {
    name: name || phone,
    phone,
    phoneRaw,
    email: str(b.email ?? b["אימייל"] ?? b["מייל"] ?? "", 200),
    business: str(b.business ?? b.businessName ?? b.company ?? b["עסק"] ?? b["שם העסק"] ?? "", 200),
    field: str(b.field ?? b.businessField ?? b.industry ?? b["תחום"] ?? b["תחום עיסוק"] ?? "", 200),
    source: str(b.source ?? b["מקור"] ?? "", 100),
    message: str(b.message ?? b.notes ?? b.text ?? b["הודעה"] ?? b["הערות"] ?? "", 2000),
    campaign: str(b.campaign ?? b.campaignName ?? b.utm_campaign ?? "", 200),
  };
}

/* Every key extractLead() reads, plus fields that are never shown to the
   team. Whatever else the payload carries is an answer the lead gave. */
const CORE_KEYS = new Set([
  "name", "fullName", "full_name", "שם", "שם מלא",
  "phone", "phone_number", "tel", "telephone", "mobile", "טלפון", "נייד", "מספר טלפון",
  "email", "אימייל", "מייל",
  "business", "businessName", "company", "עסק", "שם העסק",
  "field", "businessField", "industry", "תחום", "תחום עיסוק",
  "source", "מקור",
  "message", "notes", "text", "הודעה", "הערות",
  "campaign", "campaignName",
  "answers", "questions", "שאלות", "תשובות",
  "api_key", "apiKey", "x-api-key", "key", "token", "secret", "password",
]);
/* Ad / form plumbing: kept, but shown apart from the answers. */
const TRACKING_KEYS = new Set([
  "fbclid", "gclid", "form_id", "formId", "form_name", "page_id", "ad_id", "ad_name",
  "adset_id", "adset_name", "campaign_id", "leadgen_id", "created_time", "platform", "referrer", "landing_page", "url",
]);
const isTrackingKey = k => k.startsWith("utm_") || TRACKING_KEYS.has(k);
const MAX_ANSWERS = 100;

function answerText(v) {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(answerText).filter(Boolean).join(", ").slice(0, 2000);
  if (typeof v === "object") return JSON.stringify(sanitizeRaw(v) ?? {}).slice(0, 2000);
  if (typeof v === "boolean") return v ? "כן" : "לא";
  return String(v).trim().slice(0, 2000);
}

/* The questions the lead answered, from either shape:
     answers: [{ question, answer }]   (also {q,a} / {label,value} / Facebook's {name, values})
     answers: { "<question>": "<answer>" }
   plus any top-level field we don't otherwise understand ("budget": "5000"). */
export function extractAnswers(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const answers = [];
  const tracking = {};
  const push = (q, a) => {
    const question = str(q, 300);
    const answer = answerText(a);
    if (question && answer && answers.length < MAX_ANSWERS) answers.push({ question, answer });
  };
  const listed = b.answers ?? b.questions ?? b["שאלות"] ?? b["תשובות"];
  if (Array.isArray(listed)) {
    for (const it of listed) {
      if (it && typeof it === "object") {
        push(it.question ?? it.q ?? it.label ?? it.title ?? it.name ?? it["שאלה"], it.answer ?? it.a ?? it.value ?? it.values ?? it["תשובה"]);
      }
    }
  } else if (listed && typeof listed === "object") {
    for (const [k, v] of Object.entries(listed)) push(k, v);
  }
  for (const [k, v] of Object.entries(b)) {
    if (CORE_KEYS.has(k) || k.startsWith("$") || k.startsWith("_") || k.includes(".")) continue;
    if (isTrackingKey(k)) {
      const t = answerText(v);
      if (t && Object.keys(tracking).length < 30) tracking[k.slice(0, 100)] = t.slice(0, 500);
    } else {
      push(k, v);
    }
  }
  return { answers, tracking };
}

export function buildLeadDoc(body, { source, assignedTo = null, assignedToName = null, keepRaw = false } = {}) {
  const core = extractLead(body);
  if (!core) return null;
  const now = new Date();
  /* Only intake payloads (keepRaw) carry a questionnaire — a CSV import's
     extra columns are not answers. */
  const { answers, tracking } = keepRaw ? extractAnswers(body) : { answers: [], tracking: {} };
  return {
    ...core,
    answers,
    tracking,
    source: source || core.source || "intake",
    status: "new",
    assignedTo,
    assignedToName,
    notes: [],
    statusHistory: [],
    activatedAt: null,
    activatedBy: null,
    raw: keepRaw ? cappedRaw(body) : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

async function findAgent(db, agentId) {
  if (!agentId) return null;
  return db.collection("agents").findOne({ ...agentIdQuery(agentId), active: { $ne: false } }, { projection: { name: 1, nickname: 1, role: 1 } });
}

/* What the lead list / lead screen show as "משויך ל" — the Hebrew nickname
   when the user has one ("גלי"), else the login name. */
const agentLabel = a => a.nickname || a.name;

/* ── Auto-assign ───────────────────────────────────────────────────────
   admin_settings.leadsAutoAssignTo = agentId: every lead that comes in
   (intake, and imports that don't name a manager) goes straight to that
   user. Set on /admin/leads-distribution. A missing or deactivated user
   leaves new leads unassigned, as before. */
async function autoAssignAgent(db) {
  const settings = await db.collection("admin_settings").findOne({}, { projection: { leadsAutoAssignTo: 1 } });
  return settings?.leadsAutoAssignTo ? findAgent(db, settings.leadsAutoAssignTo) : null;
}

/* ── Lead → client sync ────────────────────────────────────────────────
   When a lead moves to בתהליך / לסלוק / לקוח פעיל it becomes a client in
   the main backend's collections (same shared MongoDB). The writes live in
   backend/services/lead-client.service.js — the payment path uses the same
   code when a lead is charged straight from its catalog. Idempotent —
   re-running just refreshes the owner. */
export const CLIENT_STATUSES = new Set(["in_process", "to_charge", "active_client"]);

function syncLeadToClient(db, lead, actor) {
  // owner = the manager the lead is assigned to; fall back to whoever acted
  return leadClient.syncLeadToClient(db, lead, {
    id: lead.assignedTo || actor.id,
    name: lead.assignedToName || actor.nickname || actor.name || "",
  });
}

/* Welcome WhatsApp for a lead that just became "לקוח פעיל". Only queued
   here — iconiq-server's client-notify worker renders and sends it through
   Green API. The unique dedupeKey makes it once per client. */
let notifyIndex = null;
async function queueWelcome(db, lead) {
  if (!lead?.phone) return;
  const col = db.collection("client_notifications");
  const dedupeKey = `welcome:${lead.phone}`;
  try {
    /* The unique dedupeKey index is what makes this once per client — create it
       here too in case this server writes before iconiq-server has ever booted. */
    notifyIndex ??= col.createIndex({ dedupeKey: 1 }, { unique: true }).catch(err => {
      notifyIndex = null;
      console.warn("[leads] client_notifications index:", err.message);
    });
    await notifyIndex;
    if (await col.findOne({ dedupeKey }, { projection: { _id: 1 } })) return;
    await col.insertOne({
      type: "welcome",
      phone: lead.phone,
      dedupeKey,
      meta: { name: lead.name || "" },
      source: "cpanel-leads",
      status: "queued",
      attempts: 0,
      createdAt: new Date(),
    });
  } catch (err) {
    if (err?.code !== 11000) console.warn("[leads] welcome message not queued:", err.message);
  }
}

function parseIds(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    try { out.push(new ObjectId(String(id))); } catch { /* skip invalid */ }
  }
  return out;
}

/* Non-admins only ever see their own leads. */
function scopeFilter(agent) {
  return agent.role === "admin" ? {} : { assignedTo: agent.id };
}

function keyMatches(given) {
  if (!LEADS_INTAKE_KEY) return true;
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(LEADS_INTAKE_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Save one inbound lead the way the public intake does: auto-assign, flag a
   phone that is already in the pipeline (duplicateOf), keep the answers and
   the raw payload. Shared by POST /api/leads/intake and the Facebook Lead
   Ads webhook (server/facebookLeads.js). Returns null when the payload has
   neither a name nor a phone. */
export async function insertIntakeLead(body, { source } = {}) {
  const doc = buildLeadDoc(body, { source, keepRaw: true });
  if (!doc) return null;
  const db = await getDb();
  const auto = await autoAssignAgent(db);
  if (auto) { doc.assignedTo = String(auto._id); doc.assignedToName = agentLabel(auto); }
  if (doc.phone) {
    const dup = await db.collection("leads").findOne({ phone: doc.phone }, { projection: { _id: 1 } });
    if (dup) doc.duplicateOf = String(dup._id);
  }
  const r = await db.collection("leads").insertOne(doc);
  return { id: String(r.insertedId), duplicateOf: doc.duplicateOf ?? null };
}

export const leadsRouter = express.Router();
/* JSON bodies are already parsed app-wide by the backend (backend/server.js). */

/* ── Public intake ──────────────────────────────────────────────────────
   POST /api/leads/intake   header: x-api-key: <LEADS_INTAKE_KEY>
   Body: any JSON with at least a phone or a name. Wire landing pages,
   Zapier etc. straight at this. Facebook Lead Ads come in through their
   own webhook, POST /api/leads/facebook-webhook (server/facebookLeads.js). */
leadsRouter.post("/api/leads/intake", async (req, res) => {
  if (!keyMatches(req.headers["x-api-key"])) {
    return res.status(401).json({ error: "unauthorized", message: "x-api-key שגוי" });
  }
  try {
    const saved = await insertIntakeLead(req.body, { source: req.query.source ? str(req.query.source, 100) : undefined });
    if (!saved) return res.status(400).json({ error: "bad_request", message: "נדרש לפחות טלפון או שם" });
    res.status(201).json({ ok: true, ...saved });
  } catch (err) {
    serverError(res, err, "leads/intake");
  }
});

/* ── Everything below requires a logged-in panel user ──────────────────
   Auth is attached per route, never router-wide: this router sits in front
   of the backend's own /api/leads router (backend/routes/leads.routes.js),
   whose public endpoints (wa-click beacon, referral, posts, statuses) a
   router-wide gate would 401. Paths that aren't the panel's fall through. */
const idRoute = (req, _res, next) => (/^[a-f0-9]{24}$/i.test(String(req.params.id)) ? next() : next("route"));
/* GET /api/leads?page_id=… is the backend's Facebook-leads listing. */
const fbLeadsRoute = (req, _res, next) => (req.query.page_id ? next("route") : next());
/* Backend referral endpoints the SPA calls (src/api/admin.ts) have no auth of
   their own in backend/routes/leads.routes.js — keep them behind the panel
   login, then hand over to the backend router. */
const toBackend = (_req, _res, next) => next("route");
leadsRouter.get("/api/leads/referrals/admin", requireAuth, toBackend);
leadsRouter.patch(["/api/leads/:id/referral-approve", "/api/leads/:id/referral-close"], requireAuth, toBackend);

function escapeRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/leads?status=&search=&assigned=me|unassigned|all|<agentId>&limit=&offset=
leadsRouter.get("/api/leads", fbLeadsRoute, requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const q = { ...scopeFilter(req.agent) };
    const { status, search, assigned } = req.query;
    if (status && LEAD_STATUSES.includes(String(status))) q.status = String(status);
    if (req.agent.role === "admin" && assigned) {
      if (assigned === "me") q.assignedTo = req.agent.id;
      else if (assigned === "unassigned") q.assignedTo = null;
      else if (assigned !== "all") q.assignedTo = String(assigned);
    }
    const s = str(search, 100);
    if (s) {
      const rx = new RegExp(escapeRx(s), "i");
      q.$or = [{ name: rx }, { phoneRaw: rx }, { email: rx }, { business: rx }, { field: rx }, { message: rx }];
      const digits = s.replace(/\D/g, "");
      if (digits.length >= 3) q.$or.push({ phone: new RegExp(escapeRx(normalizePhone(digits))) });
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const col = db.collection("leads");
    const [rows, total] = await Promise.all([
      col.find(q, { projection: { raw: 0, answers: 0, tracking: 0 } }).sort({ createdAt: -1 }).skip(offset).limit(limit).toArray(),
      col.countDocuments(q),
    ]);
    res.json({ leads: rows.map(d => serialize(d)), total });
  } catch (err) {
    serverError(res, err, "leads/list");
  }
});

// GET /api/leads/stats → { total, byStatus: { new: n, ... }, unassigned }
leadsRouter.get("/api/leads/stats", fbLeadsRoute, requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection("leads").aggregate([
      { $match: scopeFilter(req.agent) },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]).toArray();
    const byStatus = Object.fromEntries(LEAD_STATUSES.map(s => [s, 0]));
    let total = 0;
    for (const r of rows) { byStatus[r._id] = r.n; total += r.n; }
    const unassigned = req.agent.role === "admin"
      ? await db.collection("leads").countDocuments({ assignedTo: null })
      : 0;
    res.json({ total, byStatus, unassigned });
  } catch (err) {
    serverError(res, err, "leads/stats");
  }
});

/* ── Sales dashboard ───────────────────────────────────────────────────
   GET /api/leads/dashboard — the numbers on a salesperson's home screen,
   over the caller's own leads (admins: every lead) and the quotes they
   built. Days are Israel calendar days. */
const TZ = "Asia/Jerusalem";
const DASH_DAYS = 14;
const LIST_FIELDS = { name: 1, phone: 1, phoneRaw: 1, business: 1, field: 1, source: 1, status: 1, assignedToName: 1, createdAt: 1, updatedAt: 1 };
const dayKey = date => ({ $dateToString: { format: "%Y-%m-%d", date, timezone: TZ } });
const todayIL = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

leadsRouter.get("/api/leads/dashboard", requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const today = todayIL();
    const month = today.slice(0, 7);
    /* Calendar arithmetic on a UTC noon anchor — immune to DST shifts. */
    const anchor = Date.parse(`${today}T12:00:00Z`);
    const days = Array.from({ length: 31 }, (_, i) => new Date(anchor - (30 - i) * 86_400_000).toISOString().slice(0, 10));
    const since = new Date(Date.parse(`${days[0]}T00:00:00Z`) - 86_400_000); // a day of slack for the offset

    const [agg] = await db.collection("leads").aggregate([
      { $match: scopeFilter(req.agent) },
      { $facet: {
        byStatus:  [{ $group: { _id: "$status", n: { $sum: 1 } } }],
        created:   [{ $match: { createdAt: { $gte: since } } }, { $group: { _id: dayKey("$createdAt"), n: { $sum: 1 } } }],
        activated: [{ $match: { activatedAt: { $gte: since } } }, { $group: { _id: dayKey("$activatedAt"), n: { $sum: 1 } } }],
        converted: [{ $match: { $or: [{ clientPhone: { $nin: [null, ""] } }, { status: { $in: [...CLIENT_STATUSES] } }] } }, { $count: "n" }],
        fresh:     [{ $match: { status: "new" } }, { $sort: { createdAt: -1 } }, { $limit: 8 }, { $project: LIST_FIELDS }],
        callAgain: [{ $match: { status: "call_again" } }, { $sort: { updatedAt: 1 } }, { $limit: 8 }, { $project: LIST_FIELDS }],
        toCharge:  [{ $match: { status: "to_charge" } }, { $sort: { updatedAt: 1 } }, { $limit: 8 }, { $project: LIST_FIELDS }],
      } },
    ]).toArray();

    const byStatus = Object.fromEntries(LEAD_STATUSES.map(st => [st, 0]));
    let total = 0;
    for (const r of agg.byStatus) { if (r._id in byStatus) byStatus[r._id] = r.n; total += r.n; }
    const createdBy = Object.fromEntries(agg.created.map(r => [r._id, r.n]));
    const activatedBy = Object.fromEntries(agg.activated.map(r => [r._id, r.n]));
    const sum = (map, keys) => keys.reduce((n, k) => n + (map[k] || 0), 0);
    const monthDays = days.filter(d => d.startsWith(month));
    const converted = agg.converted[0]?.n || 0;

    /* Quotes this user built (admins: all), from personal_packages. */
    const quoteScope = req.agent.role === "admin" ? {} : { agentId: req.agent.id };
    const [q] = await db.collection("personal_packages").aggregate([
      { $match: { kind: "quote", active: { $ne: false }, ...quoteScope } },
      { $group: {
        _id: null,
        total:      { $sum: 1 },
        signed:     { $sum: { $cond: [{ $ifNull: ["$signed.at", false] }, 1, 0] } },
        signedNet:  { $sum: { $cond: [{ $ifNull: ["$signed.at", false] }, { $ifNull: ["$totals.commitNet", 0] }, 0] } },
        signedMonth: { $sum: { $cond: [{ $eq: [{ $substrCP: [{ $ifNull: [dayKey("$signed.at"), ""] }, 0, 7] }, month] }, 1, 0] } },
      } },
    ]).toArray();

    res.json({
      total,
      byStatus,
      converted,
      conversionRate: total ? Math.round((converted / total) * 1000) / 10 : 0,
      newToday: createdBy[today] || 0,
      newWeek: sum(createdBy, days.slice(-7)),
      newMonth: sum(createdBy, monthDays),
      activatedMonth: sum(activatedBy, monthDays),
      daily: days.slice(-DASH_DAYS).map(date => ({ date, created: createdBy[date] || 0, activated: activatedBy[date] || 0 })),
      fresh: agg.fresh.map(d => serialize(d)),
      callAgain: agg.callAgain.map(d => serialize(d)),
      toCharge: agg.toCharge.map(d => serialize(d)),
      quotes: {
        total: q?.total || 0,
        signed: q?.signed || 0,
        pending: (q?.total || 0) - (q?.signed || 0),
        signedNet: q?.signedNet || 0,
        signedMonth: q?.signedMonth || 0,
      },
    });
  } catch (err) {
    serverError(res, err, "leads/dashboard");
  }
});

/* ── Auto-assign setting (admin) ───────────────────────────────────────
   GET  /api/leads/auto-assign → { agentId, agentName, unassigned }
   PUT  /api/leads/auto-assign { agentId | null, assignExisting? }
        assignExisting also hands that user every lead that is still
        unassigned right now. */
leadsRouter.get("/api/leads/auto-assign", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const db = await getDb();
    const [a, unassigned] = await Promise.all([
      autoAssignAgent(db),
      db.collection("leads").countDocuments({ assignedTo: null }),
    ]);
    res.json({ agentId: a ? String(a._id) : null, agentName: a ? agentLabel(a) : null, unassigned });
  } catch (err) {
    serverError(res, err, "leads/auto-assign:get");
  }
});

leadsRouter.put("/api/leads/auto-assign", requireAuth, requireAdmin, async (req, res) => {
  const { agentId, assignExisting } = req.body ?? {};
  try {
    const db = await getDb();
    let a = null;
    if (agentId) {
      a = await findAgent(db, agentId);
      if (!a) return res.status(400).json({ error: "bad_agent", message: "המשתמש לשיוך לא נמצא או לא פעיל" });
      if (a.role === "admin") return res.status(400).json({ error: "bad_agent", message: "שיוך אוטומטי הוא לאיש מכירות או מנהל תיקים, לא לאדמין" });
    }
    await db.collection("admin_settings").updateOne(
      {},
      { $set: { leadsAutoAssignTo: a ? String(a._id) : null, leadsAutoAssignUpdatedAt: new Date(), leadsAutoAssignUpdatedBy: req.agent.id } },
      { upsert: true },
    );
    let assigned = 0;
    if (a && assignExisting) {
      const r = await db.collection("leads").updateMany(
        { assignedTo: null },
        { $set: { assignedTo: String(a._id), assignedToName: agentLabel(a), updatedAt: new Date() } },
      );
      assigned = r.modifiedCount;
    }
    res.json({ ok: true, agentId: a ? String(a._id) : null, agentName: a ? agentLabel(a) : null, assigned });
  } catch (err) {
    serverError(res, err, "leads/auto-assign:put");
  }
});

// POST /api/leads/import  { leads: [...], assignedTo? } → bulk create
leadsRouter.post("/api/leads/import", requireAuth, async (req, res) => {
  const { leads, assignedTo } = req.body ?? {};
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: "bad_request", message: "leads חייב להיות מערך לא ריק" });
  }
  try {
    const db = await getDb();
    let target = null, targetName = null;
    if (req.agent.role !== "admin") {
      target = req.agent.id; targetName = req.agent.nickname || req.agent.name; // managers can only import to themselves
    } else if (assignedTo) {
      const a = await findAgent(db, assignedTo);
      if (!a) return res.status(400).json({ error: "bad_agent", message: "המנהל לשיוך לא נמצא" });
      target = String(a._id); targetName = agentLabel(a);
    } else {
      const auto = await autoAssignAgent(db); // no manager picked → the auto-assign user, if set
      if (auto) { target = String(auto._id); targetName = agentLabel(auto); }
    }
    const docs = leads.slice(0, 2000)
      .map(l => buildLeadDoc(l, { source: l?.source || "import", assignedTo: target, assignedToName: targetName }))
      .filter(Boolean);
    if (docs.length === 0) return res.status(400).json({ error: "bad_request", message: "לא נמצאו לידים תקינים (נדרש שם או טלפון)" });
    const phones = docs.map(d => d.phone).filter(Boolean);
    const existing = phones.length
      ? await db.collection("leads").find({ phone: { $in: phones } }, { projection: { phone: 1 } }).toArray()
      : [];
    const seen = new Set(existing.map(e => e.phone));
    const fresh = [];
    for (const d of docs) {
      if (d.phone) {
        if (seen.has(d.phone)) continue; // already in DB, or earlier in this same batch
        seen.add(d.phone);
      }
      fresh.push(d);
    }
    let inserted = 0;
    if (fresh.length) inserted = (await db.collection("leads").insertMany(fresh)).insertedCount;
    res.json({ ok: true, imported: inserted, skipped: docs.length - inserted, assignedTo: target, assignedToName: targetName });
  } catch (err) {
    serverError(res, err, "leads/import");
  }
});

// POST /api/leads/assign  { ids: [], toAgentId }   (admin)
leadsRouter.post("/api/leads/assign", requireAuth, requireAdmin, async (req, res) => {
  const { ids, toAgentId } = req.body ?? {};
  const oids = parseIds(ids);
  if (oids.length === 0 || !toAgentId) {
    return res.status(400).json({ error: "bad_request", message: "ids ו-toAgentId נדרשים" });
  }
  try {
    const db = await getDb();
    const a = await findAgent(db, toAgentId);
    if (!a) return res.status(404).json({ error: "not_found", message: "המנהל לא נמצא" });
    const r = await db.collection("leads").updateMany(
      { _id: { $in: oids } },
      { $set: { assignedTo: String(a._id), assignedToName: agentLabel(a), updatedAt: new Date() } },
    );
    res.json({ ok: true, assigned: r.modifiedCount, skipped: (Array.isArray(ids) ? ids.length : 0) - r.modifiedCount });
  } catch (err) {
    serverError(res, err, "leads/assign");
  }
});

// POST /api/leads/round-robin  { ids: [], agentIds?: [] }   (admin)
// Least-loaded first, so repeated small batches stay balanced instead of
// always landing on the alphabetically-first manager.
leadsRouter.post("/api/leads/round-robin", requireAuth, requireAdmin, async (req, res) => {
  const { ids, agentIds } = req.body ?? {};
  const oids = parseIds(ids);
  if (oids.length === 0) return res.status(400).json({ error: "bad_request", message: "ids נדרש" });
  try {
    const db = await getDb();
    const wanted = parseIds(agentIds);
    const agentQuery = wanted.length
      ? { _id: { $in: wanted }, active: { $ne: false } }
      : { active: { $ne: false }, role: { $ne: "admin" } };
    const agents = await db.collection("agents").find(agentQuery, { projection: { name: 1, nickname: 1 } }).toArray();
    if (agents.length === 0) return res.status(400).json({ error: "no_agents", message: "אין מנהלים פעילים לחלוקה" });
    const loads = await db.collection("leads").aggregate([
      { $match: { assignedTo: { $in: agents.map(a => String(a._id)) } } },
      { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
    ]).toArray();
    const load = Object.fromEntries(agents.map(a => [String(a._id), 0]));
    for (const l of loads) load[l._id] = l.n;

    const distribution = {};
    let assigned = 0;
    for (const oid of oids) {
      // pick the currently least-loaded agent (ties → by name)
      const a = agents.slice().sort((x, y) => (load[String(x._id)] - load[String(y._id)]) || String(x.name).localeCompare(String(y.name)))[0];
      const r = await db.collection("leads").updateOne(
        { _id: oid },
        { $set: { assignedTo: String(a._id), assignedToName: agentLabel(a), updatedAt: new Date() } },
      );
      if (r.matchedCount) {
        load[String(a._id)]++;
        if (r.modifiedCount) { assigned++; distribution[agentLabel(a)] = (distribution[agentLabel(a)] || 0) + 1; }
      }
    }
    res.json({ ok: true, assigned, skipped: oids.length - assigned, distribution });
  } catch (err) {
    serverError(res, err, "leads/round-robin");
  }
});

async function loadScoped(db, req, res) {
  let oid;
  try { oid = new ObjectId(String(req.params.id)); } catch { res.status(400).json({ error: "bad_id", message: "מזהה לא תקין" }); return null; }
  const lead = await db.collection("leads").findOne({ _id: oid, ...scopeFilter(req.agent) });
  if (!lead) { res.status(404).json({ error: "not_found", message: "הליד לא נמצא" }); return null; }
  return lead;
}

/* GET /api/leads/for-client/:phone — the lead(s) a client came from, for the
   "מקור הליד" card on the client page. Allowed for admins, the client's
   manager (cpanel_clients) and the manager the lead is assigned to.
   (The backend owns GET /api/leads/by-phone/:phone — different data.) */
leadsRouter.get("/api/leads/for-client/:phone", requireAuth, async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone) return res.json({ leads: [] });
  try {
    const db = await getDb();
    const q = { $or: [{ phone }, { clientPhone: phone }], statusHistory: { $exists: true } };
    if (req.agent.role !== "admin") {
      const owns = await db.collection("cpanel_clients").findOne({ phone, agentId: req.agent.id }, { projection: { _id: 1 } });
      if (!owns) q.assignedTo = req.agent.id;
    }
    const rows = await db.collection("leads").find(q).sort({ createdAt: -1 }).limit(20).toArray();
    res.json({ leads: rows.map(d => serialize(withAnswers(d))) });
  } catch (err) {
    serverError(res, err, "leads/for-client");
  }
});

/* Intake leads stored before answers were extracted still have their raw
   payload — derive the answers from it on read. */
function withAnswers(lead) {
  if (lead.answers || !lead.raw || lead.raw._truncated) return lead;
  return { ...lead, ...extractAnswers(lead.raw) };
}

// GET /api/leads/:id  (includes the sanitized raw intake payload)
leadsRouter.get("/api/leads/:id", idRoute, requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const lead = await loadScoped(db, req, res);
    if (lead) res.json({ lead: serialize(withAnswers(lead), { withRaw: true }) });
  } catch (err) {
    serverError(res, err, "leads/get");
  }
});

// PATCH /api/leads/:id  { status?, name?, phone?, email?, business?, field?, assignedTo? (admin) }
leadsRouter.patch("/api/leads/:id", idRoute, requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const lead = await loadScoped(db, req, res);
    if (!lead) return;
    const body = req.body ?? {};
    const $set = { updatedAt: new Date() };
    const $push = {};
    for (const k of ["name", "email", "business", "field", "campaign", "source"]) {
      if (body[k] !== undefined) $set[k] = str(body[k], 200);
    }
    if (body.message !== undefined) $set.message = str(body.message, 2000);
    if (body.phone !== undefined && normalizePhone(body.phone) !== lead.phone) {
      /* The client, its catalog and payments are all keyed by this phone. */
      if (lead.clientPhone) {
        return res.status(409).json({ error: "phone_locked", message: "הליד כבר נפתח כלקוח — אי אפשר לשנות לו טלפון" });
      }
      $set.phoneRaw = str(body.phone, 50); $set.phone = normalizePhone(body.phone);
    }
    if (body.status !== undefined) {
      if (!LEAD_STATUSES.includes(body.status)) {
        return res.status(400).json({ error: "bad_status", message: `סטטוס לא חוקי. אפשרויות: ${LEAD_STATUSES.join(", ")}` });
      }
      if (body.status !== lead.status) {
        $set.status = body.status;
        $push.statusHistory = { from: lead.status, to: body.status, by: req.agent.id, byName: req.agent.name, at: new Date() };
        if (body.status === "active_client") { $set.activatedAt = new Date(); $set.activatedBy = req.agent.id; }
      }
    }
    if (body.assignedTo !== undefined) {
      if (req.agent.role !== "admin") return res.status(403).json({ error: "forbidden", message: "רק מנהל מערכת יכול לשייך לידים" });
      if (body.assignedTo) {
        const a = await findAgent(db, body.assignedTo);
        if (!a) return res.status(400).json({ error: "bad_agent", message: "המנהל לשיוך לא נמצא" });
        $set.assignedTo = String(a._id); $set.assignedToName = agentLabel(a);
      } else {
        $set.assignedTo = null; $set.assignedToName = null;
      }
    }
    const update = { $set };
    if (Object.keys($push).length) update.$push = $push;
    let r = await db.collection("leads").findOneAndUpdate({ _id: lead._id }, update, { returnDocument: "after" });
    if ($set.status && CLIENT_STATUSES.has($set.status)) {
      await syncLeadToClient(db, r, req.agent);
      r = await db.collection("leads").findOne({ _id: lead._id });
    }
    if ($set.status === "active_client") await queueWelcome(db, r);
    res.json({ lead: serialize(r) });
  } catch (err) {
    serverError(res, err, "leads/patch");
  }
});

// POST /api/leads/:id/notes  { text }
leadsRouter.post("/api/leads/:id/notes", idRoute, requireAuth, async (req, res) => {
  const text = str(req.body?.text, 4000);
  if (!text) return res.status(400).json({ error: "bad_request", message: "טקסט ההערה ריק" });
  try {
    const db = await getDb();
    const lead = await loadScoped(db, req, res);
    if (!lead) return;
    const note = { id: new ObjectId().toString(), text, by: req.agent.id, byName: req.agent.name, at: new Date() };
    const r = await db.collection("leads").findOneAndUpdate(
      { _id: lead._id },
      { $push: { notes: note }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    res.json({ lead: serialize(r), note });
  } catch (err) {
    serverError(res, err, "leads/notes");
  }
});

// POST /api/leads/:id/activate → status = active_client
leadsRouter.post("/api/leads/:id/activate", idRoute, requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const lead = await loadScoped(db, req, res);
    if (!lead) return;
    const now = new Date();
    const update = {
      $set: { status: "active_client", activatedAt: now, activatedBy: req.agent.id, updatedAt: now },
    };
    if (lead.status !== "active_client") {
      update.$push = { statusHistory: { from: lead.status, to: "active_client", by: req.agent.id, byName: req.agent.name, at: now } };
    }
    let r = await db.collection("leads").findOneAndUpdate({ _id: lead._id }, update, { returnDocument: "after" });
    await syncLeadToClient(db, r, req.agent);
    r = await db.collection("leads").findOne({ _id: lead._id });
    if (lead.status !== "active_client") await queueWelcome(db, r);
    res.json({ lead: serialize(r) });
  } catch (err) {
    serverError(res, err, "leads/activate");
  }
});

// DELETE /api/leads/:id   (admin)
leadsRouter.delete("/api/leads/:id", idRoute, requireAuth, requireAdmin, async (req, res) => {
  let oid;
  try { oid = new ObjectId(String(req.params.id)); } catch { return res.status(400).json({ error: "bad_id", message: "מזהה לא תקין" }); }
  try {
    const db = await getDb();
    const r = await db.collection("leads").deleteOne({ _id: oid });
    res.json({ ok: r.deletedCount === 1 });
  } catch (err) {
    serverError(res, err, "leads/delete");
  }
});
