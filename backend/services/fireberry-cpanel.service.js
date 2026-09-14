/**
 * fireberry-cpanel.service.js
 *
 * Embeds the C-panel inside Fireberry records (object 1005 = "ניהול לקוח").
 * Each Fireberry record has four HTML fields — one per tab — that we
 * populate with iframe HTML pointing at the C-panel's /embed/:tab/:phone
 * route. The phone comes from the Fireberry customer record itself
 * (telephone1).
 *
 * This is the same pattern as fireberry-ads.service.js but for the
 * cpanel surface — we keep the two services separate so each can have
 * its own field map and lifecycle.
 *
 * Required Fireberry setup (one-time):
 *   1. On object 1005, add four HTML fields (one per tab).
 *   2. Copy the pcfsystemfield<N> names into FIREBERRY_FIELD_MAP below.
 *   3. POST /api/fireberry-cpanel/sync-all to backfill existing records.
 *   4. Add a Fireberry Automation: On Create (object 1005) →
 *      POST /api/fireberry-cpanel/sync/{record id}
 *      so new records get their iframes populated automatically.
 */

const axios = require("axios");

const FIREBERRY_BASE   = "https://api.powerlink.co.il/api";
const CLIENT_OBJECT_TYPE = 1005;
const CPANEL_BASE      = process.env.CPANEL_BASE_URL || "https://cpanel-973d9819fba6.herokuapp.com";

// ─── Field mapping ──────────────────────────────────────────────────────────
// Fill in the pcfsystemfield names for the four HTML fields on object 1005
// (one per tab). Use the /api/fireberry-cpanel/debug/:recordId endpoint
// to discover the actual names if you don't have them yet.
const FIREBERRY_FIELD_MAP = {
  // Source — phone is the cpanel's customer identifier.
  phone: "telephone1",

  // Target — the HTML fields we populate with iframe HTML.
  // Confirmed pcf names on object 1005:
  iframeProducts:  "pcfsystemfield122", // מוצרים
  iframeLeads:     "pcfsystemfield121", // לידים
  iframeCampaigns: "pcfsystemfield120", // קמפיינים
  iframeCalendar:  "pcfsystemfield123", // לוח שנה
  iframeBilling:   "pcfsystemfield129", // דף חיוב
  iframeChat:           "pcfsystemfield130", // התכתבות עם הלקוח
  iframeCatalog:        "pcfsystemfield131", // קטלוג אישי
  iframeCharacterization: "pcfsystemfield133", // איפיון
};

const TABS = ["products", "campaigns", "leads", "calendar", "billing", "chat", "catalog", "characterization"];

// ─── Helpers ────────────────────────────────────────────────────────────────
function getAuthHeaders() {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN is not set");
  return { tokenid: token, "Content-Type": "application/json" };
}

function normalizePhone(phone) {
  if (!phone) return "";
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
}

// Object 1005 doesn't carry telephone1 directly — it's a lookup record.
// The customer's phone shows up inside pcfsystemfield100name as
// "0542587070 0542587070 שם הלקוח". Pull the first 9–10-digit run.
function extractPhoneFromRecord(record) {
  const direct = record[FIREBERRY_FIELD_MAP.phone];
  if (direct) return normalizePhone(direct);

  const candidates = [
    record["pcfsystemfield100name"],
    record["pcfsystemfield100"],
    record["accountname"],
    record["name"],
  ].filter(Boolean);

  for (const candidate of candidates) {
    const text = String(candidate);
    // Israeli phone: 0 + 9 digits (mobile/landline) OR +972/972 + 9 digits.
    const m = text.match(/\+?972\d{9}|0\d{8,9}/);
    if (m) return normalizePhone(m[0]);
  }
  return "";
}

function buildIframeHtml(tab, phone) {
  // Responsive sizing via clamp() against the VIEWPORT (not the parent
  // column). The earlier min(100%,1700px) read the narrow Fireberry
  // column for the 100% term and collapsed the iframe; clamp() against
  // 100vw escapes the column and uses the real screen width instead.
  //
  //   clamp(0px, calc(100vw - 200px), 1700px)
  //     • Mobile (375px viewport):  175px  → fits, no overflow
  //     • Tablet (768px):           568px  → fits
  //     • Desktop (1920px):         1700px → forces the Fireberry column
  //                                          to grow up to 1700px
  //
  // Height is also viewport-relative so embedded views never overflow
  // the device screen.
  const inner =
    "width:100%;" +
    "min-width:clamp(0px,calc(100vw - 200px),1700px);" +
    "height:min(1100px,calc(100vh - 16px));" +
    "min-height:600px;" +
    "border:none;border-radius:8px;display:block;";
  return `<div style="width:100%;max-width:100%;overflow:hidden;"><iframe style="${inner}" src="${CPANEL_BASE}/embed/${tab}/${encodeURIComponent(phone)}" allowfullscreen="allowfullscreen"></iframe></div>`;
}

// ─── Fireberry read ─────────────────────────────────────────────────────────
async function getClientRecord(recordId) {
  if (!recordId) throw new Error("recordId is required");
  const pkField = `customobject${CLIENT_OBJECT_TYPE}id`;
  const response = await axios.post(`${FIREBERRY_BASE}/query`, {
    objecttype: CLIENT_OBJECT_TYPE,
    page_size: 1,
    page_number: 1,
    query: `(${pkField} = ${recordId})`,
  }, {
    headers: getAuthHeaders(),
    timeout: 15000,
  });

  const { success, error_details, data } = response.data || {};
  if (!success) {
    throw new Error(`Fireberry query failed (object ${CLIENT_OBJECT_TYPE}): ${JSON.stringify(error_details)}`);
  }
  const record = data?.Data?.[0];
  if (!record) {
    throw new Error(`No Fireberry record found in object ${CLIENT_OBJECT_TYPE} with id=${recordId}`);
  }
  return record;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Write the four iframe HTML fields on a single record. Returns a summary
 * including the phone we resolved and which target fields were skipped
 * because they still point at the placeholder name.
 */
async function syncRecord(recordId) {
  const record = await getClientRecord(recordId);
  const phone = extractPhoneFromRecord(record);
  if (!phone) {
    throw new Error(`Record ${recordId}: phone not found in ${FIREBERRY_FIELD_MAP.phone} or pcfsystemfield100name`);
  }

  // Build payload — skip target fields whose pcf name is still a placeholder.
  const update = {};
  const skipped = [];
  for (const tab of TABS) {
    const key = "iframe" + tab.charAt(0).toUpperCase() + tab.slice(1);
    const pcf = FIREBERRY_FIELD_MAP[key];
    if (!pcf || pcf.startsWith("pcfsystemfield_iframe_")) {
      skipped.push({ tab, reason: "placeholder pcf name", configured: pcf });
      continue;
    }
    update[pcf] = buildIframeHtml(tab, phone);
  }

  if (Object.keys(update).length === 0) {
    return { ok: true, recordId, phone, updated: 0, skipped, note: "All 4 fields are placeholders — fill FIREBERRY_FIELD_MAP" };
  }

  await axios.put(
    `${FIREBERRY_BASE}/record/${CLIENT_OBJECT_TYPE}/${recordId}`,
    update,
    { headers: getAuthHeaders(), timeout: 10000 },
  );

  return { ok: true, recordId, phone, updated: Object.keys(update).length, skipped, fieldsWritten: Object.keys(update) };
}

/**
 * Bulk-backfill — sync every record on object 1005. Costs one query +
 * one PUT per record. Use sparingly.
 */
async function syncAllRecords(limit = 500) {
  const headers = getAuthHeaders();
  const pkField = `customobject${CLIENT_OBJECT_TYPE}id`;
  const list = await axios.post(`${FIREBERRY_BASE}/query`, {
    objecttype: CLIENT_OBJECT_TYPE,
    page_size: Math.min(limit, 500),
    page_number: 1,
    fields: `${pkField}`,
    query: "",
  }, { headers, timeout: 15000 });

  const records = list.data?.data?.Data || [];
  const results = { total: records.length, updated: 0, skipped: 0, failed: [] };
  for (const r of records) {
    const id = r[pkField];
    if (!id) continue;
    try {
      const out = await syncRecord(id);
      if (out.updated > 0) results.updated += 1;
      else                 results.skipped += 1;
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }
  return results;
}

module.exports = {
  syncRecord,
  syncAllRecords,
  // exposed for debug routes
  _getClientRecord: getClientRecord,
  _buildIframeHtml: buildIframeHtml,
  _extractPhoneFromRecord: extractPhoneFromRecord,
  _FIREBERRY_FIELD_MAP: FIREBERRY_FIELD_MAP,
  _CLIENT_OBJECT_TYPE: CLIENT_OBJECT_TYPE,
  _CPANEL_BASE: CPANEL_BASE,
  _TABS: TABS,
};
