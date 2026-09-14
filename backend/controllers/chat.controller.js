const archiver = require("archiver");
const { getDB } = require("../config/db");
const DB = require("../utils/DB");
const pushNotification = require("../services/push-notification.service");
const { getCustomer } = require("../services/customer-cache.service");
const { relaySocketEvent } = require("../services/socket-relay.service");
const { broadcast } = require("../utils/broadcast");
const backblazeService = require("../services/backblaze.service");

exports.sendMessage = async (req, res) => {
  try {
    const { phone, text, message } = req.body;
    const content = text || message;

    if (!phone || !content) {
      return res.status(400).json({ success: false, error: "phone and text/message are required" });
    }

    const chatDoc = await DB.collection("support_chats").findOne({ phone });
    if (!chatDoc) {
      return res.status(404).json({ success: false, error: "No chat found for this phone number" });
    }

    const senderName = req.body.senderName || "מערכת";

    const messageObj = {
      _id: Date.now(),
      text: content,
      fromRole: "agent",
      user: { _id: "automation", name: senderName },
      createdAt: new Date(),
    };

    await DB.collection("support_chats").updateOne(
      { _id: chatDoc._id },
      { $push: { messages: messageObj }, $set: { updated_at: new Date() } }
    );

    const io = req.app.get("io");
    const teamMsg = { ...messageObj, userId: chatDoc._id };
    if (io) {
      broadcast(io, "receive_message", String(chatDoc._id), messageObj);
      broadcast(io, "receive_message", "support_team", teamMsg);
    } else {
      relaySocketEvent("receive_message", String(chatDoc._id), messageObj);
      relaySocketEvent("receive_message", "support_team", teamMsg);
    }

    const silent = req.body.silent === true;
    if (!silent) {
      pushNotification.notifyUser(chatDoc._id, "נציג תמיכה", content, {
        screen: "ChatScreenAi",
      });
    }

    return res.json({ success: true, data: messageObj });
  } catch (err) {
    console.error("[Chat API] sendMessage error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// GET /api/chat/search?q=...
exports.searchChats = async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const orClauses = [
      { name: { $regex: q, $options: 'i' } },
      { fireberyName: { $regex: q, $options: 'i' } },
      { fireberyFirstName: { $regex: q, $options: 'i' } },
    ];

    // בניית וריאנטים של מספר טלפון: 0508817320 ↔ 972508817320
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 7) {
      const variants = new Set([digits]);
      if (digits.startsWith('0'))   variants.add('972' + digits.slice(1));
      if (digits.startsWith('972')) variants.add('0'   + digits.slice(3));

      // חיפוש phone — regex שמכסה את כל הוריאנטים
      orClauses.push({ phone: { $regex: [...variants].join('|') } });

      // _id בשיטת $in בלבד — בטוח על שדה עם טיפוסים מעורבים
      orClauses.push({ _id: { $in: [...variants] } });
    }

    const results = await getDB()
      .collection("support_chats")
      .find({ status: { $ne: "merged" }, $or: orClauses }, { projection: { messages: 0 } })
      .sort({ updated_at: -1 })
      .limit(60)
      .toArray();
    return res.json(results);
  } catch (err) {
    console.error("[Chat API] searchChats error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/chat/media-zip?userId=xxx
// מוריד את כל המדיה של לקוח ישירות מ-Backblaze לפי תיקיית הטלפון
exports.mediaZip = async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const db = getDB();
  const chatDoc = await db.collection("support_chats").findOne(
    { _id: userId },
    { projection: { phone: 1, name: 1, fireberyName: 1 } }
  );
  if (!chatDoc) return res.status(404).json({ error: "Chat not found" });

  const phone = chatDoc.phone;
  if (!phone) return res.status(404).json({ error: "No phone number for this chat" });

  const digits = phone.replace(/\D/g, "");
  const with05  = digits.startsWith("972") ? "0" + digits.slice(3) : digits;
  const with972 = digits.startsWith("0")   ? "972" + digits.slice(1) : digits;

  const [files05, files972] = await Promise.all([
    backblazeService.listFilesByPrefix(`uploads/${with05}/`, 2000).catch(() => []),
    backblazeService.listFilesByPrefix(`uploads/${with972}/`, 2000).catch(() => []),
  ]);
  const files = [...files05, ...files972];

  if (!files || files.length === 0) {
    return res.status(404).json({ error: "לא נמצאה מדיה בשיחה זו" });
  }

  const chatName = (chatDoc.fireberyName || chatDoc.name || phone).replace(/[^\w֐-׿\s-]/g, "").trim();
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("media_" + chatName)}.zip`);

  const archive = archiver("zip", { zlib: { level: 0 } });
  archive.on("error", (err) => { console.error("[MediaZip] Archiver error:", err.message); res.end(); });
  archive.pipe(res);

  for (const file of files) {
    try {
      const data = await backblazeService.downloadImageByPath(file.fileName);
      const baseName = file.fileName.split("/").pop();
      archive.append(data.buffer, { name: baseName });
    } catch (e) {
      console.error(`[MediaZip] Skipping ${file.fileName}:`, e.message);
    }
  }

  await archive.finalize();
};

// POST /api/chat/refresh-contact
// מרענן את פרטי הלקוח (שם ותמונה) מהcache של Fireberry ושומר ב-support_chats
exports.refreshContact = async (req, res) => {
  const { userId, phone } = req.body;
  if (!userId || !phone) return res.status(400).json({ success: false });
  try {
    const customer = await getCustomer(phone);
    const stripPhone = (s) => s ? s.replace(/(\+972|972|05)\d[\d\s\-]{6,}/g, '').trim() : s;
    const fireberyName      = stripPhone(customer?.accountname) || customer?.firstname || null;
    const fireberyFirstName = customer?.firstname || null;
    const fireberyLogoUrl   = customer?.logoUrl   || null;

    await getDB().collection("support_chats").updateOne(
      { _id: userId },
      { $set: { fireberyName, fireberyFirstName, fireberyLogoUrl, fireberyUpdatedAt: new Date() } }
    );

    const io = req.app.get("io");
    if (io) broadcast(io, "user_info_updated", "support_team", { userId, fireberyName, fireberyFirstName, fireberyLogoUrl });

    return res.json({ success: true, fireberyName, fireberyFirstName, fireberyLogoUrl });
  } catch (err) {
    console.error("[Chat API] refreshContact error:", err.message);
    return res.status(500).json({ success: false });
  }
};
