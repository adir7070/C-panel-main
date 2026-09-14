/* Automatic WhatsApp messages to clients (Green API), through an outbox.

   A trigger inserts a row in `client_notifications`; the worker below renders
   and sends it. The outbox lets the C-panel's own server (its leads module)
   trigger messages without a Green API client of its own, and the unique
   dedupeKey keeps every trigger idempotent — a double click, a retried
   request or a second process can't send twice.

   Types:
     welcome        — a lead became "לקוח פעיל" (manually or by a payment); once per client
     brief_done     — the manager completed the איפיון ("סיים איפיון"); once per client
     products_ready — products were sent to the client; repeat sends collapse per 10 minutes

   Without Green API credentials a message is marked "skipped" (with the
   text that would have gone out) and is NOT kept for later, so adding the
   key doesn't flood clients with stale messages. Anything still queued
   after 24h (worker down) expires instead of sending late. */

const COL = "client_notifications";
const SIGNATURE = "צוות דשן";
const MAX_ATTEMPTS = 5;
const STUCK_MS = 5 * 60 * 1000;
const EXPIRE_MS = 24 * 3600 * 1000;
const PRODUCT_READY = {
  ads:     "המודעות שלך מוכנות",
  organic: "הפוסטים שלך מוכנים",
  lp:      "דף הנחיתה שלך מוכן",
};

const getDb = () => require("../config/db").getDB();

function firstName(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  return /\d/.test(first) ? "" : first; // a phone number is not a name
}

function renderMessage(type, { name, businessName, productType, previewUrl } = {}) {
  const hi = name ? `היי ${name}!` : "היי!";
  let body;
  switch (type) {
    case "welcome":
      body = `${hi} 👋\nברוכים הבאים לדשן מדיה טק 🎉\nשמחים שבחרת בנו. בימים הקרובים נשלים יחד את איפיון העסק ונתחיל לעבוד על התוצרים שלך.`;
      break;
    case "brief_done":
      body = `${hi}\nאיפיון העסק${businessName ? ` של ${businessName}` : ""} הושלם ✅\nהצוות שלנו כבר מתחיל לעבוד על התוצרים, ונעדכן אותך ברגע שהם יהיו מוכנים.`;
      break;
    case "products_ready":
      body = `${hi} 🎨\n${PRODUCT_READY[productType] || "התוצרים שלך מוכנים"} ✨\n` +
        (previewUrl ? `לצפייה ואישור:\n${previewUrl}` : "ניצור איתך קשר בהקדם כדי לעבור עליהם יחד.");
      break;
    default:
      throw new Error(`unknown notification type: ${type}`);
  }
  return `${body}\n\n${SIGNATURE}`;
}

async function resolveVars(db, doc) {
  const [client, profile] = await Promise.all([
    db.collection("cpanel_clients").findOne({ phone: doc.phone }, { projection: { customerName: 1 } }),
    db.collection("business_profiles").findOne({ phone: doc.phone }, { projection: { businessName: 1 } }),
  ]);
  return {
    name:         firstName(doc.meta?.name || client?.customerName),
    businessName: profile?.businessName || "",
    productType:  doc.meta?.productType,
    previewUrl:   doc.meta?.previewUrl,
  };
}

async function enqueue({ type, phone, dedupeKey, meta = {} }) {
  if (!type || !phone || !dedupeKey) return { skipped: "missing_fields" };
  try {
    await getDb().collection(COL).insertOne({
      type, phone, dedupeKey, meta, source: "iconiq-server",
      status: "queued", attempts: 0, createdAt: new Date(),
    });
  } catch (err) {
    if (err?.code === 11000) return { duplicate: true };
    throw err;
  }
  // CLIENT_NOTIFY_WORKER=off leaves messages queued (tests, or another process delivers)
  if (process.env.CLIENT_NOTIFY_WORKER !== "off") {
    deliverDue().catch(e => console.warn("[client-notify] deliver:", e.message));
  }
  return { queued: true };
}

/* Triggers call these — they never throw, so a message can't break the
   action that caused it. */
async function safeEnqueue(args) {
  try {
    return await enqueue(args);
  } catch (err) {
    console.warn(`[client-notify] ${args.type} for ${args.phone} not queued:`, err.message);
    return { error: err.message };
  }
}

const tenMinuteBucket = () => Math.floor(Date.now() / 600000);

const notify = {
  welcome: (phone, { name } = {}) =>
    safeEnqueue({ type: "welcome", phone, dedupeKey: `welcome:${phone}`, meta: { name: name || "" } }),
  briefDone: (phone) =>
    safeEnqueue({ type: "brief_done", phone, dedupeKey: `brief_done:${phone}` }),
  productsReady: (phone, { scope = "package", productType, previewUrl } = {}) =>
    safeEnqueue({
      type: "products_ready", phone,
      dedupeKey: `products_ready:${phone}:${productType || scope}:${tenMinuteBucket()}`,
      meta: { productType: productType || null, previewUrl: previewUrl || null },
    }),
};

async function deliverOne(db, doc) {
  const set = fields => db.collection(COL).updateOne({ _id: doc._id }, { $set: fields });
  if (Date.now() - new Date(doc.createdAt).getTime() > EXPIRE_MS) {
    return set({ status: "expired", finishedAt: new Date() });
  }
  const greenApi = require("./greenapi.service");
  let message = null;
  try {
    message = renderMessage(doc.type, await resolveVars(db, doc));
    if (!greenApi.isConfigured()) {
      console.log(`[client-notify] ${doc.type} → ${doc.phone} skipped (Green API not configured)`);
      return set({ status: "skipped", reason: "green_api_not_configured", message, finishedAt: new Date() });
    }
    const r = await greenApi.sendMessage(doc.phone, message);
    await set({ status: "sent", message, messageId: r?.messageId || null, sentAt: new Date(), error: null });
    console.log(`[client-notify] ✅ ${doc.type} → ${doc.phone}`);
  } catch (err) {
    const attempts = (doc.attempts || 0) + 1; // claim already incremented; doc is the pre-claim copy
    const dead = attempts >= MAX_ATTEMPTS;
    await set({
      status: dead ? "dead" : "failed", message, error: err.message,
      nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** attempts) * 60000),
      ...(dead ? { finishedAt: new Date() } : {}),
    });
    console.warn(`[client-notify] ${doc.type} → ${doc.phone} ${dead ? "gave up" : "will retry"}:`, err.message);
  }
}

let deliveringSince = 0;
async function deliverDue() {
  // one cycle at a time — but a cycle stuck past STUCK_MS must not block delivery forever
  if (deliveringSince && Date.now() - deliveringSince < STUCK_MS) return;
  deliveringSince = Date.now();
  try {
    const db = getDb();
    for (let i = 0; i < 20; i++) {
      const now = new Date();
      const claim = await db.collection(COL).findOneAndUpdate(
        {
          $or: [
            { status: "queued" },
            { status: "failed", attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } },
            { status: "sending", claimedAt: { $lt: new Date(now.getTime() - STUCK_MS) } },
          ],
        },
        { $set: { status: "sending", claimedAt: now }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 } },
      );
      // driver v6 returns the doc, v4/v5 wrap it in { value, ok }
      const doc = claim && "ok" in claim && "value" in claim ? claim.value : claim;
      if (!doc) break;
      await deliverOne(db, doc);
    }
  } finally {
    deliveringSince = 0;
  }
}

let timer = null;
function startWorker(intervalMs = 10000) {
  if (timer || process.env.CLIENT_NOTIFY_WORKER === "off") return;
  timer = setInterval(() => deliverDue().catch(e => console.warn("[client-notify] worker:", e.message)), intervalMs);
  timer.unref?.();
  deliverDue().catch(e => console.warn("[client-notify] worker:", e.message));
}

async function ensureIndexes(db) {
  await db.collection(COL).createIndex({ dedupeKey: 1 }, { unique: true });
  await db.collection(COL).createIndex({ status: 1, createdAt: 1 });
  await db.collection(COL).createIndex({ phone: 1, createdAt: -1 });
}

module.exports = { notify, renderMessage, deliverDue, startWorker, ensureIndexes, firstName };
