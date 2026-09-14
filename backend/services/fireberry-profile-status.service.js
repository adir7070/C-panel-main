/**
 * fireberry-profile-status.service.js
 *
 * Updates pcfsystemfield135 on the "ניהול לקוח" (object 1005) record
 * linked to a customer, based on the completeness of their app profile:
 *
 *   1 = missing logo
 *   2 = missing profile brief (other fields incomplete, logo present)
 *   3 = missing service images (profile complete)
 *   4 = everything complete
 */

const axios = require("axios");
const { getCustomerByPhone } = require("./fireberry-customers.service");

const BASE_URL = "https://api.powerlink.co.il/api";
const MANAGEMENT_OBJECT_TYPE = 1005;
const STATUS_FIELD = "pcfsystemfield135";
// pcfsystemfield100 on object 1005 = lookup to לקוח (object 1)
const CUSTOMER_LOOKUP_FIELD = "pcfsystemfield100";

function getAuthHeaders() {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN is not set");
  return { tokenid: token, "Content-Type": "application/json" };
}

async function getManagementRecordByAccountId(accountid) {
  let response;
  try {
    response = await axios.post(
      `${BASE_URL}/query`,
      {
        objecttype: MANAGEMENT_OBJECT_TYPE,
        page_size: 1,
        page_number: 1,
        query: `(${CUSTOMER_LOOKUP_FIELD} = ${accountid})`,
      },
      { headers: getAuthHeaders(), timeout: 10000 },
    );
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[ProfileStatus] network error querying object 1005:", details);
    throw new Error(`Fireberry network error: ${JSON.stringify(details)}`);
  }

  const { success, error_details, data } = response.data;
  if (!success) {
    console.error("[ProfileStatus] query 1005 failed:", JSON.stringify(error_details));
    throw new Error(`Fireberry query 1005 failed: ${JSON.stringify(error_details)}`);
  }

  return data?.Data?.[0] || null;
}

/**
 * Finds the ניהול לקוח record for the given phone and updates pcfsystemfield135.
 *
 * @param {string} phone  - Customer phone in any common format
 * @param {1|2|3|4} status
 */
async function updateProfileStatus(phone, status) {
  if (!phone) throw new Error("phone is required");
  if (![1, 2, 3, 4].includes(Number(status))) {
    throw new Error(`Invalid status value: ${status}. Must be 1–4.`);
  }

  const customer = await getCustomerByPhone(phone);
  if (!customer?.accountid) {
    console.warn(`[ProfileStatus] no Fireberry customer found for phone=${phone}`);
    return { ok: false, reason: "customer_not_found" };
  }

  const mgmtRecord = await getManagementRecordByAccountId(customer.accountid);
  if (!mgmtRecord) {
    console.warn(
      `[ProfileStatus] no ניהול לקוח record (object 1005) for accountid=${customer.accountid}`,
    );
    return { ok: false, reason: "management_record_not_found" };
  }

  const pkField = `customobject${MANAGEMENT_OBJECT_TYPE}id`;
  const recordId = mgmtRecord[pkField];
  if (!recordId) {
    console.warn(`[ProfileStatus] record has no ${pkField} field`);
    return { ok: false, reason: "record_id_missing" };
  }

  try {
    await axios.put(
      `${BASE_URL}/record/${MANAGEMENT_OBJECT_TYPE}/${recordId}`,
      { [STATUS_FIELD]: Number(status) },
      { headers: getAuthHeaders(), timeout: 10000 },
    );
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[ProfileStatus] PUT error:", details);
    throw new Error(`Fireberry update failed: ${JSON.stringify(details)}`);
  }

  console.log(
    `[ProfileStatus] ✅ phone=${phone} accountid=${customer.accountid} recordId=${recordId} → ${STATUS_FIELD}=${status}`,
  );
  return { ok: true, recordId, status: Number(status) };
}

module.exports = { updateProfileStatus };
