const {
  fetchAvailableSlots,
  getMeetingsByDateRange,
  createMeeting,
  cancelMeeting,
  cancelMeetingByPhone,
  getCancelledMeetings,
  restoreMeeting,
  getNextMeetingByPhone,
  updateMeetingStatusAndNotes,
  getMeetingHistoryByPhone,
} = require("../services/mongo-appointments.service");
const { getStatusById } = require("../services/meeting-statuses.service");
const { getHolidayNameForDate } = require("../utils/hebcal");
const pushNotification = require("../services/push-notification.service");

const { searchCustomers } = require("../services/fireberry-customers.service");
const { getCustomer } = require("../services/customer-cache.service");
const { getDB } = require("../config/db");
const { getBlockedDaySet, getBlockedDays: fetchBlockedDays } = require("../services/blocked-days.service");
const { broadcast } = require("../utils/broadcast");

// GET /api/appointments/available
// מחזיר תאריכים עם שעות פנויות לפי ימי עבודה
// כאשר calendarDays=true מחושבים גם ימים חסומים (חגים) בטווח ומוחזרים ב-blockedDays
exports.getAvailableMeetings = async (req, res) => {
  const hasAgentName  = Boolean(String(req.query.agentName || "").trim());
  const daysBefore    = parseInt(req.query.daysBefore    ?? 0, 10);
  const daysAhead     = hasAgentName
    ? parseInt(req.query.daysAhead ?? 1, 10)
    : Math.max(parseInt(req.query.daysAhead ?? 5, 10), 5);
  const calendarDays  = parseInt(req.query.calendarDays  ?? 0, 10); // ימי לוח לסריקת חגים (אופציונלי)
  const workHourFrom  = hasAgentName ? 9 : 10;
  const workHourTo    = hasAgentName ? 18 : 16;

  try {
    const blockedSlots = hasAgentName ? [] : [{ h: 13, m: 0 }];

    // טען ימים חסומים ע"י אדמין לטווח הרלוונטי
    const now = new Date();
    const rangeFrom = new Date(now);
    const rangeTo = new Date(now);
    rangeTo.setDate(rangeTo.getDate() + Math.max(daysAhead, calendarDays || 0) + 7);
    const adminBlockedDates = await getBlockedDaySet({ from: rangeFrom, to: rangeTo });

    const slots = await fetchAvailableSlots({ daysBefore, daysAhead, workHourFrom, workHourTo, blockedSlots, isAgent: hasAgentName, adminBlockedDates });

    // חישוב ימים חסומים (חגים + אדמין) בטווח — רק כאשר calendarDays > 0
    let blockedDays = {};
    if (calendarDays > 0) {
      const scanDays = calendarDays;
      const checks = [];
      for (let i = 1; i <= scanDays; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        const dow = d.getDay();
        if (dow === 5 || dow === 6) continue; // מדלג על שישי/שבת
        checks.push(d);
      }
      const names = await Promise.all(checks.map(d => getHolidayNameForDate(d)));
      checks.forEach((d, idx) => {
        if (names[idx]) {
          const yyyy = d.getFullYear();
          const mm   = String(d.getMonth() + 1).padStart(2, '0');
          const dd   = String(d.getDate()).padStart(2, '0');
          blockedDays[`${yyyy}-${mm}-${dd}`] = names[idx];
        }
      });
    }

    // מיזוג ימים חסומים ע"י אדמין לתוך blockedDays
    const adminBlockedMap = await fetchBlockedDays({
      from: rangeFrom.toISOString().slice(0, 10),
      to: rangeTo.toISOString().slice(0, 10),
    });
    for (const [date, info] of Object.entries(adminBlockedMap)) {
      blockedDays[date] = info.reason ? `חסום: ${info.reason}` : "חסום ע\"י מנהל";
    }

    res.json({ success: true, data: slots, blockedDays });
  } catch (error) {
    console.error("❌ [Appointments] fetchAvailableSlots error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/appointments/upcoming?phone=...
// מחזיר את הפגישה הבאה הפעילה ללקוח לפי טלפון
exports.getUpcomingAppointment = async (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ success: false, error: "phone query parameter is required" });
  }
  try {
    const meeting = await getNextMeetingByPhone(phone);
    res.json({ success: true, data: meeting });
  } catch (error) {
    console.error("❌ [Appointments] getUpcomingAppointment error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/appointments/history?phone=...&includeCancelled=0
// מחזיר את כל היסטוריית הפגישות של לקוח לפי טלפון
exports.getAppointmentHistory = async (req, res) => {
  const { phone, includeCancelled } = req.query;
  if (!phone) return res.status(400).json({ success: false, error: "phone is required" });
  try {
    const meetings = await getMeetingHistoryByPhone(phone, {
      includeCancelled: includeCancelled === '1' || includeCancelled === 'true',
    });
    return res.json({ success: true, data: meetings });
  } catch (err) {
    console.error("❌ [Appointments] getAppointmentHistory error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/appointments/customer/search?q=...
// חיפוש לקוחות ב-Fireberry וב-support_chats לפי שם או טלפון
exports.searchCustomers = async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.json({ success: true, data: [] });
  }
  try {
    const [fireberyResults, chatDocs] = await Promise.all([
      searchCustomers(q).catch(() => []),
      getDB().collection("support_chats").find({
        $or: [
          { name: { $regex: q.trim(), $options: "i" } },
          { phone: { $regex: q.trim() } },
        ],
      }).limit(8).toArray().catch(() => []),
    ]);

    // מיזוג תוצאות – Fireberry קודם, אח"כ מהצ'אטים שלא נמצאו שם
    const merged = [...fireberyResults];
    for (const chat of chatDocs) {
      if (chat.phone && !merged.find(r => r.telephone1 === chat.phone)) {
        merged.push({
          accountid: null,
          accountname: chat.name || chat._id,
          telephone1: chat.phone,
          source: "chat",
        });
      }
    }

    res.json({ success: true, data: merged });
  } catch (error) {
    console.error("❌ [Appointments] searchCustomers error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/appointments/customer?phone=...
// מחזיר מידע לקוח מ-MongoDB לפי מספר טלפון
exports.getCustomerByPhone = async (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ success: false, error: "phone query parameter is required" });
  }
  try {
    const customer = await getCustomer(phone);
    if (!customer) {
      return res.status(404).json({ success: false, error: "Customer not found" });
    }
    res.json({ success: true, data: customer });
  } catch (error) {
    console.error("❌ [Appointments] getCustomerByPhone error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/appointments/week?from=YYYY-MM-DD&to=YYYY-MM-DD
// מחזיר את כל הפגישות הקיימות בטווח תאריכים, מקובצות לפי תאריך.
// ברירת מחדל: החודש הנוכחי.
exports.getWeekMeetings = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let fromDate, toDate;

    if (req.query.from && req.query.to) {
      fromDate = new Date(req.query.from + "T00:00:00");
      toDate   = new Date(req.query.to   + "T23:59:59");
    } else {
      // Default: first–last day of current month
      fromDate = new Date(today.getFullYear(), today.getMonth(), 1);
      toDate   = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);
    }

    const { agentId, stationId, viewAll } = req.query;
    const grouped = await getMeetingsByDateRange({ fromDate, toDate, agentId, stationId, viewAll: viewAll === "true" });
    res.json({ success: true, data: grouped });
  } catch (error) {
    console.error("❌ [Appointments] getWeekMeetings error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/appointments/month?month=YYYY-MM
// מחזיר פגישות לחודש ספציפי, מקובצות לפי תאריך.
// ברירת מחדל: החודש הנוכחי.
exports.getMonthMeetings = async (req, res) => {
  try {
    let year, month;

    if (req.query.month) {
      const parts = req.query.month.split("-");
      year  = parseInt(parts[0], 10);
      month = parseInt(parts[1], 10) - 1; // 0-indexed
    } else {
      const now = new Date();
      year  = now.getFullYear();
      month = now.getMonth();
    }

    const fromDate = new Date(year, month, 1, 0, 0, 0, 0);
    const toDate   = new Date(year, month + 1, 0, 23, 59, 59, 999);

    const { agentId, stationId, viewAll } = req.query;
    const grouped = await getMeetingsByDateRange({ fromDate, toDate, agentId, stationId, viewAll: viewAll === "true" });
    res.json({ success: true, data: grouped });
  } catch (error) {
    console.error("❌ [Appointments] getMonthMeetings error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/appointments
// יוצר פגישה חדשה ב-MongoDB
exports.createAppointment = async (req, res) => {
  console.log("📅 [Appointments] Creating new meeting in MongoDB");
  const {
    customerPhone,
    scheduledStart,
    customerName,
    callPurpose,
    assignedAgentId,
    assignedAgentName,
    assignedStationId,
    createdByRole,
    createdByName,
  } = req.body;

  try {
    const record = await createMeeting({
      customerPhone,
      scheduledStart,
      customerName,
      callPurpose,
      assignedAgentId,
      assignedAgentName,
      assignedStationId,
      createdByRole,
      createdByName,
    });

    const io = req.app.get('io');
    if (io) {
      const payload = {
        type: 'meeting_created',
        meeting: {
          id: record._id.toString(),
          customerPhone: record.customerPhone,
          customerName: record.customerName,
          subject: record.subject,
          scheduledStart: record.scheduledStart,
          scheduledEnd: record.scheduledEnd,
          status: record.status,
        },
      };
      broadcast(io, 'meeting_created', 'support_team', payload);
      broadcast(io, 'meeting_created', record.customerPhone, payload);

      // שליחת הודעת מערכת לצ'אט של הלקוח ולנציגים
      try {
        const chatDoc = await getDB().collection("support_chats").findOne({ phone: record.customerPhone });
        if (chatDoc) {
          const dateObj = new Date(record.scheduledStart);
          const formatted = dateObj.toLocaleString("he-IL", {
            timeZone: "Asia/Jerusalem",
            weekday: "long", day: "numeric", month: "long",
            hour: "2-digit", minute: "2-digit",
          });
          const systemMsg = {
            userId: chatDoc._id,
            fromRole: "system",
            type: "appointment",
            text: `📅 פגישה נקבעה: ${formatted}`,
            appointmentIso: record.scheduledStart.toISOString(),
            createdAt: new Date().toISOString(),
            agentOnly: false,
          };
          broadcast(io, "receive_message", chatDoc._id, systemMsg);
          broadcast(io, "receive_message", "support_team", systemMsg);

          // עדכון appointmentAt בצ'אט + שמירת הודעת המערכת בהיסטוריה
          await getDB().collection("support_chats").updateOne(
            { _id: chatDoc._id },
            {
              $set: { appointmentAt: record.scheduledStart, updated_at: new Date() },
              $push: { messages: systemMsg },
            }
          );

          // התראת Push ללקוח
          pushNotification.notifyUser(chatDoc._id, "📅 פגישה נקבעה", `פגישה נקבעה: ${formatted}`, {
            screen: "ChatScreenAi",
          });
        }
      } catch (chatErr) {
        console.error("⚠️ [Appointments] could not send chat notification:", chatErr.message);
      }
    }

    res.status(201).json({ success: true, data: record });
  } catch (error) {
    console.error("❌ [Appointments] createMeeting error:", error.message);
    const status = error.message === "SLOT_TAKEN"    ? 409
                 : error.message === "SLOT_BLOCKED"  ? 403
                 : error.message.includes("required") ? 400
                 : 500;
    const msg = error.message === "SLOT_TAKEN"
      ? "השעה שנבחרה כבר נתפסה, אנא בחר שעה אחרת"
      : error.message === "SLOT_BLOCKED"
      ? "השעה שנבחרה אינה זמינה לקביעה עצמית"
      : error.message;
    res.status(status).json({ success: false, error: msg });
  }
};

// POST /api/appointments/:phone/cancel
// מבטל את הפגישה הבאה הפעילה של לקוח לפי טלפון
exports.cancelAppointmentByPhone = async (req, res) => {
  const { customerPhone, cancelReason } = req.body;
  const phone = req.params.phone || customerPhone;
  console.log(`❌ [Appointments] Cancelling meeting for phone ${phone}`);

  try {
    const cancelledDoc = await cancelMeetingByPhone(phone, { cancelledByRole: 'customer' });

    const io = req.app.get('io');
    if (io && cancelledDoc) {
      const payload = {
        type: 'meeting_cancelled',
        meetingId: cancelledDoc._id.toString(),
        customerPhone: cancelledDoc.customerPhone,
        cancelReason: cancelReason || null,
        cancelledAt: new Date().toISOString(),
      };
      broadcast(io, 'meeting_cancelled', 'support_team', payload);
    }

    res.json({ success: true, message: "Appointment cancelled" });
  } catch (error) {
    console.error("❌ [Appointments] cancelMeetingByPhone error:", error.message);
    if (error.message.includes("not found") || error.message.includes("No active")) {
      return res.json({ success: true, message: "Appointment cancelled" });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/appointments/:id/restore
// משחזר פגישה מבוטלת לסטטוס פעיל ושולח אירוע סוקט ללקוח
exports.restoreAppointment = async (req, res) => {
  const { id } = req.params;
  console.log(`♻️  [Appointments] Restoring meeting ${id}`);
  try {
    const doc = await restoreMeeting(id);

    const io = req.app.get('io');
    if (io) {
      const payload = {
        type: 'meeting_created',
        meeting: {
          id: doc._id.toString(),
          customerPhone: doc.customerPhone,
          customerName: doc.customerName,
          subject: doc.subject,
          scheduledStart: doc.scheduledStart,
          scheduledEnd: doc.scheduledEnd,
          status: doc.status,
        },
      };
      broadcast(io, 'meeting_created', 'support_team', payload);
      broadcast(io, 'meeting_created', doc.customerPhone, payload);

      try {
        const chatDoc = await getDB().collection("support_chats").findOne({ phone: doc.customerPhone });
        if (chatDoc) {
          const formatted = new Date(doc.scheduledStart).toLocaleString("he-IL", {
            timeZone: "Asia/Jerusalem",
            weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
          });
          const systemMsg = {
            userId: chatDoc._id,
            fromRole: "system",
            type: "appointment",
            text: `📅 פגישה שוחזרה: ${formatted}`,
            appointmentIso: doc.scheduledStart.toISOString(),
            createdAt: new Date().toISOString(),
            agentOnly: false,
          };
          await getDB().collection("support_chats").updateOne(
            { _id: chatDoc._id },
            { $set: { appointmentAt: doc.scheduledStart, updated_at: new Date() }, $push: { messages: systemMsg } }
          );
          broadcast(io, "receive_message", chatDoc._id, systemMsg);
          broadcast(io, "receive_message", "support_team", systemMsg);
        }
      } catch (chatErr) {
        console.error("⚠️ [Appointments] restore chat notification error:", chatErr.message);
      }
    }

    res.json({ success: true, data: { id: doc._id.toString() } });
  } catch (error) {
    console.error("❌ [Appointments] restoreMeeting error:", error.message);
    const status = error.message.includes("not found") ? 404 : error.message.includes("Invalid") ? 400 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
};

// GET /api/appointments/cancelled
// מחזיר פגישות מבוטלות בטווח תאריכים
exports.getCancelledAppointments = async (req, res) => {
  try {
    let fromDate, toDate;
    if (req.query.from && req.query.to) {
      fromDate = new Date(req.query.from + "T00:00:00");
      toDate   = new Date(req.query.to   + "T23:59:59");
    } else {
      const now = new Date();
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      toDate   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    }
    const meetings = await getCancelledMeetings({ fromDate, toDate });
    res.json({ success: true, data: meetings });
  } catch (error) {
    console.error("❌ [Appointments] getCancelledMeetings error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/appointments/:id/cancel
// מבטל פגישה קיימת (soft delete – status: "cancelled")
exports.cancelAppointment = async (req, res) => {
  const { id } = req.params;
  const { agentId, agentName } = req.body;
  console.log(`❌ [Appointments] Cancelling meeting ${id}`);

  try {
    const cancelledDoc = await cancelMeeting(id, {
      cancelledByRole: 'agent',
      cancelledByAgentId: agentId || null,
      cancelledByAgentName: agentName || null,
    });

    const io = req.app.get('io');
    if (io && cancelledDoc) {
      const payload = {
        type: 'meeting_cancelled',
        meetingId: id,
        customerPhone: cancelledDoc.customerPhone,
        cancelledAt: new Date().toISOString(),
      };
      broadcast(io, 'meeting_cancelled', 'support_team', payload);
      broadcast(io, 'meeting_cancelled', cancelledDoc.customerPhone, payload);

      // שליחת הודעת מערכת לצ'אט של הלקוח ולנציגים
      try {
        const chatDoc = await getDB().collection("support_chats").findOne({ phone: cancelledDoc.customerPhone });
        if (chatDoc) {
          const dateObj = new Date(cancelledDoc.scheduledStart);
          const formatted = dateObj.toLocaleString("he-IL", {
            timeZone: "Asia/Jerusalem",
            weekday: "long", day: "numeric", month: "long",
            hour: "2-digit", minute: "2-digit",
          });
          const systemMsg = {
            userId: chatDoc._id,
            fromRole: "system",
            type: "appointment_cancelled",
            text: `❌ פגישה בוטלה: ${formatted}`,
            createdAt: new Date().toISOString(),
            agentOnly: false,
          };
          broadcast(io, "receive_message", chatDoc._id, systemMsg);
          broadcast(io, "receive_message", "support_team", systemMsg);

          // ניקוי appointmentAt בצ'אט
          await getDB().collection("support_chats").updateOne(
            { _id: chatDoc._id },
            { $set: { appointmentAt: null, updated_at: new Date() } }
          );
        }
      } catch (chatErr) {
        console.error("⚠️ [Appointments] could not send cancel chat notification:", chatErr.message);
      }
    }

    res.json({ success: true, message: "Appointment cancelled" });
  } catch (error) {
    console.error("❌ [Appointments] cancelMeeting error:", error.message);
    const status = error.message.includes("not found") ? 404
                 : error.message.includes("Invalid")   ? 400
                 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
};

// PATCH /api/appointments/:id/update
// מעדכן meetingStatus ו/או notes לפגישה, ושולח הודעת סוקט ללקוח אם הסטטוס מוגדר לכך
exports.updateAppointmentStatus = async (req, res) => {
  const { meetingStatus, notes, agentId, agentName, callType, assignedAgentId, assignedStationId } = req.body;
  if (meetingStatus === undefined && notes === undefined && assignedAgentId === undefined && assignedStationId === undefined) {
    return res.status(400).json({ success: false, error: "At least one field is required" });
  }
  try {
    const statusDoc = meetingStatus ? await getStatusById(meetingStatus) : null;
    const updated = await updateMeetingStatusAndNotes(req.params.id, {
      meetingStatus, notes, agentId, agentName,
      statusLabel: statusDoc?.label || '',
      assignedAgentId, assignedStationId,
    });

    // שליחת הודעה אוטומטית ללקוח אם הסטטוס מוגדר לכך
    if (meetingStatus && statusDoc) {
      try {
        const phone = updated.customerPhone;
        if (!phone) {
          console.warn("⚠️ [Appointments] status message skipped — no customerPhone on appointment");
        } else {
          const chatDoc = await getDB().collection("support_chats").findOne({ phone });
          if (!chatDoc) {
            console.warn(`⚠️ [Appointments] status message skipped — no support_chats doc for phone ${phone}`);
          } else {
            const io = req.app.get("io");
            const pushes = [];

            // 1. הודעת סטטוס רגילה (אם מוגדרת)
            if (statusDoc.sendMessage && statusDoc.messageTemplate) {
              const messageObj = {
                _id: Date.now(),
                fromRole: "agent",
                type: "status_message",
                text: statusDoc.messageTemplate,
                user: { _id: "system", name: "מערכת" },
                createdAt: new Date(),
              };
              pushes.push(messageObj);
              pushNotification.notifyUser(chatDoc._id, "עדכון פגישה", statusDoc.messageTemplate, {
                screen: "ChatScreenAi",
              });
            }

            // 2. בקשת דירוג כשסטטוס = "שיחה בוצעה"
            if (statusDoc.label === 'שיחה בוצעה') {
              const callTypeLabel = callType === 'chat' ? 'צ׳אט' : callType === 'phone' ? 'שיחה טלפונית' : null;
              const ratingText = callTypeLabel
                ? `דרג את ה${callTypeLabel} עם הנציג`
                : 'דרג את השיחה עם הנציג';
              const ratingMsg = {
                _id: Date.now() + 1,
                fromRole: "agent",
                type: "rating_request",
                text: ratingText,
                user: { _id: "system", name: "מערכת" },
                data: {
                  agentId:       agentId       || null,
                  agentName:     agentName     || null,
                  callType:      callType      || null,
                  appointmentId: updated._id.toString(),
                },
                createdAt: new Date(),
              };
              pushes.push(ratingMsg);
              pushNotification.notifyUser(chatDoc._id, ratingText, "לחץ לדירוג", {
                screen: "ChatScreenAi",
              });
            }

            if (pushes.length) {
              const chatSetFields = { updated_at: new Date() };
              // שמור pendingAgentRating לשימוש בעת קבלת הדירוג
              if (statusDoc.label === 'שיחה בוצעה') {
                chatSetFields.pendingAgentRating = {
                  agentId:        agentId                  || null,
                  agentName:      agentName                || null,
                  callType:       callType                 || null,
                  appointmentId:  updated._id.toString(),
                  callPurpose:    updated.callPurpose      || null,
                  scheduledStart: updated.scheduledStart   || null,
                };
              }
              await getDB().collection("support_chats").updateOne(
                { _id: chatDoc._id },
                { $push: { messages: { $each: pushes } }, $set: chatSetFields }
              );
              if (io) {
                pushes.forEach(msg => {
                  broadcast(io, "receive_message", chatDoc._id, msg);
                  broadcast(io, "receive_message", "support_team", { ...msg, userId: chatDoc._id });
                });
              }
            }
          }
        }
      } catch (msgErr) {
        console.error("⚠️ [Appointments] could not send status message:", msgErr.message);
      }
    }

    res.json({
      success: true,
      data: {
        id: updated._id.toString(),
        meetingStatus: updated.meetingStatus,
        notes: updated.notes,
      },
    });
  } catch (error) {
    console.error("❌ [Appointments] updateAppointmentStatus error:", error.message);
    const status = error.message.includes("not found") ? 404
                 : error.message.includes("Invalid")   ? 400
                 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
};
