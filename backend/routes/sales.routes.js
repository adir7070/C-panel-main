const router = require("express").Router();
const salesController = require("../controllers/sales.controller");

router.get("/", salesController.getSalesByPhone);
router.get("/account/:accountid", salesController.getSalesByAccountId);

module.exports = router;
