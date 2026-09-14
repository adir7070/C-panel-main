const axios = require("axios");
const { getCustomerByPhone } = require("./fireberry-customers.service");

const BASE_URL = "https://api.powerlink.co.il/api";
const MASTER_OBJECT_TYPE = 76;

function getAuthHeaders() {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN is not set");
  return { tokenid: token, "Content-Type": "application/json" };
}

/**
 * מחזיר רשומת מאסטר (אובייקט 76) לפי accountid.
 */
async function getMasterByAccountId(accountid) {
  const headers = getAuthHeaders();

  const payload = {
    objecttype: MASTER_OBJECT_TYPE,
    page_size: 10,
    page_number: 1,
    query: `(pcfsystemfield100 = ${accountid})`,
  };

  console.log(`🎨 [Master] querying objecttype=76 pcfsystemfield100=${accountid}`);

  let response;
  try {
    response = await axios.post(`${BASE_URL}/query`, payload, { headers, timeout: 10000 });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[Master] network error:", details);
    throw new Error(`Fireberry master network error: ${JSON.stringify(details)}`);
  }

  const { success, error_details, data } = response.data;

  if (!success) {
    console.error("[Master] query failed:", JSON.stringify(error_details));
    throw new Error(`Fireberry master query failed: ${JSON.stringify(error_details)}`);
  }

  const records = data?.Data || [];
  console.log(`🎨 [Master] found ${records.length} record(s) for accountid=${accountid}`);

  if (records.length === 0) return null;

  const r = records[0];
  let copyItems = [];
  if (r.pcfsystemfield128) {
    try {
      copyItems = JSON.parse(r.pcfsystemfield128);
    } catch {
      console.warn("[Master] failed to parse pcfsystemfield128");
    }
  }

  return {
    id: r.articleid || null,
    statuscode: r.articlesubject ?? null,
    copy: copyItems,
  };
}

/**
 * מחפש לפי טלפון → מוצא accountid → מושך רשומת מאסטר.
 */
async function getMasterByPhone(phone) {
  const customer = await getCustomerByPhone(phone);
  if (!customer?.accountid) {
    console.warn(`🎨 [Master] no accountid found for phone=${phone}`);
    return null;
  }
  return getMasterByAccountId(customer.accountid);
}

/**
 * מעדכן statuscode על אובייקט 76.
 */
async function updateMasterStatus(masterId, statusCode) {
  const headers = getAuthHeaders();
  console.log(`🎨 [Master] Updating master ${masterId} → statuscode=${statusCode}`);
  try {
    await axios.put(
      `${BASE_URL}/record/${MASTER_OBJECT_TYPE}/${masterId}`,
      { articlesubject: statusCode },
      { headers, timeout: 10000 },
    );
    console.log(`🎨 [Master] ✅ Status updated to ${statusCode}`);
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[Master] status update error:", details);
    throw new Error(`Fireberry master status update failed: ${JSON.stringify(details)}`);
  }
}

/**
 * מעדכן את pcfsystemfield128 (מערך JSON של קופי).
 */
async function updateMasterCopy(masterId, copyItems) {
  const headers = getAuthHeaders();
  console.log(`🎨 [Master] Updating copy for master ${masterId}`);
  try {
    await axios.put(
      `${BASE_URL}/record/${MASTER_OBJECT_TYPE}/${masterId}`,
      { pcfsystemfield128: JSON.stringify(copyItems) },
      { headers, timeout: 10000 },
    );
    console.log(`🎨 [Master] ✅ Copy updated`);
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[Master] copy update error:", details);
    throw new Error(`Fireberry master copy update failed: ${JSON.stringify(details)}`);
  }
}

module.exports = { getMasterByPhone, updateMasterStatus, updateMasterCopy };
