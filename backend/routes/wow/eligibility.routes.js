const express = require("express");
const router = express.Router();
const { getClientStatusByPhone } = require("../../services/fireberry.service");
const { DB } = require("../../config/db");

const COL = "wow_history";

const normalizePhone = (phone) => String(phone || "").replace(/\D+/g, "") || "";

const isClickClient = (status) => {
  if (!status) return false;
  return String(status).includes("קלייק");
};

// GET /api/wow/eligibility/:phone
router.get("/:phone", async (req, res, next) => {
  try {
    const { phone } = req.params;

    const status = await getClientStatusByPhone(phone);
    console.log(`[WOW Eligibility] phone=${phone} status="${status}"`);
    if (!isClickClient(status)) {
      return res.json({ isClickClient: false });
    }

    const normalized = normalizePhone(phone);
    const existing = await DB.collection(COL).findOne({ phone: normalized });

    return res.json({
      isClickClient: true,
      hasCreated: !!existing,
      landingPageUrl: existing?.url ?? null,
      sessionId: existing?.sessionId ?? null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
