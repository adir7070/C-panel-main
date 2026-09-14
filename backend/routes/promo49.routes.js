/**
 * promo49.routes.js — public "מבצע 49" landing-page purchase (PRO ₪49 first month).
 * Mounted at /api/promo49, no auth (public landing + Cardcom webhook).
 */
const express = require("express");
const router = express.Router();
const c = require("../controllers/promo49.controller");

router.post("/purchase", c.purchase);        // { name, phone, businessName? } → { url }
router.post("/confirm", c.confirm);           // Cardcom webhook → provision + activate PRO
router.get("/return", c.paymentReturn);       // Cardcom success/error redirect

module.exports = router;
