const router = require("express").Router();
const ctrl = require("../controllers/blocked-days.controller");

router.get("/", ctrl.getBlockedDays);
router.post("/", ctrl.blockDay);
router.delete("/:date", ctrl.unblockDay);

module.exports = router;
