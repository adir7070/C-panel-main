const multer = require("multer");
const { getDB } = require("../config/db");
const backblaze = require("../services/backblaze.service");
const { ObjectId } = require("mongodb");

const SERVER_BASE_URL = process.env.BASE_URL || "https://api.iconiqmedia.co.il";

const upload = multer({ storage: multer.memoryStorage() });

const col = () => getDB().collection("promotions");

// ─── Auth helper ─────────────────────────────────────────────────────────────
async function requireAdmin(req, res) {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  if (!bearer) { res.status(401).json({ message: "Unauthorized" }); return null; }
  const agent = await getDB().collection("agents").findOne({ token: bearer });
  if (!agent || agent.role !== "admin") {
    res.status(403).json({ message: "Forbidden — admin only" });
    return null;
  }
  return agent;
}

function isExpired(doc) {
  if (!doc.expiresAt) return false;
  return new Date(doc.expiresAt) < new Date();
}

function isExhausted(doc) {
  if (!doc.maxRedemptions) return false;
  return (doc.redemptionCount || 0) >= doc.maxRedemptions;
}

function serialize(doc) {
  return {
    id: doc._id.toString(),
    title: doc.title,
    description: doc.description || null,
    imageUrl: doc.imageUrl || null,
    actionType: doc.actionType || null,
    actionData: doc.actionData || {},
    isActive: !!doc.isActive,
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    maxRedemptions: doc.maxRedemptions || null,
    redemptionCount: doc.redemptionCount || 0,
    sortOrder: doc.sortOrder ?? 0,
    createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
  };
}

// GET /api/promotions — public, only active + not expired + not exhausted
exports.getActive = async (req, res) => {
  try {
    const now = new Date();
    const docs = await col()
      .find({
        isActive: true,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
      .sort({ sortOrder: 1, createdAt: -1 })
      .toArray();

    const valid = docs.filter((d) => !isExhausted(d));
    return res.json({ promotions: valid.map(serialize) });
  } catch (err) {
    console.error("[Promotions] getActive:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/promotions/admin/all — admin, all
exports.getAll = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const docs = await col().find({}).sort({ sortOrder: 1, createdAt: -1 }).toArray();
    return res.json({ promotions: docs.map(serialize) });
  } catch (err) {
    console.error("[Promotions] getAll:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/promotions/:id — public, single (for app to validate promotion before purchase)
exports.getOne = async (req, res) => {
  try {
    const doc = await col().findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!doc.isActive || isExpired(doc) || isExhausted(doc)) {
      return res.status(410).json({ message: "Promotion no longer valid" });
    }
    return res.json({ promotion: serialize(doc) });
  } catch (err) {
    console.error("[Promotions] getOne:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/promotions — admin, create (multipart/form-data)
// Fields: title, description, actionType, actionData (JSON string), isActive, expiresAt, maxRedemptions, sortOrder
// File: image
exports.create = [
  upload.single("image"),
  async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const { title, description, actionType, actionData, isActive, expiresAt, maxRedemptions, sortOrder } = req.body;
      if (!title) return res.status(400).json({ message: "title required" });

      let imageUrl = null;
      if (req.file) {
        const ext = req.file.originalname.split(".").pop().toLowerCase() || "jpg";
        const fileName = `promotions/${Date.now()}.${ext}`;
        await backblaze.uploadImage(fileName, req.file.buffer, req.file.mimetype);
        imageUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(fileName)}`;
      }

      let parsedActionData = {};
      try { parsedActionData = actionData ? JSON.parse(actionData) : {}; } catch { }

      const doc = {
        title,
        description: description || null,
        imageUrl,
        actionType: actionType || null,
        actionData: parsedActionData,
        isActive: isActive !== "false" && isActive !== false,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
        redemptionCount: 0,
        sortOrder: sortOrder !== undefined ? Number(sortOrder) : 0,
        createdAt: new Date(),
      };

      const result = await col().insertOne(doc);
      return res.json({ success: true, id: result.insertedId.toString(), promotion: serialize({ ...doc, _id: result.insertedId }) });
    } catch (err) {
      console.error("[Promotions] create:", err.message);
      res.status(500).json({ message: "Server error" });
    }
  },
];

// PUT /api/promotions/:id — admin, update (multipart/form-data)
exports.update = [
  upload.single("image"),
  async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const { id } = req.params;
      const doc = await col().findOne({ _id: new ObjectId(id) });
      if (!doc) return res.status(404).json({ message: "Not found" });

      const { title, description, actionType, actionData, isActive, expiresAt, maxRedemptions, sortOrder } = req.body;

      let imageUrl = doc.imageUrl;
      if (req.file) {
        const ext = req.file.originalname.split(".").pop().toLowerCase() || "jpg";
        const fileName = `promotions/${Date.now()}.${ext}`;
        await backblaze.uploadImage(fileName, req.file.buffer, req.file.mimetype);
        imageUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(fileName)}`;
      }

      let parsedActionData = doc.actionData || {};
      try { if (actionData !== undefined) parsedActionData = JSON.parse(actionData); } catch { }

      const $set = {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description: description || null }),
        imageUrl,
        ...(actionType !== undefined && { actionType: actionType || null }),
        actionData: parsedActionData,
        ...(isActive !== undefined && { isActive: isActive !== "false" && isActive !== false }),
        ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
        ...(maxRedemptions !== undefined && { maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null }),
        ...(sortOrder !== undefined && { sortOrder: Number(sortOrder) }),
        updatedAt: new Date(),
      };

      await col().updateOne({ _id: new ObjectId(id) }, { $set });
      const updated = await col().findOne({ _id: new ObjectId(id) });
      return res.json({ success: true, promotion: serialize(updated) });
    } catch (err) {
      console.error("[Promotions] update:", err.message);
      res.status(500).json({ message: "Server error" });
    }
  },
];

// PATCH /api/promotions/:id/toggle — admin, toggle isActive
exports.toggle = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { id } = req.params;
    const doc = await col().findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ message: "Not found" });
    await col().updateOne({ _id: new ObjectId(id) }, { $set: { isActive: !doc.isActive } });
    return res.json({ success: true, isActive: !doc.isActive });
  } catch (err) {
    console.error("[Promotions] toggle:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// DELETE /api/promotions/:id — admin
exports.remove = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await col().deleteOne({ _id: new ObjectId(req.params.id) });
    return res.json({ success: true });
  } catch (err) {
    console.error("[Promotions] remove:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/promotions/:id/redeem — internal (called from payment flow after successful purchase)
// body: { phone }
exports.redeem = async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: "phone required" });

    const doc = await col().findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!doc.isActive || isExpired(doc) || isExhausted(doc)) {
      return res.status(410).json({ message: "Promotion no longer valid" });
    }

    // Increment redemption count
    await col().updateOne({ _id: new ObjectId(id) }, { $inc: { redemptionCount: 1 } });

    // Record redemption
    await getDB().collection("promotion_redemptions").insertOne({
      promotionId: id,
      promotionTitle: doc.title,
      actionType: doc.actionType,
      actionData: doc.actionData,
      phone,
      redeemedAt: new Date(),
    });

    return res.json({ success: true, promotion: serialize({ ...doc, redemptionCount: (doc.redemptionCount || 0) + 1 }) });
  } catch (err) {
    console.error("[Promotions] redeem:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
