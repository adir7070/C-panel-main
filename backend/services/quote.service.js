/* Quotes in the Dashen format (deshen-quote-agreement): setup services paid
   at signing + monthly services for a commitment period, a discount of at
   most 10%, VAT on top. Stored in personal_packages with kind "quote" so the
   client's קטלוג אישי lists them next to older packages.

   The server is the source of truth for every number: lines are resolved
   against the catalog (cpanel_products kind "service") and the totals are
   recomputed on every save — the same arithmetic as the original HTML
   builder, mirrored in src/api/quotes.ts for the live preview. */

const { getDB } = require("../config/db");

const MAX_DISCOUNT_PCT = 10;   // sales kit: "הנחה מרבית במבצע 10%" — for everyone
const VAT_PCT = 18;
const MAX_LINES = 100;
const DEFAULTS = { validDays: 14, commitMonths: 3, noticeDays: 30 };

class QuoteError extends Error {
  constructor(message, code = "bad_request") { super(message); this.code = code; }
}

const str = (v, max = 300) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const int = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/* Today in Israel as YYYY-MM-DD. */
function todayIL() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
}

function computeTotals(lines, { discountPct = 0, vatPct = VAT_PCT, commitMonths = DEFAULTS.commitMonths } = {}) {
  const pct = Math.min(MAX_DISCOUNT_PCT, Math.max(0, Number(discountPct) || 0));
  const block = monthly => {
    const its = lines.filter(l => (l.billing === "monthly") === monthly);
    const sub = its.reduce((s, l) => s + l.price * l.qty, 0);
    const disc = Math.round(sub * pct / 100);
    const net = sub - disc;
    const vat = Math.round(net * vatPct / 100);
    return { count: its.length, sub, disc, net, vat, total: net + vat };
  };
  const setup = block(false);
  const monthly = block(true);
  return {
    discountPct: pct,
    vatPct,
    setup,
    monthly,
    commitMonths,
    commitNet: setup.net + commitMonths * monthly.net,
    commitTotal: setup.total + commitMonths * monthly.total,
  };
}

/* Next number for the year: 2026-001, 2026-002, … (global, never reused). */
async function nextQuoteNo(date) {
  const year = String(date || todayIL()).slice(0, 4);
  const r = await getDB().collection("counters").findOneAndUpdate(
    { _id: `quote_no:${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  // driver v6 returns the doc, v4/v5 wrap it in { value }
  const doc = r && "value" in r && "ok" in r ? r.value : r;
  return `${year}-${String(doc?.seq || 1).padStart(3, "0")}`;
}

/* Lines from the request → stored lines. Catalog lines take name, text and
   price from the catalog — except lines the quote already had, which keep
   the price they were quoted at. Custom lines ("פיתוח בהתאמה אישית") carry
   their own name and price. */
async function resolveLines(input, existingLines = []) {
  if (!Array.isArray(input)) throw new QuoteError("lines חייב להיות מערך");
  if (input.length > MAX_LINES) throw new QuoteError(`עד ${MAX_LINES} שורות בהצעה`);
  const keys = [...new Set(input.filter(l => l && !l.custom && l.key).map(l => String(l.key)))];
  const catalog = keys.length
    ? await getDB().collection("cpanel_products").find({ kind: "service", key: { $in: keys } }).toArray()
    : [];
  const byKey = new Map(catalog.map(s => [s.key, s]));
  const kept = new Map(existingLines.filter(l => l.key).map(l => [l.key, l]));
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const qty = int(raw.qty, 1, 999, 1);
    if (raw.custom) {
      const name = str(raw.name, 200);
      if (!name) throw new QuoteError("לשירות מותאם חסר שם");
      const price = Number(raw.price);
      if (!Number.isFinite(price) || price < 0) throw new QuoteError(`מחיר לא תקין לשירות "${name}"`);
      out.push({
        key: null, custom: true, name, description: str(raw.description, 500),
        billing: raw.billing === "monthly" ? "monthly" : "setup", onDemand: false,
        price: Math.round(price), qty, category: "custom",
      });
      continue;
    }
    const key = str(raw.key, 100);
    if (!key || seen.has(key)) continue; // a service appears once; quantity covers the rest
    seen.add(key);
    const prev = kept.get(key);
    if (prev) { out.push({ ...prev, qty }); continue; }
    const svc = byKey.get(key);
    if (!svc || svc.active === false) throw new QuoteError(`השירות "${key}" לא נמצא במחירון`);
    out.push({
      key, custom: false, name: svc.name, description: svc.description || "",
      billing: svc.billing === "monthly" ? "monthly" : "setup", onDemand: !!svc.onDemand,
      price: Number(svc.price) || 0, qty, category: svc.category || "", role: svc.role || "addon",
    });
  }
  return out;
}

function cleanClient(c = {}, fallback = {}) {
  const pick = k => str(c[k] !== undefined ? c[k] : fallback[k], k === "address" ? 300 : 200);
  return {
    name: pick("name"), id: pick("id"), contact: pick("contact"), role: pick("role"),
    phone: pick("phone"), email: pick("email"), address: pick("address"),
  };
}

/* "הוכן עבור" defaults for a new quote: the business profile, the lead the
   client came from, the client record. */
async function clientDefaults(phone) {
  const db = getDB();
  const [profile, lead, mapping] = await Promise.all([
    db.collection("business_profiles").findOne({ phone }, { projection: { businessName: 1, email: 1, address: 1 } }),
    db.collection("leads").find({ phone, statusHistory: { $exists: true } }).sort({ createdAt: 1 }).limit(1).next(),
    db.collection("cpanel_clients").findOne({ phone }, { projection: { customerName: 1 } }),
  ]);
  const business = profile?.businessName || lead?.business || "";
  const person = lead?.name && lead.name !== lead.phone ? lead.name : "";
  return {
    name: business || person || mapping?.customerName || "",
    contact: business ? person : "",
    phone,
    email: profile?.email || lead?.email || "",
    address: profile?.address || "",
  };
}

/* Request body → the fields a quote stores (lines resolved, totals computed). */
async function buildQuoteFields(body, { existing = null, phone }) {
  const b = body || {};
  const discountPct = Number(b.discountPct ?? existing?.discountPct ?? 0) || 0;
  if (discountPct < 0 || discountPct > MAX_DISCOUNT_PCT) {
    throw new QuoteError(`ההנחה המרבית היא ${MAX_DISCOUNT_PCT}%`, "discount_too_high");
  }
  const lines = b.lines !== undefined ? await resolveLines(b.lines, existing?.lines || []) : (existing?.lines || []);
  const commitMonths = int(b.commitMonths ?? existing?.commitMonths, 1, 36, DEFAULTS.commitMonths);
  const validDays = int(b.validDays ?? existing?.validDays, 1, 90, DEFAULTS.validDays);
  const noticeDays = int(b.noticeDays ?? existing?.noticeDays, 1, 180, DEFAULTS.noticeDays);
  const quoteDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.quoteDate || "")) ? String(b.quoteDate) : (existing?.quoteDate || todayIL());
  const vatPct = existing?.vatPct ?? VAT_PCT;
  const client = b.client !== undefined
    ? cleanClient(b.client, existing?.client || {})
    : existing?.client || cleanClient({}, await clientDefaults(phone));
  const totals = computeTotals(lines, { discountPct, vatPct, commitMonths });
  return {
    lines, client, discountPct, vatPct, commitMonths, validDays, noticeDays, quoteDate,
    notes: b.notes !== undefined ? str(b.notes, 2000) : (existing?.notes || ""),
    totals,
    /* What older screens read off personal_packages (pre-VAT, like before). */
    items: {},
    bullets: lines.map(l => l.qty > 1 ? `${l.name} ×${l.qty}` : l.name),
    basePrice: totals.setup.sub + totals.monthly.sub,
    finalPrice: totals.setup.net,
    coins: 0,
    currencyCode: 1,
  };
}

module.exports = {
  MAX_DISCOUNT_PCT, VAT_PCT, DEFAULTS, QuoteError,
  computeTotals, nextQuoteNo, resolveLines, clientDefaults, buildQuoteFields, todayIL, cleanClient,
};
