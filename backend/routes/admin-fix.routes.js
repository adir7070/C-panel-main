const express = require("express");
const router = express.Router();
const { DB } = require("../config/db");

const briefs = () => DB.collection("client_briefs");

// Normalize phone → 05XXXXXXXX
const normalizePhone = (phone) => {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
};

/**
 * POST /api/admin/fix-client-status
 *
 * מטריגר מ-Make.com כאשר לקוח השלים את שלבי האיפיון בפיירבייס
 * אבל הנתונים לא הגיעו ל-MongoDB.
 *
 * מסמן completedSteps: [1,2,3,4,5] ו-currentStep: 6
 * כדי לפתוח את Phase 2 (אתר) ו-Phase 3 (עיצובים) עבור הלקוח.
 *
 * Body: { phone: string, secret: string }
 * Response: { success, phone, action: "updated"|"created", brief }
 */
router.post("/fix-client-status", async (req, res) => {
  try {
    const { phone, secret } = req.body;

    // ── Auth ──────────────────────────────────────────────
    if (!process.env.ADMIN_FIX_SECRET || secret !== process.env.ADMIN_FIX_SECRET) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // ── Validation ────────────────────────────────────────
    if (!phone) {
      return res.status(400).json({ success: false, error: "phone is required" });
    }

    const normalizedPhone = normalizePhone(phone);
    console.log(`🔧 [AdminFix] fix-client-status for phone: ${normalizedPhone}`);

    // ── Check if document exists (for action label) ───────
    const existing = await briefs().findOne({ phone: normalizedPhone });

    // ── Upsert ────────────────────────────────────────────
    const now = new Date();
    const result = await briefs().findOneAndUpdate(
      { phone: normalizedPhone },
      {
        $set: {
          completedSteps: [1, 2, 3, 4, 5],
          currentStep: 6,
          totalSteps: 10,
          updatedAt: now,
        },
        $setOnInsert: {
          phone: normalizedPhone,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    const action = existing ? "updated" : "created";
    console.log(`✅ [AdminFix] ${action} brief for ${normalizedPhone}`);

    return res.json({ success: true, phone: normalizedPhone, action, brief: result });
  } catch (err) {
    console.error("[AdminFix] fix-client-status error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
