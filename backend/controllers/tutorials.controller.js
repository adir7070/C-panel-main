const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");

const categories = () => getDB().collection("tutorial_categories");
const videos     = () => getDB().collection("tutorials");

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

function serializeCategory(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    sortOrder: doc.sortOrder ?? 0,
    createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
  };
}

function serializeVideo(doc) {
  return {
    id: doc._id.toString(),
    categoryId: doc.categoryId ? doc.categoryId.toString() : null,
    title: doc.title,
    description: doc.description || null,
    videoUrl: doc.videoUrl,
    sortOrder: doc.sortOrder ?? 0,
    createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
  };
}

// GET /api/tutorials — public, returns categories + videos grouped
exports.getAll = async (req, res) => {
  try {
    const cats = await categories().find({}).sort({ sortOrder: 1, createdAt: 1 }).toArray();
    const vids = await videos().find({}).sort({ sortOrder: 1, createdAt: 1 }).toArray();

    const result = cats.map((cat) => ({
      ...serializeCategory(cat),
      videos: vids
        .filter((v) => v.categoryId && v.categoryId.toString() === cat._id.toString())
        .map(serializeVideo),
    }));

    // Uncategorized videos (no valid categoryId)
    const catIds = new Set(cats.map((c) => c._id.toString()));
    const uncategorized = vids.filter(
      (v) => !v.categoryId || !catIds.has(v.categoryId.toString())
    );
    if (uncategorized.length) {
      result.push({ id: null, name: "כללי", sortOrder: 9999, videos: uncategorized.map(serializeVideo) });
    }

    res.json({ categories: result });
  } catch (err) {
    console.error("[Tutorials] getAll:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Categories ───────────────────────────────────────────────────────────────

exports.adminGetCategories = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const cats = await categories().find({}).sort({ sortOrder: 1, createdAt: 1 }).toArray();
    res.json({ categories: cats.map(serializeCategory) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.adminCreateCategory = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { name, sortOrder } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: "שם קטגוריה חובה" });
  try {
    const doc = { name: name.trim(), sortOrder: Number(sortOrder) || 0, createdAt: new Date() };
    const result = await categories().insertOne(doc);
    res.json({ success: true, category: serializeCategory({ ...doc, _id: result.insertedId }) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.adminUpdateCategory = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { id } = req.params;
  const { name, sortOrder } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: "שם קטגוריה חובה" });
  try {
    await categories().updateOne(
      { _id: new ObjectId(id) },
      { $set: { name: name.trim(), sortOrder: Number(sortOrder) || 0 } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.adminDeleteCategory = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { id } = req.params;
  try {
    await categories().deleteOne({ _id: new ObjectId(id) });
    // Nullify categoryId on orphaned videos
    await videos().updateMany({ categoryId: new ObjectId(id) }, { $unset: { categoryId: "" } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Videos ───────────────────────────────────────────────────────────────────

exports.adminGetVideos = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const vids = await videos().find({}).sort({ sortOrder: 1, createdAt: 1 }).toArray();
    res.json({ videos: vids.map(serializeVideo) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.adminCreateVideo = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { categoryId, title, description, videoUrl, sortOrder } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: "כותרת חובה" });
  if (!videoUrl?.trim()) return res.status(400).json({ message: "קישור סרטון חובה" });
  try {
    const doc = {
      categoryId: categoryId ? new ObjectId(categoryId) : null,
      title: title.trim(),
      description: description?.trim() || null,
      videoUrl: videoUrl.trim(),
      sortOrder: Number(sortOrder) || 0,
      createdAt: new Date(),
    };
    const result = await videos().insertOne(doc);
    res.json({ success: true, video: serializeVideo({ ...doc, _id: result.insertedId }) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.adminUpdateVideo = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { id } = req.params;
  const { categoryId, title, description, videoUrl, sortOrder } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: "כותרת חובה" });
  if (!videoUrl?.trim()) return res.status(400).json({ message: "קישור סרטון חובה" });
  try {
    await videos().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          categoryId: categoryId ? new ObjectId(categoryId) : null,
          title: title.trim(),
          description: description?.trim() || null,
          videoUrl: videoUrl.trim(),
          sortOrder: Number(sortOrder) || 0,
        },
      }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.adminDeleteVideo = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { id } = req.params;
  try {
    await videos().deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
