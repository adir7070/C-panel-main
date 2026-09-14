/**
 * cpanel-products.service — single source of truth for everything sold
 * inside the cpanel billing tab.
 *
 * Collection: cpanel_products
 *
 * Document shape (all kinds share the base):
 *   {
 *     _id, key,                 // unique short id (e.g. "ad", "lp", "platinum")
 *     kind: "item"|"prebuilt"|"social"|"coins",
 *     active: true,
 *     sortOrder: number,
 *     createdAt, updatedAt,
 *
 *     // Common display:
 *     label, emoji?, badge?,
 *
 *     // Per-kind:
 *     // -- item: --
 *     unitPrice,
 *
 *     // -- prebuilt: --
 *     name, price, discountPct?, bullets: [], coins,
 *     items: { <itemKey>: count, ... },     // references item.key values
 *
 *     // -- social: --                       same shape as prebuilt; rendered
 *     name, price, discountPct?, bullets: [], coins,   //   in its own section
 *     items: { <itemKey>: count, ... },     //   above "PACKAGES" in the UI.
 *     periodLabel,                          //   e.g. "שבועי" — small caption
 *
 *     // -- coins: --
 *     name, price, coins,
 *   }
 *
 * Every consumer (frontend BillingTab + backend pricing validation) reads
 * this catalog. Hardcoded prices in JS arrays are deprecated.
 */
const { getDB } = require("../config/db");

const COL = "cpanel_products";
const col = () => getDB().collection(COL);

/* ── Defaults — seeded on first boot if the collection is empty ────── */

const DEFAULT_ITEMS = [
  { key: "ad",        kind: "item", label: "מודעות פייסבוק", emoji: "📣", unitPrice:  100, sortOrder: 1 },
  { key: "lp",        kind: "item", label: "דפי נחיתה",       emoji: "🌐", unitPrice: 1000, sortOrder: 2 },
  { key: "video",     kind: "item", label: "סרטונים",          emoji: "🎬", unitPrice:  500, sortOrder: 3 },
  { key: "social_ad", kind: "item", label: "מודעות סושיאל",   emoji: "✨", unitPrice:  100, sortOrder: 4 },
  { key: "domain",       kind: "item", label: "דומיין",              emoji: "🔗", unitPrice:  499, sortOrder: 5 },
  { key: "social_ad_10", kind: "item", label: "10 מודעות לסושיאל", emoji: "✨", unitPrice:  450, sortOrder: 6 },
  { key: "ad_10",            kind: "item", label: "10 מודעות לקמפיין",    emoji: "📣", unitPrice:  490, sortOrder: 7 },
  { key: "campaign_traffic", kind: "item", label: "קמפיין תנועה לאתר",       emoji: "📣", unitPrice:  449, sortOrder: 8 },
  { key: "campaign_leads",   kind: "item", label: "קמפיין לידים",              emoji: "📣", unitPrice:  449, sortOrder: 9 },
  { key: "meta_pages",       kind: "item", label: "הקמת דפים עסקיים ב Meta",  emoji: "📘", unitPrice:  499, sortOrder: 10 },
  { key: "sale_site",        kind: "item", label: "אתר מכירה",                  emoji: "🛒", unitPrice: 8500, sortOrder: 11 },
];

const DEFAULT_PREBUILT = [
  {
    key: "platinum", kind: "prebuilt",
    name: "חבילת פלטינום",
    price: 3490, currencyCode: 1, discountPct: 38, badge: "הכי משתלם",
    bullets: [
      "דף נחיתה",
      "גאנט חודשי (20 מודעות)",
      "2 קמפיינים (15 מודעות)",
      "וידאו",
      "1,500 טוקנים",
    ],
    items: { ad: 35, lp: 1, video: 1, logo: 0, social_ad: 0 },
    coins: 1500,
    sortOrder: 1,
  },
  {
    key: "premium", kind: "prebuilt",
    name: "חבילת פרימיום",
    price: 1490, currencyCode: 1, discountPct: 35, badge: "הכי נמכר",
    bullets: [
      "2 קמפיינים (10 מודעות)",
      "סושיאל (8 מודעות)",
      "800 טוקנים",
    ],
    items: { ad: 10, lp: 0, video: 0, social_ad: 8 },
    coins: 800,
    sortOrder: 2,
  },
  {
    key: "basic", kind: "prebuilt",
    name: "חבילת בייסיק",
    price: 749, currencyCode: 1, discountPct: 19,
    bullets: [
      "קמפיין (5 מודעות)",
      "סושיאל (3 מודעות)",
      "300 טוקנים",
    ],
    items: { ad: 5, lp: 0, video: 0, logo: 0, social_ad: 3 },
    coins: 300,
    sortOrder: 3,
  },
];

/* Social-only tiers. NOT a Cardcom-paid product — these are redeemed by
   DEBITING the client's existing coin balance. `price` = `coins` = the
   number of coins the redemption costs (no shekel charge ever happens).
   Rendered as their own section above PACKAGES. */
const DEFAULT_SOCIAL = [
  {
    key: "social_standard", kind: "social",
    name: "קמפיין סטנדרטי",
    periodLabel: "קמפיין אחד",
    price: 500, coins: 500,
    bullets: [
      "5–7 מודעות סושיאל",
      "קמפיין אחד",
    ],
    items: { ad: 0, lp: 0, video: 0, logo: 0, social_ad: 7 },
    sortOrder: 1,
  },
  {
    key: "social_pro", kind: "social",
    name: "קמפיין פרו",
    periodLabel: "כולל A/B",
    price: 1000, coins: 1000, badge: "הכי משתלם",
    bullets: [
      "10–15 מודעות סושיאל",
      "כולל טסטים A/B",
    ],
    items: { ad: 0, lp: 0, video: 0, logo: 0, social_ad: 15 },
    sortOrder: 2,
  },
];

const DEFAULT_COINS = [
  { key: "direct_1000_coins",  kind: "coins", name: "1,000 מטבעות",   price:  450, currencyCode: 1, coins: 1000,  sortOrder: 1 },
  { key: "direct_5000_coins",  kind: "coins", name: "5,000 מטבעות",   price: 1900, currencyCode: 1, coins: 5000,  sortOrder: 2 },
  { key: "direct_10000_coins", kind: "coins", name: "10,000 מטבעות",  price: 3000, currencyCode: 1, coins: 10000, sortOrder: 3 },
  { key: "direct_30000_coins", kind: "coins", name: "30,000 מטבעות",  price: 7500, currencyCode: 1, coins: 30000, sortOrder: 4 },
];

const ALL_DEFAULTS = [...DEFAULT_ITEMS, ...DEFAULT_SOCIAL, ...DEFAULT_PREBUILT, ...DEFAULT_COINS];

/* ── public API ────────────────────────────────────────────────────── */

async function ensureIndexes() {
  try {
    await col().createIndex({ key: 1 }, { unique: true });
    await col().createIndex({ kind: 1, sortOrder: 1 });
  } catch (err) {
    console.warn("[cpanel-products] index ensure failed:", err.message);
  }
}

/**
 * One-shot refresh of the social-plan rows. They were created with the
 * old name/coins/bullets shape (e.g. coins:200, name:"סושיאל שבועי",
 * bullet "200 טוקנים") before we switched them to a coin-debit model.
 * This overwrites those fields with the current DEFAULT_SOCIAL values
 * BY KEY, so existing prod rows pick up the new shape on next boot.
 *
 * Safe to leave wired indefinitely — the update is idempotent (writing
 * the same values has no effect) and only touches the 3 known keys.
 */
async function refreshSocialDefaults() {
  // Deactivate legacy social plans
  for (const oldKey of ["social_weekly", "social_biweekly", "social_monthly"]) {
    await col().updateOne({ key: oldKey }, { $set: { active: false, updatedAt: new Date() } });
  }
  // Upsert current plans
  for (const def of DEFAULT_SOCIAL) {
    const $set = { ...def, active: true, updatedAt: new Date() };
    delete $set.key;
    await col().updateOne(
      { key: def.key, kind: "social" },
      { $set, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  }
}

/**
 * Deactivate the app-facing coin packages from the C-Panel catalog.
 * They remain active in the customer app (different endpoint/source).
 * Idempotent — safe to run on every boot.
 */
async function deactivateAppCoinsFromCpanel() {
  for (const key of ["platinum_coins", "premium_coins", "basic_coins"]) {
    await col().updateOne({ key }, { $set: { active: false, updatedAt: new Date() } });
  }
}

/**
 * Seed the catalog with curated defaults if the collection is empty,
 * OR if a default is missing (idempotent — safe to run on every boot).
 */
async function seedDefaults() {
  await ensureIndexes();
  const existing = await col().find({}, { projection: { key: 1 } }).toArray();
  const existingKeys = new Set(existing.map(d => d.key));
  const toInsert = ALL_DEFAULTS
    .filter(d => !existingKeys.has(d.key))
    .map(d => ({
      ...d,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  if (toInsert.length) {
    await col().insertMany(toInsert);
    console.log(`[cpanel-products] seeded ${toInsert.length} default products`);
  }
}

/** Return the catalog grouped by kind. */
async function listAll() {
  const docs = await col().find({ active: { $ne: false } }).sort({ kind: 1, sortOrder: 1 }).toArray();
  const items    = docs.filter(d => d.kind === "item");
  const prebuilt = docs.filter(d => d.kind === "prebuilt");
  const social   = docs.filter(d => d.kind === "social");
  const coins    = docs.filter(d => d.kind === "coins");
  return { items, prebuilt, social, coins };
}

/** Upsert a single product (admin operation). */
async function upsertProduct(input) {
  if (!input?.key)  throw new Error("key required");
  if (!input?.kind) throw new Error("kind required");
  if (!["item", "prebuilt", "social", "coins"].includes(input.kind)) {
    throw new Error("kind must be one of item|prebuilt|social|coins");
  }
  const $set = {
    ...input,
    active: input.active !== false,
    updatedAt: new Date(),
  };
  /* Strip server-managed fields that may have been echoed back from a
     loaded document. createdAt collides with $setOnInsert below; _id
     can't be changed; __v is a Mongoose artifact we don't want. */
  delete $set._id;
  delete $set.createdAt;
  delete $set.__v;
  await col().updateOne(
    { key: input.key },
    { $set, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  return col().findOne({ key: input.key });
}

async function deleteProduct(key) {
  if (!key) throw new Error("key required");
  /* Soft-delete to keep historical pending purchases intact. */
  await col().updateOne({ key }, { $set: { active: false, updatedAt: new Date() } });
  return { success: true };
}

/**
 * Look up the canonical price + coins for a prebuilt or coins package.
 * Returns null if the package is unknown — callers fall back to the
 * frontend-supplied overrides.
 */
async function getPackageByKey(key) {
  if (!key) return null;
  return col().findOne({ key, active: { $ne: false } });
}

/**
 * Compute the canonical total for a "custom builder" cart from the DB.
 * Items not found in the DB are silently priced at 0.
 */
async function computeCustomBuilderTotal(itemCounts) {
  if (!itemCounts || typeof itemCounts !== "object") return { total: 0, lines: [] };
  const keys = Object.keys(itemCounts).filter(k => Number(itemCounts[k]) > 0);
  if (!keys.length) return { total: 0, lines: [] };
  const docs = await col().find({ kind: "item", key: { $in: keys } }).toArray();
  let total = 0;
  const lines = [];
  for (const d of docs) {
    const count = Number(itemCounts[d.key]) || 0;
    if (!count) continue;
    const sub = count * (d.unitPrice || 0);
    total += sub;
    lines.push({ key: d.key, label: d.label, count, unitPrice: d.unitPrice, subtotal: sub });
  }
  return { total, lines };
}

module.exports = {
  ensureIndexes,
  seedDefaults,
  refreshSocialDefaults,
  deactivateAppCoinsFromCpanel,
  listAll,
  upsertProduct,
  deleteProduct,
  getPackageByKey,
  computeCustomBuilderTotal,
  DEFAULT_ITEMS, DEFAULT_PREBUILT, DEFAULT_SOCIAL, DEFAULT_COINS,
};
