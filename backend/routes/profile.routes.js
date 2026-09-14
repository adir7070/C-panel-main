const express = require("express");
const router = express.Router();
const { setProfile, getProfile, updateFireberryPageId, setProfileByPage, getProfileByPage } = require("../controllers/profile.controller");

router.post("/set", setProfile);
router.get("/get", getProfile);
router.post("/update-page-id", updateFireberryPageId);
router.post("/set-by-page", setProfileByPage);
router.get("/get-by-page", getProfileByPage);

module.exports = router;
