/**
 * wa-clicks.controller — endpoints for the WhatsApp click tracker.
 *
 * - POST /api/leads/wa-click        public, called by wa-tracker.js (sendBeacon)
 * - GET  /api/cpanel/clients/:phone/wa-clicks   protected, used by C-panel קליקים tab
 */
const waClicks = require("../services/wa-clicks.service");
const pushNotification = require("../services/push-notification.service");
const { getDB } = require("../config/db");

/* In-memory IP rate-limit: 60 requests / 60 seconds. Per PM2 worker;
   acceptable for MVP (we have one worker). If we scale, move to Redis. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
const ipBuckets = new Map(); // ip → { count, resetAt }

function rateLimitOk(ip) {
  if (!ip) return true;
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

/* Best-effort IP extraction; honors X-Forwarded-For from the load balancer. */
function ipOf(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || null;
}

/**
 * POST /api/leads/wa-click — public endpoint hit by wa-tracker.js.
 * Always returns 200 OK (sendBeacon can't distinguish errors anyway —
 * any error code just pollutes logs without helping the caller retry).
 */
exports.trackClick = async (req, res) => {
  res.status(200).json({ ok: true }); // respond first, work after — beacon-friendly

  try {
    const ip = ipOf(req);
    if (!rateLimitOk(ip)) {
      console.warn(`[wa-clicks] rate-limited ip=${ip}`);
      return;
    }

    const b = req.body || {};
    const client_phone = String(b.client_id || "").trim();
    if (!client_phone) {
      console.warn(`[wa-clicks] missing client_id from ip=${ip}, source=${b.source}`);
      return; // unowned — drop for now (could be redirected to an "unassigned" bucket later)
    }

    const { doc, wasNew } = await waClicks.recordClick({
      client_phone,
      source:     b.source,
      wa_number:  b.wa_number,
      button:     b.button,
      page_url:   b.page_url,
      referrer:   b.referrer,
      utm:        b.utm,
      user_agent: b.user_agent || req.headers["user-agent"] || null,
      ip,
      form_data:  b.form || null,
      ts:         b.ts,
    });

    /* Notify the assigned account manager on every NEW first-click row
       (deduped repeats don't re-notify). Form submissions also fire. */
    if (wasNew) {
      const chat = await getDB().collection("support_chats").findOne(
        { phone: client_phone },
        { projection: { accountManagerId: 1, name: 1, fireberyName: 1 } },
      );
      if (chat?.accountManagerId) {
        const customerLabel = chat.fireberyName || chat.name || client_phone;
        const title = doc.form_data ? "טופס חדש מדף נחיתה" : "קליק וואטסאפ חדש";
        const body  = doc.form_data
          ? `${customerLabel}: מילוי טופס`
          : `${customerLabel}: ${doc.source || doc.page_url || "דף נחיתה"}`;
        pushNotification.notifyUser(client_phone, title, body, { screen: "ChatScreenAi" })
          .catch(err => console.warn(`[wa-clicks] push failed: ${err.message}`));
      }
    }
  } catch (err) {
    console.error("[wa-clicks] trackClick error:", err.message);
  }
};

/**
 * GET /api/cpanel/clients/:phone/wa-clicks — used by C-panel קליקים tab.
 * Protected by cpanel auth middleware.
 */
exports.listForClient = async (req, res) => {
  try {
    const { phone } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const rows = await waClicks.listForClient(phone, { limit });
    res.json({ clicks: rows });
  } catch (err) {
    console.error("[wa-clicks] listForClient error:", err.message);
    res.status(500).json({ error: err.message });
  }
};
