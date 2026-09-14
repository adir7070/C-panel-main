const express = require("express");
const router = express.Router();

const galleryRoutes = require("./gallery.routes");
const postsRoutes = require("./posts.routes");

router.use("/gallery", galleryRoutes);
router.use("/posts", postsRoutes);

// Per-day "ליצירת מודעה" — same auto-fulfill pipeline, 1 post for the chosen day.
router.post("/social/generate-day", require("../controllers/social-app.controller").generateSocialDay);

// "בחרו כמות" — charge N × 90 coins atomically and generate EXACTLY N social posts.
router.post("/social/create-with-coins", require("../controllers/social-app.controller").createSocialWithCoins);

// Home-screen "פרויקטים בהכנה" circle — live progress of all AI creations.
router.get("/creations", require("../controllers/creations.controller").listCreations);

module.exports = router;
