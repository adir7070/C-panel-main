/**
 * fireberry-campaigns.service.js
 *
 * Companion to fireberry-cpanel.service.js — same pattern but targets
 * Fireberry object 67 ("קמפיין"/campaign record) instead of 1005.
 * Each campaign record has one HTML field (pcfsystemfield121) that we
 * populate with an iframe to the C-panel account-status panel for the
 * linked customer.
 *
 * If more iframe surfaces get added on object 67 later, extend
 * FIREBERRY_FIELD_MAP + TABS in the same way 1005 did over many
 * iterations.
 */

const axios = require("axios");

const FIREBERRY_BASE        = "https://api.powerlink.co.il/api";
const CAMPAIGN_OBJECT_TYPE  = 67;
const CPANEL_BASE           = process.env.CPANEL_BASE_URL || "https://cpanel-973d9819fba6.herokuapp.com";

// ─── Field mapping for object 67 ────────────────────────────────────────────
// The phone resolution falls back to scanning a few likely display fields
// for an Israeli-shaped phone, just like the 1005 service does, so we don't
// need to know the exact phone field on object 67 up front.
const FIREBERRY_FIELD_MAP = {
  phone: "telephone1", // primary guess; extractPhoneFromRecord falls through

  // Target HTML fields on object 67:
  iframeAccountStatus: "pcfsystemfield121", // סטטוס חשבון (Account Status panel)
};

const TABS = ["account-status"];

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
    const m = text.match(/\+?972\d{9}|0\d{8,9}/);
    if (m) return normalizePhone(m[0]);
  }
  return "";
}

function buildIframeHtml(tab, phone) {
  // Same clamp()-based responsive sizing as fireberry-cpanel — desktop
  // gets the original 1700px wide layout, mobile shrinks to viewport.
  const inner =
    "width:100%;" +
    "min-width:clamp(0px,calc(100vw - 200px),1700px);" +
    "height:min(1100px,calc(100vh - 16px));" +
    "min-height:600px;" +
    "border:none;border-radius:8px;display:block;";
  return `<div style="width:100%;max-width:100%;overflow:hidden;"><iframe style="${inner}" src="${CPANEL_BASE}/embed/${tab}/${encodeURIComponent(phone)}" allowfullscreen="allowfullscreen"></iframe></div>`;
}

// ─── Fireberry read ─────────────────────────────────────────────────────────
// Use GET /record/{type}/{id} — Fireberry serves any record by URL without
// needing to know its primary-key field name (our POST /query approach
// failed on object 67 because the PK isn't 'customobject67id'). The
// response shape: { success, data: { Record: {...} } }.
async function getCampaignRecord(recordId) {
  if (!recordId) throw new Error("recordId is required");
  const response = await axios.get(
    `${FIREBERRY_BASE}/record/${CAMPAIGN_OBJECT_TYPE}/${recordId}`,
    { headers: getAuthHeaders(), timeout: 15000 },
  );

  const { success, error_details, data } = response.data || {};
  if (!success) {
    throw new Error(`Fireberry get failed (object ${CAMPAIGN_OBJECT_TYPE}): ${JSON.stringify(error_details)}`);
  }
  const record = data?.Record || data?.Data?.[0] || data;
  if (!record || typeof record !== "object") {
    throw new Error(`No Fireberry record found in object ${CAMPAIGN_OBJECT_TYPE} with id=${recordId}`);
  }
  return record;
}

// ─── Public API ─────────────────────────────────────────────────────────────
async function syncRecord(recordId) {
  const record = await getCampaignRecord(recordId);
  const phone = extractPhoneFromRecord(record);
  if (!phone) {
    throw new Error(`Record ${recordId}: phone not found on object ${CAMPAIGN_OBJECT_TYPE}`);
  }

  const update = {};
  for (const tab of TABS) {
    const key = "iframe" + tab.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
    const pcf = FIREBERRY_FIELD_MAP[key];
    if (pcf) update[pcf] = buildIframeHtml(tab, phone);
  }
  if (Object.keys(update).length === 0) {
    return { ok: true, recordId, phone, updated: 0, note: "no fields configured" };
  }

  await axios.put(
    `${FIREBERRY_BASE}/record/${CAMPAIGN_OBJECT_TYPE}/${recordId}`,
    update,
    { headers: getAuthHeaders(), timeout: 10000 },
  );
  return { ok: true, recordId, phone, updated: Object.keys(update).length, fieldsWritten: Object.keys(update) };
}

async function syncAllRecords(limit = 500) {
  const headers = getAuthHeaders();
  // No `fields` filter — Fireberry returns every column. We don't know
  // the PK name on object 67 in advance, so we sniff the GUID-shaped
  // field per-record (any value matching the standard 36-char UUID).
  const list = await axios.post(`${FIREBERRY_BASE}/query`, {
    objecttype: CAMPAIGN_OBJECT_TYPE,
    page_size: Math.min(limit, 500),
    page_number: 1,
    query: "",
  }, { headers, timeout: 15000 });

  const records = list.data?.data?.Data || [];
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const results = { total: records.length, updated: 0, skipped: 0, failed: [] };

  for (const r of records) {
    // The PK is whichever field ends in "id" and holds a GUID matching
    // this very record. We can't tell statically which one, but the
    // record's OWN id is the only one that points back at itself — and
    // any GUID-shaped *id field will work for the subsequent GET.
    let id = null;
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "string" && /id$/i.test(k) && GUID_RE.test(v)) {
        // Skip well-known FK-shaped fields (createdby, modifiedby, ownerid)
        if (["createdby", "modifiedby", "ownerid"].includes(k)) continue;
        id = v;
        break;
      }
    }
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
  _getCampaignRecord: getCampaignRecord,
  _extractPhoneFromRecord: extractPhoneFromRecord,
  _buildIframeHtml: buildIframeHtml,
  _FIREBERRY_FIELD_MAP: FIREBERRY_FIELD_MAP,
  _CAMPAIGN_OBJECT_TYPE: CAMPAIGN_OBJECT_TYPE,
  _CPANEL_BASE: CPANEL_BASE,
  _TABS: TABS,
};
