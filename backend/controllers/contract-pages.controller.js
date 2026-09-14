/**
 * contract-pages.controller.js
 */

const path     = require("path");
const fs       = require("fs");
const { exec } = require("child_process");
const multer   = require("multer");
const { getDB }      = require("../config/db");
const { ObjectId }   = require("mongodb");
const DB             = require("../utils/DB");
const { uploadImage } = require("../services/backblaze.service");

// Use the DB wrapper so reads/writes go through dual-write (both AWS + Atlas)
const DOCS_COL  = () => DB.collection("contract_doc_names");
const RULES_COL = () => DB.collection("contract_rules");

const PDF_PAGES_DIR = path.join(__dirname, "..", "pdf", "pages");

// Default rules — seeded ONLY when BOTH databases are empty. This array MUST mirror the
// live rule set. Structure is combination-based: each rule maps an EXACT product-set → one
// page, so the engine's most-specific-wins logic suppresses single-product pages when a
// combined rule matches (e.g. leads+website shows only the combined page).
const DEFAULT_RULES = [
  // ── Campaign products → permission pages (חבילת סושיאל DOES combine) ──────────
  { name: "קמפיין לידים",          conditions: ["ad_lead_10"],                          pages: ["permission_leads.png"] },
  { name: "קמפיין תנועה לאתר",     conditions: ["ad_10"],                               pages: ["permission_website.png"] },
  { name: "חבילת סושיאל",          conditions: ["social_ad_10"],                        pages: ["permission_social.png"] },
  { name: "קמפיין לידים + תנועה",   conditions: ["ad_lead_10", "ad_10"],                 pages: ["permission_leads_website.png"] },
  { name: "קמפיין לידים + סושיאל",  conditions: ["ad_lead_10", "social_ad_10"],          pages: ["permission_leads_social.png"] },
  { name: "קמפיין תנועה + סושיאל",  conditions: ["ad_10", "social_ad_10"],               pages: ["permission_website_social.png"] },
  { name: "כל הקמפיינים",          conditions: ["ad_lead_10", "ad_10", "social_ad_10"], pages: ["permission_all.png"] },
  // ── Access products → access pages. Filenames now MATCH content (renamed 2026-06-18).
  //    גישת סושיאל DOES combine here, and each combination has its own page.
  { name: "גישת תנועה לאתר",            conditions: ["web_cmp"],                            pages: ["access_website.png"] },
  { name: "גישת טופס ליד",              conditions: ["lead_cmp"],                           pages: ["access_leads.png"] },
  { name: "גישת סושיאל",                conditions: ["social_cmp"],                         pages: ["access_social.png"] },
  { name: "גישת תנועה + גישת טופס ליד",  conditions: ["web_cmp", "lead_cmp"],                pages: ["access_leads_website.png"] },
  { name: "גישת תנועה + גישת סושיאל",    conditions: ["web_cmp", "social_cmp"],              pages: ["access_website_social.png"] },
  { name: "גישת טופס ליד + גישת סושיאל", conditions: ["lead_cmp", "social_cmp"],             pages: ["access_leads_social.png"] },
  { name: "כל הגישות",                  conditions: ["web_cmp", "lead_cmp", "social_cmp"],   pages: ["access_all.png"] },
  // ── Landing / sites (single → single) ────────────────────────────────────────
  { name: "דפי נחיתה",             conditions: ["lp"],         pages: ["lp_page.png"] },
  { name: "אתר מכירה",             conditions: ["sale_site"],  pages: ["lp_shop.png"] },
  { name: "אתר קטלוג",             conditions: ["katlog_web"], pages: ["12_lp.png"] },
];

const DEFAULT_PRODUCTS = [
  { key: "lp",           label: "דפי נחיתה",            emoji: "🌐" },
  { key: "ad_lead_10",   label: "קמפיין לידים (449₪)",  emoji: "📣" },
  { key: "ad_10",        label: "קמפיין לאתר (449₪)",   emoji: "📣" },
  { key: "social_ad_10", label: "חבילת סושיאל (449₪)", emoji: "✨" },
  { key: "web_cmp",      label: "גישת טופס ליד",        emoji: "🔑" },
  { key: "lead_cmp",     label: "גישת קמפיין לאתר",     emoji: "🔑" },
  { key: "social_cmp",   label: "גישת סושיאל",          emoji: "🔑" },
  { key: "ad",           label: "מודעות פייסבוק",       emoji: "📢" },
  { key: "social_ad",    label: "מודעות סושיאל",        emoji: "✨" },
  { key: "video",        label: "סרטונים",               emoji: "🎬" },
  { key: "domain",       label: "דומיין",                emoji: "🔗" },
];

/* ── Multer — memory storage, accept PNG/PDF only ──────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (["image/png", "application/pdf"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("קובץ חייב להיות PNG או PDF"));
  },
});
exports.uploadMiddleware = upload.single("file");

// Pages that are always included regardless of rules — same on both servers.
const ALWAYS_PAGES = ["01_cover.png"];

/* ── GET /available ─────────────────────────────────────────────────────── */
// Source of truth is MongoDB (rules + named docs), NOT the local filesystem.
// This ensures both servers (Heroku / AWS) always return the same list.
exports.available = async (req, res) => {
  try {
    const [rules, names] = await Promise.all([
      RULES_COL().find({}).toArray(),
      DOCS_COL().find({}).toArray(),
    ]);

    const docMap = Object.fromEntries(names.map(n => [n.fileName, n]));
    const seen   = new Set();
    const result = [];

    const addPage = (fileName) => {
      if (seen.has(fileName)) return;
      seen.add(fileName);
      const doc     = docMap[fileName] || {};
      const onDisk  = fs.existsSync(path.join(PDF_PAGES_DIR, fileName));
      result.push({
        fileName,
        displayName:    doc.displayName || fileName.replace(".png", "").replace(/_/g, " "),
        onDisk,
        alwaysInclude:  !!doc.alwaysInclude,
        storageUrl:     doc.storageUrl || null,
      });
    };

    // 1. All named docs (includes always-marked and rule-referenced pages)
    for (const n of names) addPage(n.fileName);
    // 2. Pages referenced in rules not yet in DB
    for (const rule of rules) {
      for (const p of (rule.pages || [])) addPage(p);
    }

    result.sort((a, b) => {
      // always pages first, then alphabetical
      if (a.alwaysInclude !== b.alwaysInclude) return a.alwaysInclude ? -1 : 1;
      return a.fileName.localeCompare(b.fileName);
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── PUT /available/:file/always — toggle alwaysInclude flag ────────────── */
exports.toggleAlways = async (req, res) => {
  try {
    const { file } = req.params;
    const { alwaysInclude } = req.body;
    await DOCS_COL().updateOne(
      { fileName: file },
      { $set: { fileName: file, alwaysInclude: !!alwaysInclude, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, alwaysInclude: !!alwaysInclude });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── PUT /available/:file/name ──────────────────────────────────────────── */
exports.nameDocument = async (req, res) => {
  try {
    const { file } = req.params;
    const { displayName } = req.body;
    if (!displayName?.trim()) return res.status(400).json({ error: "displayName required" });
    await DOCS_COL().updateOne(
      { fileName: file },
      { $set: { fileName: file, displayName: displayName.trim(), updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── POST /upload ───────────────────────────────────────────────────────── */
exports.uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "לא התקבל קובץ" });
    const { displayName } = req.body;

    if (req.file.mimetype === "image/png") {
      // Save PNG directly
      const rawName  = (req.file.originalname || "doc.png").replace(/[^a-zA-Z0-9._-]/g, "_");
      const baseName = rawName.endsWith(".png") ? rawName : rawName + ".png";
      const dest     = path.join(PDF_PAGES_DIR, baseName);
      fs.writeFileSync(dest, req.file.buffer);
      // Upload to Backblaze so the file is available on all server instances
      const storageResult = await uploadImage(`contract-pages/${baseName}`, req.file.buffer, "image/png").catch(() => null);
      const storageUrl = storageResult?.publicUrl || null;
      // Always register in DB so the file appears in /available regardless of which server handles the next request
      const docDisplayName = displayName?.trim() || baseName.replace(".png", "").replace(/_/g, " ");
      await DOCS_COL().updateOne(
        { fileName: baseName },
        { $set: { fileName: baseName, displayName: docDisplayName, storageUrl, updatedAt: new Date() } },
        { upsert: true }
      );
      return res.json({ success: true, files: [baseName] });
    }

    // PDF → extract all pages with pdftoppm
    const tmpIn  = path.join("/tmp", `upload_${Date.now()}.pdf`);
    const tmpOut = path.join("/tmp", `upload_${Date.now()}`);
    fs.writeFileSync(tmpIn, req.file.buffer);

    await new Promise((resolve, reject) => {
      exec(`pdftoppm -r 200 -png "${tmpIn}" "${tmpOut}"`, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const pages = fs.readdirSync("/tmp")
      .filter(f => f.startsWith(path.basename(tmpOut)) && f.endsWith(".png"))
      .sort();

    const savedFiles = [];
    const baseName = (displayName?.trim() || "doc").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    for (let i = 0; i < pages.length; i++) {
      const suffix   = pages.length === 1 ? "" : `_${i + 1}`;
      const fileName = `${baseName}${suffix}.png`;
      const dest     = path.join(PDF_PAGES_DIR, fileName);
      fs.copyFileSync(path.join("/tmp", pages[i]), dest);
      savedFiles.push(fileName);
      // Always register in DB so the file appears in /available on both servers
      const docName = displayName?.trim()
        ? (pages.length === 1 ? displayName.trim() : `${displayName.trim()} (${i + 1})`)
        : fileName.replace(".png", "").replace(/_/g, " ");
      const pngBuf = fs.readFileSync(dest);
      const pdfStorageResult = await uploadImage(`contract-pages/${fileName}`, pngBuf, "image/png").catch(() => null);
      await DOCS_COL().updateOne(
        { fileName },
        { $set: { fileName, displayName: docName, storageUrl: pdfStorageResult?.publicUrl || null, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    // Cleanup tmp
    try { fs.unlinkSync(tmpIn); pages.forEach(p => fs.unlinkSync(path.join("/tmp", p))); } catch {}
    res.json({ success: true, files: savedFiles });
  } catch (err) {
    console.error("[contract-pages] upload:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── PUT /available/:file/replace — overwrite file with new upload ────────── */
exports.replaceDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "לא התקבל קובץ" });
    const { file } = req.params;

    const dest = path.join(PDF_PAGES_DIR, file);
    if (!fs.existsSync(dest)) return res.status(404).json({ error: "קובץ לא קיים" });

    if (req.file.mimetype === "image/png") {
      fs.writeFileSync(dest, req.file.buffer);
      const replaceStorage = await uploadImage(`contract-pages/${file}`, req.file.buffer, "image/png").catch(() => null);
      if (replaceStorage?.publicUrl) {
        await DOCS_COL().updateOne({ fileName: file }, { $set: { storageUrl: replaceStorage.publicUrl, updatedAt: new Date() } });
      }
      return res.json({ success: true });
    }

    // PDF — extract first page only and replace the target file
    const tmpIn  = path.join("/tmp", `replace_${Date.now()}.pdf`);
    const tmpOut = path.join("/tmp", `replace_out_${Date.now()}`);
    fs.writeFileSync(tmpIn, req.file.buffer);

    await new Promise((resolve, reject) => {
      exec(`pdftoppm -r 200 -png -f 1 -l 1 "${tmpIn}" "${tmpOut}"`, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const pages = fs.readdirSync("/tmp")
      .filter(f => f.startsWith(path.basename(tmpOut)) && f.endsWith(".png"))
      .sort();

    if (pages.length === 0) throw new Error("לא ניתן לחלץ דף מה-PDF");
    fs.copyFileSync(path.join("/tmp", pages[0]), dest);
    try { fs.unlinkSync(tmpIn); pages.forEach(p => fs.unlinkSync(path.join("/tmp", p))); } catch {}
    const replacedBuf = fs.readFileSync(dest);
    const replacePdfStorage = await uploadImage(`contract-pages/${file}`, replacedBuf, "image/png").catch(() => null);
    if (replacePdfStorage?.publicUrl) {
      await DOCS_COL().updateOne({ fileName: file }, { $set: { storageUrl: replacePdfStorage.publicUrl, updatedAt: new Date() } });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[contract-pages] replace:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── DELETE /available/:file — remove PNG from disk + DB + all rules ─────── */
exports.deleteDocument = async (req, res) => {
  try {
    const { file } = req.params;
    const dest = path.join(PDF_PAGES_DIR, file);

    // Delete from local disk (may not exist on this server — that's ok)
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}

    // Delete display name record
    await DOCS_COL().deleteOne({ fileName: file });

    // Remove page from every rule that references it
    await RULES_COL().updateMany({ pages: file }, { $pull: { pages: file } });
    // Clean up rules that are now empty
    await RULES_COL().deleteMany({ pages: { $size: 0 } });

    res.json({ success: true });
  } catch (err) {
    console.error("[contract-pages] delete:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /storage — list all contract_doc_names with storageUrl ─────────── */
exports.storageList = async (req, res) => {
  try {
    const atlasDb = DB._fallbackDb || getDB();
    const docs = await atlasDb.collection("contract_doc_names")
      .find({})
      .sort({ fileName: 1 })
      .toArray();
    res.json(docs.map(d => ({
      _id:         d._id,
      fileName:    d.fileName,
      displayName: d.displayName || d.fileName.replace(".png", "").replace(/_/g, " "),
      storageUrl:  d.storageUrl || null,
      updatedAt:   d.updatedAt  || null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── POST /sync-to-backblaze — upload all local PNG pages to Backblaze ────── */
// Run this from the AWS server to register storageUrls for all local files.
// After running, Heroku will redirect missing files to Backblaze automatically.
exports.syncToBackblaze = async (req, res) => {
  try {
    const files = fs.existsSync(PDF_PAGES_DIR)
      ? fs.readdirSync(PDF_PAGES_DIR).filter(f => f.endsWith(".png"))
      : [];

    if (files.length === 0) {
      return res.json({ synced: 0, skipped: 0, failed: 0, message: "No local PNG files found" });
    }

    let synced = 0, skipped = 0, failed = 0;
    const results = [];

    for (const fileName of files) {
      try {
        // Skip if already has a storageUrl
        const existing = await DOCS_COL().findOne({ fileName, storageUrl: { $exists: true, $ne: null } });
        if (existing?.storageUrl) { skipped++; results.push({ fileName, status: "skipped" }); continue; }

        const buf = fs.readFileSync(path.join(PDF_PAGES_DIR, fileName));
        const upload = await uploadImage(`contract-pages/${fileName}`, buf, "image/png");
        if (!upload?.publicUrl) { failed++; results.push({ fileName, status: "upload_failed" }); continue; }

        await DOCS_COL().updateOne(
          { fileName },
          { $set: { fileName, storageUrl: upload.publicUrl, updatedAt: new Date() } },
          { upsert: true }
        );
        synced++;
        results.push({ fileName, status: "synced", url: upload.publicUrl });
      } catch (err) {
        failed++;
        results.push({ fileName, status: "error", error: err.message });
      }
    }

    res.json({ synced, skipped, failed, results });
  } catch (err) {
    console.error("[contract-pages] syncToBackblaze:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /products ──────────────────────────────────────────────────────── */
exports.products = async (req, res) => {
  try {
    const catalogItems = await getDB()
      .collection("cpanel_products")
      .find({ kind: "item", active: { $ne: false } })
      .sort({ sortOrder: 1 })
      .toArray();
    const seen = new Set();
    const result = [];
    for (const item of catalogItems) {
      seen.add(item.key);
      result.push({ key: item.key, label: item.label, emoji: item.emoji || "" });
    }
    for (const def of DEFAULT_PRODUCTS) {
      if (!seen.has(def.key)) result.push(def);
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── POST /products — create new product ────────────────────────────────── */
exports.createProduct = async (req, res) => {
  try {
    const { key, label, emoji } = req.body;
    if (!key?.trim() || !label?.trim()) return res.status(400).json({ error: "key ו-label נדרשים" });
    const cleanKey = key.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
    if (!cleanKey) return res.status(400).json({ error: "key לא תקין" });
    const col = getDB().collection("cpanel_products");
    const existing = await col.findOne({ key: cleanKey });
    if (existing) {
      if (existing.active === false) {
        await col.updateOne({ key: cleanKey }, { $set: { label: label.trim(), emoji: emoji || "", active: true, updatedAt: new Date() } });
        return res.json({ success: true, key: cleanKey });
      }
      return res.status(409).json({ error: "מוצר עם key זה כבר קיים" });
    }
    const maxOrder = await col.find({ kind: "item" }).sort({ sortOrder: -1 }).limit(1).toArray();
    const sortOrder = maxOrder.length ? (maxOrder[0].sortOrder || 0) + 10 : 10;
    await col.insertOne({ key: cleanKey, label: label.trim(), emoji: emoji || "", kind: "item", active: true, sortOrder, createdAt: new Date(), updatedAt: new Date() });
    res.json({ success: true, key: cleanKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── PUT /products/:key — update label + emoji ──────────────────────────── */
exports.updateProduct = async (req, res) => {
  try {
    const { key } = req.params;
    const { label, emoji } = req.body;
    if (!label?.trim()) return res.status(400).json({ error: "label נדרש" });
    await getDB().collection("cpanel_products").updateOne(
      { key },
      { $set: { label: label.trim(), emoji: emoji || "", updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── DELETE /products/:key — soft-delete ────────────────────────────────── */
exports.deleteProduct = async (req, res) => {
  try {
    const { key } = req.params;
    await getDB().collection("cpanel_products").updateOne(
      { key },
      { $set: { active: false, updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── GET /rules — auto-seeds defaults if collection is empty ─────────────── */
// Uses upsert (not insertMany) so seeding is idempotent across both servers.
// IMPORTANT: only seeds when BOTH primary AND Atlas have 0 rules.
// If Atlas has rules but AWS is empty (sync gap), we skip seeding so we don't
// re-create deleted defaults — they'll come back from Atlas on next read.
exports.listRules = async (req, res) => {
  try {
    const count = await RULES_COL().countDocuments();
    if (count === 0) {
      // Check Atlas before seeding — avoid restoring deleted rules due to sync gap.
      // If Atlas has rules but AWS is empty, skip seeding so user's custom rules survive.
      const atlasCount = DB._fallbackDb
        ? await DB._fallbackDb.collection("contract_rules").countDocuments().catch(() => 0)
        : 0;
      if (atlasCount === 0) {
        // Both DBs are genuinely empty — safe to seed defaults
        const now = new Date();
        await Promise.all(
          DEFAULT_RULES.map((r, i) =>
            RULES_COL().updateOne(
              { seeded: true, conditions: r.conditions },
              { $setOnInsert: { ...r, priority: i + 1, createdAt: now, seeded: true } },
              { upsert: true }
            )
          )
        );
      }
    }
    // Always read from Atlas (source of truth) so admin sees latest state from both servers
    const atlasDb = DB._fallbackDb || getDB();
    const rules = await atlasDb.collection("contract_rules").find({}).sort({ priority: 1, createdAt: 1 }).toArray();
    res.json(rules);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── POST /rules ─────────────────────────────────────────────────────────── */
exports.createRule = async (req, res) => {
  try {
    const { name, conditions, pages, priority } = req.body;
    if (!Array.isArray(conditions) || conditions.length === 0)
      return res.status(400).json({ error: "conditions required" });
    if (!Array.isArray(pages) || pages.length === 0)
      return res.status(400).json({ error: "pages required" });
    const doc = { name: name?.trim() || "", conditions: conditions.filter(Boolean), pages: pages.filter(Boolean), priority: Number(priority) || 10, createdAt: new Date() };
    const result = await RULES_COL().insertOne(doc);
    res.json({ success: true, _id: result.insertedId });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── PUT /rules/:id ─────────────────────────────────────────────────────── */
exports.updateRule = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const { name, conditions, pages, priority } = req.body;
    await RULES_COL().updateOne(
      { _id: new ObjectId(id) },
      { $set: { name: name?.trim() || "", conditions: (conditions || []).filter(Boolean), pages: (pages || []).filter(Boolean), priority: Number(priority) || 10, updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── DELETE /rules/:id ──────────────────────────────────────────────────── */
exports.deleteRule = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    await RULES_COL().deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── Portfolio (works catalog) ──────────────────────────────────────────── */
const PORTFOLIO_COL = () => getDB().collection("portfolio_websites");

/* GET /portfolio — public list, newest first */
exports.listPortfolio = async (req, res) => {
  try {
    const items = await PORTFOLIO_COL().find({}).sort({ createdAt: -1 }).toArray();
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* GET /portfolio/site-screenshot?url=...&force=1
   Returns a cached full-page PNG screenshot of `url`. First request for
   a URL kicks off Puppeteer (~5-15s); subsequent requests serve from
   disk instantly. `?force=1` re-captures even if cached. */
const { getScreenshot } = require("../services/site-screenshot.service");
exports.siteScreenshot = async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    const force = req.query.force === "1";
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "valid url required" });
    const buf = await getScreenshot(url, { force });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    console.error("[site-screenshot] error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* POST /portfolio — add { title?, url } */
exports.addPortfolio = async (req, res) => {
  try {
    const { title, url } = req.body;
    if (!url?.trim()) return res.status(400).json({ error: "url required" });
    const cleanUrl = url.trim().startsWith("http") ? url.trim() : `https://${url.trim()}`;
    const result = await PORTFOLIO_COL().insertOne({
      title: title?.trim() || cleanUrl,
      url: cleanUrl,
      createdAt: new Date(),
    });
    res.json({ success: true, _id: result.insertedId });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* DELETE /portfolio/:id */
exports.deletePortfolio = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    await PORTFOLIO_COL().deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
