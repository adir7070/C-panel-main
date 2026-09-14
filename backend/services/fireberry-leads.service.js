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

/**
 * fireberry-leads.service — Iconiq's incoming-lead pool from Fireberry.
 *
 * Leads are stored in Fireberry as objecttype 1 (Account) records — the
 * same shape as customers. We used to default-filter by `statuscode = 1`
 * (assumed to mean "חדש") but that broke once Fireberry's status mapping
 * shifted: their saved "1.חדש" view kept showing 168 leads while our
 * API query returned 0, because the records no longer carried statuscode
 * value 1.
 *
 * Decision: drop the default filter. We now return every account from
 * Fireberry and rely on the local `lead_assignments` collection (already
 * applied by the controller) to hide leads that were already distributed.
 * Admins can narrow down via the UI filters: free-text search, date
 * range, business field, business type. They can also still set the
 * FIREBERRY_LEADS_QUERY env var to a custom Fireberry query string if
 * they want a server-side baseline filter.
 *
 * Pagination is delegated to Fireberry — page_size + page_number — so we
 * never load the full set into memory.
 */

/* Empty default = no baseline filter (return everything). Override via
   FIREBERRY_LEADS_QUERY env var if a baseline is needed in production. */
const DEFAULT_LEADS_QUERY = "";

const axios = require("axios");

const FIREBERRY_URL = "https://api.powerlink.co.il/api/query";
const ACCOUNT_OBJECT_TYPE = 1;

/* Fields we surface to the admin panel. Add more if the UI needs them.
   Note: Fireberry/Powerlink doesn't implement all Microsoft-Dynamics-
   style field names — `address1_city` and `industrycode` were rejected
   by their /query endpoint and 500'd the whole request. Sticking to
   fields we've verified work on this tenant. To reintroduce city /
   industry, add the actual `pcfsystemfield____` codes via Fireberry's
   Object Designer once we know them. */
const LEAD_FIELDS = [
  /* Identity + timing */
  "accountid",
  "accountname",
  "createdon",
  "modifiedon",         // last-touched timestamp (stale-lead indicator)
  "statuscode",
  /* Ownership — the head manager assigns leads to account managers via
     Fireberry's Owner field. We resolve ownerid → our agent via the
     `fireberryOwnerId` field on the `agents` collection so assignments
     made in Fireberry flow back into cpanel_clients automatically.
     NOTE: only `ownerid` is queryable on this tenant — `owneridname`
     blew up the whole /query call with 500 (same failure mode as
     `address1_city` documented above). For unmapped-owner samples we
     just surface the UUID; that's enough for the admin to identify
     which managers still need a fireberryOwnerId set. */
  "ownerid",
  /* Contact — these standard fields exist on every Fireberry account */
  "telephone1",
  "telephone2",         // second phone
  "emailaddress1",      // email (often filled by FB lead form)
  "websiteurl",         // website
  /* Free-text */
  "description",        // free-text notes Fireberry stores natively
  /* Custom fields (user's tenant) */
  "pcfsystemfield1439", // תחום עיסוק
  "pcfsystemfield1480", // סוג העסק
  "systemfield10",      // פרטי הליד
  "pcfsystemfield124",  // כמה זמן העסק קיים
].join(",");

function authHeaders() {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in environment");
  return { tokenid: token, "Content-Type": "application/json" };
}

/**
 * Build the final Fireberry query string from filters supplied by the
 * admin UI plus the optional baseline filter from the env var. We AND
 * everything together — Fireberry tolerates parens around clauses.
 */
function buildLeadsQuery({ search, fromDate, toDate, businessField, businessType, ownerid }) {
  const parts = [];
  const baseline = (process.env.FIREBERRY_LEADS_QUERY || DEFAULT_LEADS_QUERY).trim();
  if (baseline) parts.push(`(${baseline})`);

  if (search && search.trim()) {
    const s = search.trim().replace(/"/g, "");
    /* Free-text: name OR phone (contains both ways). */
    parts.push(`((accountname contains "${s}") OR (telephone1 contains "${s}"))`);
  }
  if (fromDate) parts.push(`(createdon >= '${fromDate}')`);
  if (toDate)   parts.push(`(createdon <= '${toDate}')`);
  if (businessField) parts.push(`(pcfsystemfield1439 = '${businessField}')`);
  if (businessType)  parts.push(`(pcfsystemfield1480 = '${businessType}')`);
  /* Owner filter — used by the diagnostic endpoint to count per-agent
     assignments straight from Fireberry. CRITICAL: UUIDs go UNQUOTED
     in Fireberry's query language (see fireberry-meetings.service.js
     using `resource = <uuid>` without quotes). Wrapping in single
     quotes silently turns the filter into a no-op — Fireberry then
     returns every record and we hit the pagination cap. */
  if (ownerid) parts.push(`(ownerid = ${ownerid})`);

  return parts.join(" AND ");
}

/**
 * Fetch a page of leads from Fireberry.
 *   pageNumber starts at 1.
 *   Returns { rows, totalCount? } — Fireberry's total isn't always populated;
 *   the UI falls back to "load more" if it's missing.
 */
async function listLeads({
  pageSize = 50,
  pageNumber = 1,
  search = "",
  fromDate = "",
  toDate = "",
  businessField = "",
  businessType = "",
} = {}) {
  const query = buildLeadsQuery({ search, fromDate, toDate, businessField, businessType });

  const body = {
    objecttype: ACCOUNT_OBJECT_TYPE,
    page_size: Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200),
    page_number: Math.max(parseInt(pageNumber, 10) || 1, 1),
    fields: LEAD_FIELDS,
    query,
    /* Newest first — admins want fresh leads at the top. */
    sort_by: "createdon",
    sort_type: "desc",
  };

  let resp;
  try {
    resp = await axios.post(FIREBERRY_URL, body, { headers: authHeaders() });
  } catch (err) {
    /* Fireberry returns useful error detail in response.data — surface
       it instead of the generic axios "Request failed with status 500".
       Saves a round of "what went wrong?" debugging next time the field
       list contains an unrecognized name. */
    const fbDetail = err?.response?.data;
    const fbMessage = typeof fbDetail === "string"
      ? fbDetail
      : fbDetail?.message || fbDetail?.error || JSON.stringify(fbDetail || {});
    throw new Error(`Fireberry /query failed: ${err.message}${fbMessage ? ` — ${fbMessage}` : ""}`);
  }
  const data = resp.data?.data || {};
  return {
    rows:       Array.isArray(data.Data) ? data.Data : [],
    totalCount: typeof data.Total_no_of_pages === "number" ? data.Total_no_of_pages * body.page_size : null,
    pageSize:   body.page_size,
    pageNumber: body.page_number,
  };
}

module.exports = {
  listLeads: async () => { throw FIREBERRY_RETIRED_ERROR(); },
  LEAD_FIELDS: async () => { throw FIREBERRY_RETIRED_ERROR(); },
};
