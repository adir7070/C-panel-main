const router = require("express").Router();
const ctrl = require("../controllers/projects.controller");

router.get("/", ctrl.getByPhone);
router.get("/account/:accountId", ctrl.getByAccountId);
router.put("/:projectId/status", ctrl.updateStatus);

module.exports = router;
