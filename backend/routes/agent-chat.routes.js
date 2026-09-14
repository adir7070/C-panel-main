const express = require("express");
const multer = require("multer");
const router = express.Router();
const c = require("../controllers/agent.controller");

// 60MB — images are small but clients now also send short videos in the AI chat
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// App-facing dedicated AI-manager chat (separate from the human support thread)
router.get("/approvals", c.listApprovals);     // ?phone=
router.post("/message", c.postMessage);         // { phone, text }
router.post("/upload", upload.single("image"), c.uploadChatImage); // { phone, image(file), caption? }
router.post("/read", c.markRead);               // { phone }
router.post("/approve", c.approve);             // { approvalId }
router.post("/reject", c.reject);               // { approvalId }
// Conversations (multi-thread) — MUST be before the "/:phone" catch-all, or
// "conversations" is swallowed as a phone param.
router.get("/conversations/:phone", c.listConversations);   // list + active pointer
router.post("/conversations/new", c.newConversation);       // { phone, title? }
router.post("/conversations/switch", c.switchConversation); // { phone, conversationId }
router.get("/:phone", c.getChat);               // load thread (?conversationId=)

module.exports = router;
