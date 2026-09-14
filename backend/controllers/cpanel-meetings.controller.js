const { fetchAvailableSlots, createCpanelMeeting } = require("../services/cpanel-meetings.service");

// GET /api/cpanel/meetings/available?daysAhead=5
exports.getAvailableSlots = async (req, res) => {
  const daysAhead = Math.min(parseInt(req.query.daysAhead ?? 5, 10), 14);
  try {
    const data = await fetchAvailableSlots(daysAhead);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("[CpanelMeetings] getAvailableSlots error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/cpanel/meetings
// body: { customerPhone, managerId, managerName, scheduledStart, callPurpose?, customerName?, businessName? }
exports.createMeeting = async (req, res) => {
  const { customerPhone, managerId, managerName, scheduledStart, callPurpose, customerName, businessName } = req.body ?? {};

  if (!customerPhone || !managerId || !scheduledStart) {
    return res.status(400).json({ success: false, error: "customerPhone, managerId and scheduledStart are required" });
  }

  try {
    const meeting = await createCpanelMeeting({ customerPhone, managerId, managerName, scheduledStart, callPurpose, customerName, businessName });
    return res.status(201).json({ success: true, data: meeting });
  } catch (err) {
    if (err.message === "SLOT_TAKEN") {
      return res.status(409).json({ success: false, error: "SLOT_TAKEN" });
    }
    console.error("[CpanelMeetings] createMeeting error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
