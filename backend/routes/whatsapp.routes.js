const express = require("express");
const router = express.Router();
const whatsappController = require("../controllers/whatsapp.controller");

/**
 * @swagger
 * /api/whatsapp/send:
 *   post:
 *     summary: Send a WhatsApp message via Green API
 *     tags: [WhatsApp]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, message]
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Recipient phone number (format — 972XXXXXXXXX)
 *                 example: "972501234567"
 *               message:
 *                 type: string
 *                 description: Text message to send
 *                 example: "שלום! הודעה לדוגמה"
 *     responses:
 *       200:
 *         description: Message sent successfully
 *       500:
 *         description: Failed to send message
 */
router.post("/send", whatsappController.sendMessage);

/**
 * @swagger
 * /api/whatsapp/status:
 *   get:
 *     summary: Get Green API account connection status
 *     tags: [WhatsApp]
 *     responses:
 *       200:
 *         description: Current WhatsApp connection status
 *       500:
 *         description: Server error
 */
router.get("/sms-logs", whatsappController.getSmsLogs);
router.get("/sms-counter", whatsappController.getSmsCounter);

router.get("/status", whatsappController.getStatus);

module.exports = router;
