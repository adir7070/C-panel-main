/* Charging a signed quote (הצעת מחיר) through Cardcom: the first payment,
   the monthly token charges, and updating a card after a failed charge.

   First payment, made after the client signs:
     • No monthly lines → a ChargeOnly page for the setup total. The client
       can pay by card, Bit, Apple Pay or Google Pay, whichever are switched
       on for the terminal.
     • Monthly lines → a ChargeAndCreateToken page (card only) for the setup
       plus the first month. The saved token becomes a quote_subscriptions
       doc, and the sweep below charges it every month on the same day. It
       keeps charging after the commitment period until an admin stops it.
   Cardcom issues a חשבונית מס קבלה with every charge and emails it to the
   client.

   The page is opened by the client, from the signing page (/sign/<token>),
   or by a manager, through "חייב" in the panel. Both create the page when
   the button is pressed, because a Cardcom page expires 20 minutes after it
   is opened, so a link must never point at a page directly.

   A payment is applied through purchase-sync's lock (package_transactions,
   keyed by LowProfileId), so the webhook, the panel's polling and the
   redirect page can all report the same payment without applying it twice.

   Monthly sweep (hourly):
     • ExternalUniqTranId is written to quote_charges BEFORE Cardcom is
       called, and is sent with ExternalUniqUniqTranIdResponse:true. If we
       crash or time out after Cardcom charged, the retry with the same id
       gets the original answer back and does not charge again.
     • A decline is retried daily, 3 tries in all. From the first failure
       the subscription shows up in the panel's billing alerts, and the
       client's link offers a card update (ChargeAndCreateToken for the
       month that is due). After 3 failures it is "past_due" and stops.
     • GATED: it only charges with QUOTE_MONTHLY_BILLING=on. Otherwise it
       logs what it would charge. */

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const cardcom = require("./cardcom-v11.service");
const purchaseSync = require("./purchase-sync.service");

const QUOTES = () => getDB().collection("personal_packages");
const LEDGER = () => getDB().collection("cpanel_pending_purchases");
const SUBS = () => getDB().collection("quote_subscriptions");
const CHARGES = () => getDB().collection("quote_charges");

const MAX_TRIES = 3;
const RETRY_MS = 24 * 3600e3;
const BILLING_LIVE = () => String(process.env.QUOTE_MONTHLY_BILLING || "").trim().toLowerCase() === "on";

class QuotePayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const oid = id => (id instanceof ObjectId ? id : new ObjectId(String(id)));

function serverBase() {
  const base = (process.env.SERVER_BASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new QuotePayError(500, "server_base_missing", "SERVER_BASE_URL לא מוגדר בשרת");
  return base;
}

/* ── dates: the same day every month, clamped (31 → 30/28) ──────────── */

const ilDay = d => Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", day: "numeric" }).format(d));
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/* billingDay of the month `plus` months after `from`, ~10:00 Israel time. */
function monthlyDate(from, billingDay, plus = 1) {
  const d = new Date(from);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + plus;
  const y = Math.floor(total / 12);
  const m = total % 12;
  return new Date(Date.UTC(y, m, Math.min(billingDay, daysInMonth(y, m)), 7));
}

/* ── what a quote charges ───────────────────────────────────────────── */

function hasMonthly(quote) {
  const m = quote?.totals?.monthly;
  return !!m && m.count > 0 && m.total > 0;
}

/* The first payment: setup, plus the first month when there are monthly
   lines. Amounts are VAT-inclusive (totals.*.total). */
function firstPaymentPlan(quote) {
  const T = quote.totals || {};
  const monthly = hasMonthly(quote);
  const products = [];
  if (T.setup?.total > 0) products.push({ description: `שירותי הקמה — הצעת מחיר ${quote.quoteNo}`, amount: T.setup.total });
  if (monthly) products.push({ description: `שירותים חודשיים, חודש 1 — הצעת מחיר ${quote.quoteNo}`, amount: T.monthly.total });
  const amount = products.reduce((s, p) => s + p.amount, 0);
  const net = (T.setup?.net || 0) + (monthly ? T.monthly.net : 0);
  return {
    amount, net, products, monthly,
    monthlyAmount: monthly ? T.monthly.total : 0,
    operation: monthly ? "ChargeAndCreateToken" : "ChargeOnly",
  };
}

function needsCard(sub) {
  if (!sub) return false;
  return sub.status === "past_due" || sub.status === "needs_card" || (sub.status === "active" && sub.failedAttempts > 0);
}

/* What the client's link should offer: "due" (first payment), "card"
   (update the card + pay the month that is due), "paid", "suspended" (a Bit
   payment Cardcom holds as a suspended deal), or "none". */
async function payState(quote) {
  if (!quote?.signed && !quote?.purchased) return { stage: "none" };
  const plan = firstPaymentPlan(quote);
  if (!quote.purchased) {
    if (quote.payment?.status === "suspended") return { stage: "suspended", ...planView(plan) };
    return plan.amount > 0 ? { stage: "due", ...planView(plan) } : { stage: "none" };
  }
  const sub = await SUBS().findOne({ quoteId: String(quote._id) });
  if (needsCard(sub)) return { stage: "card", amount: sub.amount, month: (sub.chargesDone || 0) + 1, monthlyAmount: sub.amount, monthly: true };
  return { stage: "paid", ...planView(plan), paidAt: quote.payment?.paidAt || quote.purchasedAt || null };
}
const planView = p => ({ amount: p.amount, monthly: p.monthly, monthlyAmount: p.monthlyAmount });

/* ── opening a payment page ─────────────────────────────────────────── */

async function startPayment(quote, { via, agent = null }) {
  if (!quote || quote.kind !== "quote" || quote.active === false) throw new QuotePayError(404, "not_found", "ההצעה לא נמצאה");
  if (!quote.signed) throw new QuotePayError(409, "not_signed", "אפשר לחייב רק אחרי שהלקוח חתם על ההצעה");

  const state = await payState(quote);
  if (state.stage === "suspended") throw new QuotePayError(409, "payment_suspended", "התקבל תשלום בביט שממתין לאישור בקרדקום — בדקו שם לפני חיוב נוסף");
  if (state.stage === "paid" || state.stage === "none") throw new QuotePayError(409, "already_paid", "ההצעה כבר שולמה");

  /* A double click, or a client tapping "pay" again and again. */
  const since = new Date(Date.now() - 10_000);
  if (await LEDGER().countDocuments({ personalPackageId: String(quote._id), kind: "quote", createdAt: { $gte: since } }, { limit: 1 })) {
    throw new QuotePayError(429, "too_fast", "רגע — דף התשלום כבר נפתח. נסו שוב בעוד כמה שניות");
  }

  const base = serverBase();
  const token = await require("./quote-sign.service").ensureSignToken(quote);
  const id = String(quote._id);
  const common = {
    successUrl: `${base}/sign/${token}/paid`,
    failedUrl: `${base}/sign/${token}?payment=failed`,
    webhookUrl: `${base}/api/cpanel/quote-payment-webhook`,
    client: quote.client || {},
  };

  let page, row;
  if (state.stage === "due") {
    const plan = firstPaymentPlan(quote);
    page = await cardcom.createPaymentPage({
      ...common,
      amount: plan.amount,
      operation: plan.operation,
      returnValue: `quote|${id}|first`,
      productName: `הצעת מחיר ${quote.quoteNo} — דשן מדיה טק`,
      products: plan.products,
    });
    row = { purpose: "first", totalAmount: plan.net, amountWithVat: plan.amount, packageName: `הצעת מחיר ${quote.quoteNo}` };
  } else {
    const sub = await SUBS().findOne({ quoteId: id });
    const n = (sub.chargesDone || 0) + 1;
    page = await cardcom.createPaymentPage({
      ...common,
      amount: sub.amount,
      operation: "ChargeAndCreateToken",
      returnValue: `quote|${id}|card|${n}`,
      productName: `עדכון כרטיס ותשלום חודש ${n} — הצעת מחיר ${quote.quoteNo}`,
      products: [{ description: `שירותים חודשיים, חודש ${n} — הצעת מחיר ${quote.quoteNo}`, amount: sub.amount }],
    });
    row = { purpose: "card", n, totalAmount: sub.net, amountWithVat: sub.amount, packageName: `חיוב חודשי ${n} — הצעת מחיר ${quote.quoteNo}` };
    /* hold the sweep's retries while the client is on the card page, so
       the old card and the new one can't both pay the same month */
    await SUBS().updateOne({ _id: sub._id, status: "active" }, { $set: { nextAttemptAt: new Date(Date.now() + 2 * 3600e3) } });
  }

  await LEDGER().insertOne({
    lowProfileId: page.lowProfileId,
    phone: quote.phone,
    personalPackageId: id,
    kind: "quote",
    quoteNo: quote.quoteNo,
    packageKey: `quote_${id}`,
    name: row.packageName,
    description: row.packageName,
    coinsOverride: 0,
    source: via === "client" ? "quote_sign_page" : "cpanel_quote",
    createdBy: agent?._id ? String(agent._id) : null,
    createdAt: new Date(),
    ...row,
  });
  return { url: page.url, lowProfileId: page.lowProfileId, kind: row.purpose, amount: row.amountWithVat };
}

/* ── applying a Cardcom result ──────────────────────────────────────── */

async function finalizeByLowProfileId(lowProfileId, via) {
  const row = await LEDGER().findOne({ lowProfileId: String(lowProfileId), kind: "quote" });
  if (!row) return { status: "unknown" };
  const lp = await cardcom.getPaymentResult(row.lowProfileId);
  return row.purpose === "card" ? finalizeCard(row, lp, via) : finalizeFirst(row, lp, via);
}

/* The panel / redirect page check the quote's recent unfinished pages —
   Cardcom's webhook can't reach a local server, and may lag. */
async function confirmOpenPages(quote, via) {
  const rows = await LEDGER().find({
    personalPackageId: String(quote._id), kind: "quote",
    completedAt: { $exists: false }, createdAt: { $gte: new Date(Date.now() - 48 * 3600e3) },
  }).sort({ createdAt: -1 }).limit(5).toArray();
  let best = { status: "pending" };
  for (const row of rows) {
    let r;
    try {
      const lp = await cardcom.getPaymentResult(row.lowProfileId);
      r = row.purpose === "card" ? await finalizeCard(row, lp, via) : await finalizeFirst(row, lp, via);
    } catch (err) {
      console.warn(`[quote-pay] check ${row.lowProfileId}: ${err.message}`);
      continue;
    }
    if (r.status === "paid") return r;
    if (r.status === "suspended") best = r;
  }
  return best;
}

function lpPayment(lp, row, via, now) {
  return {
    status: "paid",
    paidAt: now,
    lowProfileId: row.lowProfileId,
    transactionId: cardcom.transactionId(lp),
    amount: row.amountWithVat,
    method: cardcom.paymentMethod(lp),
    last4: lp?.TranzactionInfo?.Last4CardDigitsString || null,
    documentNumber: lp?.DocumentInfo?.DocumentNumber || lp?.TranzactionInfo?.DocumentNumber || null,
    /* who opened the page: the client's link, or a manager's "חייב" */
    via: row.source === "quote_sign_page" ? "client" : "manager",
    confirmedVia: via,
  };
}

/* Only one caller (webhook / panel check / redirect page) works on a page
   at a time. A claim left by a crashed attempt goes stale after 2 minutes.
   Returns null when someone else is on it. */
async function claimRow(row) {
  const now = new Date();
  const r = await LEDGER().findOneAndUpdate(
    { lowProfileId: row.lowProfileId, completedAt: { $exists: false }, $or: [{ finalizingAt: { $exists: false } }, { finalizingAt: { $lt: new Date(now.getTime() - 2 * 60e3) } }] },
    { $set: { finalizingAt: now } },
  );
  const doc = r && "ok" in r && "value" in r ? r.value : r;
  if (doc) return { claimedAt: now };
  const cur = await LEDGER().findOne({ lowProfileId: row.lowProfileId }, { projection: { completedAt: 1 } });
  return cur?.completedAt ? { claimedAt: null } : null; // completed but not "done" → resume
}
async function releaseRow(row, claim) {
  if (!claim?.claimedAt) return;
  await LEDGER().updateOne({ lowProfileId: row.lowProfileId, finalizingAt: claim.claimedAt }, { $unset: { finalizingAt: "" } }).catch(() => {});
}

async function finalizeFirst(row, lp, via) {
  const db = getDB();
  const now = new Date();
  const quoteId = row.personalPackageId;
  if (lp?.ReturnValue && lp.ReturnValue !== `quote|${quoteId}|first`) return { status: "mismatch" };

  if (!cardcom.isPaid(lp)) {
    if (cardcom.isSuspended(lp)) {
      await QUOTES().updateOne(
        { _id: oid(quoteId), purchased: { $ne: true } },
        { $set: { payment: { status: "suspended", method: cardcom.paymentMethod(lp), lowProfileId: row.lowProfileId, suspendedDealId: lp.SuspendedInfo.SuspendedDealId, at: now, via } } },
      );
      return { status: "suspended" };
    }
    return { status: "pending", code: lp?.ResponseCode ?? null };
  }

  if (await purchaseSync.paymentState(db, row.lowProfileId) === "done") {
    await purchaseSync.recordRevenue(db, { lowProfileId: row.lowProfileId, phone: row.phone });
    return { status: "paid", already: true };
  }
  const claim = await claimRow(row);
  if (!claim) return { status: "processing" };
  try {
    return await applyFirst(row, lp, via, now);
  } catch (err) {
    await releaseRow(row, claim);
    throw err;
  }
}

async function applyFirst(row, lp, via, now) {
  const db = getDB();
  const quoteId = row.personalPackageId;
  const lock = await purchaseSync.lockPayment(db, row.lowProfileId, {
    phone: row.phone, personalPackageId: quoteId, packageName: row.packageName,
    amount: row.totalAmount, coinsGranted: 0, source: "cpanel_quote", via,
  });
  if (lock === "done") return { status: "paid", already: true };

  const quote = await QUOTES().findOne({ _id: oid(quoteId) });
  if (!quote) throw new Error(`quote ${quoteId} not found`);
  /* a lead that pays becomes a client (owner = the lead's manager) */
  await purchaseSync.ensureUserDoc(db, row.phone);

  const payment = lpPayment(lp, row, via, now);
  const r = await QUOTES().updateOne(
    { _id: quote._id, purchased: { $ne: true } },
    { $set: { purchased: true, purchasedAt: now, payment, status: "paid", updatedAt: now } },
  );
  let primary = r.modifiedCount === 1;
  if (!primary) {
    /* resuming an attempt that already stamped this payment on the quote? */
    const cur = await QUOTES().findOne({ _id: quote._id }, { projection: { payment: 1 } });
    primary = cur?.payment?.lowProfileId === row.lowProfileId;
  }
  if (!primary) {
    /* paid twice — e.g. the client and the manager, in two windows. It's
       real money: count it, and flag it so an admin refunds one. */
    await QUOTES().updateOne({ _id: quote._id, "duplicatePayments.lowProfileId": { $ne: row.lowProfileId } }, { $push: { duplicatePayments: payment } });
    console.error(`[quote-pay] ⚠️ quote ${quote.quoteNo} paid twice (${row.lowProfileId}) — refund one in Cardcom`);
  } else if (hasMonthly(quote)) {
    await createSubscription(quote, lp, now);
  }

  await purchaseSync.recordRevenue(db, { lowProfileId: row.lowProfileId, phone: row.phone });
  await purchaseSync.markLeadsActive(db, row.phone);

  if (await purchaseSync.markPaymentDone(db, row.lowProfileId)) {
    require("./wow-manager-notify.service")
      .notifyManagerOfPurchase({ clientPhone: row.phone, businessName: quote.client?.name || null, packageName: `הצעת מחיר ${quote.quoteNo}`, amount: row.amountWithVat, coinsGranted: 0 })
      .catch(e => console.warn("[quote-pay] notify:", e.message));
    console.log(`[quote-pay] ✅ ${via}: ${row.phone} paid quote ${quote.quoteNo} ₪${row.amountWithVat} (${payment.method})`);
  }
  return { status: "paid" };
}

async function createSubscription(quote, lp, paidAt) {
  const tok = cardcom.tokenOf(lp);
  const billingDay = ilDay(paidAt);
  const next = monthlyDate(paidAt, billingDay, 1);
  const T = quote.totals;
  if (!tok) console.error(`[quote-pay] ⚠️ quote ${quote.quoteNo} has monthly lines but Cardcom returned no token`);
  try {
    await SUBS().updateOne(
      { quoteId: String(quote._id) },
      { $setOnInsert: {
        quoteId: String(quote._id),
        phone: quote.phone,
        quoteNo: quote.quoteNo,
        agentId: quote.agentId || null,
        client: quote.client || {},
        amount: T.monthly.total,
        net: T.monthly.net,
        commitMonths: quote.commitMonths,
        billingDay,
        token: tok?.token || null,
        cardExpiry: tok?.cardExpiry || null,
        last4: tok?.last4 || null,
        status: tok ? "active" : "needs_card",
        chargesDone: 1,
        startedAt: paidAt,
        nextChargeAt: next,
        nextAttemptAt: tok ? next : null,
        failedAttempts: 0,
        createdAt: paidAt,
        updatedAt: paidAt,
      } },
      { upsert: true },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err; // a concurrent finalize created it
  }
}

/* Month n of `sub` was paid. Order: revenue row (idempotent) → the
   subscription moves on (conditional on chargesDone === n-1, so a repeat
   or a second payment of the same month can't advance it twice) → the
   charge is marked paid. A crash before the last step leaves the
   externalId pending, and the re-send gets Cardcom's original answer. */
async function applyMonthlySuccess(sub, n, { ledgerKey, ledgerFields = null, transactionId = null, documentNumber = null, via, reactivate = false }) {
  const now = new Date();
  await purchaseSync.recordRevenue(getDB(), { lowProfileId: ledgerKey, phone: sub.phone, fields: ledgerFields });

  let next = monthlyDate(sub.nextChargeAt || now, sub.billingDay, 1);
  if (next <= now) next = monthlyDate(now, sub.billingDay, 1);
  const filter = { _id: sub._id, chargesDone: n - 1 };
  const set = { chargesDone: n, lastChargedAt: now, lastLedgerKey: ledgerKey, nextChargeAt: next, nextAttemptAt: next, failedAttempts: 0, lastError: null, updatedAt: now };
  if (reactivate) {
    filter.status = { $in: ["active", "past_due", "needs_card"] };
    set.status = "active";
  }
  const r = await SUBS().updateOne(filter, { $set: set });
  if (r.modifiedCount === 0) {
    const cur = await SUBS().findOne({ _id: sub._id }, { projection: { chargesDone: 1, lastLedgerKey: 1, duplicateCharges: 1 } });
    /* the same payment applied again (a resumed attempt) is not a duplicate */
    const same = cur?.lastLedgerKey === ledgerKey || (cur?.duplicateCharges || []).some(d => d.ledgerKey === ledgerKey);
    if ((cur?.chargesDone || 0) >= n && !same) {
      await SUBS().updateOne({ _id: sub._id }, { $push: { duplicateCharges: { n, ledgerKey, at: now } } });
      console.error(`[quote-billing] ⚠️ month ${n} of quote ${sub.quoteNo} was paid twice (${ledgerKey}) — refund one in Cardcom`);
      return;
    }
  }
  await upsertCharge(sub, n, { $set: { status: "paid", paidAt: now, transactionId, documentNumber, via, ledgerKey }, $unset: { pendingExternalId: "" } });
}

async function upsertCharge(sub, n, update) {
  const _id = `${sub._id}:${n}`;
  try {
    await CHARGES().updateOne({ _id }, {
      ...update,
      $setOnInsert: { subscriptionId: String(sub._id), quoteId: sub.quoteId, phone: sub.phone, n, amount: sub.amount, createdAt: new Date() },
    }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    await CHARGES().updateOne({ _id }, update);
  }
}

async function finalizeCard(row, lp, via) {
  const db = getDB();
  const quoteId = row.personalPackageId;
  if (lp?.ReturnValue && lp.ReturnValue !== `quote|${quoteId}|card|${row.n}`) return { status: "mismatch" };
  if (!cardcom.isPaid(lp)) return { status: "pending", code: lp?.ResponseCode ?? null };

  if (await purchaseSync.paymentState(db, row.lowProfileId) === "done") {
    await purchaseSync.recordRevenue(db, { lowProfileId: row.lowProfileId, phone: row.phone });
    return { status: "paid", already: true };
  }
  const claim = await claimRow(row);
  if (!claim) return { status: "processing" };
  try {
    return await applyCard(row, lp, via);
  } catch (err) {
    await releaseRow(row, claim);
    throw err;
  }
}

async function applyCard(row, lp, via) {
  const db = getDB();
  const quoteId = row.personalPackageId;
  const lock = await purchaseSync.lockPayment(db, row.lowProfileId, {
    phone: row.phone, personalPackageId: quoteId, packageName: row.packageName,
    amount: row.totalAmount, coinsGranted: 0, source: "quote_card_update", via,
  });
  if (lock === "done") return { status: "paid", already: true };

  const sub = await SUBS().findOne({ quoteId });
  if (!sub) throw new Error(`no subscription for quote ${quoteId}`);
  const tok = cardcom.tokenOf(lp);
  if (tok) {
    await SUBS().updateOne({ _id: sub._id }, { $set: { token: tok.token, cardExpiry: tok.cardExpiry, last4: tok.last4, cardUpdatedAt: new Date() } });
  }
  await applyMonthlySuccess(sub, row.n, {
    ledgerKey: row.lowProfileId, transactionId: cardcom.transactionId(lp),
    documentNumber: lp?.DocumentInfo?.DocumentNumber || null, via: `card_page:${via}`, reactivate: true,
  });
  if (await purchaseSync.markPaymentDone(db, row.lowProfileId)) {
    console.log(`[quote-pay] ✅ card updated + month ${row.n} paid for quote ${sub.quoteNo} (${row.phone})`);
  }
  return { status: "paid" };
}

/* ── monthly sweep ──────────────────────────────────────────────────── */

/* ≤25 chars, unique per subscription + month + try, and different across
   databases (local vs production), since both may talk to the same
   terminal. */
const externalIdFor = (sub, n, attempt) => `Q${String(sub._id).slice(-10)}M${n}T${attempt}`;

async function chargeOne(sub) {
  const n = (sub.chargesDone || 0) + 1;
  const chargeId = `${sub._id}:${n}`;
  await upsertCharge(sub, n, { $set: { updatedAt: new Date() } });
  const charge = await CHARGES().findOne({ _id: chargeId });

  /* charged, then crashed before the subscription moved on */
  if (charge.status === "paid") {
    await applyMonthlySuccess(sub, n, { ledgerKey: charge.ledgerKey, transactionId: charge.transactionId, documentNumber: charge.documentNumber, via: charge.via || "token" });
    return "paid";
  }
  if (!sub.token) {
    await SUBS().updateOne({ _id: sub._id }, { $set: { status: "needs_card", nextAttemptAt: null, lastError: "אין כרטיס שמור", updatedAt: new Date() } });
    return "needs_card";
  }

  const externalId = charge.pendingExternalId || externalIdFor(sub, n, (charge.attempts?.length || 0) + 1);
  if (!charge.pendingExternalId) await CHARGES().updateOne({ _id: chargeId }, { $set: { pendingExternalId: externalId } });

  let res;
  try {
    res = await cardcom.chargeToken({
      amount: sub.amount, token: sub.token, cardExpiry: sub.cardExpiry, externalId, client: sub.client,
      products: [{ description: `שירותים חודשיים, חודש ${n} — הצעת מחיר ${sub.quoteNo}`, amount: sub.amount }],
    });
  } catch (err) {
    /* outcome unknown — the next try re-sends the same externalId, which
       Cardcom answers with the original result instead of charging again */
    await SUBS().updateOne({ _id: sub._id }, { $set: { nextAttemptAt: new Date(Date.now() + 3600e3), lastError: `תקלת תקשורת עם קרדקום: ${err.message}`, updatedAt: new Date() } });
    console.warn(`[quote-billing] ${sub.quoteNo} month ${n}: no answer from Cardcom (${err.message}) — retry in 1h`);
    return "unknown";
  }

  const attempt = { externalId, at: new Date(), code: res.ResponseCode ?? null, description: res.Description || null, transactionId: res.TranzactionId || null };
  if (res.ResponseCode === 0) {
    await CHARGES().updateOne({ _id: chargeId }, { $push: { attempts: attempt } });
    await applyMonthlySuccess(sub, n, {
      ledgerKey: `token:${externalId}`,
      ledgerFields: {
        personalPackageId: sub.quoteId, kind: "quote", purpose: "monthly", n, quoteNo: sub.quoteNo,
        packageKey: `quote_${sub.quoteId}`, name: `חיוב חודשי ${n} — הצעת מחיר ${sub.quoteNo}`,
        description: `חיוב חודשי ${n} — הצעת מחיר ${sub.quoteNo}`, totalAmount: sub.net, amountWithVat: sub.amount,
        coinsOverride: 0, source: "quote_token",
      },
      transactionId: res.TranzactionId || null, documentNumber: res.DocumentNumber || null, via: "token",
    });
    console.log(`[quote-billing] ✅ ${sub.phone} quote ${sub.quoteNo} month ${n} ₪${sub.amount}`);
    return "paid";
  }

  const fails = (sub.failedAttempts || 0) + 1;
  const giveUp = fails >= MAX_TRIES;
  await CHARGES().updateOne({ _id: chargeId }, { $push: { attempts: attempt }, $set: { status: "declined" }, $unset: { pendingExternalId: "" } });
  await SUBS().updateOne({ _id: sub._id }, { $set: {
    failedAttempts: fails,
    lastError: res.Description || `קוד ${res.ResponseCode}`,
    lastFailedAt: new Date(),
    status: giveUp ? "past_due" : "active",
    nextAttemptAt: giveUp ? null : new Date(Date.now() + RETRY_MS),
    updatedAt: new Date(),
  } });
  console.warn(`[quote-billing] ❌ ${sub.phone} quote ${sub.quoteNo} month ${n} declined (${fails}/${MAX_TRIES}): ${res.Description || res.ResponseCode}`);
  return "declined";
}

let sweeping = false;
async function chargeDue() {
  if (sweeping) return { skipped: true };
  sweeping = true;
  try {
    const live = BILLING_LIVE();
    const now = new Date();
    const due = await SUBS().find({ status: "active", nextAttemptAt: { $lte: now } }).limit(100).toArray();
    const out = { due: due.length, live, results: {} };
    for (const sub of due) {
      if (!live) {
        console.log(`[quote-billing][DRY] would charge ${sub.phone} quote ${sub.quoteNo} month ${(sub.chargesDone || 0) + 1} ₪${sub.amount} (…${sub.last4 || "?"})`);
        continue;
      }
      /* claim it, so a slow Cardcom call can't overlap the next sweep */
      const claimed = await SUBS().findOneAndUpdate(
        { _id: sub._id, status: "active", nextAttemptAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
        { $set: { lockedUntil: new Date(Date.now() + 10 * 60e3) } },
        { returnDocument: "after" },
      );
      const doc = claimed && "value" in claimed && "ok" in claimed ? claimed.value : claimed;
      if (!doc) continue;
      try {
        const r = await chargeOne(doc);
        out.results[r] = (out.results[r] || 0) + 1;
      } catch (err) {
        console.error(`[quote-billing] ${sub.quoteNo}: ${err.message}`);
      } finally {
        await SUBS().updateOne({ _id: sub._id }, { $unset: { lockedUntil: "" } });
      }
    }
    return out;
  } finally {
    sweeping = false;
  }
}

let timer = null;
function startQuoteBilling(intervalMs = 3600e3) {
  if (timer) return;
  const run = () => chargeDue().catch(e => console.error("[quote-billing] sweep:", e.message));
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(run, 60e3).unref?.();
  console.log(`[quote-billing] monthly sweep started (every ${Math.round(intervalMs / 60e3)} min · ${BILLING_LIVE() ? "LIVE" : "DRY-RUN — set QUOTE_MONTHLY_BILLING=on to charge"})`);
}

/* ── panel: summaries, alerts, stop / resume ───────────────────────── */

function billingSummary(sub) {
  if (!sub) return null;
  return {
    status: sub.status,
    amount: sub.amount,
    chargesDone: sub.chargesDone || 0,
    commitMonths: sub.commitMonths || null,
    nextChargeAt: sub.status === "stopped" ? null : sub.nextChargeAt || null,
    nextAttemptAt: sub.nextAttemptAt || null,
    failedAttempts: sub.failedAttempts || 0,
    maxTries: MAX_TRIES,
    lastError: sub.lastError || null,
    lastFailedAt: sub.lastFailedAt || null,
    last4: sub.last4 || null,
    cardExpiry: sub.cardExpiry || null,
    startedAt: sub.startedAt || null,
    stoppedAt: sub.stoppedAt || null,
    stoppedByName: sub.stoppedBy?.name || null,
    duplicateCharges: (sub.duplicateCharges || []).length,
    live: BILLING_LIVE(),
  };
}

async function attachBilling(packages) {
  const ids = packages.filter(p => p.kind === "quote" && p.purchased).map(p => String(p._id));
  if (ids.length === 0) return packages;
  const subs = await SUBS().find({ quoteId: { $in: ids } }).toArray();
  const byQuote = new Map(subs.map(s => [s.quoteId, s]));
  return packages.map(p => (byQuote.has(String(p._id)) ? { ...p, billing: billingSummary(byQuote.get(String(p._id))) } : p));
}

/* Subscriptions that need a person: a failed charge, past due, no card. */
async function alertsFor(agent) {
  const q = { $or: [{ status: { $in: ["past_due", "needs_card"] } }, { status: "active", failedAttempts: { $gt: 0 } }] };
  if (agent?.role !== "admin") {
    const mine = await getDB().collection("cpanel_clients").find({ agentId: String(agent?._id) }, { projection: { phone: 1 } }).toArray();
    q.phone = { $in: mine.map(c => c.phone) };
  }
  const subs = await SUBS().find(q).sort({ lastFailedAt: -1 }).limit(50).toArray();
  return subs.map(s => ({
    quoteId: s.quoteId, phone: s.phone, quoteNo: s.quoteNo,
    clientName: s.client?.name || s.client?.contact || s.phone,
    ...billingSummary(s),
  }));
}

async function setBilling(quote, action, agent) {
  const sub = await SUBS().findOne({ quoteId: String(quote._id) });
  if (!sub) throw new QuotePayError(404, "no_billing", "אין חיוב חודשי להצעה הזאת");
  const now = new Date();
  if (action === "stop") {
    if (sub.status === "stopped") return billingSummary(sub);
    await SUBS().updateOne({ _id: sub._id }, { $set: {
      status: "stopped", stoppedAt: now, nextAttemptAt: null, updatedAt: now,
      stoppedBy: { id: agent?._id ? String(agent._id) : null, name: agent?.nickname || agent?.name || null },
    } });
  } else if (action === "resume") {
    if (sub.status === "active" && !sub.failedAttempts) return billingSummary(sub);
    if (!sub.token) {
      await SUBS().updateOne({ _id: sub._id }, { $set: { status: "needs_card", failedAttempts: 0, nextAttemptAt: null, updatedAt: now } });
    } else {
      /* an overdue month is charged on the next sweep */
      const at = sub.nextChargeAt && sub.nextChargeAt > now ? sub.nextChargeAt : now;
      await SUBS().updateOne({ _id: sub._id }, { $set: { status: "active", failedAttempts: 0, lastError: null, nextAttemptAt: at, updatedAt: now }, $unset: { stoppedAt: "", stoppedBy: "" } });
    }
  } else {
    throw new QuotePayError(400, "bad_action", "פעולה לא מוכרת");
  }
  return billingSummary(await SUBS().findOne({ _id: sub._id }));
}

async function ensureIndexes() {
  await SUBS().createIndex({ quoteId: 1 }, { unique: true });
  await SUBS().createIndex({ status: 1, nextAttemptAt: 1 });
  await SUBS().createIndex({ phone: 1 });
  await CHARGES().createIndex({ subscriptionId: 1, n: 1 });
  await LEDGER().createIndex({ personalPackageId: 1, kind: 1, createdAt: -1 });
}

module.exports = {
  QuotePayError, MAX_TRIES,
  firstPaymentPlan, payState, needsCard,
  startPayment, finalizeByLowProfileId, confirmOpenPages,
  chargeDue, startQuoteBilling,
  billingSummary, attachBilling, alertsFor, setBilling,
  ensureIndexes,
  _test: { monthlyDate, ilDay, externalIdFor },
};
