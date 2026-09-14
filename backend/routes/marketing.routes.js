const express = require("express");
const router = express.Router();
const marketingController = require("../controllers/marketing.controller");

router.post("/generate-copy", marketingController.generateCopy);

module.exports = router;
