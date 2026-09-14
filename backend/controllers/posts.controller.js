const { DB } = require("../config/db");
const { ObjectId } = require("mongodb");

const posts = () => DB.collection("posts");

// GET /api/leads/posts?page_id=XXX
// מחזיר את כל הפוסטים בסטטוס draft עבור ה-pageId
exports.getDraftPosts = async (req, res) => {
  console.log("📋 [Posts] Get draft posts requested");
  try {
    const { page_id } = req.query;

    if (!page_id) {
      return res.status(400).json({ error: "page_id is required" });
    }

    const results = await posts()
      .find({ page_id, status: "draft" })
      .sort({ created_at: -1 })
      .toArray();

    console.log(`✅ [Posts] Found ${results.length} draft posts for page ${page_id}`);
    res.json({ success: true, data: results });
  } catch (error) {
    console.error("❌ [Posts] Error fetching draft posts:", error.message);
    res.status(500).json({ error: "Failed to fetch posts", details: error.message });
  }
};

// PATCH /api/leads/posts/:id/execute
// מעביר פוסט מ-draft ל-executed - פעולה חד-כיוונית, ללא גוף תגובה
exports.executePost = async (req, res) => {
  console.log("🚀 [Posts] Execute post requested");
  try {
    const { id } = req.params;
    const { page_id } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Post ID is required" });
    }

    const query = { _id: new ObjectId(id) };
    if (page_id) query.page_id = page_id;

    const result = await posts().updateOne(query, {
      $set: { status: "executed", executed_at: new Date(), updated_at: new Date() },
    });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Post not found or page_id mismatch" });
    }

    console.log(`✅ [Posts] Post executed: ${id}`);
    res.status(204).send();
  } catch (error) {
    console.error("❌ [Posts] Error executing post:", error.message);
    res.status(500).json({ error: "Failed to execute post", details: error.message });
  }
};

// PUT /api/leads/posts/:id
// עדכון פוסט קיים לפי _id ו-page_id
exports.updatePost = async (req, res) => {
  console.log("✏️ [Posts] Update post requested");
  try {
    const { id } = req.params;
    const { page_id, job_id, campaign, ad_set, ads, campaign_settings, status } = req.body;

    if (!page_id) {
      return res.status(400).json({ success: false, message: "page_id is required" });
    }

    const fields = { updated_at: new Date() };
    if (job_id !== undefined)            fields.job_id            = job_id;
    if (campaign !== undefined)          fields.campaign          = campaign;
    if (ad_set !== undefined)            fields.ad_set            = ad_set;
    if (ads !== undefined)               fields.ads               = ads;
    if (campaign_settings !== undefined) fields.campaign_settings = campaign_settings;
    if (status !== undefined)            fields.status            = status;

    const result = await posts().findOneAndUpdate(
      { _id: new ObjectId(id), page_id },
      { $set: fields },
      { returnDocument: "after" },
    );

    if (!result) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    console.log(`✅ [Posts] Post updated: ${id}`);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("❌ [Posts] Error updating post:", error.message);
    res.status(500).json({ success: false, message: "Failed to update post", details: error.message });
  }
};

// DELETE /api/leads/posts/:id?page_id=XXX
// מחיקת טיוטה (draft) בלבד — לא ניתן למחוק פוסט שבוצע
exports.deletePost = async (req, res) => {
  console.log("🗑️ [Posts] Delete post requested");
  try {
    const { id } = req.params;
    const { page_id } = req.query;

    if (!id || !page_id) {
      return res.status(400).json({ error: "Post ID and page_id are required" });
    }

    const result = await posts().deleteOne({
      _id: new ObjectId(id),
      page_id,
      status: "draft",
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Post not found, already executed, or page_id mismatch" });
    }

    console.log(`✅ [Posts] Post deleted: ${id}`);
    res.status(204).send();
  } catch (error) {
    console.error("❌ [Posts] Error deleting post:", error.message);
    res.status(500).json({ error: "Failed to delete post", details: error.message });
  }
};

// POST /api/leads/posts
// שומר פוסט חדש לפי page_id עם סטטוס draft
exports.savePost = async (req, res) => {
  console.log("💾 [Posts] Save post requested");
  try {
    const { page_id, campaign, ad_set, ads, campaign_settings, form } = req.body;

    if (!page_id) {
      return res.status(400).json({ error: "page_id is required" });
    }

    const doc = {
      page_id,
      status: "draft",
      campaign: campaign || null,
      ad_set: ad_set || null,
      ads: ads || [],
      campaign_settings: campaign_settings || null,
      form: form || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const result = await posts().insertOne(doc);

    console.log(`✅ [Posts] Post saved with ID: ${result.insertedId} for page ${page_id}`);
    res.status(201).json({ success: true, data: { _id: result.insertedId, ...doc } });
  } catch (error) {
    console.error("❌ [Posts] Error saving post:", error.message);
    res.status(500).json({ error: "Failed to save post", details: error.message });
  }
};
