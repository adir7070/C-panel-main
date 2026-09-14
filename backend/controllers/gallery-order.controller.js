const { DB } = require("../config/db");
const backblazeService = require("../services/backblaze.service");

const orders = () => DB.collection("ai_creation_orders");

const normalizePhone = (phone) => {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gallery-order/submit
// Multipart form-data:
//   images[]       — image files (up to 10)
//   phone          — customer phone
//   facebook.*     — FB credentials (pageToken, pageId, pageName, userToken, adAccountId)
//   instagram.*    — IG credentials (token, id, username, name)
//   selectedDay    — Hebrew letter (א/ב/ג/ד/ה/ו/ש)
//   selectedTime   — "HH:MM"
// ─────────────────────────────────────────────────────────────────────────────
exports.submitGalleryOrder = async (req, res) => {
  try {
    const {
      phone: rawPhone,
      clientName,
      businessName,
      selectedDay,
      selectedTime,
    } = req.body;

    const facebook = {
      userToken: req.body["facebook.userToken"] ?? null,
      pageToken: req.body["facebook.pageToken"] ?? null,
      pageId: req.body["facebook.pageId"] ?? null,
      pageName: req.body["facebook.pageName"] ?? null,
      adAccountId: req.body["facebook.adAccountId"] ?? null,
    };

    const instagram = {
      token: req.body["instagram.token"] ?? null,
      id: req.body["instagram.id"] ?? null,
      username: req.body["instagram.username"] ?? null,
      name: req.body["instagram.name"] ?? null,
    };

    if (!rawPhone) return res.status(400).json({ error: "phone is required" });
    if (!selectedDay) return res.status(400).json({ error: "selectedDay is required" });
    if (!selectedTime) return res.status(400).json({ error: "selectedTime is required" });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "at least one image is required" });

    const phone = normalizePhone(rawPhone);
    const now = new Date();

    // Placeholder id for path construction before actual insert
    const tempId = `${phone}_${now.getTime()}`;

    // Upload all images to Backblaze
    const imageUrls = await Promise.all(
      req.files.map(async (file, i) => {
        const ext = file.originalname.split(".").pop()?.toLowerCase() || "jpg";
        const b2Path = `gallery/${phone}/${tempId}/image-${i}.${ext}`;
        await backblazeService.uploadImage(b2Path, file.buffer, file.mimetype);
        return `${process.env.BASE_URL}/api/img?url=${encodeURIComponent(b2Path)}`;
      })
    );

    // Build creative: single post or carousel
    let creative;
    if (imageUrls.length === 1) {
      creative = { type: "post", imageUrl: imageUrls[0], desc: "", status: "completed", publishLog: [] };
    } else {
      creative = {
        type: "carousel",
        slides: imageUrls.map((url) => ({ imageUrl: url })),
        desc: "",
        status: "completed",
        publishLog: [],
      };
    }

    const order = {
      phone,
      clientName: clientName ?? null,
      businessName: businessName ?? null,
      orderType: "gallery",

      facebook,
      instagram,

      status: "pending",

      // Creatives are already ready — skip AI processing
      creatives: [creative],
      creativesStatus: "completed",
      publishPointer: 0,
      creativesFullyPublished: false,

      // Recurring weekly slot
      publish: {
        slots: [{ time: selectedTime, days: [selectedDay] }],
      },

      createdAt: now,
      updatedAt: now,
    };

    const result = await orders().insertOne(order);
    const orderId = result.insertedId.toString();

    console.log(`✅ [GalleryOrder] Submitted for phone=${phone}, id=${orderId}, images=${imageUrls.length}, day=${selectedDay}, time=${selectedTime}`);
    res.json({ success: true, orderId });
  } catch (err) {
    console.error("❌ [GalleryOrder] submitGalleryOrder error:", err.message);
    res.status(500).json({ error: "Failed to submit gallery order", details: err.message });
  }
};
