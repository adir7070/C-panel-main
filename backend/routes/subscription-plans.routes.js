const express = require("express");
const router = express.Router();
const c = require("../controllers/subscription-plans.controller");

router.get("/", c.getPlans);
router.post("/", c.createPlan);
router.put("/:id", c.updatePlan);
router.delete("/:id", c.deletePlan);

module.exports = router;
