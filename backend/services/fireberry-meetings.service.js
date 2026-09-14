const axios = require("axios");

const BASE_URL = "https://api.powerlink.co.il/api";
const MEETINGS_OBJECT_TYPE = 6;
const DEFAULT_RESOURCE = "01fa95e1-feed-4998-a2bc-af31f654ed48";
const DEFAULT_ACTIVITY_TYPE = 308;
const DEFAULT_DAYS_BEFORE = 0;
const DEFAULT_DAYS_AHEAD = 1;

/**
 * Build the Axios headers required by the Fireberry API.
 * @returns {{ tokenid: string, organizationid: string, "Content-Type": string }}
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
 * Fetch available meetings from Fireberry CRM for a given resource and activity type.
 * Fireberry REST API does not support >= / <= on date fields, so date filtering is done in JS.
 *
 * @param {object} [options]
 * @param {number} [options.daysBefore=0]  - How many days before today to include (default: 0)
 * @param {number} [options.daysAhead=1]   - How many days ahead of today to include (default: 1 = tomorrow)
 * @param {number} [options.pageSize=200]  - Max records to fetch from API before JS filtering
 * @returns {Promise<Array<object>>}       - Array of mapped meeting objects
 */
async function fetchAvailableMeetings({
  daysBefore = DEFAULT_DAYS_BEFORE,
  daysAhead = DEFAULT_DAYS_AHEAD,
  pageSize = 200,
} = {}) {
  const headers = getAuthHeaders();

  const payload = {
    objecttype: MEETINGS_OBJECT_TYPE,
    page_size: pageSize,
    page_number: 1,
    query: `(resource = ${DEFAULT_RESOURCE} AND activitytypecode = ${DEFAULT_ACTIVITY_TYPE})`,
  };

  let response;
  try {
    response = await axios.post(`${BASE_URL}/query`, payload, {
      headers,
      timeout: 30000,
    });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error(
      "[FireberryMeetings] Network error on fetchAvailableMeetings:",
      details,
    );
    throw new Error(`Fireberry network error: ${JSON.stringify(details)}`);
  }

  const { success, error_details, data } = response.data;

  if (!success) {
    console.error(
      "[FireberryMeetings] CRM returned success=false:",
      error_details,
    );
    throw new Error(`Fireberry query failed: ${JSON.stringify(error_details)}`);
  }

  const from = new Date();
  from.setDate(from.getDate() - daysBefore);
  from.setHours(0, 0, 0, 0);

  const to = new Date();
  to.setDate(to.getDate() + daysAhead);
  to.setHours(23, 59, 59, 999);

  const records = (data?.Data || []).filter((a) => {
    if (!a.scheduledstart) return false;
    const start = new Date(a.scheduledstart);
    return start >= from && start <= to;
  });

  return records.map((a) => ({
    id: a.activityid,
    subject: a.subject,
    scheduledstart: a.scheduledstart,
    scheduledend: a.scheduledend,
    zoomLink: a.pcfsystemfield102 || null,
    resource: a.resource,
    resourceName: a.resourcename || null,
    status: a.statuscode,
    owner: a.ownerid,
  }));
}

/**
 * Create a new meeting record in Fireberry CRM.
 *
 * @param {object} params
 * @param {string} params.customerPhone   - The phone number of the customer
 * @param {string} params.scheduledStart  - ISO 8601 date string for the meeting start time
 * @returns {Promise<object>}             - The newly created meeting record from the CRM
 */
async function createMeeting({ customerPhone, scheduledStart }) {
  if (
    !customerPhone ||
    typeof customerPhone !== "string" ||
    !customerPhone.trim()
  ) {
    throw new Error("customerPhone is required and must be a non-empty string");
  }
  if (
    !scheduledStart ||
    typeof scheduledStart !== "string" ||
    isNaN(Date.parse(scheduledStart))
  ) {
    throw new Error(
      "scheduledStart is required and must be a valid ISO 8601 date string",
    );
  }

  const headers = getAuthHeaders();

  const startDate = new Date(scheduledStart);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
  const scheduledEnd = endDate.toISOString();

  const payload = {
    activitytypecode: DEFAULT_ACTIVITY_TYPE,
    resource: DEFAULT_RESOURCE,
    ownerid: DEFAULT_RESOURCE,
    subject: `פגישה ללקוח -\n - המספר שלו הוא ${customerPhone}`,
    scheduledstart: scheduledStart,
    scheduledend: scheduledEnd,
    location: 5,
  };

  let response;
  try {
    response = await axios.post(
      `${BASE_URL}/record/${MEETINGS_OBJECT_TYPE}`,
      payload,
      {
        headers,
        timeout: 15000,
      },
    );
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error(
      "[FireberryMeetings] Network error on createMeeting:",
      details,
    );
    throw new Error(`Fireberry network error: ${JSON.stringify(details)}`);
  }

  const { success, error_details, data } = response.data;

  if (!success) {
    console.error(
      "[FireberryMeetings] CRM rejected createMeeting:",
      error_details,
    );
    throw new Error(
      `Fireberry create failed: ${JSON.stringify(error_details)}`,
    );
  }

  return data?.Record || data;
}

const WORK_HOUR_FROM = 10;
const WORK_HOUR_TO   = 16;

/** ראשון–חמישי בלבד (0=Sun … 4=Thu, 5=Fri, 6=Sat) */
function isWorkingDay(date) {
  const dow = date.getDay();
  return dow !== 5 && dow !== 6;
}

/**
 * Returns an ordered array of working-day Date objects (midnight, local time):
 * daysBefore working days before today, today (if working), daysAhead working days ahead.
 * Weekends (Fri/Sat) are skipped, so Thursday+1 = Sunday.
 */
function buildWorkingDaysList(now, daysBefore, daysAhead) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  // Collect daysBefore working days before today
  const backDays = [];
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (count < daysBefore) {
    if (isWorkingDay(cursor)) { backDays.unshift(new Date(cursor)); count++; }
    cursor.setDate(cursor.getDate() - 1);
  }

  const days = [...backDays];

  // Today (if working day)
  if (isWorkingDay(today)) days.push(new Date(today));

  // Collect daysAhead working days after today
  const fwd = new Date(today);
  fwd.setDate(fwd.getDate() + 1);
  let fwdCount = 0;
  while (fwdCount < daysAhead) {
    if (isWorkingDay(fwd)) { days.push(new Date(fwd)); fwdCount++; }
    fwd.setDate(fwd.getDate() + 1);
  }

  return days;
}

/**
 * Fetch available 30-minute booking slots from Fireberry CRM.
 * Only working days (Sun–Thu) are included; weekends are skipped automatically.
 * Slots are grouped by date → hour block.
 * A slot is taken if any booked meeting's scheduledstart falls within [slot_start, slot_end).
 * Past slots on today are excluded.
 *
 * @param {object} [options]
 * @param {number} [options.daysBefore=0]  - Working days before today to include
 * @param {number} [options.daysAhead=1]   - Working days ahead of today to include
 * @returns {Promise<object>}              - { "YYYY-MM-DD": [{ hour, slots }] }
 */
async function fetchAvailableSlots({
  daysBefore = DEFAULT_DAYS_BEFORE,
  daysAhead  = DEFAULT_DAYS_AHEAD,
} = {}) {
  const now = new Date();

  const workingDays = buildWorkingDaysList(now, daysBefore, daysAhead);
  if (workingDays.length === 0) return {};

  // Compute calendar range for the Fireberry fetch
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const MS_PER_DAY = 86400000;
  const calDaysBefore = Math.round((today - workingDays[0]) / MS_PER_DAY);
  const calDaysAhead  = Math.round((workingDays[workingDays.length - 1] - today) / MS_PER_DAY);

  const bookedMeetings = await fetchAvailableMeetings({
    daysBefore: calDaysBefore,
    daysAhead:  calDaysAhead,
  });

  // Build a set of booked slot keys: "YYYY-MM-DD|HH:MM"
  const bookedSlotKeys = new Set();
  for (const m of bookedMeetings) {
    if (!m.scheduledstart) continue;
    const start = new Date(m.scheduledstart);
    const dateStr = start.toISOString().slice(0, 10);
    const minutes = start.getHours() * 60 + start.getMinutes();
    const slotMinutes = Math.floor(minutes / 30) * 30;
    const slotHour = Math.floor(slotMinutes / 60);
    const slotMin = slotMinutes % 60;
    bookedSlotKeys.add(
      `${dateStr}|${String(slotHour).padStart(2, "0")}:${String(slotMin).padStart(2, "0")}`,
    );
  }

  const result = {};

  for (const day of workingDays) {
    const dateStr = day.toISOString().slice(0, 10);
    const isToday = day.toDateString() === now.toDateString();
    const hourGroups = [];

    for (let h = WORK_HOUR_FROM; h < WORK_HOUR_TO; h++) {
      const availableSlots = [];

      for (const m of [0, 30]) {
        const slotStart = new Date(day);
        slotStart.setHours(h, m, 0, 0);

        if (isToday && slotStart <= now) continue;

        const startStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        const endH = Math.floor((h * 60 + m + 30) / 60);
        const endM = (m + 30) % 60;
        const endStr = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;

        if (!bookedSlotKeys.has(`${dateStr}|${startStr}`)) {
          availableSlots.push({ start: startStr, end: endStr, iso: slotStart.toISOString() });
        }
      }

      if (availableSlots.length > 0) {
        hourGroups.push({
          hour: `${String(h).padStart(2, "0")}:00-${String(h + 1).padStart(2, "0")}:00`,
          slots: availableSlots,
        });
      }
    }

    if (hourGroups.length > 0) result[dateStr] = hourGroups;
  }

  return result;
}

/**
 * Fetch all booked meetings for the current work week and the next work week.
 * Returns meetings grouped by date: { "YYYY-MM-DD": [meeting, ...] }
 * Each meeting contains: id, subject, scheduledstart, scheduledend, status.
 */
async function fetchWeekMeetings() {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  // Find end of next work week (Thu of next work week)
  // Walk forward until we've passed 2 full Sun-Thu cycles
  let daysAhead = 0;
  let workWeeksFound = 0;
  let lastThursday = null;
  const cursor = new Date(today);

  while (workWeeksFound < 2) {
    cursor.setDate(cursor.getDate() + 1);
    daysAhead++;
    const dow = cursor.getDay();
    if (dow === 4) { // Thursday
      lastThursday = new Date(cursor);
      workWeeksFound++;
    }
  }

  // Fetch all meetings in the range
  const meetings = await fetchAvailableMeetings({ daysBefore: 0, daysAhead });

  // Group by date
  const grouped = {};
  for (const m of meetings) {
    if (!m.scheduledstart) continue;
    const dateStr = new Date(m.scheduledstart).toISOString().slice(0, 10);
    if (!grouped[dateStr]) grouped[dateStr] = [];
    grouped[dateStr].push({
      id: m.id,
      subject: m.subject,
      scheduledstart: m.scheduledstart,
      scheduledend: m.scheduledend,
      status: m.status,
    });
  }

  // Sort meetings within each day
  for (const date of Object.keys(grouped)) {
    grouped[date].sort((a, b) => new Date(a.scheduledstart) - new Date(b.scheduledstart));
  }

  return grouped;
}

module.exports = {
  fetchAvailableMeetings,
  fetchAvailableSlots,
  fetchWeekMeetings,
  createMeeting,
};
