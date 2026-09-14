/**
 * Public manager-picker routes for the mobile onboarding flow.
 * NO AUTH — new clients haven't logged in yet when they hit these.
 *
 *   GET  /api/public/managers           — pickable manager list
 *   POST /api/public/managers/:id/choose — client commits to a manager
 */
const express = require("express");
const router = express.Router();
const c = require("../controllers/public-managers.controller");

router.get("/managers",            c.listPublicManagers);
router.get("/my-manager",          c.getMyManager);
router.get("/user-type",           c.getUserType);
router.post("/managers/:id/choose", c.chooseManager);
router.post("/managers/:id/rate",   c.rateManager);

module.exports = router;
