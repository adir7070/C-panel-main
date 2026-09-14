const express = require('express');
const router = express.Router();
const instagramController = require('../controllers/instagram.controller');
const instagramAuthController = require('../controllers/instagram-auth.controller');

/**
 * @swagger
 * /api/instagram/generate:
 *   post:
 *     summary: Generate an Instagram post (async job)
 *     description: Starts an async job to generate Instagram post content (text + image). Returns a jobId to poll for status.
 *     tags: [Instagram]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               prompt:  { type: string, description: "Content description or brief" }
 *               page_id: { type: string, description: "Facebook Page ID" }
 *     responses:
 *       200:
 *         description: Job started. Use jobId to poll status.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:  { type: string }
 *                 status: { type: string, example: "pending" }
 *       500:
 *         description: Server error
 */
router.post('/generate', instagramController.createPost);

/**
 * @swagger
 * /api/instagram/jobs/{jobId}:
 *   get:
 *     summary: Get Instagram post generation job status
 *     tags: [Instagram]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job status and result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:  { type: string }
 *                 status: { type: string, enum: [pending, processing, completed, failed] }
 *                 result: { type: object, nullable: true }
 *       404:
 *         description: Job not found
 */
router.get('/jobs/:jobId', instagramController.getJobStatus);

// ─── Instagram OAuth ───
router.get('/auth/ig-login-url', instagramAuthController.getIgLoginUrl);
router.get('/auth/callback', instagramAuthController.igCallback);
router.get('/auth/fb-login-url', instagramAuthController.getFbLoginUrl);
router.get('/auth/fb-callback', instagramAuthController.fbCallback);

module.exports = router;
