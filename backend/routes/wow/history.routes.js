const express = require("express");
const router = express.Router();
const historyService = require("../../services/wow/history.service");
const sessionService = require("../../services/wow/session.service");

// GET /api/wow/history?phone=...
router.get("/", async (req, res, next) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: true, message: "phone is required" });
    }
    const items = await historyService.listByPhone(String(phone));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// Delete a session (Mongo-backed). Backblaze blob cleanup not performed here.
async function deleteSession(sessionId) {
  try { await sessionService.deleteSession(sessionId); } catch { /* */ }
}

// POST /api/wow/history/:sessionId/delete — delete (POST alternative)
router.post("/:sessionId/delete", async (req, res, next) => {
  try { await deleteSession(req.params.sessionId); res.json({ ok: true }); } catch (err) { next(err); }
});

// DELETE /api/wow/history/:sessionId
router.delete("/:sessionId", async (req, res, next) => {
  try { await deleteSession(req.params.sessionId); res.json({ ok: true }); } catch (err) { next(err); }
});

module.exports = router;
