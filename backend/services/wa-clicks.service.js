/**
 * wa-clicks.service — persistence + dedup for WhatsApp click-tracker beacons.
 *
 * Collection: wa_clicks
 *
 * Document shape:
 *   {
 *     _id, client_phone, source, wa_number, button, page_url, referrer,
 *     utm: { source, medium, campaign, term, content },
 *     user_agent, ip,
 *     click_count: 1,                 // increments on dedup hit
 *     first_clicked_at: Date,
 *     last_clicked_at:  Date,
 *     form_data: object | null,       // present when the page reported a real submission
 *     created_at, updated_at,
 *   }
 *
 * Dedup window: (client_phone, ip, user_agent, page_url) within 30 seconds.
 * Rows with form_data NEVER dedup — every form submission gets a new row.
 */
const { getDB } = require("../config/db");

const COL = "wa_clicks";
const DEDUP_WINDOW_MS = 30 * 1000;
const col = () => getDB().collection(COL);

async function ensureIndexes() {
  try {
    await col().createIndex({ client_phone: 1, created_at: -1 });
    await col().createIndex({ client_phone: 1, ip: 1, user_agent: 1, page_url: 1, last_clicked_at: -1 });
  } catch (err) {
    console.warn("[wa-clicks] index ensure failed:", err.message);
  }
}

/**
 * Insert a new click, or merge it into an existing recent row if it's a dup.
 * Returns { doc, wasNew: boolean } — wasNew=true means this is a fresh row
 * (callers use this to decide whether to fire a push notification).
 */
async function recordClick({ client_phone, source, wa_number, button, page_url, referrer, utm, user_agent, ip, form_data, ts }) {
  const now = new Date();
  const eventAt = ts ? new Date(ts) : now;

  // Form submissions are always new — skip dedup
  if (!form_data) {
    const cutoff = new Date(now.getTime() - DEDUP_WINDOW_MS);
    const existing = await col().findOne(
      {
        client_phone,
        ip,
        user_agent,
        page_url,
        last_clicked_at: { $gte: cutoff },
        form_data: null,
      },
      { sort: { last_clicked_at: -1 } },
    );
    if (existing) {
      await col().updateOne(
        { _id: existing._id },
        {
          $inc: { click_count: 1 },
          $set: { last_clicked_at: eventAt, updated_at: now },
        },
      );
      return { doc: { ...existing, click_count: (existing.click_count || 1) + 1, last_clicked_at: eventAt }, wasNew: false };
    }
  }

  const doc = {
    client_phone,
    source: source || null,
    wa_number: wa_number || null,
    button: button || null,
    page_url: page_url || null,
    referrer: referrer || null,
    utm: utm || {},
    user_agent: user_agent || null,
    ip: ip || null,
    click_count: 1,
    first_clicked_at: eventAt,
    last_clicked_at: eventAt,
    form_data: form_data || null,
    created_at: now,
    updated_at: now,
  };
  const result = await col().insertOne(doc);
  return { doc: { ...doc, _id: result.insertedId }, wasNew: true };
}

/**
 * Recent clicks for a given client phone, most-recent first.
 */
async function listForClient(client_phone, { limit = 200 } = {}) {
  return col()
    .find({ client_phone })
    .sort({ last_clicked_at: -1 })
    .limit(limit)
    .toArray();
}

module.exports = { ensureIndexes, recordClick, listForClient };
