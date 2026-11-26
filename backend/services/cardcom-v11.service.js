/* Cardcom REST API v11: the field names as Cardcom's own swagger
   (secure.cardcom.solutions/swagger/v11/swagger.json) and knowledge base
   (kb.cardcom.solutions) define them. Used by the quote payment flow.

   The older cardcom.service.js predates this. It sends fields v11 does not
   define (IsBit, IsApplePay, IsCreateToken, CreateInvoice, a numeric
   Operation), and it is kept only for the legacy app flows.

   Facts this module relies on:
   - LowProfile/Create needs `FailedRedirectUrl` + `WebHookUrl`. `Operation`
     is a string: "ChargeOnly" | "ChargeAndCreateToken" | …
   - Bit / Apple Pay / Google Pay are switched on per terminal in the
     dashboard, not per request. They only appear on ChargeOnly pages; a
     ChargeAndCreateToken page is card-only.
   - The webhook is unauthenticated. The truth is GetLpResult.
   - A token charge (Transactions/Transaction) is idempotent with
     ExternalUniqTranId (≤25 chars) + ExternalUniqUniqTranIdResponse:true:
     a repeat returns the original result instead of charging again.
   - ApiPassword is only needed for refunds and cancelling documents, so
     nothing here sends it. */

const axios = require("axios");

const BASE = "https://secure.cardcom.solutions/api/v11";
const ILS = 1;

function config() {
  const terminal = Number(process.env.CARDCOM_TERMINAL_NUMBER) || null;
  return {
    terminal,
    /* Cardcom may require token charges on a separate "no CVV" terminal. */
    tokenTerminal: Number(process.env.CARDCOM_TOKEN_TERMINAL_NUMBER) || terminal,
    apiName: (process.env.CARDCOM_API_NAME || "").trim(),
    apiPassword: (process.env.CARDCOM_API_PASSWORD || "").trim(),
  };
}

class CardcomError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function requireConfig() {
  const c = config();
  if (!c.terminal || !c.apiName) {
    throw new CardcomError("cardcom_not_configured", "הסליקה עוד לא הוגדרה בשרת (CARDCOM_TERMINAL_NUMBER / CARDCOM_API_NAME)");
  }
  return c;
}

/* Cardcom answers declines inside HTTP 200, and request errors with
   400/401 + { ResponseCode, Description }. Both come back as data. */
async function post(path, body, timeout = 20000) {
  const r = await axios.post(`${BASE}${path}`, body, { timeout, validateStatus: () => true });
  if (r.status >= 500) throw new CardcomError("cardcom_http_" + r.status, `Cardcom HTTP ${r.status}`);
  return r.data || {};
}

const money = n => Math.round(Number(n) * 100) / 100;
const digits = s => String(s || "").replace(/\D/g, "");

/* חשבונית מס קבלה for the client. The product lines must add up to the
   charged amount, so every UnitCost here is VAT-inclusive. */
function buildDocument(client = {}, products = []) {
  const doc = {
    DocumentTypeToCreate: "TaxInvoiceAndReceipt",
    Name: String(client.name || client.contact || "לקוח").slice(0, 50),
    Language: "he",
    Products: products.map(p => ({ Description: String(p.description).slice(0, 250), Quantity: 1, UnitCost: money(p.amount) })),
  };
  const taxId = digits(client.id);
  if (taxId) doc.TaxId = taxId;
  if (client.email) { doc.Email = client.email; doc.IsSendByEmail = true; }
  if (client.address) doc.AddressLine1 = String(client.address).slice(0, 100);
  if (client.phone) doc.Mobile = digits(client.phone);
  return doc;
}

/* Creates a hosted payment page. Returns { lowProfileId, url }. */
async function createPaymentPage({ amount, operation = "ChargeOnly", returnValue, productName, successUrl, failedUrl, webhookUrl, client = {}, products = [] }) {
  const c = requireConfig();
  const body = {
    TerminalNumber: c.terminal,
    ApiName: c.apiName,
    Operation: operation,
    ReturnValue: String(returnValue).slice(0, 250),
    Amount: money(amount),
    ISOCoinId: ILS,
    Language: "he",
    ProductName: String(productName || "").slice(0, 250),
    SuccessRedirectUrl: successUrl,
    FailedRedirectUrl: failedUrl,
    WebHookUrl: webhookUrl,
    UIDefinition: {
      CardOwnerNameValue: String(client.contact || client.name || "").slice(0, 50),
      CardOwnerPhoneValue: digits(client.phone),
      CardOwnerEmailValue: client.email || "",
    },
    Document: buildDocument(client, products),
  };
  const data = await post("/LowProfile/Create", body);
  if (data.ResponseCode !== 0 || !data.Url) {
    throw new CardcomError("cardcom_create_failed", data.Description || "קרדקום לא יצרה דף תשלום", { code: data.ResponseCode });
  }
  return { lowProfileId: data.LowProfileId, url: data.Url };
}

async function getPaymentResult(lowProfileId) {
  const c = requireConfig();
  return post("/LowProfile/GetLpResult", { TerminalNumber: c.terminal, ApiName: c.apiName, LowProfileId: lowProfileId }, 15000);
}

function transactionId(lp) {
  return Number(lp?.TranzactionId || lp?.TranzactionInfo?.TranzactionId || 0);
}

/* Paid = approved AND a real transaction id. A page the client is still
   typing into does not have one. */
function isPaid(lp) {
  return !!lp && lp.ResponseCode === 0 && transactionId(lp) > 0;
}

/* Bit through Cardcom runs as a suspended deal (no immediate charge). */
function isSuspended(lp) {
  return !!lp && lp.ResponseCode === 0 && !transactionId(lp) && !!lp.SuspendedInfo?.SuspendedDealId;
}

const METHODS = { 104: "bit", 11: "applepay", 15: "googlepay" };
function paymentMethod(lp) {
  return METHODS[Number(lp?.ExternalPaymentVector)] || "card";
}

/* { token, cardExpiry "MMYY", last4 } from a ChargeAndCreateToken result. */
function tokenOf(lp) {
  const t = lp?.TokenInfo;
  if (!t?.Token) return null;
  const month = String(t.CardMonth || "").padStart(2, "0");
  const year = String(t.CardYear || "").slice(-2);
  return {
    token: t.Token,
    cardExpiry: month + year,
    last4: lp?.TranzactionInfo?.Last4CardDigitsString || String(lp?.TranzactionInfo?.Last4CardDigits || ""),
  };
}

/* Charges a saved token. Returns Cardcom's TransactionInfo: ResponseCode 0
   = charged, anything else = declined. A network error throws; repeating
   the call with the same externalId is safe. */
async function chargeToken({ amount, token, cardExpiry, externalId, client = {}, products = [] }) {
  const c = requireConfig();
  if (!externalId || externalId.length > 25) throw new CardcomError("bad_external_id", "ExternalUniqTranId must be 1–25 chars");
  return post("/Transactions/Transaction", {
    TerminalNumber: c.tokenTerminal,
    ApiName: c.apiName,
    Amount: money(amount),
    Token: token,
    CardExpirationMMYY: cardExpiry,
    ExternalUniqTranId: externalId,
    ExternalUniqUniqTranIdResponse: true,
    NumOfPayments: 1,
    ISOCoinId: ILS,
    CardOwnerInformation: {
      FullName: String(client.contact || client.name || "").slice(0, 50),
      Phone: digits(client.phone),
      CardOwnerEmail: client.email || "",
    },
    Document: buildDocument(client, products),
  }, 45000);
}

/* For the public status check: are the config vars set, and does Cardcom
   accept them? Asks for the result of a page that cannot exist. Wrong
   credentials answer 603 ("שם משתמש או סיסמה שגויים"). Cached for a minute. */
let statusCache = null;
async function credentialsStatus() {
  const c = config();
  const vars = { terminal: !!c.terminal, apiName: !!c.apiName, apiPassword: !!c.apiPassword, tokenTerminal: c.tokenTerminal !== c.terminal };
  if (!c.terminal || !c.apiName) return { ...vars, credentials: "missing" };
  if (statusCache && Date.now() - statusCache.at < 60_000) return { ...vars, ...statusCache.result };
  let result;
  try {
    const data = await post("/LowProfile/GetLpResult", { TerminalNumber: c.terminal, ApiName: c.apiName, LowProfileId: "00000000-0000-0000-0000-000000000000" }, 10000);
    const rejected = data.ResponseCode === 603 || /שם משתמש|סיסמה|סיסמא/.test(String(data.Description || ""));
    result = { credentials: rejected ? "rejected" : "accepted", cardcomCode: data.ResponseCode ?? null, cardcomDescription: data.Description || null };
  } catch (err) {
    result = { credentials: "unreachable", error: err.message };
  }
  statusCache = { at: Date.now(), result };
  return { ...vars, ...result };
}

module.exports = {
  CardcomError, config, buildDocument,
  createPaymentPage, getPaymentResult, chargeToken, credentialsStatus,
  isPaid, isSuspended, paymentMethod, tokenOf, transactionId,
};
