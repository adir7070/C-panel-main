const express = require("express");
const router = express.Router();
const { getReceipts, downloadReceipt } = require("../controllers/receipts.controller");

router.get("/", getReceipts);
router.get("/:id/pdf", downloadReceipt);

module.exports = router;
