/**
 * cpanel-products.service — the price list everything in the panel is sold
 * from.
 *
 * Collection: cpanel_products
 *
 * Since 2026-11-22 the catalog is the 64 services of the Dashen sales kit
 * (kind "service", seeded from service-catalog.data.js). The old Iconiq-era
 * kinds (item / prebuilt / social / coins) were deleted at the user's request
 * and are no longer seeded; listAll() still returns their (now empty) groups
 * so old readers keep working.
 *
 * Service document:
 *   { _id, key, kind: "service", active, sortOrder, createdAt, updatedAt,
 *     name, description, category, categoryName, categoryOrder,
 *     role: "core"|"addon", billing: "setup"|"monthly", onDemand, price,
 *     keywords }
 */
const { getDB } = require("../config/db");

const COL = "cpanel_products";
const col = () => getDB().collection(COL);

/* ── Defaults — the sales-kit services, inserted when missing ───────── */

const { CATEGORIES, SERVICES } = require("./service-catalog.data");
const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

const DEFAULT_SERVICES = SERVICES.map((svc, i) => ({
  ...svc,
  kind: "service",
  categoryName: CATEGORY_BY_KEY[svc.category]?.name || "",
  categoryOrder: CATEGORY_BY_KEY[svc.category]?.order || 99,
  onDemand: !!svc.onDemand,
  sortOrder: i + 1,
}));

const ALL_DEFAULTS = DEFAULT_SERVICES;

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
 * Insert every sales-kit service whose key is missing (idempotent — safe to
 * run on every boot). Existing documents are never touched, so a price or a
 * deactivation made in the DB survives restarts.
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
    /* unordered: a key some other document already holds (unique index)
       must not stop the rest of the services from being inserted */
    try {
      await col().insertMany(toInsert, { ordered: false });
    } catch (err) {
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
      console.warn("[cpanel-products] some services were not seeded:", err.message);
    }
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
  const services = docs
    .filter(d => d.kind === "service")
    .sort((x, y) => (x.categoryOrder - y.categoryOrder) || (x.sortOrder - y.sortOrder));
  return { items, prebuilt, social, coins, services, categories: CATEGORIES };
}

/** Upsert a single product (admin operation). */
async function upsertProduct(input) {
  if (!input?.key)  throw new Error("key required");
  if (!input?.kind) throw new Error("kind required");
  if (!["item", "prebuilt", "social", "coins", "service"].includes(input.kind)) {
    throw new Error("kind must be one of item|prebuilt|social|coins|service");
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
  listAll,
  upsertProduct,
  deleteProduct,
  getPackageByKey,
  computeCustomBuilderTotal,
  DEFAULT_SERVICES,
};
