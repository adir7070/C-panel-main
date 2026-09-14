const express = require("express");
const router = express.Router();
const domainController = require("../controllers/domain.controller");

/**
 * @swagger
 * tags:
 *   name: Domain
 *   description: בדיקת זמינות ורכישת דומיינים דרך LiveDNS
 */

/**
 * @swagger
 * /api/domain/check:
 *   get:
 *     summary: בדיקת זמינות דומיין (Whois)
 *     description: |
 *       שולח בקשת SOAP ל-LiveDNS ומחזיר האם הדומיין זמין לרישום.
 *       `availableTlds` — רשימת סיומות זמינות אם LiveDNS מחזיר כמה אופציות.
 *       `whoisResult` — תשובת ה-Whois הגולמית כטקסט.
 *     tags: [Domain]
 *     parameters:
 *       - in: query
 *         name: domain
 *         required: true
 *         schema:
 *           type: string
 *         example: "alofhashiputzim.co.il"
 *         description: שם הדומיין לבדיקה (כולל סיומת)
 *     responses:
 *       200:
 *         description: תוצאת Whois
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:       { type: boolean, example: true }
 *                 domain:        { type: string, example: "alofhashiputzim.co.il" }
 *                 available:     { type: boolean, nullable: true, example: true }
 *                 availableTlds:
 *                   type: array
 *                   items: { type: string }
 *                   example: ["co.il", "org.il"]
 *                 whoisResult:   { type: string, nullable: true }
 *       400:
 *         description: Missing or invalid domain
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: LiveDNS SOAP error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/check", domainController.checkDomain);

/**
 * @swagger
 * /api/domain/register:
 *   post:
 *     summary: רכישת דומיין (בקרוב)
 *     description: |
 *       Placeholder — טרם הוטמע.
 *       בעתיד ישלח בקשת RegisterDomain ל-LiveDNS עם credentials.
 *     tags: [Domain]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [domain]
 *             properties:
 *               domain:
 *                 type: string
 *                 example: "mynewsite.co.il"
 *               years:
 *                 type: integer
 *                 example: 1
 *                 description: מספר שנים לרישום
 *     responses:
 *       501:
 *         description: Not implemented yet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string }
 */
router.post("/register", domainController.registerDomain);

router.post("/approve", domainController.approveDomain);

module.exports = router;
