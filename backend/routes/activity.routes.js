const express = require("express");
const router = express.Router();
const { ingest } = require("../controllers/activity.controller");

router.post("/ingest", ingest);

module.exports = router;
