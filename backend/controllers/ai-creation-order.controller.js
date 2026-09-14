const { DB } = require("../config/db");
const { processCreatives } = require("../services/ai-creation-order.service");
const fbService = require("../services/facebook.service");
const igService = require("../services/instagram.service");

const orders = () => DB.collection("ai_creation_orders");

const normalizePhone = (phone) => {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai-creation-order/submit
// Body: { phone, billing, services, campaign, review, publish }
// ─────────────────────────────────────────────────────────────────────────────
exports.submitOrder = async (req, res) => {
  try {
    const {
      phone: rawPhone,
      clientName,
      businessName,
      facebook,
      instagram,
      billing,
      services,
      campaign,
      review,
      publish,
    } = req.body;

    if (!rawPhone) return res.status(400).json({ error: "phone is required" });
    if (!billing?.packageId) return res.status(400).json({ error: "billing.packageId is required" });

    const phone = normalizePhone(rawPhone);
    const now = new Date();

    const order = {
      // ─── זהות הלקוח ───
      phone,
      clientName: clientName ?? null,
      businessName: businessName ?? null,

      // ─── פרטי Facebook ───
      facebook: {
        userToken: facebook?.userToken ?? null,       // טוקן המשתמש הראשי
        pageToken: facebook?.pageToken ?? null,       // טוקן הדף (לפרסום)
        pageId: facebook?.pageId ?? null,             // מזהה הדף
        pageName: facebook?.pageName ?? null,         // שם הדף
        adAccountId: facebook?.adAccountId ?? null,  // מזהה חשבון הפרסום
      },

      // ─── פרטי Instagram ───
      instagram: {
        token: instagram?.token ?? null,              // טוקן Instagram
        id: instagram?.id ?? null,                    // מזהה חשבון IG
        username: instagram?.username ?? null,        // @username
        name: instagram?.name ?? null,                // שם התצוגה
      },

      // ─── הזמנה ───
      status: "pending",
      billing: {
        cycle: billing.cycle,
        packageId: billing.packageId,
        packageName: billing.packageName,
        postCount: billing.postCount,
        carouselCount: billing.carouselCount,
        packagePrice: billing.packagePrice,
        manageProject: billing.manageProject ?? false,
        projectManagementPrice: billing.projectManagementPrice ?? 0,
        totalPrice: (billing.packagePrice ?? 0) + (billing.projectManagementPrice ?? 0),
      },
      services: Array.isArray(services) ? services : [],
      campaign: Array.isArray(campaign) ? campaign : [],
      review: {
        contactInfo: review?.contactInfo ?? [],
        ctaText: review?.ctaText ?? "",
      },
      publish: {
        slots: Array.isArray(publish?.slots) ? publish.slots : [],
      },
      createdAt: now,
      updatedAt: now,
    };

    const result = await orders().insertOne(order);
    const orderId = result.insertedId.toString();

    console.log(`✅ [AICreationOrder] Order submitted for phone=${phone}, id=${orderId}`);
    res.json({ success: true, orderId });

    // Fire & forget — runs in background after response is sent
    processCreatives(orderId, order).catch((err) =>
      console.error(`❌ [AICreationOrder] processCreatives crashed: ${err.message}`)
    );
  } catch (err) {
    console.error("❌ [AICreationOrder] submitOrder error:", err.message);
    res.status(500).json({ error: "Failed to submit order", details: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-creation-order/by-phone/:phone
// ─────────────────────────────────────────────────────────────────────────────
exports.getByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const list = await orders().find({ phone }).sort({ createdAt: -1 }).toArray();

    res.json({ success: true, data: list });
  } catch (err) {
    console.error("❌ [AICreationOrder] getByPhone error:", err.message);
    res.status(500).json({ error: "Failed to fetch orders", details: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/ai-creation-order/:id/status
// Body: { status }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateStatus = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ["pending", "in_progress", "completed", "cancelled"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
    }

    await orders().updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ [AICreationOrder] updateStatus error:", err.message);
    res.status(500).json({ error: "Failed to update status", details: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/ai-creation-order/:id
// Deletes an order by ID (admin/testing use only)
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteOrder = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const { id } = req.params;
    const result = await orders().deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ [AICreationOrder] deleteOrder error:", err.message);
    res.status(500).json({ error: "Failed to delete order", details: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai-creation-order/retry-failed
// Retries all creatives whose last publishLog entry has overallStatus: "failed"
// Fixes localhost imageUrls → BASE_URL automatically
// ─────────────────────────────────────────────────────────────────────────────
exports.retryFailed = async (req, res) => {
  // BASE_URL must be a real public URL (e.g. https://api.iconiqmedia.co.il)
  // Falls back to request host only when that host is also public (i.e. not localhost)
  const envBase = process.env.BASE_URL;
  const reqBase = `${req.protocol}://${req.get("host")}`;
  const publicBase = envBase || (reqBase.includes("localhost") ? null : reqBase);

  const fixUrl = (url) => {
    if (!url) return url;
    if (/https?:\/\/localhost(:\d+)?/.test(url)) {
      if (!publicBase) return url; // can't fix — no public base known
      return url.replace(/https?:\/\/localhost(:\d+)?/, publicBase);
    }
    return url;
  };

  try {
    const pending = await orders()
      .find({ creativesStatus: "completed", creativesFullyPublished: { $ne: true } })
      .toArray();

    const results = [];

    for (const order of pending) {
      const creatives = order.creatives || [];
      const pointer = order.publishPointer ?? 0;
      if (pointer >= creatives.length) continue;

      const creative = creatives[pointer];
      const log = creative.publishLog || [];
      const lastEntry = log[log.length - 1];

      // Only retry if last attempt failed
      if (!lastEntry || lastEntry.overallStatus !== "failed") continue;

      const { type, desc, imageUrl, slides } = creative;
      const { facebook, instagram } = order;

      const rawUrls = type === "carousel"
        ? (slides || []).filter((s) => s.imageUrl).map((s) => s.imageUrl)
        : imageUrl ? [imageUrl] : [];

      const imageUrls = rawUrls.map(fixUrl);

      // Warn if any URL is still localhost — Meta will reject it
      const stillLocal = imageUrls.filter((u) => /localhost/.test(u));
      if (stillLocal.length) {
        console.warn(`[RetryFailed] ⚠️  Order ${order._id} has ${stillLocal.length} localhost URL(s) — set BASE_URL env var to fix`);
      }

      const logEntry = {
        slot: "retry",
        day: null,
        publishedAt: new Date(),
        facebook: null,
        instagram: null,
      };

      if (facebook?.pageToken && facebook?.pageId) {
        try {
          const result = type === "carousel"
            ? await fbService.publishCarousel(facebook.pageToken, facebook.pageId, imageUrls, desc)
            : await fbService.publishPhoto(facebook.pageToken, facebook.pageId, imageUrls[0], desc);
          logEntry.facebook = { status: "success", postId: result.postId };
        } catch (err) {
          const detail = err.response?.data?.error?.message || err.message;
          logEntry.facebook = { status: "failed", error: detail };
          console.error(`[RetryFailed] FB error for order ${order._id}:`, detail);
        }
      }

      if (instagram?.token && instagram?.id) {
        try {
          const result = type === "carousel"
            ? await igService.publishCarousel(instagram.token, instagram.id, imageUrls, desc)
            : await igService.publishPhoto(instagram.token, instagram.id, imageUrls[0], desc);
          logEntry.instagram = { status: "success", postId: result.postId, permalink: result.permalink || null };
        } catch (err) {
          const detail = err.response?.data?.error?.message || err.message;
          logEntry.instagram = { status: "failed", error: detail };
          console.error(`[RetryFailed] IG error for order ${order._id}:`, detail);
        }
      }

      const anySuccess =
        logEntry.facebook?.status === "success" || logEntry.instagram?.status === "success";
      logEntry.overallStatus = anySuccess
        ? logEntry.facebook?.status === logEntry.instagram?.status ? "success" : "partial"
        : "failed";

      const newPointer = anySuccess ? pointer + 1 : pointer;
      const publishLogField = `creatives.${pointer}.publishLog`;

      await orders().updateOne(
        { _id: order._id },
        {
          $push: { [publishLogField]: logEntry },
          $set: { publishPointer: newPointer, updatedAt: new Date() },
        }
      );

      results.push({
        orderId: order._id,
        creativeIndex: pointer,
        imageUrls,
        fb: logEntry.facebook?.status ?? "—",
        fbError: logEntry.facebook?.error ?? null,
        fbPostId: logEntry.facebook?.postId ?? null,
        ig: logEntry.instagram?.status ?? "—",
        igError: logEntry.instagram?.error ?? null,
        igPostId: logEntry.instagram?.postId ?? null,
        igPermalink: logEntry.instagram?.permalink ?? null,
        overall: logEntry.overallStatus,
      });

      console.log(`[RetryFailed] Order ${order._id} creative[${pointer}] — FB: ${logEntry.facebook?.status ?? "—"} | IG: ${logEntry.instagram?.status ?? "—"} | overall: ${logEntry.overallStatus}`);
    }

    res.json({ success: true, retried: results.length, results });
  } catch (err) {
    console.error("❌ [RetryFailed] error:", err.message);
    res.status(500).json({ error: "Failed to retry", details: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai-creation-order/trigger-publish
// Runs the publish cron logic against ALL pending orders — no time/slot filter.
// Useful for manual testing and recovery.
// ─────────────────────────────────────────────────────────────────────────────
exports.triggerPublish = async (req, res) => {
  try {
    const { runPublishAll } = require("../cron/publish-creatives.cron");
    const results = await runPublishAll();
    res.json({ success: true, processed: results.length, results });
  } catch (err) {
    console.error("❌ [TriggerPublish] error:", err.message);
    res.status(500).json({ error: "Failed to trigger publish", details: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai-creation-order/schedule-social
// Body: { phone, facebook, instagram, items: [{ imageUrl, description, scheduledAt }] }
// scheduledAt — Unix ms timestamp (Israel timezone used for slot calculation).
// Creates one order with ready creatives + specificDate slots for the cron.
// ─────────────────────────────────────────────────────────────────────────────
exports.scheduleSocial = async (req, res) => {
  try {
    const { phone: rawPhone, facebook, instagram, items } = req.body;

    if (!rawPhone) return res.status(400).json({ error: "phone is required" });
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: "items array is required" });

    const phone = normalizePhone(rawPhone);

    const formatSlot = (ts) => {
      const d = new Date(ts);
      const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);
      const timeParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Jerusalem",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(d);
      let h = timeParts.find((p) => p.type === "hour")?.value ?? "00";
      const m = timeParts.find((p) => p.type === "minute")?.value ?? "00";
      if (h === "24") h = "00";
      return { specificDate: dateStr, time: `${h.padStart(2, "0")}:${m.padStart(2, "0")}` };
    };

    const creatives = items.map((item) => ({
      type: "post",
      imageUrl: item.imageUrl,
      desc: item.description || "",
      status: "completed",
      publishLog: [],
    }));

    const slots = items.map((item) => formatSlot(item.scheduledAt));

    const now = new Date();
    const order = {
      phone,
      orderType: "social_schedule",
      facebook: {
        userToken:   facebook?.userToken   ?? null,
        pageToken:   facebook?.pageToken   ?? null,
        pageId:      facebook?.pageId      ?? null,
        pageName:    facebook?.pageName    ?? null,
        adAccountId: facebook?.adAccountId ?? null,
      },
      instagram: {
        token:    instagram?.token    ?? null,
        id:       instagram?.id       ?? null,
        username: instagram?.username ?? null,
        name:     instagram?.name     ?? null,
      },
      status:                  "pending",
      creatives,
      creativesStatus:         "completed",
      publishPointer:          0,
      creativesFullyPublished: false,
      publish: { slots },
      createdAt: now,
      updatedAt: now,
    };

    const result = await orders().insertOne(order);
    const orderId = result.insertedId.toString();

    console.log(`✅ [ScheduleSocial] phone=${phone}, orderId=${orderId}, items=${items.length}, slots=${JSON.stringify(slots)}`);
    res.json({ success: true, orderId });
  } catch (err) {
    console.error("❌ [ScheduleSocial] error:", err.message);
    res.status(500).json({ error: "Failed to schedule social posts", details: err.message });
  }
};
