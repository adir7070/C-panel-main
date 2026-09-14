const express = require("express");
const router = express.Router();
const clientBriefController = require("../controllers/client-brief.controller");

// ─────────────────────────────────────────────
// CLIENT BRIEF
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/client-brief:
 *   get:
 *     summary: Get all client briefs (admin dashboard)
 *     tags: [ClientBrief]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: skip
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of client briefs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ClientBrief' }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     limit: { type: integer }
 *                     skip:  { type: integer }
 */
router.get("/", clientBriefController.getAllBriefs);

/**
 * @swagger
 * /api/client-brief/by-phone/{phone}:
 *   get:
 *     summary: Get a single client brief by phone number
 *     tags: [ClientBrief]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *         example: "0501234567"
 *     responses:
 *       200:
 *         description: Client brief data
 *       404:
 *         description: Brief not found
 */
router.get("/by-phone/:phone", clientBriefController.getBriefByPhone);

/**
 * @swagger
 * /api/client-brief/msgs/{phone}:
 *   get:
 *     summary: Get only the msgs array for a customer by phone
 *     tags: [ClientBrief]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *         example: "0501234567"
 *     responses:
 *       200:
 *         description: msgs array
 *       404:
 *         description: Brief not found
 */
router.get("/msgs/:phone", clientBriefController.getMsgsByPhone);

/**
 * @swagger
 * /api/client-brief/snake-status/{phone}:
 *   post:
 *     summary: Push a snake-process status update for a customer (upserts by phone)
 *     tags: [ClientBrief]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *         description: "Phone in any format: 05XXXXXXXX, 9725XXXXXXXX, +9725XXXXXXXX"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, example: "completed_step_3" }
 *               shortmsg: { type: string, example: "שלב 3 הושלם" }
 *     description: "Pushes { status, receivedAt } into the msgs array, identified by phone only"
 *     responses:
 *       200:
 *         description: Status pushed successfully
 *       400:
 *         description: Missing status
 */
router.post("/snake-status/:phone", clientBriefController.addSnakeStatus);

/**
 * @swagger
 * /api/client-brief/{id}:
 *   put:
 *     summary: Update a client brief by MongoDB _id (admin)
 *     tags: [ClientBrief]
 */
router.put("/:id", clientBriefController.updateBrief);

/**
 * @swagger
 * /api/client-brief/{id}:
 *   delete:
 *     summary: Delete a client brief by MongoDB _id (admin)
 *     tags: [ClientBrief]
 */
router.delete("/:id", clientBriefController.deleteBrief);

/**
 * @swagger
 * /api/client-brief/{pageId}:
 *   get:
 *     summary: Get a single client brief by pageId
 *     tags: [ClientBrief]
 *     parameters:
 *       - in: path
 *         name: pageId
 *         required: true
 *         schema: { type: string }
 *         example: "123456789"
 *     responses:
 *       200:
 *         description: Client brief data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/ClientBrief' }
 *       404:
 *         description: Brief not found
 */
router.get("/:pageId", clientBriefController.getBrief);

/**
 * @swagger
 * /api/client-brief:
 *   post:
 *     summary: Create or update a client brief (upsert by pageId)
 *     tags: [ClientBrief]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: []
 *             properties:
 *               pageId:         { type: string, example: "123456789" }
 *               stepId:         { type: integer, example: 3 }
 *               clientName:     { type: string, example: "בית קפה דני" }
 *               phone:          { type: string, example: "0501234567" }
 *               completedSteps: { type: array, items: { type: integer }, example: [1, 2, 3] }
 *               answers:
 *                 type: object
 *                 example: { business_name: "בית קפה דני", business_field: "מסעדנות" }
 *     responses:
 *       200:
 *         description: Brief saved/updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/ClientBrief' }
 *       400:
 *         description: Missing pageId
 */
router.post("/", clientBriefController.upsertBrief);

module.exports = router;
