const express = require("express");
const router = express.Router();
const { submitRating, getRatings, getRatingsSummary } = require("../controllers/ratings.controller");

router.get("/summary", getRatingsSummary);
router.get("/", getRatings);
router.post("/submit", submitRating);

module.exports = router;
