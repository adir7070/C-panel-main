/**
 * cpanel-categories.service — manager-extensible category list.
 *
 * The frontend ships a curated `data/categories.ts` list that's good enough
 * for 95% of Israeli businesses. When a manager runs into an industry that
 * isn't on the list, they can add it on the fly from the Characterization
 * tab and it persists for everyone in the cpanel from that point on.
 *
 * We only store the delta — custom categories and custom sub-categories —
 * not the built-in ones. The frontend merges them at render time.
 *
 * Doc shape (collection: cpanel_categories):
 *   {
 *     key:        "custom_<slug>",
 *     label:      "<Hebrew label>",
 *     subCategories: [{ key, label, createdAt, createdBy }],
 *     custom:     true,            // marks the whole doc as a custom-added category
 *     createdAt:  Date,
 *     createdBy:  agentId | null,
 *     updatedAt:  Date,
 *   }
 *
 * For sub-categories on a built-in category, we still create a doc keyed by
 * the BUILT-IN key (e.g. `beauty`) but mark `extendsBuiltIn: true` so the
 * frontend knows it's only a partial extension, not a full replacement.
 */
const { getDB } = require("../config/db");

const COL = "cpanel_categories";
const col = () => getDB().collection(COL);

/* ── helpers ────────────────────────────────────────────────────────── */

function slug(label) {
  /* Hebrew-safe slug: keep letters, numbers, dashes; collapse whitespace. */
  return String(label || "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .slice(0, 60)
    .toLowerCase() || `cat_${Date.now().toString(36)}`;
}

async function ensureIndexes() {
  try {
    await col().createIndex({ key: 1 }, { unique: true });
  } catch (_) {}
}

/* ── public API ─────────────────────────────────────────────────────── */

/** Return every stored doc (custom categories + extensions to built-ins). */
async function listAll() {
  return col().find({}).sort({ createdAt: 1 }).toArray();
}

/**
 * Add a brand-new top-level category.
 * Returns the inserted doc. Idempotent on label collision.
 */
async function addCategory(label, agentId) {
  const trimmed = String(label || "").trim();
  if (!trimmed) throw new Error("label required");

  /* Idempotent: if a custom category with the same label already exists,
     return it instead of failing. Built-ins are not stored here so a
     duplicate against a built-in label is impossible to detect server-side. */
  const existing = await col().findOne({ label: trimmed, custom: true });
  if (existing) return existing;

  const key = `custom_${slug(trimmed)}_${Date.now().toString(36)}`;
  const doc = {
    key,
    label: trimmed,
    subCategories: [],
    custom: true,
    extendsBuiltIn: false,
    createdAt: new Date(),
    createdBy: agentId || null,
    updatedAt: new Date(),
  };
  await col().insertOne(doc);
  return doc;
}

/**
 * Add a sub-category to either a built-in or custom parent category.
 * For a built-in parent (no doc yet), we create the extension doc on the fly.
 * Returns the parent doc post-update.
 */
async function addSubCategory(parentKey, label, agentId) {
  const trimmed = String(label || "").trim();
  if (!trimmed) throw new Error("label required");
  if (!parentKey) throw new Error("parentKey required");

  const subDoc = {
    key: `custom_${slug(trimmed)}_${Date.now().toString(36)}`,
    label: trimmed,
    custom: true,
    createdAt: new Date(),
    createdBy: agentId || null,
  };

  /* Skip duplicates by label within the parent. */
  const existing = await col().findOne({ key: parentKey });
  if (existing) {
    if ((existing.subCategories || []).some(s => s.label === trimmed)) {
      return existing;
    }
    await col().updateOne(
      { key: parentKey },
      {
        $push: { subCategories: subDoc },
        $set:  { updatedAt: new Date() },
      }
    );
  } else {
    /* First custom sub for a built-in parent → create the extension doc. */
    await col().insertOne({
      key: parentKey,
      label: null,            // null = "extension only", frontend uses built-in label
      subCategories: [subDoc],
      custom: false,
      extendsBuiltIn: true,
      createdAt: new Date(),
      createdBy: agentId || null,
      updatedAt: new Date(),
    });
  }

  return col().findOne({ key: parentKey });
}

module.exports = { ensureIndexes, listAll, addCategory, addSubCategory };
