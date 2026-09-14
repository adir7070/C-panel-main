const express = require("express");
const router = express.Router();
const { updateProfileStatus } = require("../services/fireberry-profile-status.service");

/**
 * POST /api/fireberry-profile-status/update
 * Body: { phone: string, status: 1|2|3|4 }
 *
 * Updates pcfsystemfield135 on the ניהול לקוח (object 1005) record.
 * Called by the app every time the home screen loads and the profile
 * completeness check runs.
 */
router.post("/update", async (req, res) => {
  const { phone, status } = req.body;
  if (!phone || status == null) {
    return res.status(400).json({ ok: false, error: "phone and status are required" });
  }
  try {
    const result = await updateProfileStatus(phone, Number(status));
    res.json(result);
  } catch (err) {
    console.error("[ProfileStatus route] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
