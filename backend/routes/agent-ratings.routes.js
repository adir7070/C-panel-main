const express = require("express");
const router = express.Router();
const c = require("../controllers/agent-ratings.controller");

router.get("/summary", c.getAgentRatingsSummary);
router.get("/leaderboard", c.getAgentLeaderboard);
router.get("/agent/:agentId", c.getSingleAgentStats);
router.get("/", c.getAgentRatings);

module.exports = router;
