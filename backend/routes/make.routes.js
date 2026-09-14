const express = require("express");
const router = express.Router();
const requireApiKey = require("../middlewares/api-key.middleware");
const make = require("../controllers/make.controller");

router.use(requireApiKey);
router.post("/set-image", make.setImage);

module.exports = router;
