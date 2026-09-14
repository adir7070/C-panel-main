const axios = require("axios");
const { getCustomerByPhone } = require("./fireberry-customers.service");

const BASE_URL = "https://api.powerlink.co.il/api";
const PROJECT_OBJECT_TYPE = 46;

function getAuthHeaders() {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN is not set");
  return { tokenid: token, "Content-Type": "application/json" };
}

/**
 * מחזיר רשימת פרויקטים (בניית אתר) לפי accountid.
 * objecttype 46
 */
async function getProjectsByAccountId(accountid) {
  const headers = getAuthHeaders();

  const payload = {
    objecttype: PROJECT_OBJECT_TYPE,
    page_size: 10,
    page_number: 1,
    query: `(accountid = ${accountid})`,
  };

  console.log(`🏗️ [Projects] querying objecttype=46 accountid=${accountid}`);

  let response;
  try {
    response = await axios.post(`${BASE_URL}/query`, payload, { headers, timeout: 10000 });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[Projects] network error:", details);
    throw new Error(`Fireberry projects network error: ${JSON.stringify(details)}`);
  }

  const { success, error_details, data } = response.data;

  if (!success) {
    console.error("[Projects] query failed:", JSON.stringify(error_details));
    throw new Error(`Fireberry projects query failed: ${JSON.stringify(error_details)}`);
  }

  const records = data?.Data || [];
  console.log(`🏗️ [Projects] found ${records.length} record(s) for accountid=${accountid}`);

  return records.map((r) => ({
    projectId:  r.id || r.pcfprojectid || r[Object.keys(r).find(k => k.endsWith("id") && k !== "accountid")] || null,
    name:       r.name || r.subject || null,
    statusCode: r.statuscode ?? null,
    statusName: r.statuscodename || r.status || null,
    createdOn:  r.createdon || null,
    wpLink:     r.pcfsystemfield119 || null,
    wpUsername: r.pcfsystemfield120 || null,
    wpPassword: r.pcfsystemfield121 || null,
  }));
}

/**
 * מחפש לפי טלפון → מוצא accountid → מושך פרויקטים.
 */
async function getProjectsByPhone(phone) {
  const customer = await getCustomerByPhone(phone);
  if (!customer?.accountid) {
    console.warn(`🏗️ [Projects] no accountid found for phone=${phone}`);
    return [];
  }
  return getProjectsByAccountId(customer.accountid);
}

/**
 * Update project status in Fireberry.
 * @param {string} projectId - Fireberry project record ID
 * @param {number} statusCode - New numeric status code
 */
async function updateProjectStatus(projectId, statusCode) {
  const headers = getAuthHeaders();
  console.log(`🏗️ [Projects] Updating project ${projectId} → statuscode=${statusCode}`);
  try {
    await axios.put(
      `${BASE_URL}/record/${PROJECT_OBJECT_TYPE}/${projectId}`,
      { statuscode: statusCode },
      { headers, timeout: 10000 },
    );
    console.log(`🏗️ [Projects] ✅ Status updated to ${statusCode}`);
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[Projects] status update error:", details);
    throw new Error(`Fireberry status update failed: ${JSON.stringify(details)}`);
  }
}

module.exports = { getProjectsByAccountId, getProjectsByPhone, updateProjectStatus };
