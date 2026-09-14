/* ── Fireberry is retired ────────────────────────────────────────────
   The Fireberry CRM was decommissioned with the Iconiq shutdown. This
   module is kept only so the ~20 legacy requires across the repo keep
   resolving; every call now fails fast and locally instead of reaching
   api.powerlink.co.il. Nothing in the C-panel path calls it any more.
   (Setting FIREBERRY_TOKEN does NOT re-enable it — delete this guard.) */
const FIREBERRY_RETIRED_ERROR = () => {
  const e = new Error("Fireberry integration has been removed");
  e.code = "fireberry_disabled";
  return e;
};

const axios = require("axios");

const BASE_URL = "https://api.powerlink.co.il/api";
const FIREBERRY_API_URL = `${BASE_URL}/query`;
const FIREBERRY_OBJECT_TYPE = 1013;

/**
 * Query Fireberry CRM records
 */
async function queryFireberry(fields, query, pageSize = 1) {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in environment");

  const response = await axios.post(
    FIREBERRY_API_URL,
    {
      objecttype: FIREBERRY_OBJECT_TYPE,
      page_size: pageSize,
      page_number: 1,
      fields,
      query,
    },
    {
      headers: {
        tokenid: token,
        "Content-Type": "application/json",
      },
    },
  );

  return response.data;
}

// Field names in Fireberry objecttype 1013
const PHONE_FIELD = "pcfsystemfield110";       // טלפון לשליחת לידים
const EXPO_TOKEN_FIELD = "pcfsystemfield107";  // expo token
const WA_TOKEN_FIELD = "pcfsystemfield119";    // ווצאפ session_id (token)
const WA_MESSAGE_FIELD = "pcfsystemfield120";  // הודעה אוטומטית
const CHAT_ACTIVE_FIELD = "pcfsystemfield122"; // האם לקוח השתמש בצ'אט
const USER_TOKEN_FIELD = "pcfsystemfield100";  // user token (Facebook)
const PAGE_ID_FIELD = "pcfsystemfield104";     // page id
const IG_TOKEN_FIELD = "pcfsystemfield121";    // instagram token

/**
 * Build all phone variants for Fireberry query:
 * 972501234567 / 0501234567 / 501234567
 */
function buildPhoneQuery(phone) {
  const digits = phone.replace(/\D/g, "");

  // Extract the 9-digit core (5XXXXXXXX)
  let core = null;
  if (digits.startsWith("972") && digits.length === 12) {
    core = digits.slice(3);                   // 972501234567 → 501234567
  } else if (digits.startsWith("0") && digits.length === 10) {
    core = digits.slice(1);                   // 0501234567   → 501234567
  } else if (digits.length === 9 && digits.startsWith("5")) {
    core = digits;                            // 501234567    → 501234567
  }

  const variants = new Set([digits]);
  if (core) {
    variants.add("972" + core);               // 972501234567
    variants.add("0" + core);                 // 0501234567 (05 format)
    variants.add(core);                       // 501234567
  }

  // Phone is stored as a string in Fireberry — values MUST be single-quoted.
  // Unquoted numerics are parsed as integers and never match.
  return [...variants].map((v) => `(${PHONE_FIELD} = '${v}')`).join(" OR ");
}

/**
 * Get Expo push token for a user by phone number from Fireberry
 */
async function getPushTokenByPhone(phone) {
  const query = buildPhoneQuery(phone);
  const data = await queryFireberry(EXPO_TOKEN_FIELD, query);

  const records = data?.data?.Data || [];
  if (records.length === 0) {
    console.log(`[Fireberry] No record found for phone: ${phone}`);
    return null;
  }

  const token = records[0][EXPO_TOKEN_FIELD] || null;
  console.log(`[Fireberry] Token for ${phone}: ${token}`);
  return token;
}

/**
 * Find the objecttype 1013 record ID by phone number.
 */
async function findRecordByPhone(phone) {
  const query = buildPhoneQuery(phone);
  const data = await queryFireberry("customobject1013id", query);
  const records = data?.data?.Data || [];
  return records[0]?.customobject1013id || null;
}

/**
 * Update WhatsApp fields in Fireberry objecttype 1013.
 * @param {string} phone - User's phone number (for lookup)
 * @param {{ sessionId?: string, message?: string }} fields
 */
async function updateWaFields(phone, { sessionId, message } = {}) {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in environment");

  const recordId = await findRecordByPhone(phone);
  if (!recordId) {
    console.log(`[Fireberry] No 1013 record found for phone: ${phone}`);
    return;
  }

  const body = {};
  if (sessionId) body[WA_TOKEN_FIELD] = sessionId;
  if (message !== undefined) body[WA_MESSAGE_FIELD] = message;

  if (Object.keys(body).length === 0) return;

  await axios.put(
    `${BASE_URL}/record/${FIREBERRY_OBJECT_TYPE}/${recordId}`,
    body,
    {
      headers: {
        tokenid: token,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );
  console.log(`[Fireberry] Updated WA fields for ${phone} (record ${recordId})`);
}

/**
 * Mark a customer as active chat user in Fireberry (pcfsystemfield122 = "כן").
 */
async function markChatActive(phone) {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in environment");

  const recordId = await findRecordByPhone(phone);
  if (!recordId) {
    console.log(`[Fireberry] No 1013 record found for phone: ${phone}`);
    return;
  }

  await axios.put(
    `${BASE_URL}/record/${FIREBERRY_OBJECT_TYPE}/${recordId}`,
    { [CHAT_ACTIVE_FIELD]: "כן" },
    {
      headers: {
        tokenid: token,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );
  console.log(`[Fireberry] Marked chat active for ${phone} (record ${recordId})`);
}

/**
 * Update page ID in Fireberry by user token.
 * Finds the 1013 record where pcfsystemfield100 = userToken,
 * then sets pcfsystemfield104 = pageId.
 */
async function updatePageIdByToken(userToken, pageId) {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in environment");

  const query = `(${USER_TOKEN_FIELD} = ${userToken})`;
  const data = await queryFireberry("customobject1013id", query);
  const records = data?.data?.Data || [];
  const recordId = records[0]?.customobject1013id || null;

  if (!recordId) {
    console.log(`[Fireberry] No 1013 record found for user token`);
    return null;
  }

  await axios.put(
    `${BASE_URL}/record/${FIREBERRY_OBJECT_TYPE}/${recordId}`,
    { [PAGE_ID_FIELD]: pageId },
    {
      headers: {
        tokenid: token,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );
  console.log(`[Fireberry] Updated page ID to ${pageId} (record ${recordId})`);
  return recordId;
}

/**
 * Update Instagram token in Fireberry by phone number.
 */
async function updateInstagramToken(phone, igToken) {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in environment");

  const recordId = await findRecordByPhone(phone);
  if (!recordId) {
    console.log(`[Fireberry] No 1013 record found for phone: ${phone}`);
    return null;
  }

  await axios.put(
    `${BASE_URL}/record/${FIREBERRY_OBJECT_TYPE}/${recordId}`,
    { [IG_TOKEN_FIELD]: igToken },
    {
      headers: {
        tokenid: token,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );
  console.log(`[Fireberry] Updated Instagram token for ${phone} (record ${recordId})`);
  return recordId;
}

/**
 * Get Instagram token for a user by phone number from Fireberry.
 */
async function getInstagramTokenByPhone(phone) {
  const query = buildPhoneQuery(phone);
  const data = await queryFireberry(IG_TOKEN_FIELD, query);
  const records = data?.data?.Data || [];
  if (records.length === 0) return null;
  return records[0][IG_TOKEN_FIELD] || null;
}

/**
 * Get client status field (pcfsystemfield115) by phone.
 * Returns 3 for "קליק" clients, null if not found.
 */
async function getClientStatusByPhone(phone) {
  const query = buildPhoneQuery(phone);
  const data = await queryFireberry("pcfsystemfield115", query);
  const records = data?.data?.Data || [];
  console.log(`[Fireberry] getClientStatusByPhone ${phone}: ${records.length} records found`);
  if (records.length === 0) return null;
  const raw = records[0]["pcfsystemfield115"] ?? null;
  console.log(`[Fireberry] pcfsystemfield115 raw value: ${JSON.stringify(raw)}`);
  return raw;
}

/**
 * Clear Facebook user token (pcfsystemfield100) in Fireberry by phone.
 * Called when the token is expired or missing on login.
 */
async function clearUserTokenByPhone(phone) {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in environment");

  const recordId = await findRecordByPhone(phone);
  if (!recordId) {
    console.log(`[Fireberry] No 1013 record found for phone: ${phone}`);
    return;
  }

  await axios.put(
    `${BASE_URL}/record/${FIREBERRY_OBJECT_TYPE}/${recordId}`,
    { [USER_TOKEN_FIELD]: "" },
    {
      headers: {
        tokenid: token,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );
  console.log(`[Fireberry] Cleared user token for ${phone} (record ${recordId})`);
}

const WOW_FEEDBACK_FIELD = "pcfsystemfield124";

async function saveWowFeedback(phone, comment) {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in environment");
  const recordId = await findRecordByPhone(phone);
  if (!recordId) {
    console.log(`[Fireberry] No 1013 record found for phone: ${phone}`);
    return;
  }
  await axios.put(
    `${BASE_URL}/record/${FIREBERRY_OBJECT_TYPE}/${recordId}`,
    { [WOW_FEEDBACK_FIELD]: comment },
    { headers: { tokenid: token, "Content-Type": "application/json" }, timeout: 10000 },
  );
  console.log(`[Fireberry] Saved WOW feedback for ${phone}`);
}

module.exports = {
  queryFireberry: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  getPushTokenByPhone: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  findRecordByPhone: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  getClientStatusByPhone: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  saveWowFeedback: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  updateWaFields: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  markChatActive: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  updatePageIdByToken: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  updateInstagramToken: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  getInstagramTokenByPhone: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  clearUserTokenByPhone: async () => { throw FIREBERRY_RETIRED_ERROR(); },
};
