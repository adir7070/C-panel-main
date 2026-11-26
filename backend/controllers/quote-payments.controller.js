/* Charging signed quotes (services/quote-payment.service.js).

   Public, called by Cardcom or a setup check:
     POST /api/cpanel/quote-payment-webhook   Cardcom's WebHookUrl. Its
          body is not trusted: the LowProfileId is re-read with GetLpResult.
     GET  /api/cpanel/cardcom-status           which CARDCOM_* vars are set
          and whether Cardcom accepts them. Booleans only, never values.
   Panel (login + requireClientAccess):
     POST /api/cpanel/clients/:phone/quotes/:id/pay              → { url }
     POST /api/cpanel/clients/:phone/quotes/:id/confirm-payment  → { status }
     POST /api/cpanel/clients/:phone/quotes/:id/billing          { action: stop|resume }, admins only
     GET  /api/cpanel/billing/alerts                             failed monthly charges */

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const payments = require("../services/quote-payment.service");
const cardcom = require("../services/cardcom-v11.service");

function fail(res, err, ctx) {
  if (err instanceof payments.QuotePayError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err instanceof cardcom.CardcomError) {
    console.error(`[quote-pay] ${ctx}: ${err.code} ${err.message}`);
    const status = err.code === "cardcom_not_configured" ? 503 : 502;
    return res.status(status).json({ error: err.code, message: err.code === "cardcom_not_configured" ? err.message : `קרדקום: ${err.message}` });
  }
  console.error(`[quote-pay] ${ctx}:`, err.message);
  return res.status(500).json({ error: "server_error", message: "שגיאת שרת — נסה שוב" });
}

async function loadQuote(req, res) {
  const { phone, id } = req.params;
  if (!ObjectId.isValid(id)) { res.status(400).json({ error: "bad_id", message: "מזהה לא תקין" }); return null; }
  const q = await getDB().collection("personal_packages").findOne({ _id: new ObjectId(id), phone, kind: "quote", active: { $ne: false } });
  if (!q) { res.status(404).json({ error: "not_found", message: "ההצעה לא נמצאה" }); return null; }
  return q;
}

/* Answer 200 only after the payment is applied: a 5xx makes Cardcom retry
   (7 times, over ~1.5 days). */
exports.webhook = async (req, res) => {
  const b = req.body || {};
  const lowProfileId = b.LowProfileId || b.lowProfileId || req.query.LowProfileId || req.query.lowprofileid;
  if (!lowProfileId) return res.json({ ok: true, ignored: true });
  try {
    const r = await payments.finalizeByLowProfileId(String(lowProfileId), "webhook");
    res.json({ ok: true, status: r.status });
  } catch (err) {
    console.error("[quote-pay] webhook:", err.message);
    res.status(500).json({ ok: false });
  }
};

exports.cardcomStatus = async (_req, res) => {
  try {
    const s = await cardcom.credentialsStatus();
    res.set("Cache-Control", "no-store").json({
      ...s,
      serverBaseUrl: !!process.env.SERVER_BASE_URL,
      monthlyBilling: String(process.env.QUOTE_MONTHLY_BILLING || "").trim().toLowerCase() === "on" ? "on" : "dry-run",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.pay = async (req, res) => {
  try {
    const q = await loadQuote(req, res);
    if (!q) return;
    res.json(await payments.startPayment(q, { via: "manager", agent: req.agent }));
  } catch (err) {
    fail(res, err, "pay");
  }
};

exports.confirmPayment = async (req, res) => {
  try {
    const q = await loadQuote(req, res);
    if (!q) return;
    res.json(await payments.confirmOpenPages(q, "panel"));
  } catch (err) {
    fail(res, err, "confirm");
  }
};

exports.billing = async (req, res) => {
  try {
    if (req.agent?.role !== "admin") return res.status(403).json({ error: "admins_only", message: "רק מנהל מערכת יכול לעצור או לחדש חיוב חודשי" });
    const q = await loadQuote(req, res);
    if (!q) return;
    res.json(await payments.setBilling(q, String(req.body?.action || ""), req.agent));
  } catch (err) {
    fail(res, err, "billing");
  }
};

exports.alerts = async (req, res) => {
  try {
    res.json(await payments.alertsFor(req.agent));
  } catch (err) {
    fail(res, err, "alerts");
  }
};
