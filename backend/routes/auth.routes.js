const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

/**
 * @swagger
 * /api/auth/otp/send:
 *   post:
 *     summary: Send OTP to a phone number via WhatsApp
 *     description: Generates a 6-digit OTP, saves it in DB (expires in 10 min), and sends it via WhatsApp (Green API).
 *     tags: [Auth]
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
 *                 description: Israeli phone number. Accepted formats — 0501234567 / 972501234567 / +972501234567
 *                 example: "0501234567"
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "OTP sent successfully." }
 *       400:
 *         description: Missing or invalid phone number
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       500:
 *         description: Failed to send OTP via WhatsApp
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 */
router.post('/otp/send', authController.sendOtp);

/**
 * @swagger
 * /api/auth/otp/verify:
 *   post:
 *     summary: Verify OTP code
 *     description: Checks the OTP against the DB. OTP expires after 10 minutes. Clears the OTP on success.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, code]
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Must match the phone used in otp/send (formatted as 972XXXXXXXXX)
 *                 example: "972501234567"
 *               code:
 *                 type: string
 *                 description: 6-digit OTP code received via WhatsApp
 *                 example: "482931"
 *     responses:
 *       200:
 *         description: OTP verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "OTP verified successfully" }
 *       400:
 *         description: Invalid or expired OTP
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "Invalid or expired OTP" }
 *       500:
 *         description: Server error
 */
router.post('/otp/verify', authController.verifyOtp);

router.post('/push-token', authController.savePushToken);
router.get('/restore-credentials/:phone', authController.restoreCredentials);
router.delete('/token/:phone', authController.clearUserToken);

module.exports = router;
