const multer = require("multer");
const axios = require("axios");
const DB = require("../utils/DB");
const driveService = require("../services/google-drive.service");
const {
  getMasterByPhone,
  updateMasterStatus,
  updateMasterCopy,
} = require("../services/fireberry-master.service");

// ─── Multer (memory) for product image upload ────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Make.com webhook for AI creative editing (Gemini).
// Create a new Make scenario that accepts: { imageUrl, feedback } and returns { resultImageUrl }
const GEMINI_EDIT_WEBHOOK_URL = process.env.GEMINI_EDIT_WEBHOOK_URL || "";

const COLLECTION = "master_edit_attempts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** מחזיר את ה-folderId של תיקיית "לקמפיינר" של הלקוח */
const getMasterParentFolder = async (phone) => {
  const clientFolders = await driveService.searchFolders(phone);
  if (clientFolders.length === 0) throw new Error(`No Drive folder found for ${phone}`);
  const clientFolderId = clientFolders[0].id;
  const campaignFolderId = await driveService.findSubfolder(clientFolderId, "לקמפיינר");
  if (!campaignFolderId) throw new Error(`Subfolder "לקמפיינר" not found for ${phone}`);
  return campaignFolderId;
};

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/master/:phone
 * מחזיר: { id, statuscode, copy: [...] }
 * כשstatus=6 ו-image_conected חסר — ממלא אוטומטית מ-Drive (נוי מאשרת)
 */
exports.getMaster = async (req, res) => {
  try {
    const { phone } = req.params;
    const master = await getMasterByPhone(phone);
    if (!master) {
      return res.status(404).json({ success: false, error: "Master record not found" });
    }

    // Status 6: if copy items are missing image_conected, pull from Drive
    if (master.statuscode === 6 && Array.isArray(master.copy) && master.copy.length > 0) {
      const hasImages = master.copy.some((c) => c.image_conected);
      if (!hasImages) {
        try {
          const driveImages = await driveService.getClientImagesFromPath(phone, ["לקמפיינר", "נוי מאשרת"]);
          if (driveImages.length > 0) {
            console.log(`🎨 [Master] Enriching ${master.copy.length} copy items with ${driveImages.length} Drive images`);
            master.copy = master.copy.map((item, idx) => {
              const img = driveImages[idx];
              if (img) {
                return { ...item, image_conected: `https://lh3.googleusercontent.com/d/${img.id}=w800` };
              }
              return item;
            });
          }
        } catch (driveErr) {
          console.warn("⚠️ [Master] Drive image enrichment failed:", driveErr.message);
        }
      }
    }

    return res.json({ success: true, ...master });
  } catch (error) {
    console.error("❌ [Master] getMaster error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PUT /api/master/:phone/status
 * body: { masterId, statusCode }
 */
exports.updateStatus = async (req, res) => {
  const { masterId, statusCode } = req.body;
  if (!masterId || statusCode == null) {
    return res.status(400).json({ success: false, error: "masterId and statusCode required" });
  }
  try {
    await updateMasterStatus(masterId, statusCode);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [Master] updateStatus error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PUT /api/master/:phone/copy
 * body: { masterId, copy: [...], moveToStatus8?: boolean }
 * מעדכן pcfsystemfield128 ואם moveToStatus8=true גם מעביר ל-status 8.
 */
exports.updateCopy = async (req, res) => {
  const { masterId, copy, moveToStatus8 } = req.body;
  if (!masterId || !Array.isArray(copy)) {
    return res.status(400).json({ success: false, error: "masterId and copy array required" });
  }
  try {
    await updateMasterCopy(masterId, copy);
    if (moveToStatus8) {
      await updateMasterStatus(masterId, 8);
    }
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [Master] updateCopy error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/master/:phone/upload-image
 * multipart/form-data: image file
 * מעלה תמונת מוצר ל-Drive ומחזיר את ה-URL.
 */
exports.uploadImageMiddleware = upload.single("image");

exports.uploadImage = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, error: "image file required" });
    }

    const parentFolderId = await getMasterParentFolder(phone);
    const filename = `product_image_${Date.now()}.${req.file.mimetype.split("/")[1] || "jpg"}`;

    const uploaded = await driveService.uploadFile(
      parentFolderId,
      filename,
      req.file.buffer,
      req.file.mimetype,
    );

    const url = `https://lh3.googleusercontent.com/d/${uploaded.id}=w800`;
    return res.json({ success: true, url, fileId: uploaded.id });
  } catch (error) {
    console.error("❌ [Master] uploadImage error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/master/:phone/creative-edit
 * body: { masterId, adIndex, imageUrl, feedback }
 *
 * שולח לגימיני לעריכה → מעלה תוצאה ל-Drive → מעדכן image_conected + edit_attempts.
 * אם edit_attempts >= 2 — מעביר ל-status 12.
 */
exports.creativeEdit = async (req, res) => {
  const { phone } = req.params;
  const { masterId, adIndex, imageUrl, feedback } = req.body;

  if (!masterId || adIndex == null || !imageUrl || !feedback) {
    return res.status(400).json({ success: false, error: "masterId, adIndex, imageUrl, feedback required" });
  }

  try {
    // 1. שלוף את הקופי הנוכחי מ-Fireberry
    const master = await getMasterByPhone(phone);
    if (!master || !master.copy) {
      return res.status(404).json({ success: false, error: "Master record not found" });
    }

    const copy = [...master.copy];
    const item = copy[adIndex];
    if (!item) {
      return res.status(400).json({ success: false, error: `No ad at index ${adIndex}` });
    }

    const currentAttempts = item.edit_attempts || 0;

    if (currentAttempts >= 2) {
      // כבר הגיע ל-2 ניסיונות - שלח ל-12
      await updateMasterStatus(masterId, 12);
      return res.json({ success: false, maxAttemptsReached: true, movedToStatus12: true });
    }

    // 2. שלח ל-Gemini webhook לעריכה
    if (!GEMINI_EDIT_WEBHOOK_URL) {
      console.warn("[Master] GEMINI_EDIT_WEBHOOK_URL not set — returning placeholder");
      return res.status(503).json({ success: false, error: "Gemini edit webhook not configured" });
    }

    console.log(`🎨 [Master] Sending creative edit to Gemini, adIndex=${adIndex}`);
    const webhookRes = await axios.post(
      GEMINI_EDIT_WEBHOOK_URL,
      { imageUrl, feedback, phone },
      { timeout: 60000 },
    );

    const resultImageUrl = webhookRes.data?.resultImageUrl || webhookRes.data?.url || null;
    if (!resultImageUrl) {
      throw new Error("Gemini webhook did not return a result image URL");
    }

    // 3. הורד את התמונה החדשה ועלה ל-Drive
    const imageResponse = await axios.get(resultImageUrl, { responseType: "arraybuffer", timeout: 30000 });
    const buffer = Buffer.from(imageResponse.data);
    const parentFolderId = await getMasterParentFolder(phone);
    const filename = `ad_edit_${adIndex}_${Date.now()}.png`;
    const uploaded = await driveService.uploadFile(parentFolderId, filename, buffer, "image/png");
    const newImageUrl = `https://lh3.googleusercontent.com/d/${uploaded.id}=w800`;

    // 4. עדכן edit_attempts ו-image_conected בקופי
    const newAttempts = currentAttempts + 1;
    copy[adIndex] = { ...item, image_conected: newImageUrl, edit_attempts: newAttempts };
    await updateMasterCopy(masterId, copy);

    // 5. אם הגיע ל-2 ניסיונות → status 12
    if (newAttempts >= 2) {
      await updateMasterStatus(masterId, 12);
      return res.json({
        success: true,
        newImageUrl,
        attemptsLeft: 0,
        maxAttemptsReached: true,
        movedToStatus12: true,
      });
    }

    return res.json({
      success: true,
      newImageUrl,
      attemptsLeft: 2 - newAttempts,
      maxAttemptsReached: false,
    });
  } catch (error) {
    console.error("❌ [Master] creativeEdit error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};
