/* Public quote-signing routes — no panel login; the secret token in the
   link is the only key (services/quote-sign.service.js). Mounted at the app
   root in server.js, before the SPA fallback. In dev, Vite proxies /sign.

     GET  /sign/:token           the mobile signing page
     GET  /sign/:token/document  the full agreement (live render, unsigned)
     GET  /sign/:token/signed    the frozen signed copy
     POST /sign/:token           sign   { version, client, signature, agreeTerms, agreePayment }
     POST /sign/:token/pay       a fresh Cardcom page for what is due → { url }
     GET  /sign/:token/paid      where Cardcom returns after paying (checks the payment) */

const express = require("express");
const signing = require("../services/quote-sign.service");
const { renderSignPage, renderMessagePage, renderPaidPage } = require("../services/quote-sign-page.service");
const payments = require("../services/quote-payment.service");
const { renderQuoteHtml } = require("../services/quote-document.service");

const router = express.Router();

/* The token is in the URL: never let it leak through Referer, caches or
   search engines. */
router.use("/sign", (_req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
  });
  next();
});

const html = (res, body, status = 200) => res.status(status).type("html").send(body);
const notFound = res => html(res, renderMessagePage("הקישור לא תקין", "ייתכן שההצעה בוטלה או שהקישור הועתק חלקית. בקשו מהנציג קישור חדש."), 404);

router.get("/sign/:token", async (req, res) => {
  try {
    const quote = await signing.findByToken(req.params.token);
    if (!quote) return notFound(res);
    const view = quote.signed ? "signed" : signing.isExpired(quote) ? "expired" : "sign";
    if (view === "sign") signing.recordView(quote);
    /* before signing: what will be due right after it */
    let pay = { stage: "none" };
    if (view === "signed") {
      pay = await payments.payState(quote);
    } else if (view === "sign") {
      const plan = payments.firstPaymentPlan(quote);
      if (plan.amount > 0) pay = { stage: "due", amount: plan.amount, monthly: plan.monthly, monthlyAmount: plan.monthlyAmount };
    }
    html(res, renderSignPage(quote, { view, validUntil: signing.validUntil(quote), token: req.params.token, pay, paymentFailed: req.query.payment === "failed" }));
  } catch (err) {
    console.error("[quote-sign] page:", err.message);
    html(res, renderMessagePage("שגיאה", "משהו השתבש בטעינת ההצעה. נסו שוב בעוד רגע."), 500);
  }
});

router.get("/sign/:token/document", async (req, res) => {
  try {
    const quote = await signing.findByToken(req.params.token);
    if (!quote) return notFound(res);
    if (quote.signed) {
      const signedDoc = await signing.signedHtml(quote);
      if (signedDoc) return html(res, signedDoc);
    }
    html(res, renderQuoteHtml(quote));
  } catch (err) {
    console.error("[quote-sign] document:", err.message);
    html(res, renderMessagePage("שגיאה", "לא ניתן להציג את ההסכם כרגע."), 500);
  }
});

router.get("/sign/:token/signed", async (req, res) => {
  try {
    const quote = await signing.findByToken(req.params.token);
    if (!quote) return notFound(res);
    const signedDoc = await signing.signedHtml(quote);
    if (!signedDoc) return html(res, renderMessagePage("ההסכם עוד לא נחתם", "אחרי החתימה יופיע כאן העותק החתום."), 404);
    html(res, signedDoc);
  } catch (err) {
    console.error("[quote-sign] signed:", err.message);
    html(res, renderMessagePage("שגיאה", "לא ניתן להציג את ההסכם כרגע."), 500);
  }
});

router.post("/sign/:token", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const { signed } = await signing.sign(req.params.token, req.body, req);
    res.json({ ok: true, signedAt: signed.at });
  } catch (err) {
    if (err instanceof signing.SignError) {
      return res.status(err.status).json({ error: err.code, message: err.message, fields: err.fields });
    }
    console.error("[quote-sign] sign:", err.message);
    res.status(500).json({ error: "server_error", message: "החתימה לא נשמרה — נסו שוב בעוד רגע" });
  }
});

router.post("/sign/:token/pay", async (req, res) => {
  try {
    const quote = await signing.findByToken(req.params.token);
    if (!quote) return res.status(404).json({ error: "not_found", message: "הקישור לא תקין" });
    const r = await payments.startPayment(quote, { via: "client" });
    res.json({ url: r.url });
  } catch (err) {
    if (err instanceof payments.QuotePayError) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error("[quote-sign] pay:", err.code || "", err.message);
    res.status(502).json({ error: "payment_unavailable", message: "לא ניתן לפתוח את דף התשלום כרגע — נסו שוב בעוד כמה דקות או פנו אלינו" });
  }
});

router.get("/sign/:token/paid", async (req, res) => {
  try {
    const quote = await signing.findByToken(req.params.token);
    if (!quote) return notFound(res);
    let result = { status: "pending" };
    try {
      result = await payments.confirmOpenPages(quote, "redirect");
    } catch (err) {
      console.warn("[quote-sign] paid check:", err.message);
    }
    if (result.status === "pending" && quote.purchased) result = { status: "paid" };
    const tries = Math.min(20, Math.max(0, parseInt(req.query.t, 10) || 0));
    html(res, renderPaidPage(quote, result, { token: req.params.token, tries }));
  } catch (err) {
    console.error("[quote-sign] paid:", err.message);
    html(res, renderMessagePage("שגיאה", "לא ניתן לאמת את התשלום כרגע. אם חויבתם, אין צורך לשלם שוב."), 500);
  }
});

module.exports = router;
