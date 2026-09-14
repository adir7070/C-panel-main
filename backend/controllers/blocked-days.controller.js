const { getBlockedDays, blockDay, unblockDay } = require("../services/blocked-days.service");

// GET /api/blocked-days?from=YYYY-MM-DD&to=YYYY-MM-DD
exports.getBlockedDays = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, error: "from and to are required" });
    }
    const data = await getBlockedDays({ from, to });
    res.json({ success: true, data });
  } catch (err) {
    console.error("[BlockedDays] getBlockedDays error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/blocked-days
// body: { date: "YYYY-MM-DD", reason?: string, agentName: string }
exports.blockDay = async (req, res) => {
  try {
    const { date, reason, agentName } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: "date is required (YYYY-MM-DD)" });
    }
    await blockDay({ date, reason, blockedByName: agentName || "אדמין" });
    res.json({ success: true });
  } catch (err) {
    console.error("[BlockedDays] blockDay error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// DELETE /api/blocked-days/:date
exports.unblockDay = async (req, res) => {
  try {
    const { date } = req.params;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: "date is required (YYYY-MM-DD)" });
    }
    await unblockDay(date);
    res.json({ success: true });
  } catch (err) {
    console.error("[BlockedDays] unblockDay error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
