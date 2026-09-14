const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/ad-sessions.controller");

router.post("/create", ctrl.createSession);
router.get("/by-phone/:phone", ctrl.getByPhone);
router.get("/:sessionId", ctrl.getOne);

module.exports = router;
