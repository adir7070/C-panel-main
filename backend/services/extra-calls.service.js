/* Call recordings from Extra Mobile (exm.co.il), the carrier the sales
   line was ported to. Extra records every call at network level and keeps
   the recordings. We keep each call's details in `extra_calls` and ask
   Extra for a short-lived link when an admin presses play.

   The calls arrive two ways, and both are idempotent (`_id` = Extra's id):
     • Extra's end-of-call webhook → POST /api/cpanel/calls/extra-webhook.
       Its body only has to carry the call id. The call itself is re-read
       from the API, so a forged or malformed body can't inject data. When
       EXTRA_WEBHOOK_SECRET is set, the request must carry it (Bearer).
     • A sync every 15 minutes pulls the recent mobile-line calls from
       the API. It catches whatever the webhook missed: a deploy, or an
       automation Extra disabled after 3 failed deliveries.

   API (https://api.exm.co.il/spec/?v=1, Bearer EXTRA_API_KEY):
     POST /calls/                    history; { id } fetches one call
     POST /calls/get-recording-urls/ { ids, config: { ttl 1..10 min } } → signed URLs
     GET  /auth/key/                 verifies the key; returns its expiry
   The Call object: `type` is incoming | incoming_missed | outgoing |
   outgoing_missed (… _start while ringing); `numbers.caller` is the
   initiator and `numbers.destination` the receiver; time.start is local
   "Y-m-d H:i:s" plus time.gmt_offset; `recording` is false when there
   is none. */

const axios = require("axios");
const crypto = require("crypto");
const { getDB } = require("../config/db");

const BASE = (process.env.EXTRA_API_BASE || "https://api.exm.co.il/v1").replace(/\/+$/, "");
const CALLS = () => getDB().collection("extra_calls");
const STATE = () => getDB().collection("integration_state");
const STATE_ID = "extra_calls";
const MOBILE_LINE = 5;

const apiKey = () => (process.env.EXTRA_API_KEY || "").trim();
const webhookSecret = () => (process.env.EXTRA_WEBHOOK_SECRET || "").trim();

class ExtraError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function api(method, path, body) {
  if (!apiKey()) throw new ExtraError("extra_not_configured", "EXTRA_API_KEY לא מוגדר בשרת");
  const r = await axios({
    method, url: `${BASE}${path}`, data: body, timeout: 20000,
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    validateStatus: () => true,
  });
  if (r.status === 401) throw new ExtraError("extra_unauthorized", "אקסטרה דחו את מפתח ה-API");
  if (r.status === 403) throw new ExtraError("extra_blocked", "אקסטרה חסמו את מפתח ה-API (חריגה ממגבלת בקשות?)");
  if (r.status >= 400) throw new ExtraError(`extra_http_${r.status}`, `Extra HTTP ${r.status}`);
  return r.data || {};
}

/* ── normalizing a Call ─────────────────────────────────────────────── */

/* +972501234567 → 0501234567 (same as server/leads.js normalizePhone). */
function localPhone(v) {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("972") && digits.length >= 11) return "0" + digits.slice(3);
  return digits;
}

/* "2026-07-09 14:32:05" + "+03:00" → Date. Without an offset, the time is
   read as Israel time. */
function parseLocal(s, offset) {
  if (!s) return null;
  const iso = String(s).trim().replace(" ", "T");
  if (/^[+-]\d{2}:\d{2}$/.test(String(offset || ""))) {
    const d = new Date(iso + offset);
    return isNaN(d) ? null : d;
  }
  const asUtc = new Date(iso + "Z");
  if (isNaN(asUtc)) return null;
  const il = new Date(asUtc.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const utc = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(asUtc.getTime() - (il - utc));
}

/* `type` is an alias; the webhook docs also describe it in Hebrew
   ("נכנסת נענתה", "יוצאת לא נענתה"), so both are understood. */
function classify(type) {
  const t = String(type || "").toLowerCase();
  const outgoing = t.startsWith("outgoing") || t.includes("יוצאת");
  const missed = t.includes("missed") || t.includes("לא נענתה");
  return { direction: outgoing ? "out" : "in", answered: !missed };
}

function normalize(call) {
  const { direction, answered } = classify(call.type);
  const caller = call.numbers?.caller?.e164 || "";
  const dest = call.numbers?.destination?.e164 || "";
  const other = direction === "out" ? dest : caller;
  const rec = call.recording && typeof call.recording === "object" ? call.recording : null;
  const { contact, ...raw } = call; // contact (name + avatar) comes from the user's phone book
  return {
    type: call.type || null,
    direction,
    answered,
    ownType: call.own_type || null,
    own: call.numbers?.own?.e164 || null,
    caller: caller || null,
    destination: dest || null,
    other: other || null,
    otherLocal: /anonymous/i.test(other) ? "" : localPhone(other),
    contactName: contact && typeof contact === "object" ? contact.name || null : null,
    duration: Number.isFinite(Number(call.duration)) ? Number(call.duration) : null,
    startedAt: parseLocal(call.time?.start, call.time?.gmt_offset),
    endedAt: parseLocal(call.time?.end, call.time?.gmt_offset),
    hasRecording: !!rec && !rec.skip_reason,
    recordingSkipReason: rec?.skip_reason || null,
    starred: !!call.starred,
    note: call.note || null,
    raw,
  };
}

async function upsertCall(call, via) {
  if (!call?.id || call.event === "start") return false;
  const now = new Date();
  await CALLS().updateOne(
    { _id: String(call.id) },
    {
      $set: { ...normalize(call), updatedAt: now },
      $setOnInsert: { provider: "extra", firstSeenAt: now },
      $addToSet: { seenVia: via },
    },
    { upsert: true },
  );
  return true;
}

async function fetchCall(id) {
  const data = await api("post", "/calls/", { id: String(id) });
  return Array.isArray(data.calls) ? data.calls.find(c => String(c.id) === String(id)) || data.calls[0] || null : null;
}

/* ── webhook ────────────────────────────────────────────────────────── */

function webhookAuthorized(req) {
  const secret = webhookSecret();
  if (!secret) return true;
  const auth = String(req.headers.authorization || "");
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : String(req.headers["x-webhook-secret"] || req.headers["x-api-key"] || "").trim();
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* The body only needs { id }. The call is read back from the API; if
   that fails now, the next sync picks it up. */
async function handleWebhook(body = {}) {
  const id = String(body.id || body.call_id || "").trim();
  await STATE().updateOne({ _id: STATE_ID }, { $set: { lastWebhookAt: new Date(), lastWebhookId: id || null } }, { upsert: true });
  if (!id || /\{\{/.test(id)) return { status: "ignored" };
  try {
    const call = await fetchCall(id);
    if (!call) return { status: "not_found" };
    await upsertCall(call, "webhook");
    return { status: "saved" };
  } catch (err) {
    console.warn(`[extra-calls] webhook ${id}: ${err.message} — the sync will retry`);
    return { status: "deferred" };
  }
}

/* ── sync ───────────────────────────────────────────────────────────── */

function ilLocalString(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

let syncing = false;
async function syncRecent({ days = null } = {}) {
  if (!apiKey()) return { skipped: "no_api_key" };
  if (syncing) return { skipped: "running" };
  syncing = true;
  const startedAt = new Date();
  try {
    const state = await STATE().findOne({ _id: STATE_ID });
    const from = days
      ? new Date(Date.now() - days * 864e5)
      : state?.lastSyncAt ? new Date(new Date(state.lastSyncAt).getTime() - 2 * 3600e3) : new Date(Date.now() - 7 * 864e5);
    const filter = { line_types: [MOBILE_LINE], time: { from: ilLocalString(from) } };
    let next = null, saved = 0, pages = 0;
    do {
      const data = await api("post", "/calls/", { ...filter, pagination: { items: 100, ...(next ? { next } : {}) } });
      if (data.success === false) throw new ExtraError("extra_error", JSON.stringify(data.errors || data.error || data).slice(0, 300));
      for (const call of data.calls || []) if (await upsertCall(call, "sync")) saved++;
      next = data.metadata?.next_page_token || null;
      pages++;
    } while (next && pages < 20);
    await STATE().updateOne({ _id: STATE_ID }, { $set: { lastSyncAt: startedAt, lastSyncSaved: saved, lastSyncError: null } }, { upsert: true });
    return { saved, pages };
  } catch (err) {
    await STATE().updateOne({ _id: STATE_ID }, { $set: { lastSyncError: err.message, lastSyncErrorAt: new Date() } }, { upsert: true }).catch(() => {});
    console.warn("[extra-calls] sync:", err.message);
    return { error: err.message };
  } finally {
    syncing = false;
  }
}

let timer = null;
function startExtraSync(intervalMs = 15 * 60e3) {
  if (timer) return;
  const run = () => syncRecent().catch(e => console.error("[extra-calls] sync:", e.message));
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(run, 2 * 60e3).unref?.();
  console.log(`[extra-calls] sync every ${Math.round(intervalMs / 60e3)} min${apiKey() ? "" : " (idle — EXTRA_API_KEY not set)"}`);
}

/* ── panel ──────────────────────────────────────────────────────────── */

/* A signed link valid for 10 minutes; reused for 8. */
const urlCache = new Map();
async function recordingUrl(id) {
  const hit = urlCache.get(id);
  if (hit && hit.until > Date.now()) return hit.url;
  const data = await api("post", "/calls/get-recording-urls/", { ids: [String(id)], config: { ttl: 10 } });
  if (data.success === false) throw new ExtraError("extra_error", data.error?.message || "Extra error");
  const item = (data.urls || []).find(u => String(u.id) === String(id));
  if (!item || item.code !== 0 || !item.url) return null;
  urlCache.set(id, { url: item.url, until: Date.now() + 8 * 60e3 });
  if (urlCache.size > 500) urlCache.delete(urlCache.keys().next().value);
  return item.url;
}

/* Names for the other party: lead, client, business. */
async function attachNames(calls) {
  const phones = [...new Set(calls.map(c => c.otherLocal).filter(Boolean))];
  if (phones.length === 0) return calls;
  const db = getDB();
  const [leads, clients, profiles] = await Promise.all([
    db.collection("leads").find({ phone: { $in: phones }, statusHistory: { $exists: true } }, { projection: { phone: 1, name: 1, status: 1 } }).sort({ createdAt: -1 }).toArray(),
    db.collection("cpanel_clients").find({ phone: { $in: phones } }, { projection: { phone: 1, customerName: 1 } }).toArray(),
    db.collection("business_profiles").find({ phone: { $in: phones } }, { projection: { phone: 1, businessName: 1 } }).toArray(),
  ]);
  const lead = new Map(); for (const l of leads) if (!lead.has(l.phone)) lead.set(l.phone, l);
  const client = new Map(clients.map(c => [c.phone, c]));
  const biz = new Map(profiles.map(p => [p.phone, p]));
  return calls.map(c => {
    const l = lead.get(c.otherLocal), cl = client.get(c.otherLocal), b = biz.get(c.otherLocal);
    return {
      ...c,
      lead: l ? { id: String(l._id), name: l.name || null, status: l.status || null } : null,
      client: cl ? { phone: cl.phone, name: b?.businessName || cl.customerName || null } : null,
    };
  });
}

function toView(doc) {
  const { _id, raw, seenVia, ...rest } = doc;
  return { id: _id, ...rest };
}

async function listCalls({ phone = "", before = null, limit = 50 } = {}) {
  const q = {};
  const p = localPhone(phone);
  if (p) q.otherLocal = p.length >= 9 ? p : { $regex: p.replace(/[^\d]/g, "") };
  if (before) q.startedAt = { $lt: new Date(before) };
  const docs = await CALLS().find(q).sort({ startedAt: -1 }).limit(Math.min(200, Math.max(1, Number(limit) || 50))).toArray();
  return attachNames(docs.map(toView));
}

async function status() {
  const state = await STATE().findOne({ _id: STATE_ID });
  const out = {
    apiKey: !!apiKey(),
    webhookSecret: !!webhookSecret(),
    lastWebhookAt: state?.lastWebhookAt || null,
    lastSyncAt: state?.lastSyncAt || null,
    lastSyncError: state?.lastSyncError || null,
  };
  if (!apiKey()) return { ...out, key: "missing" };
  if (keyCache && Date.now() - keyCache.at < 10 * 60e3) return { ...out, ...keyCache.result };
  let result;
  try {
    const data = await api("get", "/auth/key/");
    result = data.success === false ? { key: "rejected" } : { key: "valid", keyExpires: data.times?.expire || null };
  } catch (err) {
    result = { key: err.code === "extra_unauthorized" ? "rejected" : "unreachable", keyError: err.message };
  }
  keyCache = { at: Date.now(), result };
  return { ...out, ...result };
}
let keyCache = null;

async function ensureIndexes() {
  await CALLS().createIndex({ startedAt: -1 });
  await CALLS().createIndex({ otherLocal: 1, startedAt: -1 });
}

module.exports = {
  ExtraError, webhookAuthorized, handleWebhook, syncRecent, startExtraSync,
  recordingUrl, listCalls, status, ensureIndexes,
  _test: { normalize, parseLocal, classify, localPhone, ilLocalString },
};
