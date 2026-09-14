const DB = require("../utils/DB");

const COLLECTION = "instagram_posts";

const SERVER_BASE_URL = process.env.BASE_URL || "https://iconiq-b19bf9d01fab.herokuapp.com";
function toAbsoluteUrl(url) {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${SERVER_BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

const HE_DAY_TO_JS = { "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6 };

/**
 * Parse specificDate + time as Israel local time (Asia/Jerusalem).
 * The cron and C-Panel treat these strings as Israel time, so we must
 * do the same to get a correct UTC timestamp for display in the app.
 */
function slotToTimestamp(slot) {
  if (slot?.specificDate) {
    const s = slot.specificDate;
    const timeStr = (slot.time && slot.time !== "--:--") ? slot.time : "00:00";
    let dateStr;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      dateStr = s;  // YYYY-MM-DD
    } else if (/^\d{2}\.\d{2}\.\d{2}$/.test(s)) {
      const [dd, mm, yy] = s.split(".");
      dateStr = `20${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    }
    if (dateStr) {
      // Compute Israel timezone offset for this date (handles DST automatically)
      const probe = new Date(`${dateStr}T${timeStr}:00Z`);
      const israelParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Jerusalem",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      }).formatToParts(probe);
      const utcH = probe.getUTCHours(), utcM = probe.getUTCMinutes();
      const ilH  = parseInt(israelParts.find(p => p.type === "hour")?.value   ?? "0", 10);
      const ilM  = parseInt(israelParts.find(p => p.type === "minute")?.value ?? "0", 10);
      const offsetMs = ((ilH - utcH) * 60 + (ilM - utcM)) * 60_000;
      // Parse target time as if it were UTC, then subtract the offset to get actual UTC
      const naive = new Date(`${dateStr}T${timeStr}:00Z`);
      return naive.getTime() - offsetMs;
    }
  }
  if (slot?.time && slot.time !== "--:--" && Array.isArray(slot.days) && slot.days.length > 0) {
    const [h, m] = slot.time.split(":").map(Number);
    const targetDay = HE_DAY_TO_JS[slot.days[0]] ?? 0;
    const now = new Date();
    const d = new Date();
    d.setHours(h, m, 0, 0);
    let daysUntil = (targetDay - now.getDay() + 7) % 7;
    if (daysUntil === 0 && d <= now) daysUntil = 7;
    d.setDate(d.getDate() + daysUntil);
    return d.getTime();
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

function normalizePhone(phone) {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
}

/**
 * GET /api/app/posts/:phone
 * מחזיר פוסטים מ-instagram_posts + creatives מ-ai_creation_orders
 */
const getServerPosts = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);

    // 1. פוסטים שנשמרו ישירות
    const docs = await DB.collection(COLLECTION).find({ phone }).toArray();
    const storedPosts = docs.map((doc) => doc.post);
    const existingIds = new Set(storedPosts.map((p) => String(p?.id)));

    // 2. creatives מהזמנות AI שהושלמו (לא ב-instagram_posts עדיין)
    const orders = await DB.collection("ai_creation_orders")
      .find({ phone, creativesStatus: "completed" })
      .toArray();

    const orderPosts = [];
    for (const order of orders) {
      const slots = order.publish?.slots ?? [];
      let slotIdx = 0;
      for (const creative of order.creatives ?? []) {
        if (creative.type !== "post") { slotIdx++; continue; }
        const postId = `order_${order._id}_${slotIdx}`;
        if (!existingIds.has(postId)) {
          orderPosts.push({
            id: postId,
            status: creative.status === "published" ? "published" : "scheduled",
            imgurl: toAbsoluteUrl(creative.imageUrl) ?? "",
            description: creative.desc ?? "",
            scheduled_at: slotToTimestamp(slots[slotIdx] ?? {}),
            created_at: order.createdAt?.getTime?.() ?? Date.now(),
          });
        }
        slotIdx++;
      }
    }

    console.log(`[InstagramPosts] phone=${phone} stored=${storedPosts.length} fromOrders=${orderPosts.length}`);
    return res.json({ posts: [...storedPosts, ...orderPosts] });
  } catch (error) {
    console.error("[InstagramPosts] getServerPosts error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/app/posts/:phone/upsert
 * body: { postId, post }
 */
const upsertServerPost = async (req, res) => {
  try {
    const { phone } = req.params;
    const { postId, post } = req.body;

    if (!postId || !post) {
      return res.status(400).json({ success: false, error: "postId and post required" });
    }

    await DB.collection(COLLECTION).updateOne(
      { phone, postId: String(postId) },
      { $set: { phone, postId: String(postId), post, updatedAt: new Date() } },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("[InstagramPosts] upsertServerPost error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * DELETE /api/app/posts/:phone/:postId
 */
const deleteServerPost = async (req, res) => {
  try {
    const { phone, postId } = req.params;
    await DB.collection(COLLECTION).deleteOne({ phone, postId: String(postId) });
    return res.json({ success: true });
  } catch (error) {
    console.error("[InstagramPosts] deleteServerPost error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { getServerPosts, upsertServerPost, deleteServerPost };
