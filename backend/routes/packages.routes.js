const express = require("express");
const router = express.Router();
const c = require("../controllers/packages.controller");

router.get("/", c.listPackages);
router.get("/social", c.listSocialPackages);
router.post("/redeem-with-coins", c.redeemWithCoins);
router.post("/purchase-iframe", c.purchaseIframe);
router.post("/verify-payment", c.verifyPayment);
router.post("/charge-token", c.chargeToken);
router.post("/payment-notify", c.paymentNotify);

// Personal packages (per-client, built by account manager)
router.get("/personal",                        c.listPersonal);
router.get("/my-purchases",                    c.myPurchases);
router.post("/purchase-personal-iframe",       c.purchasePersonalIframe);
/* Public self-serve webinar packages page (/packages) — server-side fulfilment */
router.post("/webinar-ensure-offers",          c.webinarEnsureOffers);
router.post("/webinar-pay-iframe",             c.webinarPayIframe);
router.post("/webinar-pay-status",             c.webinarPayStatus);
router.post("/webinar-bundle-iframe",          c.webinarBundleIframe);
router.post("/webinar-bundle-confirm",         c.webinarBundleConfirm);
router.post("/verify-personal-payment",        c.verifyPersonalPayment);
router.get("/contract-debug",                  c.contractDebug);
router.post("/contract-html",                  c.contractHtml);
/* Public GET version of contract-html — same HTML, but accepts phone +
   personalPackageId via query string and requires no auth. Used for SMS
   links sent to clients so they can open & sign from their phone without
   logging into anything. */
router.get("/contract-view",                   c.contractView);
router.post("/submit-contract-signature",      c.submitContractSignature);
router.post("/contract-save-coin",             c.contractSaveCoin);
router.post("/contract-pay",                   c.contractPay);
router.get("/contract-pay-success",            c.contractPaySuccess);
router.post("/contract-coins-iframe",          c.contractCoinsIframe);
router.get("/contract-coins-success",          c.contractCoinsSuccess);

module.exports = router;
