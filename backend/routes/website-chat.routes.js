const express = require("express");
const router = express.Router();
const websiteChatController = require("../controllers/website-chat.controller");

// GET /api/website-chat/search?q=...
router.get("/search", websiteChatController.searchWebsiteChats);

module.exports = router;
