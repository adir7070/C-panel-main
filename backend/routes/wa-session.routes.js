const express = require("express");
const router = express.Router();
const waController = require("../controllers/wa-session.controller");

/**
 * @swagger
 * /api/wa/session/get-or-create:
 *   post:
 *     summary: Get existing or create new WhatsApp session for a phone number
 *     tags: [WhatsApp Sessions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "972501234567"
 *               name:
 *                 type: string
 *                 example: "John"
 *     responses:
 *       200:
 *         description: Session data with connect URL
 */
router.post("/session/get-or-create", waController.getOrCreateSession);

/**
 * @swagger
 * /api/wa/session/status/{phone}:
 *   get:
 *     summary: Get WhatsApp session status by phone number
 *     tags: [WhatsApp Sessions]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session status
 */
router.get("/session/status/:phone", waController.getSessionStatus);

/**
 * @swagger
 * /api/wa/session/status/wa-phone/{waPhone}:
 *   get:
 *     summary: Get WhatsApp session status by the connected WA phone number
 *     tags: [WhatsApp Sessions]
 *     parameters:
 *       - in: path
 *         name: waPhone
 *         required: true
 *         schema:
 *           type: string
 *         description: "The actual WhatsApp number that is connected (e.g. 972541234567)"
 *     responses:
 *       200:
 *         description: Session status including session_id and api_key
 */
router.get("/session/status/wa-phone/:waPhone", waController.getSessionStatusByWaPhone);

/**
 * @swagger
 * /api/wa/session/wa-phone/{waPhone}/send:
 *   post:
 *     summary: Send a message using the connected WA number as the session key
 *     tags: [WhatsApp Sessions]
 *     parameters:
 *       - in: path
 *         name: waPhone
 *         required: true
 *         schema:
 *           type: string
 *         description: "The connected WhatsApp number (e.g. 972541234567)"
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
 *                 example: "972501234567"
 *               message:
 *                 type: string
 *                 example: "שלום!"
 *     responses:
 *       200:
 *         description: Message sent
 */
router.post("/session/wa-phone/:waPhone/send", waController.sendMessageByWaPhone);

/**
 * @swagger
 * /api/wa/session/{phone}:
 *   delete:
 *     summary: Disconnect and delete WhatsApp session by phone number
 *     tags: [WhatsApp Sessions]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session deleted
 */
router.delete("/session/:phone", waController.deleteSessionByPhone);

/**
 * @swagger
 * /api/wa/session/{sessionId}/send:
 *   post:
 *     summary: Send WhatsApp message via connected session
 *     tags: [WhatsApp Sessions]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
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
 *                 example: "972501234567"
 *               message:
 *                 type: string
 *                 example: "שלום!"
 *     responses:
 *       200:
 *         description: Message sent
 */
router.post("/session/:sessionId/send", waController.sendMessage);

/**
 * @swagger
 * /api/wa/session/pairing-code:
 *   post:
 *     summary: Request a pairing code for phone number linking
 *     tags: [WhatsApp Sessions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, waPhone]
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "972501234567"
 *                 description: "Iconiq user phone"
 *               waPhone:
 *                 type: string
 *                 example: "972501234567"
 *                 description: "WhatsApp phone number (digits only)"
 *     responses:
 *       200:
 *         description: Pairing code returned
 */
router.post("/session/pairing-code", waController.requestPairingCode);

// ─── Auto-reply & messages ──────────────────────────────────────────────────

router.put("/session/auto-reply", waController.updateAutoReply);
router.get("/session/:phone/auto-reply", waController.getAutoReply);
router.get("/session/:phone/messages", waController.getMessagesByPhone);
router.get("/session/:phone/trust-score", waController.getTrustScore);

// ─── Admin panel routes (protected by WA_ADMIN_TOKEN) ───────────────────────

function requireWaAdmin(req, res, next) {
  const adminKey = req.headers["x-admin-key"];
  const token = process.env.WA_ADMIN_TOKEN;

  if (!token || !adminKey || adminKey !== token) {
    return res.status(401).json({ success: false, error: "Invalid admin token" });
  }

  next();
}

router.get("/panel/sessions", requireWaAdmin, waController.getAllSessions);
router.get("/panel/sessions/:id/status", requireWaAdmin, waController.getSessionStatusById);
router.delete("/panel/sessions/:id", requireWaAdmin, waController.deleteSessionById);
router.get("/panel/sessions/:id/messages", requireWaAdmin, waController.getMessages);

module.exports = router;
