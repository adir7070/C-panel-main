const express = require("express");
const router = express.Router();
const requireApiKey = require("../middlewares/api-key.middleware");
const chatController = require("../controllers/chat.controller");

/**
 * @swagger
 * /api/chat/send:
 *   post:
 *     summary: Send a system message to a support chat
 *     tags: [Chat]
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, text]
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "0501234567"
 *               text:
 *                 type: string
 *                 example: "הודעת מערכת אוטומטית"
 *     responses:
 *       200:
 *         description: Message sent successfully
 *       400:
 *         description: Missing phone or text
 *       401:
 *         description: Invalid or missing API key
 *       404:
 *         description: No chat found for this phone
 */
router.get("/search", chatController.searchChats);
router.get("/media-zip", chatController.mediaZip);
router.post("/send", requireApiKey, chatController.sendMessage);

// POST /api/chat/refresh-contact — מרענן שם ותמונה מ-Fireberry ל-support_chats
router.post("/refresh-contact", chatController.refreshContact);

module.exports = router;
