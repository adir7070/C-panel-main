const DB = require("../utils/DB");

const COLLECTION = "gallery_statuses";

/**
 * GET /api/app/gallery/:phone/statuses
 * מחזיר { statuses: { [imageUrl]: "archived" | "approved" } }
 */
const getGalleryStatuses = async (req, res) => {
  try {
    const { phone } = req.params;
    const docs = await DB.collection(COLLECTION).find({ phone }).toArray();
    const statuses = {};
    for (const doc of docs) {
      statuses[doc.imageUrl] = doc.status;
    }
    return res.json({ statuses });
  } catch (error) {
    console.error("[Gallery] getGalleryStatuses error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/app/gallery/:phone/status
 * body: { imageUrl, status: "archived" | "approved" }
 */
const updateGalleryStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const { imageUrl, status } = req.body;

    if (!imageUrl || !["archived", "approved"].includes(status)) {
      return res.status(400).json({ success: false, error: "imageUrl and valid status required" });
    }

    await DB.collection(COLLECTION).updateOne(
      { phone, imageUrl },
      { $set: { phone, imageUrl, status } },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("[Gallery] updateGalleryStatus error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { getGalleryStatuses, updateGalleryStatus };
