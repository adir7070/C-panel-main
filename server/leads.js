import crypto from "crypto";
import express from "express";
import { ObjectId } from "mongodb";
import { getDb } from "./db.js";
import { requireAuth, requireAdmin, serverError, agentIdQuery } from "./auth.js";

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
  const phoneRaw = str(b.phone ?? b.tel ?? b.telephone ?? b.mobile ?? b["טלפון"] ?? b["נייד"] ?? "", 50);
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

export function buildLeadDoc(body, { source, assignedTo = null, assignedToName = null, keepRaw = false } = {}) {
  const core = extractLead(body);
  if (!core) return null;
  const now = new Date();
  return {
    ...core,
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
  return db.collection("agents").findOne({ ...agentIdQuery(agentId), active: { $ne: false } }, { projection: { name: 1, nickname: 1 } });
}

/* ── Lead → client sync ────────────────────────────────────────────────
   When a lead moves to בתהליך / לסלוק / לקוח פעיל it becomes a client in
   the main backend's collections (same shared MongoDB): the exact writes
   the backend's own Fireberry-free path does (cpanel_clients mapping +
   support_chats owner), plus a business_profiles seed so the איפיון tab
   opens pre-filled. Idempotent — re-running just refreshes the owner. */
export const CLIENT_STATUSES = new Set(["in_process", "to_charge", "active_client"]);

async function syncLeadToClient(db, lead, actor) {
  if (!lead.phone) return { skipped: "no_phone" };
  const now = new Date();
  // owner = the manager the lead is assigned to; fall back to whoever acted
  const ownerId = lead.assignedTo || actor.id;
  const ownerName = lead.assignedToName || actor.nickname || actor.name || "";
  const name = lead.name || lead.business || lead.phone;

  await db.collection("cpanel_clients").updateOne(
    { phone: lead.phone },
    {
      $set: { agentId: String(ownerId), agentName: ownerName, phone: lead.phone, customerName: name, leadId: String(lead._id) },
      $setOnInsert: { firebery1013Id: null, customerId: null, createdAt: now, source: "lead" },
    },
    { upsert: true },
  );
  await db.collection("support_chats").updateOne(
    { phone: lead.phone },
    {
      $set: { accountManagerId: String(ownerId), accountManagerName: ownerName || null, updated_at: now },
      $setOnInsert: { _id: lead.phone, phone: lead.phone, name, status: "open", created_at: now },
    },
    { upsert: true },
  );
  const profileSeed = { phone: lead.phone, updatedAt: now };
  if (lead.business) profileSeed.businessName = lead.business;
  if (lead.email) profileSeed.email = lead.email;
  if (lead.field) profileSeed.businessField = lead.field;
  await db.collection("business_profiles").updateOne(
    { phone: lead.phone },
    { $setOnInsert: { ...profileSeed, createdAt: now, businessPhone: lead.phone } },
    { upsert: true },
  );
  await db.collection("leads").updateOne(
    { _id: lead._id },
    { $set: { clientPhone: lead.phone, convertedAt: lead.convertedAt || now, updatedAt: now } },
  );
  return { clientPhone: lead.phone };
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

export const leadsRouter = express.Router();
/* Body parser scoped to /api/leads only — a router-level parser would also
   drain bodies of /api/** requests that fall through to the backend proxy. */
leadsRouter.use("/api/leads", express.json({ limit: "2mb" }));

/* ── Public intake ──────────────────────────────────────────────────────
   POST /api/leads/intake   header: x-api-key: <LEADS_INTAKE_KEY>
   Body: any JSON with at least a phone or a name. Wire landing pages,
   Facebook lead-form forwarders, Zapier, etc. straight at this. */
leadsRouter.post("/api/leads/intake", async (req, res) => {
  if (!keyMatches(req.headers["x-api-key"])) {
    return res.status(401).json({ error: "unauthorized", message: "x-api-key שגוי" });
  }
  const doc = buildLeadDoc(req.body, { source: req.query.source ? str(req.query.source, 100) : undefined, keepRaw: true });
  if (!doc) return res.status(400).json({ error: "bad_request", message: "נדרש לפחות טלפון או שם" });
  try {
    const db = await getDb();
    if (doc.phone) {
      const dup = await db.collection("leads").findOne({ phone: doc.phone }, { projection: { _id: 1 } });
      if (dup) doc.duplicateOf = String(dup._id);
    }
    const r = await db.collection("leads").insertOne(doc);
    res.status(201).json({ ok: true, id: String(r.insertedId), duplicateOf: doc.duplicateOf ?? null });
  } catch (err) {
    serverError(res, err, "leads/intake");
  }
});

/* ── Everything below requires a logged-in panel user ────────────────── */
leadsRouter.use("/api/leads", requireAuth);

function escapeRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/leads?status=&search=&assigned=me|unassigned|all|<agentId>&limit=&offset=
leadsRouter.get("/api/leads", async (req, res) => {
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
      col.find(q, { projection: { raw: 0 } }).sort({ createdAt: -1 }).skip(offset).limit(limit).toArray(),
      col.countDocuments(q),
    ]);
    res.json({ leads: rows.map(d => serialize(d)), total });
  } catch (err) {
    serverError(res, err, "leads/list");
  }
});

// GET /api/leads/stats → { total, byStatus: { new: n, ... }, unassigned }
leadsRouter.get("/api/leads/stats", async (req, res) => {
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

// POST /api/leads/import  { leads: [...], assignedTo? } → bulk create
leadsRouter.post("/api/leads/import", async (req, res) => {
  const { leads, assignedTo } = req.body ?? {};
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: "bad_request", message: "leads חייב להיות מערך לא ריק" });
  }
  try {
    const db = await getDb();
    let target = null, targetName = null;
    if (req.agent.role !== "admin") {
      target = req.agent.id; targetName = req.agent.name; // managers can only import to themselves
    } else if (assignedTo) {
      const a = await findAgent(db, assignedTo);
      if (!a) return res.status(400).json({ error: "bad_agent", message: "המנהל לשיוך לא נמצא" });
      target = String(a._id); targetName = a.name;
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
leadsRouter.post("/api/leads/assign", requireAdmin, async (req, res) => {
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
      { $set: { assignedTo: String(a._id), assignedToName: a.name, updatedAt: new Date() } },
    );
    res.json({ ok: true, assigned: r.modifiedCount, skipped: (Array.isArray(ids) ? ids.length : 0) - r.modifiedCount });
  } catch (err) {
    serverError(res, err, "leads/assign");
  }
});

// POST /api/leads/round-robin  { ids: [], agentIds?: [] }   (admin)
// Least-loaded first, so repeated small batches stay balanced instead of
// always landing on the alphabetically-first manager.
leadsRouter.post("/api/leads/round-robin", requireAdmin, async (req, res) => {
  const { ids, agentIds } = req.body ?? {};
  const oids = parseIds(ids);
  if (oids.length === 0) return res.status(400).json({ error: "bad_request", message: "ids נדרש" });
  try {
    const db = await getDb();
    const wanted = parseIds(agentIds);
    const agentQuery = wanted.length
      ? { _id: { $in: wanted }, active: { $ne: false } }
      : { active: { $ne: false }, role: { $ne: "admin" } };
    const agents = await db.collection("agents").find(agentQuery, { projection: { name: 1 } }).toArray();
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
        { $set: { assignedTo: String(a._id), assignedToName: a.name, updatedAt: new Date() } },
      );
      if (r.matchedCount) {
        load[String(a._id)]++;
        if (r.modifiedCount) { assigned++; distribution[a.name] = (distribution[a.name] || 0) + 1; }
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

// GET /api/leads/:id  (includes the sanitized raw intake payload)
leadsRouter.get("/api/leads/:id", async (req, res) => {
  try {
    const db = await getDb();
    const lead = await loadScoped(db, req, res);
    if (lead) res.json({ lead: serialize(lead, { withRaw: true }) });
  } catch (err) {
    serverError(res, err, "leads/get");
  }
});

// PATCH /api/leads/:id  { status?, name?, phone?, email?, business?, field?, assignedTo? (admin) }
leadsRouter.patch("/api/leads/:id", async (req, res) => {
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
    if (body.phone !== undefined) { $set.phoneRaw = str(body.phone, 50); $set.phone = normalizePhone(body.phone); }
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
        $set.assignedTo = String(a._id); $set.assignedToName = a.name;
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
leadsRouter.post("/api/leads/:id/notes", async (req, res) => {
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
leadsRouter.post("/api/leads/:id/activate", async (req, res) => {
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
leadsRouter.delete("/api/leads/:id", requireAdmin, async (req, res) => {
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
