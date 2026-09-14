'use strict';

const { col, oid, BpError } = require('./bp-db');
const { normalizeName } = require('./bp-ocr.service');

// ─── Default Categories ───────────────────────────────────────────────────────

const DEFAULT_CATEGORIES = [
  { name: 'מזון ומשקאות', accountingCode: '7100', vatDeductible: false, color: '#FF6B6B', keywords: ['מזון', 'אוכל', 'משקה', 'סופרמרקט', 'מסעדה', 'קפה', 'food', 'restaurant'] },
  { name: 'דלק ותחבורה', accountingCode: '7200', vatDeductible: true,  color: '#4ECDC4', keywords: ['דלק', 'תדלוק', 'פז', 'דור אלון', 'סונול', 'fuel', 'petrol', 'gas', 'transport'] },
  { name: 'משרד וציוד', accountingCode: '7300', vatDeductible: true,  color: '#45B7D1', keywords: ['משרד', 'ציוד', 'נייר', 'מדפסת', 'office', 'supplies', 'stationery'] },
  { name: 'תקשורת', accountingCode: '7400', vatDeductible: true,  color: '#96CEB4', keywords: ['תקשורת', 'סלולר', 'אינטרנט', 'בזק', 'hot', 'partner', 'yes', 'cellcom', 'telecom', 'phone', 'internet'] },
  { name: 'שיווק ופרסום', accountingCode: '7500', vatDeductible: true,  color: '#FFEAA7', keywords: ['שיווק', 'פרסום', 'מדיה', 'google', 'facebook', 'meta', 'marketing', 'advertising', 'ads'] },
  { name: 'חשמל ומים', accountingCode: '7600', vatDeductible: false, color: '#DDA0DD', keywords: ['חשמל', 'מים', 'גז', 'electricity', 'water', 'עיריה', 'municipality', 'חברת חשמל'] },
  { name: 'שכר דירה', accountingCode: '7700', vatDeductible: false, color: '#98D8C8', keywords: ['שכר דירה', 'שכירות', 'rent', 'real estate', 'נדלן'] },
  { name: 'ציוד ומכשירים', accountingCode: '7800', vatDeductible: true,  color: '#F7DC6F', keywords: ['ציוד', 'מחשב', 'טלפון', 'מכשיר', 'equipment', 'hardware', 'laptop', 'computer'] },
  { name: 'שירותים מקצועיים', accountingCode: '7900', vatDeductible: true,  color: '#A8E6CF', keywords: ['עורך דין', 'רואה חשבון', 'ייעוץ', 'consultant', 'lawyer', 'accountant', 'professional'] },
  { name: 'ביטוח', accountingCode: '8000', vatDeductible: false, color: '#FFB3BA', keywords: ['ביטוח', 'insurance', 'מגדל', 'הפניקס', 'הראל', 'כלל'] },
  { name: 'בנק ועמלות', accountingCode: '8100', vatDeductible: false, color: '#BFEFFF', keywords: ['בנק', 'עמלה', 'bank', 'fee', 'commission', 'הפועלים', 'לאומי', 'דיסקונט', 'מזרחי'] },
  { name: 'אחר', accountingCode: '9999', vatDeductible: false, color: '#D3D3D3', keywords: [] },
];

// ─── Seed Default Categories ──────────────────────────────────────────────────

/**
 * Seeds default Israeli accounting categories for a tenant if none exist.
 * Safe to call multiple times — no-ops if categories already exist.
 * @param {string} tenantId
 * @returns {Promise<void>}
 */
async function seedDefaultCategories(tenantId) {
  const existing = await col('categories').countDocuments({ tenantId: oid(tenantId) });
  if (existing > 0) return;

  const now = new Date();
  const docs = DEFAULT_CATEGORIES.map((cat) => ({
    tenantId: oid(tenantId),
    name: cat.name,
    accountingCode: cat.accountingCode,
    vatDeductible: cat.vatDeductible,
    color: cat.color,
    keywords: cat.keywords || [],
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }));

  await col('categories').insertMany(docs);
}

// ─── List Categories ──────────────────────────────────────────────────────────

/**
 * Returns all active categories for a tenant.
 * @param {string} tenantId
 * @returns {Promise<object[]>}
 */
async function listCategories(tenantId) {
  return col('categories')
    .find({ tenantId: oid(tenantId), isActive: true })
    .sort({ accountingCode: 1 })
    .toArray();
}

// ─── Get Category by ID ───────────────────────────────────────────────────────

/**
 * Fetches a single category by id, scoped to a tenant.
 * @param {string} tenantId
 * @param {string} categoryId
 * @returns {Promise<object>}
 */
async function getCategoryById(tenantId, categoryId) {
  const category = await col('categories').findOne({
    _id: oid(categoryId),
    tenantId: oid(tenantId),
  });

  if (!category) {
    throw new BpError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  }

  return category;
}

// ─── Create Category ──────────────────────────────────────────────────────────

/**
 * Creates a new category for a tenant.
 * @param {string} tenantId
 * @param {{ name: string, accountingCode?: string, vatDeductible?: boolean, color?: string, keywords?: string[] }} data
 * @returns {Promise<object>}
 */
async function createCategory(tenantId, data) {
  if (!data.name) {
    throw new BpError('Category name is required', 400, 'MISSING_NAME');
  }

  const now = new Date();
  const doc = {
    tenantId: oid(tenantId),
    name: data.name,
    accountingCode: data.accountingCode || '',
    vatDeductible: data.vatDeductible ?? false,
    color: data.color || '#D3D3D3',
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  const result = await col('categories').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

// ─── Suggest Category ─────────────────────────────────────────────────────────

/**
 * Suggests a category name for a vendor/document by keyword matching.
 * Returns the matched category name, or 'אחר' as fallback.
 * @param {string} tenantId
 * @param {string} [vendorName]
 * @param {string} [documentType]
 * @returns {Promise<string>}
 */
async function suggestCategory(tenantId, vendorName, documentType) {
  if (!vendorName) return 'אחר';

  const normalized = normalizeName(vendorName).toLowerCase();

  const categories = await col('categories')
    .find({ tenantId: oid(tenantId), isActive: true })
    .toArray();

  // Score each category by keyword hits
  let bestCategory = null;
  let bestScore = 0;

  for (const cat of categories) {
    if (cat.name === 'אחר') continue;
    const keywords = Array.isArray(cat.keywords) ? cat.keywords : [];
    let score = 0;
    for (const kw of keywords) {
      if (normalized.includes(normalizeName(kw))) {
        score += kw.length; // longer matches score higher
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat;
    }
  }

  return bestCategory ? bestCategory.name : 'אחר';
}

async function updateCategory(tenantId, categoryId, updates) {
  const allowed = ['name', 'accountingCode', 'vatDeductible', 'vatDeductiblePercent', 'color', 'icon', 'keywords', 'isActive', 'sortOrder'];
  const set = { updatedAt: new Date() };
  for (const k of allowed) if (updates[k] !== undefined) set[k] = updates[k];
  const result = await col('categories').findOneAndUpdate(
    { _id: oid(categoryId), tenantId },
    { $set: set },
    { returnDocument: 'after' }
  );
  if (!result) throw new BpError('Category not found', 404, 'NOT_FOUND');
  return result;
}

async function deleteCategory(tenantId, categoryId) {
  await col('categories').updateOne(
    { _id: oid(categoryId), tenantId },
    { $set: { isActive: false, updatedAt: new Date() } }
  );
}

module.exports = {
  seedDefaultCategories,
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  suggestCategory,
};
