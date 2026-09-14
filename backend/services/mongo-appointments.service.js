const { ObjectId } = require("mongodb");
const DB = require("../utils/DB");
const { filterOutHolidays } = require("../utils/hebcal");

const COLLECTION = "appointments";
const DEFAULT_WORK_HOUR_FROM = 10;
const DEFAULT_WORK_HOUR_TO = 16;

// ───────────────────────────── helpers ──────────────────────────────

function isWorkingDay(date) {
  const dow = date.getDay();
  return dow !== 5 && dow !== 6; // ראשון–חמישי בלבד
}

function buildWorkingDaysList(now, daysBefore, daysAhead) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const backDays = [];
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (count < daysBefore) {
    if (isWorkingDay(cursor)) { backDays.unshift(new Date(cursor)); count++; }
    cursor.setDate(cursor.getDate() - 1);
  }

  const days = [...backDays];
  if (isWorkingDay(today)) days.push(new Date(today));

  const fwd = new Date(today);
  fwd.setDate(fwd.getDate() + 1);
  let fwdCount = 0;
  while (fwdCount < daysAhead) {
    if (isWorkingDay(fwd)) { days.push(new Date(fwd)); fwdCount++; }
    fwd.setDate(fwd.getDate() + 1);
  }

  return days;
}

function normalizePhoneVariants(phone) {
  const digits = phone.replace(/\D/g, "");
  const variants = new Set();

  if (digits.startsWith("972")) {
    variants.add(digits);                    // 972XXXXXXXXX
    variants.add("0" + digits.slice(3));     // 0XXXXXXXXX
    variants.add(digits.slice(3));           // XXXXXXXXX
  } else if (digits.startsWith("0")) {
    variants.add("972" + digits.slice(1));   // 972XXXXXXXXX
    variants.add(digits);                    // 0XXXXXXXXX
    variants.add(digits.slice(1));           // XXXXXXXXX
  } else {
    variants.add("972" + digits);            // 972XXXXXXXXX
    variants.add("0" + digits);              // 0XXXXXXXXX
    variants.add(digits);                    // XXXXXXXXX
  }

  return [...variants];
}

/**
 * מחזיר את ה-offset של ישראל ב-UTC (2 בחורף, 3 בקיץ) לתאריך נתון.
 * משתמש ב-Intl.DateTimeFormat עם Asia/Jerusalem לטיפול אוטומטי ב-DST.
 */
function getIsraelUTCOffset(date) {
  const noon = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12));
  const israelHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }).format(noon)
  );
  return israelHour - 12; // 2 (חורף) או 3 (קיץ)
}

// ───────────────────────────── exports ──────────────────────────────

/**
 * שולף פגישות פעילות מ-MongoDB בטווח תאריכים נתון.
 * @param {{ from: Date, to: Date }} range
 * @returns {Promise<Array>}
 */
async function getBookedMeetings({ from, to }) {
  const cursor = DB.collection(COLLECTION).find({
    status: "active",
    scheduledStart: { $gte: from, $lte: to },
  });
  return cursor.toArray();
}

/**
 * מחשב סלוטים פנויים לפגישה לפי ימי עבודה.
 * @param {{ daysBefore?: number, daysAhead?: number, workHourFrom?: number, workHourTo?: number }} options
 * @returns {Promise<object>} { "YYYY-MM-DD": [{ hour, slots }] }
 */
async function fetchAvailableSlots({
  daysBefore = 0,
  daysAhead = 1,
  workHourFrom = DEFAULT_WORK_HOUR_FROM,
  workHourTo = DEFAULT_WORK_HOUR_TO,
  blockedSlots = [],
  isAgent = false,
  adminBlockedDates = new Set(), // Set<"YYYY-MM-DD"> of admin-blocked days
} = {}) {
  const now = new Date();
  const rawWorkingDays = buildWorkingDaysList(now, daysBefore, daysAhead);
  const holidayFiltered = await filterOutHolidays(rawWorkingDays);
  // סנן גם ימים שהאדמין חסם
  const workingDays = adminBlockedDates.size > 0
    ? holidayFiltered.filter(d => {
        const ds = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
        return !adminBlockedDates.has(ds);
      })
    : holidayFiltered;
  if (workingDays.length === 0) return {};

  const from = workingDays[0];
  const to = new Date(workingDays[workingDays.length - 1]);
  to.setHours(23, 59, 59, 999);

  const booked = await getBookedMeetings({ from, to });

  // לנציג: Set של ISO times לבדיקה מדויקת
  const bookedIsos = new Set(booked.map(m => new Date(m.scheduledStart).toISOString()));

  // ללקוח קצה: מערך timestamps לבדיקת חפיפה בטווח שעה
  const bookedTimestamps = isAgent ? null : booked.map(m => new Date(m.scheduledStart).getTime());

  const result = {};

  for (const day of workingDays) {
    const dateStr = [
      day.getFullYear(),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    ].join('-');
    const isToday = day.toDateString() === now.toDateString();
    const israelOffset = getIsraelUTCOffset(day); // UTC+2 (חורף) או UTC+3 (קיץ)
    const hourGroups = [];

    for (let h = workHourFrom; h < workHourTo; h++) {
      const availableSlots = [];

      if (!isAgent) {
        // ─── לקוח קצה: סלוט אחד בלבד לשעה (בדקה :00) ───────────────────
        // השעה נחסמת אם יש בה כל פגישה פעילה (כולל נציגים ב-:30)
        if (blockedSlots.some(b => b.h === h && b.m === 0)) continue;

        const utcSlotStart = new Date(Date.UTC(
          day.getFullYear(), day.getMonth(), day.getDate(),
          h - israelOffset, 0, 0, 0
        ));
        const utcHourEnd = new Date(utcSlotStart.getTime() + 60 * 60 * 1000);

        if (isToday && utcSlotStart <= now) continue;

        const hourTaken = bookedTimestamps.some(ts => ts >= utcSlotStart.getTime() && ts < utcHourEnd.getTime());
        if (!hourTaken) {
          availableSlots.push({
            start: `${String(h).padStart(2, "0")}:00`,
            end:   `${String(h + 1).padStart(2, "0")}:00`,
            iso:   utcSlotStart.toISOString(),
          });
        }
      } else {
        // ─── נציג: שני סלוטים לשעה (:00 ו-:30), כל אחד עצמאי ────────────
      for (const m of [0, 30]) {
        // בונה UTC ישיר מהשעה הישראלית — ללא תלות ב-timezone של השרת
        const utcSlotStart = new Date(Date.UTC(
          day.getFullYear(), day.getMonth(), day.getDate(),
          h - israelOffset, m, 0, 0
        ));

        if (isToday && utcSlotStart <= now) continue;
        if (bookedIsos.has(utcSlotStart.toISOString())) continue;
        if (blockedSlots.some(b => b.h === h && b.m === m)) continue;

        const startStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        const endStr   = `${String(m === 30 ? h + 1 : h).padStart(2, "0")}:${m === 30 ? "00" : "30"}`;

        availableSlots.push({ start: startStr, end: endStr, iso: utcSlotStart.toISOString() });
      }
      } // end else (isAgent)

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
 * שולף פגישות מ-MongoDB בטווח תאריכים, מקובצות לפי תאריך.
 * @param {{ fromDate: Date, toDate: Date, agentId?: string, stationId?: string, viewAll?: boolean }} params
 * @returns {Promise<object>} { "YYYY-MM-DD": [meeting, ...] }
 */
async function getMeetingsByDateRange({ fromDate, toDate, agentId, stationId, viewAll }) {
  const baseFilter = {
    status: "active",
    scheduledStart: { $gte: fromDate, $lte: toDate },
  };

  if (!viewAll && agentId) {
    baseFilter.assignedAgentId = agentId; // רק פגישות שמשויכות ישירות לנציג זה
  }

  const cursor = DB.collection(COLLECTION).find(baseFilter);
  const meetings = await cursor.toArray();

  const grouped = {};
  for (const m of meetings) {
    const d = new Date(m.scheduledStart);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!grouped[dateStr]) grouped[dateStr] = [];
    grouped[dateStr].push({
      id: m._id.toString(),
      subject: m.subject,
      customerPhone: m.customerPhone,
      scheduledstart: m.scheduledStart,
      scheduledend: m.scheduledEnd,
      status: m.status,
      zoomLink: m.zoomLink || null,
      callPurpose: m.callPurpose || null,
      assignedAgentId: m.assignedAgentId || null,
      assignedAgentName: m.assignedAgentName || null,
      assignedStationId: m.assignedStationId || null,
      meetingStatus: m.meetingStatus || null,
      notes: m.notes || '',
    });
  }

  for (const date of Object.keys(grouped)) {
    grouped[date].sort((a, b) => new Date(a.scheduledstart) - new Date(b.scheduledstart));
  }

  return grouped;
}

/**
 * יוצר פגישה חדשה ב-MongoDB.
 * @param {{ customerPhone: string, scheduledStart: string, customerName?: string, createdByRole?: string, createdByName?: string }} params
 * @returns {Promise<object>} המסמך שנוצר
 */
async function createMeeting({
  customerPhone,
  scheduledStart,
  customerName,
  callPurpose,
  assignedAgentId,
  assignedAgentName,
  assignedStationId,
  createdByRole,
  createdByName,
}) {
  if (!customerPhone || typeof customerPhone !== "string" || !customerPhone.trim()) {
    throw new Error("customerPhone is required and must be a non-empty string");
  }
  if (!scheduledStart || typeof scheduledStart !== "string" || isNaN(Date.parse(scheduledStart))) {
    throw new Error("scheduledStart is required and must be a valid ISO 8601 date string");
  }

  const startDate = new Date(scheduledStart);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
  const now = new Date();

  const displayName = customerName?.trim() || customerPhone.trim();
  const normalizedCreatedByRole = createdByRole === "agent" ? "agent" : "user";

  if (normalizedCreatedByRole === "user") {
    const israelOffset = getIsraelUTCOffset(startDate);
    const israelHour   = (startDate.getUTCHours() + israelOffset) % 24;
    const israelMinute = startDate.getUTCMinutes();
    if (israelHour === 13 && israelMinute === 0) {
      throw new Error("SLOT_BLOCKED");
    }

    // לקוח קצה: חסימת שעה מלאה — אם יש פגישה כלשהי בתוך [h:00, h+1:00) → SLOT_TAKEN
    const hourEnd = new Date(startDate.getTime() + 60 * 60 * 1000);
    const conflict = await DB.collection(COLLECTION).findOne({
      status: "active",
      scheduledStart: { $gte: startDate, $lt: hourEnd },
    });
    if (conflict) throw new Error("SLOT_TAKEN");
  }
  const normalizedCreatedByName =
    createdByName?.trim() ||
    (normalizedCreatedByRole === "agent" ? assignedAgentName?.trim() : null) ||
    customerName?.trim() ||
    customerPhone.trim();
  const doc = {
    customerPhone: customerPhone.trim(),
    customerName: customerName?.trim() || null,
    subject: `פגישה ללקוח - ${displayName}`,
    scheduledStart: startDate,
    scheduledEnd: endDate,
    status: "active",
    zoomLink: null,
    callPurpose: callPurpose?.trim() || null,
    assignedAgentId: assignedAgentId?.trim() || null,
    assignedAgentName: assignedAgentName?.trim() || null,
    assignedStationId: assignedStationId?.trim() || null,
    createdByRole: normalizedCreatedByRole,
    createdByName: normalizedCreatedByName,
    meetingStatus: null,
    notes: '',
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await DB.collection(COLLECTION).insertOne(doc);
    return { ...doc, _id: result.insertedId };
  } catch (err) {
    if (err.code === 11000) throw new Error("SLOT_TAKEN");
    throw err;
  }
}

/**
 * מבטל פגישה (soft delete) לפי ID.
 * @param {string} id - מזהה ObjectId של הפגישה
 * @returns {Promise<object>} תוצאת העדכון
 */
async function cancelMeeting(id, { cancelledByRole = 'agent', cancelledByAgentId = null, cancelledByAgentName = null } = {}) {
  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    throw new Error("Invalid appointment ID");
  }

  const cancelledAt = new Date();
  const doc = await DB.collection(COLLECTION).findOneAndUpdate(
    { _id: objectId, status: "active" },
    { $set: { status: "cancelled", cancelledByRole, cancelledByAgentId, cancelledByAgentName, cancelledAt, updatedAt: cancelledAt } },
    { returnDocument: "before" }
  );

  if (!doc) {
    throw new Error("Appointment not found or already cancelled");
  }

  return doc; // מחזיר את המסמך לפני הביטול (כולל customerPhone)
}

/**
 * מחזיר את הפגישה הבאה הפעילה ללקוח לפי טלפון (מהרגע הנוכחי והלאה).
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
async function getNextMeetingByPhone(phone) {
  if (!phone) return null;
  const variants = normalizePhoneVariants(phone);
  const now = new Date();

  // מציג פגישה עד שעה אחרי תחילתה (grace period)
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const meeting = await DB.collection(COLLECTION).findOne(
    { customerPhone: { $in: variants }, status: "active", scheduledStart: { $gt: cutoff } },
    { sort: { scheduledStart: 1 } }
  );

  if (!meeting) return null;
  return {
    id: meeting._id.toString(),
    subject: meeting.subject,
    customerPhone: meeting.customerPhone,
    customerName: meeting.customerName || null,
    scheduledStart: meeting.scheduledStart,
    scheduledEnd: meeting.scheduledEnd,
    status: meeting.status,
    zoomLink: meeting.zoomLink || null,
  };
}

/**
 * מבטל את הפגישה הבאה הפעילה של לקוח לפי טלפון (soft delete).
 * @param {string} phone
 * @returns {Promise<object>} המסמך לפני הביטול
 */
async function cancelMeetingByPhone(phone, { cancelledByRole = 'customer', cancelledByAgentId = null, cancelledByAgentName = null } = {}) {
  if (!phone) throw new Error("phone is required");
  const variants = normalizePhoneVariants(phone);
  const now = new Date();
  const cancelledAt = new Date();

  const doc = await DB.collection(COLLECTION).findOneAndUpdate(
    { customerPhone: { $in: variants }, status: "active", scheduledStart: { $gt: now } },
    { $set: { status: "cancelled", cancelledByRole, cancelledByAgentId, cancelledByAgentName, cancelledAt, updatedAt: cancelledAt } },
    { sort: { scheduledStart: 1 }, returnDocument: "before" }
  );

  if (!doc) throw new Error("No active appointment found for this phone");
  return doc;
}

/**
 * מחפש לקוח לפי מספר טלפון ב-MongoDB (collection: customers).
 * מנסה 3 פורמטים: 972X, 0X, X.
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
async function getCustomerByPhone(phone) {
  if (!phone) throw new Error("phone is required");

  const variants = normalizePhoneVariants(phone);

  const customer = await DB.collection("customers").findOne({
    phone: { $in: variants },
  });

  return customer || null;
}

/**
 * מעדכן meetingStatus ו/או notes לפגישה לפי ID.
 * @param {string} id - ObjectId של הפגישה
 * @param {{ meetingStatus?: string|null, notes?: string }} params
 */
async function updateMeetingStatusAndNotes(id, { meetingStatus, notes, agentId, agentName, statusLabel, assignedAgentId, assignedStationId }) {
  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    throw new Error("Invalid appointment ID");
  }

  const set = { updatedAt: new Date() };
  if (meetingStatus !== undefined) set.meetingStatus = meetingStatus;
  if (notes !== undefined) set.notes = notes;
  if (agentId) { set.lastAgentId = agentId; set.lastAgentName = agentName || ''; }
  // Client always sends both fields together; handle them as a unit
  if (assignedAgentId !== undefined || assignedStationId !== undefined) {
    set.assignedAgentId   = assignedAgentId   ?? null;
    set.assignedStationId = assignedStationId ?? null;
  }

  const update = { $set: set };
  if (meetingStatus !== undefined && agentId) {
    update.$push = {
      statusHistory: {
        statusId: meetingStatus,
        statusLabel: statusLabel || '',
        agentId,
        agentName: agentName || '',
        notes: notes || null,
        timestamp: new Date(),
      },
    };
  }

  const result = await DB.collection(COLLECTION).findOneAndUpdate(
    { _id: objectId },
    update,
    { returnDocument: "after" }
  );

  if (!result) throw new Error("Appointment not found");
  return result;
}

/**
 * מעדכן callPurpose בפגישה לפי טלפון + זמן קביעה.
 * משמש כאשר ההודעה מגיעה מהבוט לפני יצירת רשומת הפגישה.
 * @param {{ customerPhone: string, appointmentIso: string, callPurpose: string }} params
 */
async function upsertAppointmentPurpose({ customerPhone, appointmentIso, callPurpose }) {
  if (!customerPhone || !appointmentIso || !callPurpose) return;
  const variants = normalizePhoneVariants(customerPhone);
  const scheduledStart = new Date(appointmentIso);
  await DB.collection(COLLECTION).updateOne(
    { customerPhone: { $in: variants }, scheduledStart },
    { $set: { callPurpose: callPurpose.trim(), updatedAt: new Date() } }
  );
}

/**
 * מחזיר פגישות מבוטלות בטווח תאריכים, ממוינות מהחדש לישן.
 * @param {{ fromDate: Date, toDate: Date }} params
 * @returns {Promise<Array>}
 */
async function getCancelledMeetings({ fromDate, toDate }) {
  const cursor = DB.collection(COLLECTION).find(
    { status: "cancelled", scheduledStart: { $gte: fromDate, $lte: toDate } },
    { sort: { cancelledAt: -1, scheduledStart: -1 } }
  );
  const meetings = await cursor.toArray();
  return meetings.map(m => ({
    id: m._id.toString(),
    subject: m.subject,
    customerPhone: m.customerPhone,
    customerName: m.customerName || null,
    scheduledStart: m.scheduledStart,
    scheduledEnd: m.scheduledEnd,
    callPurpose: m.callPurpose || null,
    assignedAgentName: m.assignedAgentName || null,
    cancelledByRole: m.cancelledByRole || null,
    cancelledByAgentId: m.cancelledByAgentId || null,
    cancelledByAgentName: m.cancelledByAgentName || null,
    cancelledAt: m.cancelledAt || m.updatedAt || null,
  }));
}

/**
 * משחזר פגישה מבוטלת לסטטוס פעיל.
 * @param {string} id
 * @returns {Promise<object>} המסמך המעודכן
 */
async function restoreMeeting(id) {
  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    throw new Error("Invalid appointment ID");
  }

  const doc = await DB.collection(COLLECTION).findOneAndUpdate(
    { _id: objectId, status: "cancelled" },
    {
      $set: { status: "active", updatedAt: new Date() },
      $unset: { cancelledByRole: "", cancelledByAgentId: "", cancelledByAgentName: "", cancelledAt: "" },
    },
    { returnDocument: "after" }
  );

  if (!doc) throw new Error("Appointment not found or not cancelled");
  return doc;
}

/**
 * מחזיר את כל הפגישות של לקוח לפי טלפון, ממוין לפי תאריך יורד.
 * @param {string} phone
 * @param {{ includeCancelled?: boolean }} options
 * @returns {Promise<object[]>}
 */
async function getMeetingHistoryByPhone(phone, { includeCancelled = false } = {}) {
  if (!phone) return [];
  const variants = normalizePhoneVariants(phone);
  const query = { customerPhone: { $in: variants } };
  if (!includeCancelled) query.status = { $ne: "cancelled" };
  const meetings = await DB.collection(COLLECTION)
    .find(query)
    .sort({ scheduledStart: -1 })
    .toArray();
  return meetings.map(m => ({
    id: m._id.toString(),
    scheduledStart: m.scheduledStart,
    scheduledEnd: m.scheduledEnd,
    status: m.status,
    meetingStatus: m.meetingStatus || null,
    subject: m.subject || null,
    callPurpose: m.callPurpose || null,
    assignedAgentName: m.assignedAgentName || null,
    createdByRole: m.createdByRole || null,
    createdByName: m.createdByName || null,
    notes: m.notes || null,
    cancelledAt: m.cancelledAt || null,
  }));
}

module.exports = {
  fetchAvailableSlots,
  getMeetingsByDateRange,
  createMeeting,
  cancelMeeting,
  cancelMeetingByPhone,
  getCancelledMeetings,
  restoreMeeting,
  getCustomerByPhone,
  getNextMeetingByPhone,
  upsertAppointmentPurpose,
  updateMeetingStatusAndNotes,
  getMeetingHistoryByPhone,
};
