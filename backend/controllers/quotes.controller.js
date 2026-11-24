/* Quotes (הצעות מחיר) — personal_packages documents with kind "quote".
   Mounted under /api/cpanel/clients/:phone/quotes, behind the panel login
   and the per-client access gate (cpanel.routes.js). Listing and deleting go
   through the personal-catalog endpoints like every other package.

   Signing and charging a quote are the next stage: until then a quote is
   built, saved and displayed (GET …/document) only. */

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const quotes = require("../services/quote.service");
const { renderQuoteHtml } = require("../services/quote-document.service");
const signing = require("../services/quote-sign.service");

const COL = () => getDB().collection("personal_packages");

function fail(res, err, ctx) {
  if (err instanceof quotes.QuoteError) {
    return res.status(400).json({ error: err.code, message: err.message });
  }
  console.error(`[Quotes] ${ctx}:`, err.message);
  return res.status(500).json({ error: "server_error", message: "שגיאת שרת — נסה שוב" });
}

async function loadQuote(req, res) {
  const { phone, id } = req.params;
  if (!ObjectId.isValid(id)) { res.status(400).json({ error: "bad_id", message: "מזהה לא תקין" }); return null; }
  const q = await COL().findOne({ _id: new ObjectId(id), phone, kind: "quote", active: { $ne: false } });
  if (!q) { res.status(404).json({ error: "not_found", message: "ההצעה לא נמצאה" }); return null; }
  return q;
}

/* GET /api/cpanel/clients/:phone/quotes/defaults — what a new quote starts
   with: "הוכן עבור" from the business profile / lead, today's date, the
   default terms and the rules (max discount, VAT). */
exports.defaults = async (req, res) => {
  try {
    res.json({
      client: { id: "", role: "", ...(await quotes.clientDefaults(req.params.phone)) },
      quoteDate: quotes.todayIL(),
      ...quotes.DEFAULTS,
      maxDiscountPct: quotes.maxDiscountFor(req.agent),
      vatPct: quotes.VAT_PCT,
    });
  } catch (err) {
    fail(res, err, "defaults");
  }
};

/* POST /api/cpanel/clients/:phone/quotes */
exports.create = async (req, res) => {
  try {
    const { phone } = req.params;
    const fields = await quotes.buildQuoteFields(req.body, { phone, maxDiscountPct: quotes.maxDiscountFor(req.agent) });
    const quoteNo = await quotes.nextQuoteNo(fields.quoteDate);
    const now = new Date();
    const doc = {
      phone,
      kind: "quote",
      quoteNo,
      name: `הצעת מחיר ${quoteNo}`,
      agentId: req.agent?._id ? String(req.agent._id) : null,
      agentName: req.agent?.nickname || req.agent?.name || "",
      ...fields,
      active: true,
      purchased: false,
      purchasedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const r = await COL().insertOne(doc);
    res.status(201).json({ ...doc, _id: r.insertedId });
  } catch (err) {
    fail(res, err, "create");
  }
};

/* PATCH /api/cpanel/clients/:phone/quotes/:id */
exports.update = async (req, res) => {
  try {
    const existing = await loadQuote(req, res);
    if (!existing) return;
    if (existing.purchased) return res.status(409).json({ error: "quote_paid", message: "הצעה ששולמה אינה ניתנת לעריכה" });
    if (existing.signed) return res.status(409).json({ error: "quote_signed", message: "הצעה חתומה אינה ניתנת לעריכה — צרו הצעה חדשה" });
    const fields = await quotes.buildQuoteFields(req.body, { existing, phone: existing.phone, maxDiscountPct: quotes.maxDiscountFor(req.agent) });
    const r = await COL().findOneAndUpdate(
      { _id: existing._id },
      { $set: { ...fields, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    const doc = r && "value" in r && "ok" in r ? r.value : r;
    res.json(doc);
  } catch (err) {
    fail(res, err, "update");
  }
};

/* GET /api/cpanel/clients/:phone/quotes/:id/document — the quote as the
   printable Dashen document (text/html). */
exports.document = async (req, res) => {
  try {
    const q = await loadQuote(req, res);
    if (!q) return;
    res.set("Content-Type", "text/html; charset=utf-8").send(renderQuoteHtml(q));
  } catch (err) {
    fail(res, err, "document");
  }
};

/* POST /api/cpanel/clients/:phone/quotes/:id/sign-link — the client's
   signing link (/sign/<token>), created on first use. */
exports.signLink = async (req, res) => {
  try {
    const q = await loadQuote(req, res);
    if (!q) return;
    const token = await signing.ensureSignToken(q);
    res.json({ token, path: `/sign/${token}`, signed: !!q.signed, expired: signing.isExpired(q), validUntil: signing.validUntil(q) });
  } catch (err) {
    fail(res, err, "signLink");
  }
};

/* GET /api/cpanel/clients/:phone/quotes/:id/signed-document — the frozen
   copy saved when the client signed (text/html). */
exports.signedDocument = async (req, res) => {
  try {
    const q = await loadQuote(req, res);
    if (!q) return;
    const doc = await signing.signedHtml(q);
    if (!doc) return res.status(404).json({ error: "not_signed", message: "ההצעה עוד לא נחתמה" });
    res.set("Content-Type", "text/html; charset=utf-8").send(doc);
  } catch (err) {
    fail(res, err, "signedDocument");
  }
};
