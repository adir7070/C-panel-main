/**
 * fireberry-ads.service.js
 *
 * Orchestrates the Fireberry ↔ WOW ads pipeline integration:
 *   1. Reads a customer brief from Fireberry (object type 1)
 *   2. Maps it to WOW brief format
 *   3. Triggers WOW ads pipeline (child process on port 3001)
 *   4. Persists recordId → sessionId mapping in Mongo
 *   5. Exposes lookups + decision saving (write-back to Fireberry)
 *
 * Mongo collection: fireberry_ad_sessions
 * Local proxy:      http://localhost:3001/api/fireberry-ads/from-brief
 */

const axios = require("axios");
const { DB } = require("../config/db");

const FIREBERRY_BASE = "https://api.powerlink.co.il/api";
const PUBLIC_BASE    = process.env.BASE_URL || "https://api.iconiqmedia.co.il";

// Produces the iframe HTML to inject into pcfsystemfield123 — the recordId
// is already substituted server-side so we don't depend on Fireberry's
// template engine (which doesn't substitute merge fields in HTML field
// values).
function buildIframeHtml(recordId) {
  return `<div><iframe style="width: 100%; min-width: 900px; height: 850px; border: none; border-radius: 12px;" src="${PUBLIC_BASE}/fireberry-ads-review?recordId=${recordId}" allowfullscreen="allowfullscreen"></iframe></div>`;
}
// Two-object layout in Fireberry:
//   BRIEF (1012)    — tracking fields (status / decisions / session id) +
//                     a lookup field (pcfsystemfield100) pointing at the
//                     master customer.
//   CUSTOMER (1)    — the actual brief inputs (business name, about, etc).
// We always fetch both and merge before handing to the WOW pipeline.
const BRIEF_OBJECT_TYPE    = 1012;
const CUSTOMER_OBJECT_TYPE = 1;
const WOW_LOCAL_BASE = "http://localhost:3001/api";

// ─── Field mapping ──────────────────────────────────────────────────────────
// Fields are split by which Fireberry object they live on. The brief object
// (1012) carries tracking + a lookup; the customer object (1) carries the
// actual brief inputs that the WOW pipeline needs.
//
// Picklist fields are mapped to their "<name>name" sibling so we get the
// display string ("מנימליסטי") instead of the numeric code (3).
const FIREBERRY_FIELD_MAP = {
  // Fields on the BRIEF object (1012):
  customerLink:  "pcfsystemfield100", // לקוח מקושר (lookup → accountid on object 1)
  adsStatus:     "pcfsystemfield101", // סטטוס יצירת מודעות (picklist)
  adsDecisions:  "pcfsystemfield119", // החלטות מודעות (JSON in long text)
  adsSessionId:  "pcfsystemfield120", // Session ID (text)
  adsIframeHtml: "pcfsystemfield123", // HTML field showing the embedded review widget

  // Fields on the CUSTOMER object (1) — core brief inputs:
  businessName:  "pcfsystemfield1475", // שם העסק
  businessField: "pcfsystemfield1439", // תחום עיסוק
  about:         "pcfsystemfield1491", // אודות / מידע כללי
  services:      "pcfsystemfield1495", // שירות עיקרי

  // Fields on the CUSTOMER object (1) — enrichment (better ads quality):
  detailedAbout:  "pcfsystemfield1492",     // אודות מפורט
  tagline:        "pcfsystemfield1490",     // הצעת ערך / tagline
  promotion:      "pcfsystemfield1493",     // מבצע נוכחי
  eventTypes:     "pcfsystemfield1485",     // סוגי אירועים (חתונה, בר מצווה...)
  coverageArea:   "pcfsystemfield1469",     // אזור גיאוגרפי
  brandColors:    "pcfsystemfield1461",     // צבעי מותג ("שחור לבן וזהב")
  designStyle:    "pcfsystemfield1459name", // סגנון עיצובי picklist → display
  boutiqueLevel:  "pcfsystemfield1460name", // רמת יוקרה picklist → display
  toneOfVoice:    "pcfsystemfield1462name", // טון דיבור picklist → display
  targetAudience: "pcfsystemfield1468name", // קהל יעד picklist → display
  phone:          "telephone1",
  email:          "emailaddress1",
  website:        "pcfsystemfield1474",
  logoFolder:     "pcfsystemfield114",      // Drive folder (logo + photos)
};

// Which fields live on which Fireberry object — used by the two-hop fetcher
// and by saveDecision to decide where to PUT updates. Anything not in the
// brief set is treated as a customer field.
const FIELDS_ON_BRIEF = new Set([
  "customerLink", "adsStatus", "adsDecisions", "adsSessionId", "adsIframeHtml",
]);
const FIELDS_ON_CUSTOMER = new Set([
  "businessName", "businessField", "about", "services",
  "detailedAbout", "tagline", "promotion", "eventTypes",
  "coverageArea", "brandColors", "designStyle", "boutiqueLevel",
  "toneOfVoice", "targetAudience", "phone", "email", "website", "logoFolder",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────
function getAuthHeaders() {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN is not set");
  return { tokenid: token, "Content-Type": "application/json" };
}

const sessions = () => DB.collection("fireberry_ad_sessions");

// ─── Fireberry read (low-level) ─────────────────────────────────────────────
async function fireberryQueryOne(objectType, queryStr, fields = null) {
  const payload = {
    objecttype: objectType,
    page_size: 1,
    page_number: 1,
    query: queryStr,
  };
  if (fields) payload.fields = fields;

  const response = await axios.post(`${FIREBERRY_BASE}/query`, payload, {
    headers: getAuthHeaders(),
    timeout: 15000,
  });

  const { success, error_details, data } = response.data || {};
  if (!success) {
    throw new Error(`Fireberry query failed (object ${objectType}): ${JSON.stringify(error_details)}`);
  }
  return data?.Data?.[0] || null;
}

// ─── Two-hop record fetch ───────────────────────────────────────────────────
// Returns a merged object: { ...customer, ...brief } so brief tracking
// fields (status / decisions / session id) take precedence in case of
// pcfsystemfield-name collisions. The brief's customerLink (pcfsystemfield100)
// is used to find the master customer record.
async function getCustomerRecord(recordId, fieldFilter = true) {
  if (!recordId) throw new Error("recordId is required");

  // 1. Fetch the brief record from object 1012
  const briefPk = `customobject${BRIEF_OBJECT_TYPE}id`;
  const brief = await fireberryQueryOne(
    BRIEF_OBJECT_TYPE,
    `(${briefPk} = ${recordId})`,
    null, // no field filter — always grab all columns on the brief; it's small
  );
  if (!brief) {
    throw new Error(`No Fireberry brief found in object ${BRIEF_OBJECT_TYPE} with id=${recordId}`);
  }

  // 2. Follow the customerLink lookup to fetch the master customer
  const customerLinkPcf = FIREBERRY_FIELD_MAP.customerLink;
  const customerId = brief[customerLinkPcf];
  let customer = {};
  if (customerId) {
    let custFields = null;
    if (fieldFilter) {
      custFields = [...FIELDS_ON_CUSTOMER]
        .map(k => FIREBERRY_FIELD_MAP[k])
        .filter(Boolean)
        .join(",");
    }
    try {
      customer = await fireberryQueryOne(
        CUSTOMER_OBJECT_TYPE,
        `(accountid = ${customerId})`,
        custFields,
      ) || {};
    } catch (err) {
      console.warn(`[FireberryAds] customer fetch failed for ${customerId}:`, err.message);
      // Don't throw — brief tracking still works without customer data;
      // mapToWowBrief will fall back to defaults.
    }
  } else {
    console.warn(`[FireberryAds] brief ${recordId} has no linked customer (${customerLinkPcf} is empty)`);
  }

  // 3. Merge — brief wins on collisions
  return { ...customer, ...brief, __brief: brief, __customer: customer };
}

// ─── Mapping ────────────────────────────────────────────────────────────────
function mapToWowBrief(record) {
  const get = key => record[FIREBERRY_FIELD_MAP[key]] || "";
  const audience  = get("targetAudience");
  const tagline   = get("tagline");
  const detailed  = get("detailedAbout");
  const services  = [get("services"), get("eventTypes")].filter(Boolean).join("; ");
  const designHint = get("designStyle") || get("boutiqueLevel") || "modern";

  return {
    businessName:   get("businessName") || "עסק ללא שם",
    businessField:  get("businessField"),
    businessNiche:  tagline || get("businessField"), // tagline makes a sharper niche
    about:          detailed || get("about"),         // prefer detailed when present
    services:       services || "",
    targetAudience: audience ? [audience] : ["קהל כללי"],
    preferredColors: {
      // Brand colors come as a single Hebrew string ("שחור לבן וזהב"); the
      // WOW prompt concatenates primary/secondary/accent so dropping the
      // whole list in primary still produces a usable prompt line.
      primary:   get("brandColors") || "",
      secondary: "",
      accent:    "",
    },
    phone:          get("phone"),
    address:        get("coverageArea"),
    socialLinks:    get("website") ? { website: get("website") } : {},
    designStyle:    designHint,
    pageGoal:       "",
    promotion:      get("promotion"),
  };
}

// ─── WOW pipeline trigger ───────────────────────────────────────────────────
async function callWowFromBrief(brief) {
  const response = await axios.post(
    `${WOW_LOCAL_BASE}/fireberry-ads/from-brief`,
    brief,
    { timeout: 15000 },
  );
  const { ok, sessionId, briefId } = response.data || {};
  if (!ok || !sessionId) {
    throw new Error(`WOW pipeline rejected: ${JSON.stringify(response.data)}`);
  }
  return { sessionId, briefId };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Triggered by Fireberry automation webhook.
 * Reads brief, kicks off WOW pipeline, persists mapping.
 */
async function triggerGenerationFromFireberry(recordId, options = {}) {
  const { force = false } = options;
  console.log(`🎨 [FireberryAds] generate triggered for record=${recordId} force=${force}`);

  if (!force) {
    const existing = await sessions().findOne({ fireberryRecordId: recordId });
    if (existing && (existing.status === "generating" || existing.status === "ready")) {
      console.log(`🎨 [FireberryAds] reuse existing session ${existing.sessionId} (${existing.status})`);
      return { sessionId: existing.sessionId, status: existing.status, reused: true };
    }
  }

  const record = await getCustomerRecord(recordId);
  const brief  = mapToWowBrief(record);
  const { sessionId, briefId } = await callWowFromBrief(brief);

  await sessions().updateOne(
    { fireberryRecordId: recordId },
    {
      $set: {
        fireberryRecordId: recordId,
        fireberryObjectType: BRIEF_OBJECT_TYPE,
        sessionId,
        briefId,
        status: "generating",
        decisions: {},
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  // Best-effort: stamp sessionId AND the iframe HTML (with the real
  // recordId baked in) onto the brief record. The iframe field needs
  // the substituted GUID because Fireberry doesn't expand merge fields
  // inside HTML field values and the Referer header arrives without
  // the record path.
  try {
    await axios.put(
      `${FIREBERRY_BASE}/record/${BRIEF_OBJECT_TYPE}/${recordId}`,
      {
        [FIREBERRY_FIELD_MAP.adsSessionId]:  sessionId,
        [FIREBERRY_FIELD_MAP.adsIframeHtml]: buildIframeHtml(recordId),
      },
      { headers: getAuthHeaders(), timeout: 10000 },
    );
  } catch (err) {
    console.warn(`[FireberryAds] sessionId/iframe write-back failed: ${err.message}`);
  }

  console.log(`🎨 [FireberryAds] ✅ session=${sessionId} for record=${recordId}`);
  return { sessionId, status: "generating", reused: false };
}

/**
 * Iframe widget asks for its session by recordId.
 * Also polls live status from WOW and returns the ads list when ready.
 */
async function getSessionForRecord(recordId) {
  const mapping = await sessions().findOne({ fireberryRecordId: recordId });
  if (!mapping) return { found: false };

  let status   = mapping.status;
  let ads      = [];
  let adsCount = 0;

  try {
    const statusResp = await axios.get(
      `${WOW_LOCAL_BASE}/ads/status/${mapping.sessionId}`,
      { timeout: 5000 },
    );
    const live = statusResp.data;
    if (live?.ready) {
      status = "ready";
      const listResp = await axios.get(
        `${WOW_LOCAL_BASE}/ads/${mapping.sessionId}`,
        { timeout: 5000 },
      );
      ads = listResp.data?.ads || [];
      adsCount = ads.filter(a => a.imageUrl).length;
    } else {
      adsCount = live?.adsCount || 0;
    }
  } catch (err) {
    console.warn(`[FireberryAds] status poll failed: ${err.message}`);
  }

  if (status !== mapping.status) {
    await sessions().updateOne(
      { fireberryRecordId: recordId },
      { $set: { status, updatedAt: new Date() } },
    );
  }

  return {
    found: true,
    sessionId: mapping.sessionId,
    status,
    ads,
    adsCount,
    decisions: mapping.decisions || {},
  };
}

/**
 * Saves a single approve/reject decision.
 * Persists in Mongo and writes a JSON summary back to Fireberry.
 */
async function saveDecision(recordId, adId, decision) {
  if (!["approved", "rejected"].includes(decision)) {
    throw new Error(`Invalid decision: ${decision}`);
  }

  const mapping = await sessions().findOne({ fireberryRecordId: recordId });
  if (!mapping) throw new Error(`No session found for record ${recordId}`);

  const decisions = { ...(mapping.decisions || {}), [adId]: decision };
  await sessions().updateOne(
    { fireberryRecordId: recordId },
    { $set: { decisions, updatedAt: new Date() } },
  );

  // Best-effort write-back to the BRIEF object (1012). Local Mongo is the
  // source of truth; Fireberry is a mirror. Failure here is non-fatal.
  try {
    const updateFields = {};
    if (FIREBERRY_FIELD_MAP.adsDecisions) {
      updateFields[FIREBERRY_FIELD_MAP.adsDecisions] = JSON.stringify(decisions);
    }
    if (Object.keys(updateFields).length > 0) {
      await axios.put(
        `${FIREBERRY_BASE}/record/${BRIEF_OBJECT_TYPE}/${recordId}`,
        updateFields,
        { headers: getAuthHeaders(), timeout: 10000 },
      );
    }
  } catch (err) {
    console.warn(`[FireberryAds] write-back failed: ${err.message}`);
  }

  return { ok: true, decisions };
}

// ─── Iframe HTML sync ──────────────────────────────────────────────────────
// Standalone — writes pcfsystemfield123 with the proper iframe HTML for
// one record, without triggering a pipeline. Used to backfill existing
// records that were created before the integration started write-back.
async function syncIframeForRecord(recordId) {
  if (!recordId) throw new Error("recordId is required");
  await axios.put(
    `${FIREBERRY_BASE}/record/${BRIEF_OBJECT_TYPE}/${recordId}`,
    { [FIREBERRY_FIELD_MAP.adsIframeHtml]: buildIframeHtml(recordId) },
    { headers: getAuthHeaders(), timeout: 10000 },
  );
  return { ok: true, recordId, html: buildIframeHtml(recordId) };
}

// Lists every record on the brief object and stamps the iframe HTML on
// each one. Costs one PUT per record — use sparingly.
async function syncIframeForAllRecords(limit = 500) {
  const headers = getAuthHeaders();
  const list = await axios.post(`${FIREBERRY_BASE}/query`, {
    objecttype: BRIEF_OBJECT_TYPE,
    page_size: Math.min(limit, 500),
    page_number: 1,
    fields: `customobject${BRIEF_OBJECT_TYPE}id`,
    query: "",
  }, { headers, timeout: 15000 });

  const records = list.data?.data?.Data || [];
  const results = { total: records.length, updated: 0, failed: [] };
  for (const r of records) {
    const id = r[`customobject${BRIEF_OBJECT_TYPE}id`];
    if (!id) continue;
    try {
      await syncIframeForRecord(id);
      results.updated += 1;
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }
  return results;
}

module.exports = {
  triggerGenerationFromFireberry,
  getSessionForRecord,
  saveDecision,
  syncIframeForRecord,
  syncIframeForAllRecords,
  // exported for tests / introspection / debug endpoint
  _getCustomerRecord: getCustomerRecord,
  _mapToWowBrief: mapToWowBrief,
  _FIREBERRY_FIELD_MAP: FIREBERRY_FIELD_MAP,
  _FIELDS_ON_BRIEF: FIELDS_ON_BRIEF,
  _FIELDS_ON_CUSTOMER: FIELDS_ON_CUSTOMER,
  _BRIEF_OBJECT_TYPE: BRIEF_OBJECT_TYPE,
  _CUSTOMER_OBJECT_TYPE: CUSTOMER_OBJECT_TYPE,
};
