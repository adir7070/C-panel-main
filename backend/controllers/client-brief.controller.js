const { DB } = require("../config/db");

// Database helper
const briefs = () => DB.collection("client_briefs");

// Normalize phone → 05XXXXXXXX
const normalizePhone = (phone) => {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
};

// ─────────────────────────────────────────────
// Upsert brief (create or update by pageId OR phone)
// Merges incoming answers with existing ones
// ─────────────────────────────────────────────
exports.upsertBrief = async (req, res) => {
  console.log("📝 [ClientBrief] Upsert requested");
  try {
    let { pageId, stepId, answers, completedSteps, clientName, phone } =
      req.body;

    if (!pageId && !phone) {
      return res.status(400).json({ error: "pageId or phone is required" });
    }

    // If both pageId and phone provided, merge any orphaned phone-only document
    if (pageId && phone) {
      const phoneBrief = await briefs().findOne({ phone, pageId: { $exists: false } });
      if (phoneBrief) {
        console.log(`🔄 [ClientBrief] Merging phone-only doc for ${phone} into pageId ${pageId}`);
        answers = { ...(phoneBrief.answers || {}), ...(answers || {}) };
        completedSteps = [...new Set([...(phoneBrief.completedSteps || []), ...(completedSteps || [])])];
        if (!clientName && phoneBrief.clientName) clientName = phoneBrief.clientName;
        await briefs().deleteOne({ _id: phoneBrief._id });
      }
    }

    // Build query filter: phone first (stable identifier), then pageId
    let filter;
    if (phone) {
      filter = { phone };
    } else {
      filter = { pageId };
    }

    const now = new Date();

    // Read existing doc so we can deep-merge answers
    const existing = await briefs().findOne(filter);
    const mergedAnswers = { ...(existing?.answers || {}), ...(answers || {}) };
    const mergedSteps =
      completedSteps && completedSteps.length
        ? [...new Set([...(existing?.completedSteps || []), ...completedSteps])]
        : existing?.completedSteps || [];

    const result = await briefs().findOneAndUpdate(
      filter,
      {
        $set: {
          answers: mergedAnswers,
          completedSteps: mergedSteps,
          ...(clientName && { clientName }),
          ...(phone && { phone }),
          ...(pageId && { pageId }),
          ...(stepId && { currentStep: stepId }),
          totalSteps: 10,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );

    const identifier = pageId || phone;
    console.log(
      `✅ [ClientBrief] Brief saved for ${pageId ? "page" : "phone"} ${identifier} (step ${stepId || "N/A"}, keys: ${Object.keys(mergedAnswers).length})`,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("❌ [ClientBrief] Error upserting brief:", error.message);
    res
      .status(500)
      .json({ error: "Failed to save brief", details: error.message });
  }
};

// ─────────────────────────────────────────────
// Get brief by pageId
// ─────────────────────────────────────────────
exports.getBrief = async (req, res) => {
  console.log("🔍 [ClientBrief] Get brief requested");
  try {
    const { pageId } = req.params;

    if (!pageId) {
      return res.status(400).json({ error: "pageId is required" });
    }

    const brief = await briefs().findOne({ pageId });

    if (!brief) {
      return res.status(404).json({ error: "Brief not found" });
    }

    console.log(`✅ [ClientBrief] Brief found for page ${pageId}`);
    res.json({ success: true, data: brief });
  } catch (error) {
    console.error("❌ [ClientBrief] Error fetching brief:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch brief", details: error.message });
  }
};

// ─────────────────────────────────────────────
// Get brief by phone
// ─────────────────────────────────────────────
exports.getBriefByPhone = async (req, res) => {
  console.log("🔍 [ClientBrief] Get brief by phone requested");
  try {
    const { phone } = req.params;

    if (!phone) {
      return res.status(400).json({ error: "phone is required" });
    }

    const brief = await briefs().findOne({ phone });

    if (!brief) {
      return res.status(404).json({ error: "Brief not found" });
    }

    console.log(`✅ [ClientBrief] Brief found for phone ${phone}`);
    res.json({ success: true, data: brief });
  } catch (error) {
    console.error(
      "❌ [ClientBrief] Error fetching brief by phone:",
      error.message,
    );
    res
      .status(500)
      .json({ error: "Failed to fetch brief", details: error.message });
  }
};

// ─────────────────────────────────────────────
// Update brief answers (admin)
// ─────────────────────────────────────────────
exports.updateBrief = async (req, res) => {
  console.log("✏️ [ClientBrief] Update brief requested");
  try {
    const { ObjectId } = require("mongodb");
    const { id } = req.params;
    const { answers, completedSteps, clientName, phone } = req.body;

    const update = { updatedAt: new Date() };
    if (answers) update.answers = answers;
    if (completedSteps) update.completedSteps = completedSteps;
    if (clientName !== undefined) update.clientName = clientName;
    if (phone !== undefined) update.phone = phone;

    const result = await briefs().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: update },
      { returnDocument: "after" },
    );

    if (!result) {
      return res.status(404).json({ error: "Brief not found" });
    }

    console.log(`✅ [ClientBrief] Brief ${id} updated`);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("❌ [ClientBrief] Error updating brief:", error.message);
    res
      .status(500)
      .json({ error: "Failed to update brief", details: error.message });
  }
};

// ─────────────────────────────────────────────
// Delete brief (admin)
// ─────────────────────────────────────────────
exports.deleteBrief = async (req, res) => {
  console.log("🗑️ [ClientBrief] Delete brief requested");
  try {
    const { ObjectId } = require("mongodb");
    const { id } = req.params;

    const result = await briefs().deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Brief not found" });
    }

    console.log(`✅ [ClientBrief] Brief ${id} deleted`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [ClientBrief] Error deleting brief:", error.message);
    res
      .status(500)
      .json({ error: "Failed to delete brief", details: error.message });
  }
};

// ─────────────────────────────────────────────
// Push a snake-process status update by phone
// ─────────────────────────────────────────────
exports.addSnakeStatus = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const { status, shortmsg } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    const now = new Date();
    const entry = { status, shortmsg, receivedAt: now };

    const result = await briefs().findOneAndUpdate(
      { phone },
      {
        $push: { msgs: entry },
        $set: { updatedAt: now },
        $setOnInsert: { phone, createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );

    console.log(
      `✅ [ClientBrief] Snake status "${status}" pushed for phone ${phone}`,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("❌ [ClientBrief] Error adding snake status:", error.message);
    res
      .status(500)
      .json({ error: "Failed to add status", details: error.message });
  }
};

// ─────────────────────────────────────────────
// Get msgs array by phone
// ─────────────────────────────────────────────
exports.getMsgsByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const brief = await briefs().findOne(
      { phone },
      { projection: { msgs: 1 } },
    );
    if (!brief) {
      return res.status(404).json({ error: "Brief not found" });
    }

    console.log(`✅ [ClientBrief] msgs fetched for phone ${phone}`);
    res.json({ success: true, data: brief.msgs || [] });
  } catch (error) {
    console.error("❌ [ClientBrief] Error fetching msgs:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch msgs", details: error.message });
  }
};

// ─────────────────────────────────────────────
// Get all briefs (admin dashboard)
// ─────────────────────────────────────────────
exports.getAllBriefs = async (req, res) => {
  console.log("📋 [ClientBrief] Get all briefs requested");
  try {
    const { limit = 50, skip = 0, search } = req.query;

    // Build filter: server-side search on phone, clientName, pageId,
    // and the common business-name locations inside `answers` (the
    // brief data is mostly nested under step keys, so a plain clientName
    // search misses anything where only answers.business_name is set).
    let filter = {};
    if (search && search.trim()) {
      const q = search.trim();
      const regex = { $regex: q, $options: "i" };
      filter = {
        $or: [
          { phone: regex },
          { clientName: regex },
          { pageId: regex },
          { "answers.business_name": regex },
          { "answers.1.businessName": regex },
          { "answers.1.clientData.businessName": regex },
          { "answers.1.clientData.business_name": regex },
        ],
      };
    }

    const data = await briefs()
      .find(filter)
      .sort({ updatedAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();

    const total = await briefs().countDocuments(filter);

    console.log(`✅ [ClientBrief] Found ${data.length} briefs`);
    res.json({
      success: true,
      data,
      pagination: { total, limit: parseInt(limit), skip: parseInt(skip) },
    });
  } catch (error) {
    console.error("❌ [ClientBrief] Error fetching briefs:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch briefs", details: error.message });
  }
};
