import crypto from "crypto";
import express from "express";
import { getDb } from "./db.js";
import { insertIntakeLead } from "./leads.js";

/* ── Facebook Lead Ads → leads pipeline ─────────────────────────────────
   Dashen's own Facebook page sends every new lead-form submission here
   through our Meta app's Webhooks product (Page object, "leadgen" field):

     GET  /api/leads/facebook-webhook   Meta's subscription handshake
                                        (no hub.* params → a config check)
     POST /api/leads/facebook-webhook   { object: "page", entry[].changes[] }

   A notification carries ids only (leadgen_id, form_id, ad_id …), so the
   lead is read from the Graph API with the page's token and saved through
   insertIntakeLead(), exactly like POST /api/leads/intake: source
   "facebook", auto-assign, duplicate-phone flag, the form's answers.

   Config (Heroku config vars):
     FB_LEADS_VERIFY_TOKEN  the "Verify token" typed into the app's Webhooks setup
     FB_LEADS_APP_SECRET    the app's App Secret — checks X-Hub-Signature-256
     FB_LEADS_PAGE_TOKEN    a long-lived (never-expiring) Page access token
     FB_LEADS_PAGE_ID       only this page's leads are taken
     FB_LEADS_API_VERSION   optional ("v24.0"); unset = the app's default version

   Meta retries a delivery that gets no 2xx for up to 36 hours, so a lead
   whose read failed answers 500 and comes back later. fb_leadgen_events
   (_id = leadgen_id) makes each lead land once however often it is sent. */

export const FB_WEBHOOK_PATH = "/api/leads/facebook-webhook";
const STALE_MS = 2 * 60 * 1000;
const FORM_CACHE_MS = 10 * 60 * 1000;

function cfg() {
  const e = process.env;
  return {
    verifyToken: e.FB_LEADS_VERIFY_TOKEN || "",
    appSecret: e.FB_LEADS_APP_SECRET || "",
    pageToken: e.FB_LEADS_PAGE_TOKEN || "",
    pageId: String(e.FB_LEADS_PAGE_ID || "").trim(),
    graph: `https://graph.facebook.com${e.FB_LEADS_API_VERSION ? "/" + e.FB_LEADS_API_VERSION : ""}`,
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Meta signs the exact bytes it sent: "sha256=" + HMAC-SHA256(body, App
   Secret). backend/server.js keeps those bytes as req.rawBody on this path. */
function signatureOk(req, appSecret) {
  const header = String(req.get("x-hub-signature-256") || "");
  if (!header.startsWith("sha256=") || !Buffer.isBuffer(req.rawBody)) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
  return safeEqual(header, expected);
}

/* Facebook ids can exceed 2^53; parse the raw bytes so a numeric id keeps
   every digit (as a string) instead of being rounded. */
function parseExact(raw) {
  try {
    return JSON.parse(raw.toString("utf8"), (_k, v, ctx) =>
      typeof v === "number" && !Number.isSafeInteger(v) && ctx?.source ? ctx.source : v);
  } catch {
    return null;
  }
}

async function graphGet(c, path, params) {
  const url = new URL(c.graph + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", c.pageToken);
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = data.error || {};
    // never put the URL in the message — it carries the page token
    const err = new Error(`Graph ${path}: ${e.message || `HTTP ${r.status}`}`);
    err.graph = { status: r.status, code: e.code, subcode: e.error_subcode, type: e.type };
    throw err;
  }
  return data;
}

/* The form's name and its question labels (key → the text the lead saw),
   so answers read "מה התקציב שלך?" instead of a generated key. */
const formCache = new Map();
async function formInfo(c, formId) {
  if (!formId) return { name: "", labels: new Map() };
  const hit = formCache.get(formId);
  if (hit && Date.now() - hit.at < FORM_CACHE_MS) return hit;
  const info = { at: Date.now(), name: "", labels: new Map() };
  try {
    const f = await graphGet(c, `/${formId}`, { fields: "name,questions" });
    info.name = String(f.name || "");
    for (const q of Array.isArray(f.questions) ? f.questions : []) {
      if (q?.key) info.labels.set(String(q.key), String(q.label || q.key));
    }
  } catch (err) {
    console.warn(`[fb-leads] form ${formId}: labels unavailable (${err.message})`);
  }
  formCache.set(formId, info);
  return info;
}

/* Ad / campaign names need access the page token may lack; the answers
   themselves don't — fall back to the bare lead rather than lose it. */
async function readLead(c, leadgenId) {
  try {
    return await graphGet(c, `/${leadgenId}`, {
      fields: "id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,platform",
    });
  } catch (err) {
    console.warn(`[fb-leads] lead ${leadgenId}: full read failed (${err.message}) — reading the answers only`);
    return graphGet(c, `/${leadgenId}`, { fields: "id,created_time,field_data,form_id,ad_id" });
  }
}

/* A Graph lead → the body POST /api/leads/intake understands: Facebook's
   standard keys map onto the fields extractLead() reads, every other
   question goes into answers, ids go into the tracking keys. */
export function toIntakeBody(lead, notif, form) {
  const body = {};
  const answers = [];
  let first = "";
  let last = "";
  for (const f of Array.isArray(lead.field_data) ? lead.field_data : []) {
    const key = String(f?.name ?? "");
    const values = Array.isArray(f?.values) ? f.values : [f?.values];
    const value = values.filter(v => v !== undefined && v !== null && String(v).trim() !== "").join(", ");
    if (!key || !value) continue;
    if (key === "full_name") body.full_name = value;
    else if (key === "first_name") first = value;
    else if (key === "last_name") last = value;
    else if (key === "phone_number") body.phone_number = value;
    else if (key === "email") body.email = value;
    else if (key === "company_name") body.company = value;
    else answers.push({ question: form.labels.get(key) || key, answer: value });
  }
  if (!body.full_name && (first || last)) body.full_name = `${first} ${last}`.trim();
  // a lead needs a name or a phone to be saved — never drop one for lacking both
  if (!body.full_name && !body.phone_number) body.full_name = body.email || `ליד פייסבוק ${notif.leadgen_id}`;
  body.answers = answers;
  if (lead.campaign_name) body.campaign = String(lead.campaign_name);
  const tracking = {
    leadgen_id: notif.leadgen_id,
    page_id: notif.page_id,
    form_id: lead.form_id || notif.form_id,
    form_name: form.name,
    ad_id: lead.ad_id || notif.ad_id,
    ad_name: lead.ad_name,
    adset_id: lead.adset_id,
    adset_name: lead.adset_name,
    campaign_id: lead.campaign_id,
    platform: lead.platform,
    created_time: lead.created_time,
  };
  for (const [k, v] of Object.entries(tracking)) {
    if (v !== undefined && v !== null && v !== "") body[k] = String(v);
  }
  return body;
}

/* One leadgen notification → one lead, at most once. */
async function ingest(c, db, notif) {
  const leadgenId = String(notif.leadgen_id);
  const events = db.collection("fb_leadgen_events");
  const now = new Date();
  let takeover = false;
  try {
    await events.insertOne({
      _id: leadgenId,
      pageId: String(notif.page_id ?? ""),
      formId: String(notif.form_id ?? ""),
      status: "processing",
      attempts: 1,
      receivedAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    // seen before: "done" → nothing to do; "failed", or stuck in "processing" → retry it
    const took = await events.findOneAndUpdate(
      { _id: leadgenId, $or: [{ status: "failed" }, { status: "processing", updatedAt: { $lt: new Date(now.getTime() - STALE_MS) } }] },
      { $set: { status: "processing", updatedAt: now }, $inc: { attempts: 1 } },
    );
    if (!took) return "duplicate";
    takeover = true;
  }
  try {
    if (takeover) {
      // an earlier attempt may have saved the lead and died before marking it done
      const prior = await db.collection("leads").findOne({ "tracking.leadgen_id": leadgenId }, { projection: { _id: 1 } });
      if (prior) {
        await events.updateOne({ _id: leadgenId }, { $set: { status: "done", leadId: String(prior._id), updatedAt: new Date() }, $unset: { error: "" } });
        return "duplicate";
      }
    }
    const lead = await readLead(c, leadgenId);
    const form = await formInfo(c, String(lead.form_id || notif.form_id || ""));
    const saved = await insertIntakeLead(toIntakeBody(lead, notif, form), { source: "facebook" });
    await events.updateOne({ _id: leadgenId }, { $set: { status: "done", leadId: saved?.id ?? null, updatedAt: new Date() }, $unset: { error: "" } });
    return saved?.duplicateOf ? "saved (phone already in the pipeline)" : "saved";
  } catch (err) {
    await events.updateOne({ _id: leadgenId }, { $set: { status: "failed", error: String(err.message).slice(0, 500), updatedAt: new Date() } }).catch(() => {});
    throw err;
  }
}

export const facebookLeadsRouter = express.Router();

facebookLeadsRouter.get(FB_WEBHOOK_PATH, (req, res) => {
  const c = cfg();
  if (req.query["hub.mode"] === undefined) {
    // setup check: which settings the server sees — never their values
    return res.json({
      ok: true,
      configured: { verifyToken: !!c.verifyToken, appSecret: !!c.appSecret, pageToken: !!c.pageToken, pageId: !!c.pageId },
    });
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (c.verifyToken && req.query["hub.mode"] === "subscribe" && safeEqual(req.query["hub.verify_token"], c.verifyToken)) {
    return res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
  }
  console.warn("[fb-leads] webhook verification refused (wrong or unset FB_LEADS_VERIFY_TOKEN)");
  return res.status(403).type("text/plain").send("verification failed");
});

facebookLeadsRouter.post(FB_WEBHOOK_PATH, async (req, res) => {
  const c = cfg();
  if (!c.appSecret || !c.pageToken || !c.pageId) {
    console.error("[fb-leads] FB_LEADS_APP_SECRET / FB_LEADS_PAGE_TOKEN / FB_LEADS_PAGE_ID not set — notification refused, Meta will retry");
    return res.sendStatus(503);
  }
  if (!signatureOk(req, c.appSecret)) {
    console.warn("[fb-leads] bad or missing X-Hub-Signature-256 — ignored");
    return res.sendStatus(401);
  }
  const body = parseExact(req.rawBody);
  if (body?.object !== "page") return res.sendStatus(200);
  const notifs = [];
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (ch?.field === "leadgen" && ch.value?.leadgen_id) notifs.push(ch.value);
    }
  }
  let failed = 0;
  try {
    const db = notifs.length ? await getDb() : null;
    for (const n of notifs) {
      if (String(n.page_id) !== c.pageId) {
        console.warn(`[fb-leads] lead ${n.leadgen_id} is for page ${n.page_id}, not FB_LEADS_PAGE_ID — ignored`);
        continue;
      }
      try {
        console.log(`[fb-leads] lead ${n.leadgen_id} (form ${n.form_id}): ${await ingest(c, db, n)}`);
      } catch (err) {
        failed++;
        console.error(`[fb-leads] lead ${n.leadgen_id} failed: ${err.message}`, err.graph ? JSON.stringify(err.graph) : "");
      }
    }
  } catch (err) {
    failed++;
    console.error("[fb-leads] database unavailable:", err.message);
  }
  res.sendStatus(failed ? 500 : 200);
});
