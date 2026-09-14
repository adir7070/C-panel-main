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
const CUSTOMER_OBJECT_TYPE = 1;

/**
 * Build Axios headers for the Fireberry API.
 */
function getAuthHeaders() {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token)
    throw new Error("FIREBERRY_TOKEN is not set in environment variables");
  return {
    tokenid: token,
    "Content-Type": "application/json",
  };
}

/**
 * Build an OR query covering the three common phone formats:
 * 972XXXXXXXXX / 0XXXXXXXXX / XXXXXXXXX
 */
function buildPhoneQuery(phone) {
  const digits = phone.replace(/\D/g, "");

  let core = null;
  if (digits.startsWith("972") && digits.length === 12) {
    core = digits.slice(3);
  } else if (digits.startsWith("0") && digits.length === 10) {
    core = digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith("5")) {
    core = digits;
  }

  const variants = new Set([digits]);
  if (core) {
    variants.add("972" + core);
    variants.add("0" + core);
    variants.add(core);
    variants.add("+972" + core);
  }

  const PHONE_FIELDS = [
    "telephone1",
    "telephone2",
    "telephone3",
    "pcfsystemfield104",
    "pcfsystemfield1478",
  ];
  const WA_FIELDS = ["pcfLinktowhatsapp"];
  const exactClauses = [...variants].flatMap((v) =>
    PHONE_FIELDS.map((f) => `(${f} = ${v})`),
  );
  const containsClauses = core
    ? [...PHONE_FIELDS, ...WA_FIELDS].map((f) => `(${f} contains "${core}")`)
    : [];
  return [...exactClauses, ...containsClauses].join(" OR ");
}

function buildPhoneQueryFor1013(phone) {
  const digits = phone.replace(/\D/g, "");
  let core = null;
  if (digits.startsWith("972") && digits.length === 12) core = digits.slice(3);
  else if (digits.startsWith("0") && digits.length === 10)
    core = digits.slice(1);
  else if (digits.length === 9 && digits.startsWith("5")) core = digits;
  const variants = new Set([digits]);
  if (core) {
    variants.add("972" + core);
    variants.add("0" + core);
    variants.add(core);
  }
  // Phone stored as string in Fireberry — values MUST be single-quoted.
  return [...variants].map((v) => `(pcfsystemfield110 = '${v}')`).join(" OR ");
}

/**
 * Look up a Fireberry customer (objecttype 1) by phone number.
 * Tries three phone variants to handle format differences.
 *
 * @param {string} phone - Customer phone number in any common format
 * @returns {Promise<{accountid: string, accountname: string, telephone1: string} | null>}
 */
async function getCustomerByPhone(phone) {
  if (!phone || typeof phone !== "string" || !phone.trim()) {
    throw new Error("phone is required and must be a non-empty string");
  }

  const headers = getAuthHeaders();
  const query = buildPhoneQuery(phone);
  const payload = {
    objecttype: CUSTOMER_OBJECT_TYPE,
    page_size: 1,
    page_number: 1,
    query,
  };

  let response;
  try {
    response = await axios.post(`${BASE_URL}/query`, payload, {
      headers,
      timeout: 15000,
    });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error(
      "[FireberryCustomers] Network error on getCustomerByPhone:",
      details,
    );
    throw new Error(`Fireberry network error: ${JSON.stringify(details)}`);
  }

  const { success, error_details, data } = response.data;

  if (!success) {
    console.error(
      "[FireberryCustomers] CRM returned success=false:",
      error_details,
    );
    throw new Error(`Fireberry query failed: ${JSON.stringify(error_details)}`);
  }

  let record = data?.Data?.[0];
  if (!record) {
    // Fallback: look up in objecttype 1013 (WA/app users) by WA phone field (pcfsystemfield110)
    // then fetch the linked customer by accountid
    const token1013 = process.env.FIREBERRY_TOKEN;
    const res1013Raw = await axios.post(
      `${BASE_URL}/query`,
      {
        objecttype: 1013,
        page_size: 1,
        page_number: 1,
        query: buildPhoneQueryFor1013(phone),
      },
      {
        headers: { tokenid: token1013, "Content-Type": "application/json" },
        timeout: 10000,
      },
    );
    const res1013 = res1013Raw.data;
    const raw1013 = res1013?.data?.Data?.[0];
    if (!raw1013) return null;
    // pcfsystemfield106 = lookup לקוח (objecttype 1) מתוך רשומת 1013
    const linkedAccountId = raw1013.pcfsystemfield106 || null;
    if (!linkedAccountId) return null;

    // Fetch the customer from objecttype 1 by accountid
    const custResp = await axios.post(
      `${BASE_URL}/query`,
      {
        objecttype: CUSTOMER_OBJECT_TYPE,
        page_size: 1,
        page_number: 1,
        query: `(accountid = ${linkedAccountId})`,
      },
      { headers, timeout: 10000 },
    );
    record = custResp.data?.data?.Data?.[0];
    if (!record) return null;
  }

  return {
    accountid: record.accountid,
    accountname: record.accountname || null,
    firstname: record.firstname || null,
    bizname: record.pcfsystemfield1475 || null,
    telephone1: record.telephone1 || null,
    telephone2: record.telephone2 || null,
    driveUrl: record.pcfsystemfield114 || null,
    logoUrl: record.pcfsystemfield1445 || null,
    websiteUrl: record.websiteurl || null,
    email:       record.emailaddress1    || null,
    vatId:       record.pcfsystemfield35 || null,
    invoiceName: record.idnumber         || null,
    city: record.address1_city || null,
    saleRef: record.pcfsystemfield1441 || null,
    saleName: record["pcfsystemfield1441name"] || null,
    saleDate: record.pcfsystemfield1434 || null,
    saleStatusCode: record.statuscode || null,
    saleStatusName: record.statuscodename || null,
    saleAmount: record.revenue || null,
    hasLogo: record.pcfsystemfield1456 == 2 || null,
  };
}

/**
 * Search Fireberry customers by name or phone (up to 8 results).
 * - If the query looks like a phone (digits / +) → search by telephone1
 * - Otherwise → search by accountname (contains)
 *
 * @param {string} query - Free-text search term (name or phone)
 * @returns {Promise<Array<{accountid, accountname, telephone1}>>}
 */
async function searchCustomers(query) {
  if (!query || typeof query !== "string" || !query.trim()) return [];

  const q = query.trim();
  const headers = getAuthHeaders();

  // Detect phone-like input: mostly digits / dashes / + / spaces
  const isPhone = /^[\d\s\-+]{4,}$/.test(q);

  let queryStr;
  if (isPhone) {
    queryStr = buildPhoneQuery(q);
  } else {
    queryStr = `(accountname contains "${q.replace(/"/g, "")}")`;
  }

  const payload = {
    objecttype: CUSTOMER_OBJECT_TYPE,
    page_size: 8,
    page_number: 1,
    query: queryStr,
  };

  let response;
  try {
    response = await axios.post(`${BASE_URL}/query`, payload, {
      headers,
      timeout: 10000,
    });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error(
      "[FireberryCustomers] Network error on searchCustomers:",
      details,
    );
    return [];
  }

  const { success, data } = response.data;
  if (!success || !data?.Data) return [];

  return data.Data.map((r) => ({
    accountid: r.accountid,
    accountname: r.accountname || null,
    telephone1: r.telephone1 || null,
  }));
}

/**
 * Fetch all characterization fields for a customer by phone.
 * Used to pre-fill the snake flow in the app.
 *
 * @param {string} phone - Customer phone number in any common format
 * @returns {Promise<Record<string, string|null> | null>}
 */
async function getCharacterizationByPhone(phone) {
  if (!phone || typeof phone !== "string" || !phone.trim()) {
    throw new Error("phone is required and must be a non-empty string");
  }

  const CHARACTERIZATION_FIELDS = [
    "idnumber",
    "pcfsystemfield1475", // שם העסק
    "pcfsystemfield1457",
    "pcfsystemfield1448",
    "pcfsystemfield1460",
    "pcfsystemfield1459",
    "billingstate",
    "pcfsystemfield1467",
    "pcfsystemfield1468",
    "pcfsystemfield1464",
    "pcfsystemfield1449",
    "pcfsystemfield1490",
    "pcfsystemfield1491",
    "pcfsystemfield1492",
    "pcfsystemfield1495",
    "pcfsystemfield1453",
    "pcfsystemfield1485",
    "billingcountry",
    "fax1",
    "telephone1",
    "emailaddress1",
    "pcfsystemfield1494",
    "pcfsystemfield1474",
  ];

  const headers = getAuthHeaders();
  const query = buildPhoneQuery(phone);
  const payload = {
    objecttype: CUSTOMER_OBJECT_TYPE,
    page_size: 1,
    page_number: 1,
    fields: CHARACTERIZATION_FIELDS.join(","),
    query,
  };

  let response;
  try {
    response = await axios.post(`${BASE_URL}/query`, payload, {
      headers,
      timeout: 15000,
    });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error(
      "[FireberryCustomers] Network error on getCharacterizationByPhone:",
      details,
    );
    throw new Error(`Fireberry network error: ${JSON.stringify(details)}`);
  }

  const { success, error_details, data } = response.data;

  if (!success) {
    console.error(
      "[FireberryCustomers] CRM returned success=false:",
      error_details,
    );
    throw new Error(`Fireberry query failed: ${JSON.stringify(error_details)}`);
  }

  let record = data?.Data?.[0];
  if (!record) {
    // Fallback: objecttype 1013 → linked customer
    const res1013Raw = await axios.post(
      `${BASE_URL}/query`,
      {
        objecttype: 1013,
        page_size: 1,
        page_number: 1,
        query: buildPhoneQueryFor1013(phone),
      },
      { headers, timeout: 10000 },
    );
    const raw1013 = res1013Raw.data?.data?.Data?.[0];
    if (!raw1013) return null;
    const linkedAccountId = raw1013.pcfsystemfield106 || null;
    if (!linkedAccountId) return null;

    const custResp = await axios.post(
      `${BASE_URL}/query`,
      {
        objecttype: CUSTOMER_OBJECT_TYPE,
        page_size: 1,
        page_number: 1,
        fields: CHARACTERIZATION_FIELDS.join(","),
        query: `(accountid = ${linkedAccountId})`,
      },
      { headers, timeout: 10000 },
    );
    record = custResp.data?.data?.Data?.[0];
    if (!record) return null;
  }

  const result = {};
  for (const field of CHARACTERIZATION_FIELDS) {
    result[field] = record[field] || null;
  }
  return result;
}

/**
 * Create a new Fireberry customer (objecttype 1).
 * Only the provided fields are sent. Returns the new accountid.
 *
 * @param {{ accountname?: string, idnumber?: string, telephone1?: string, statuscode?: number }} fields
 * @returns {Promise<string|null>} the new accountid, or null if creation returned no ID
 */
async function createCustomer(fields = {}) {
  const headers = getAuthHeaders();

  const body = {};
  if (fields.accountname != null) body.accountname = fields.accountname;
  if (fields.idnumber != null) body.idnumber = fields.idnumber;
  if (fields.telephone1 != null) body.telephone1 = fields.telephone1;
  if (fields.statuscode != null) body.statuscode = fields.statuscode;

  let response;
  try {
    response = await axios.post(`${BASE_URL}/record/${CUSTOMER_OBJECT_TYPE}`, body, {
      headers,
      timeout: 15000,
    });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[FireberryCustomers] Network error on createCustomer:", details);
    throw new Error(`Fireberry create error: ${JSON.stringify(details)}`);
  }

  const data = response.data?.data;
  const accountid = data?.Record?.accountid ?? data?.accountid ?? null;
  console.log(`[FireberryCustomers] Created customer ${accountid}`);
  return accountid;
}

module.exports = {
  getCustomerByPhone: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  searchCustomers: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  getCharacterizationByPhone: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  createCustomer: async () => { throw FIREBERRY_RETIRED_ERROR(); },
};
