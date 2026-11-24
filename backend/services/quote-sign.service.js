/* Signing a quote online.

   The panel creates one secret link per quote (`signToken`, 32 random
   bytes). The client opens /sign/<token>, completes any missing details,
   signs on screen, and the signed agreement is frozen at that moment:

     signed_documents  { quoteId, phone, quoteNo, signingId, html, sha256,
                         signature, client, totals, signedAt, ip, userAgent }
     personal_packages.signed = { at, name, role, ip, userAgent, docId,
                                  sha256, signingId }

   The frozen HTML is what the panel and the client see afterwards; later
   edits to the price list or the quote never touch it. A signed quote can
   no longer be edited or deleted (quotes.controller / personal-packages). */

const crypto = require("crypto");
const { getDB } = require("../config/db");
const quotes = require("./quote.service");
const { renderQuoteHtml } = require("./quote-document.service");

const COL = () => getDB().collection("personal_packages");
const DOCS = () => getDB().collection("signed_documents");
const TOKEN_RX = /^[A-Za-z0-9_-]{32,64}$/;
const MAX_SIGNATURE_BYTES = 400 * 1024;

class SignError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

let indexes = null;
function ensureIndexes() {
  indexes ??= Promise.all([
    COL().createIndex({ signToken: 1 }, { unique: true, partialFilterExpression: { signToken: { $type: "string" } } }),
    DOCS().createIndex({ quoteId: 1 }),
  ]).catch(err => { indexes = null; console.warn("[quote-sign] index:", err.message); });
  return indexes;
}

/* The link token of a quote, created on first use. */
async function ensureSignToken(quote) {
  if (quote.signToken) return quote.signToken;
  await ensureIndexes();
  const token = crypto.randomBytes(32).toString("base64url");
  const r = await COL().findOneAndUpdate(
    { _id: quote._id, signToken: { $exists: false } },
    { $set: { signToken: token, signLinkAt: new Date() } },
    { returnDocument: "after" },
  );
  const doc = r && "value" in r && "ok" in r ? r.value : r;
  if (doc?.signToken) return doc.signToken;
  // created concurrently by another click
  const fresh = await COL().findOne({ _id: quote._id }, { projection: { signToken: 1 } });
  return fresh.signToken;
}

async function findByToken(token) {
  if (!TOKEN_RX.test(String(token || ""))) return null;
  return COL().findOne({ signToken: String(token), kind: "quote", active: { $ne: false } });
}

/* Last day the offer is valid, as YYYY-MM-DD (quoteDate + validDays). */
function validUntil(quote) {
  const d = new Date(`${quote.quoteDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(quote.validDays || 0));
  return d.toISOString().slice(0, 10);
}

function isExpired(quote) {
  return quotes.todayIL() > validUntil(quote);
}

async function recordView(quote) {
  const now = new Date();
  await COL().updateOne({ _id: quote._id }, { $set: { lastViewedAt: now }, $inc: { viewCount: 1 } }).catch(() => {});
}

/* The client details the agreement needs. Returns { client, errors }. */
function validateClient(input, existing) {
  const client = quotes.cleanClient(input || {}, existing || {});
  const errors = {};
  /* ח.פ. / ע.מ. is optional — checked only when the client fills it in. */
  const need = { name: "שם העסק / הלקוח", address: "כתובת", phone: "טלפון", email: 'דוא"ל', contact: "שם החותם" };
  for (const [k, label] of Object.entries(need)) if (!client[k]) errors[k] = `חסר ${label}`;
  const idDigits = client.id.replace(/\D/g, "");
  if (client.id && (idDigits.length < 5 || idDigits.length > 9)) errors.id = "מספר ח.פ. / ע.מ. צריך להכיל 5–9 ספרות";
  const phoneDigits = client.phone.replace(/\D/g, "");
  if (client.phone && (phoneDigits.length < 9 || phoneDigits.length > 13)) errors.phone = "מספר טלפון לא תקין";
  if (client.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(client.email)) errors.email = 'כתובת דוא"ל לא תקינה';
  return { client, errors };
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (fwd || req.socket?.remoteAddress || "").replace(/^::ffff:/, "").slice(0, 64);
}

/* POST /sign/:token — body { version, client, signature, agreeTerms, agreePayment }. */
async function sign(token, body, req) {
  const quote = await findByToken(token);
  if (!quote) throw new SignError(404, "not_found", "הקישור לא תקין או שההצעה בוטלה");
  if (quote.signed) throw new SignError(409, "already_signed", "ההצעה כבר נחתמה");
  if (isExpired(quote)) throw new SignError(410, "expired", "תוקף ההצעה פג");
  const b = body || {};
  /* The client must sign what they saw: if the manager changed the quote
     since the page loaded, ask for a reload. */
  if (b.version && String(b.version) !== new Date(quote.updatedAt).toISOString()) {
    throw new SignError(409, "quote_changed", "ההצעה עודכנה בזמן שהדף היה פתוח — רעננו את הדף ועברו עליה שוב");
  }
  if (b.agreeTerms !== true || b.agreePayment !== true) {
    throw new SignError(400, "consent_required", "יש לאשר את שני הסעיפים לפני החתימה");
  }
  const sig = String(b.signature || "");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig)) throw new SignError(400, "bad_signature", "החתימה חסרה");
  const bytes = Math.floor((sig.length - "data:image/png;base64,".length) * 3 / 4);
  if (bytes < 300) throw new SignError(400, "bad_signature", "החתימה חסרה");
  if (bytes > MAX_SIGNATURE_BYTES) throw new SignError(400, "bad_signature", "קובץ החתימה גדול מדי");
  const { client, errors } = validateClient(b.client, quote.client);
  if (Object.keys(errors).length) {
    const e = new SignError(400, "missing_details", Object.values(errors)[0]);
    e.fields = errors;
    throw e;
  }

  const now = new Date();
  const ip = clientIp(req);
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 300);
  const signingId = crypto.randomUUID();
  const signedQuote = { ...quote, client };
  const html = renderQuoteHtml(signedQuote, {
    signed: { at: now, name: client.contact, role: client.role, signature: sig, ip, id: signingId },
  });
  const sha256 = crypto.createHash("sha256").update(html).digest("hex");
  await ensureIndexes();
  const doc = await DOCS().insertOne({
    kind: "quote", quoteId: quote._id, phone: quote.phone, quoteNo: quote.quoteNo, signingId,
    html, sha256, signature: sig, client, totals: quote.totals, lines: quote.lines,
    signedAt: now, ip, userAgent, createdAt: now,
  });
  const signed = { at: now, name: client.contact, role: client.role, ip, userAgent, docId: doc.insertedId, sha256, signingId };
  const r = await COL().findOneAndUpdate(
    { _id: quote._id, signed: { $exists: false }, active: { $ne: false } },
    { $set: { client, signed, status: "signed", updatedAt: now } },
    { returnDocument: "after" },
  );
  const updated = r && "value" in r && "ok" in r ? r.value : r;
  if (!updated) {
    // signed a moment ago from another tab/device — keep that one
    await DOCS().deleteOne({ _id: doc.insertedId }).catch(() => {});
    throw new SignError(409, "already_signed", "ההצעה כבר נחתמה");
  }
  return { quote: updated, signed };
}

async function signedHtml(quote) {
  if (!quote?.signed?.docId) return null;
  const doc = await DOCS().findOne({ _id: quote.signed.docId }, { projection: { html: 1 } });
  return doc?.html || null;
}

module.exports = {
  SignError, ensureSignToken, findByToken, validUntil, isExpired, recordView, validateClient, sign, signedHtml,
};
