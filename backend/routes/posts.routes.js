const express = require("express");
const router = express.Router();
const { getServerPosts, upsertServerPost, deleteServerPost } = require("../controllers/instagram-posts.controller");

// GET /:phone — שליפת כל הפוסטים לפי phone
router.get("/:phone", getServerPosts);

// POST /:phone/upsert — שמירת/עדכון פוסט
router.post("/:phone/upsert", upsertServerPost);

// DELETE /:phone/:postId — מחיקת פוסט (לאחר פרסום)
router.delete("/:phone/:postId", deleteServerPost);

module.exports = router;
