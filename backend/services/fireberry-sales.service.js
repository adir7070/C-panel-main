const axios = require("axios");
const { getCustomerByPhone } = require("./fireberry-customers.service");

const BASE_URL = "https://api.powerlink.co.il/api";
const SALES_OBJECT_TYPE = 4; // מכירה (Opportunity) בפיירברי

function getAuthHeaders() {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN is not set");
  return { tokenid: token, "Content-Type": "application/json" };
}

/**
 * מחזיר רשימת מכירות לפי accountid (לקוח).
 * שדות ידועים מ-objecttype 4:
 *   name              → שם העסקה
 *   status            → סטטוס (טקסט: "הוסדר תשלום")
 *   statuscode        → סטטוס (מספר: 9)
 *   pcfsystemfield42  → תאריך התחלה
 *   estimatedclosedate→ תאריך סגירה משוער
 *   pcfsystemfield105 → סכום העסקה
 *   pcfsystemfield46name → חבילה שנרכשה
 *   estimatedvalue    → סכום ששולם עד כה
 *   pcfremainmoney    → נותר לתשלום
 *   createdon         → נוצר בתאריך
 *   opportunityid     → מזהה ראשי
 */
async function getSalesByAccountId(accountid) {
  const headers = getAuthHeaders();

  const payload = {
    objecttype: SALES_OBJECT_TYPE,
    page_size: 10,
    page_number: 1,
    query: `(accountid = ${accountid})`,
  };

  console.log(`🛒 [Sales] querying objecttype=4 accountid=${accountid}`);

  let response;
  try {
    response = await axios.post(`${BASE_URL}/query`, payload, { headers, timeout: 10000 });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("[Sales] network error:", details);
    throw new Error(`Fireberry sales network error: ${JSON.stringify(details)}`);
  }

  const { success, error_details, data } = response.data;

  if (!success) {
    console.error("[Sales] query failed:", JSON.stringify(error_details));
    throw new Error(`Fireberry sales query failed: ${JSON.stringify(error_details)}`);
  }

  const records = data?.Data || [];
  console.log(`🛒 [Sales] found ${records.length} record(s) for accountid=${accountid}`);

  return records.map((r) => ({
    saleId:       r.opportunityid                     || null,
    dealName:     r.name                              || null,  // שם העסקה
    package:      r.pcfsystemfield46name              || null,  // חבילה שנרכשה
    startDate:    r.pcfsystemfield42                  || null,  // תאריך התחלה
    closeDate:    r.estimatedclosedate                || null,  // תאריך סגירה משוער
    createdOn:    r.createdon                         || null,
    statusCode:   r.statuscode                        || null,  // 9 = הוסדר תשלום
    statusName:   r.status                            || null,  // "הוסדר תשלום"
    amount:       r.pcfsystemfield105                 || null,  // סכום העסקה
    paidAmount:   r.estimatedvalue                    || null,  // סכום ששולם
    remaining:    r.pcfremainmoney                    || null,  // נותר לתשלום
  }));
}

/**
 * מחפש לפי טלפון → מוצא accountid → מושך מכירות.
 */
async function getSalesByPhone(phone) {
  const customer = await getCustomerByPhone(phone);
  if (!customer?.accountid) {
    console.warn(`🛒 [Sales] no accountid found for phone=${phone}`);
    return [];
  }
  return getSalesByAccountId(customer.accountid);
}

module.exports = { getSalesByAccountId, getSalesByPhone };
