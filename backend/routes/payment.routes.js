const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/payment.controller");

// הנתיב הראשי ליצירת מנוי
router.post("/create-monthly-subscription", paymentController.createMonthlySubscription);

// רכישת מטבעות
router.post("/create-coin-purchase", paymentController.createCoinPurchase);

// אימות תשלום LowProfile
router.post("/verify-payment", paymentController.verifyPayment);

// חיוב ישיר עם פרטי כרטיס (deprecated — להשאיר לתאימות לאחור)
router.post("/charge-direct", paymentController.chargeDirect);

// חיוב אסימון שמור
router.post("/charge-token", paymentController.chargeToken);

// כרטיס שמור
router.get("/saved-card", paymentController.getSavedCard);
router.post("/delete-saved-card", paymentController.deleteSavedCard);

// נתיב לביטול
router.post("/cancel-subscription", paymentController.cancelSubscription);

router.get("/health", paymentController.healthCheck);

module.exports = router;