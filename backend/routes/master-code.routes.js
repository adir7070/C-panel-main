const router = require("express").Router();
const ctrl = require("../controllers/master-code.controller");

// GET  /api/master-code/current  — קוד נוכחי + expiresAt + serverTime
router.get("/current", ctrl.getCurrentCode);

// POST /api/master-code/validate — { code } → { valid }
router.post("/validate", ctrl.validateCode);

module.exports = router;
