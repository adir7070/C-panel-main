const DB = require("../utils/DB");
const { filterOutHolidays } = require("../utils/hebcal");

const COLLECTION = "cpanelMeeting";
const WORK_HOUR_FROM = 10;
const WORK_HOUR_TO = 17;

// ────────────────────────── helpers ────────────────────────────────

function isWorkingDay(date) {
  const dow = date.getDay();
  return dow !== 5 && dow !== 6;
}

function buildWorkingDays(daysAhead) {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const days = [];
  if (isWorkingDay(today)) days.push(new Date(today));

  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() + 1);
  let count = 0;
  while (count < daysAhead) {
    if (isWorkingDay(cursor)) { days.push(new Date(cursor)); count++; }
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function getIsraelUTCOffset(date) {
  const noon = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12));
  const israelHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", hour: "numeric", hour12: false }).format(noon)
  );
  return israelHour - 12;
}

// ────────────────────────── exports ────────────────────────────────

const SLOT_MINUTES = 30;

/**
 * מחזיר סלוטים פנויים של 30 דקות לפגישת מנהל תיק.
 */
async function fetchAvailableSlots(daysAhead = 3) {
  const now = new Date();
  const rawDays = buildWorkingDays(daysAhead);
  const workingDays = await filterOutHolidays(rawDays);
  if (workingDays.length === 0) return {};

  const from = workingDays[0];
  const to = new Date(workingDays[workingDays.length - 1]);
  to.setHours(23, 59, 59, 999);

  const booked = await DB.collection(COLLECTION)
    .find({ status: "scheduled", scheduledStart: { $gte: from, $lte: to } })
    .toArray();

  const bookedTimestamps = booked.map(m => new Date(m.scheduledStart).getTime());

  const result = {};

  for (const day of workingDays) {
    const dateStr = [
      day.getFullYear(),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    ].join("-");
    const isToday = day.toDateString() === now.toDateString();
    const israelOffset = getIsraelUTCOffset(day);
    const hourGroups = [];

    for (let h = WORK_HOUR_FROM; h < WORK_HOUR_TO; h++) {
      for (const m of [0, 30]) {
        const utcStart = new Date(Date.UTC(
          day.getFullYear(), day.getMonth(), day.getDate(),
          h - israelOffset, m, 0, 0
        ));
        const utcEnd = new Date(utcStart.getTime() + SLOT_MINUTES * 60 * 1000);

        if (isToday && utcStart <= now) continue;

        const taken = bookedTimestamps.some(ts => ts === utcStart.getTime());
        if (!taken) {
          const endH = utcEnd.getUTCHours() + israelOffset;
          const endM = utcEnd.getUTCMinutes();
          const startLabel = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          const endLabel   = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
          hourGroups.push({
            hour: `${startLabel}-${endLabel}`,
            slots: [{
              start: startLabel,
              end:   endLabel,
              iso:   utcStart.toISOString(),
            }],
          });
        }
      }
    }

    if (hourGroups.length > 0) result[dateStr] = hourGroups;
  }

  return result;
}

/**
 * יוצר פגישת מנהל תיק חדשה.
 * מעשיר אוטומטית ב-customerName ו-businessName מ-cpanel_clients אם לא סופקו.
 */
async function createCpanelMeeting({
  customerPhone,
  managerId,
  managerName,
  scheduledStart,
  callPurpose,
  customerName,
  businessName,
}) {
  if (!customerPhone?.trim()) throw new Error("customerPhone is required");
  if (!managerId?.trim()) throw new Error("managerId is required");
  if (!scheduledStart || isNaN(Date.parse(scheduledStart))) throw new Error("scheduledStart must be a valid ISO date");

  const startDate = new Date(scheduledStart);
  const endDate = new Date(startDate.getTime() + SLOT_MINUTES * 60 * 1000);

  // בדיקת חפיפה — exact slot match
  const conflict = await DB.collection(COLLECTION).findOne({
    status: "scheduled",
    scheduledStart: startDate,
  });
  if (conflict) throw new Error("SLOT_TAKEN");

  // העשרת פרטי לקוח מ-cpanel_clients אם לא סופקו
  if (!customerName || !businessName) {
    try {
      const clientRow = await DB.collection("cpanel_clients").findOne(
        { phone: customerPhone },
        { projection: { customerName: 1, businessName: 1, fireberyName: 1 } }
      );
      if (clientRow) {
        customerName = customerName || clientRow.customerName || clientRow.fireberyName || null;
        businessName = businessName || clientRow.businessName || null;
      }
    } catch { /* fail soft */ }
  }

  const doc = {
    customerPhone: customerPhone.trim(),
    customerName: customerName?.trim() || null,
    businessName: businessName?.trim() || null,
    managerId: managerId.trim(),
    managerName: managerName?.trim() || null,
    scheduledStart: startDate,
    scheduledEnd: endDate,
    callPurpose: callPurpose?.trim() || null,
    status: "scheduled",
    source: "app_onboarding",
    createdAt: new Date(),
  };

  const result = await DB.collection(COLLECTION).insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

module.exports = { fetchAvailableSlots, createCpanelMeeting };
