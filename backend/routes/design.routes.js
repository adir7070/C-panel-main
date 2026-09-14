const express = require("express");
const router = express.Router();
const {
  getDesignImages,
  getDesignStatuses,
  approveImage,
  requestImageEdit,
  removeNote,
} = require("../controllers/design.controller");

/**
 * @swagger
 * /api/app/design/{phone}/images:
 *   get:
 *     summary: List design images from Google Drive
 *     tags: [Design]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: Paginated list of images with statuses
 */
router.get("/:phone/images", getDesignImages);

/**
 * @swagger
 * /api/app/design/{phone}/statuses:
 *   get:
 *     summary: Get all design statuses for a user
 *     tags: [Design]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Map of fileId to status
 */
router.get("/:phone/statuses", getDesignStatuses);

/**
 * @swagger
 * /api/app/design/{phone}/approve:
 *   post:
 *     summary: Approve a design image
 *     tags: [Design]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fileId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Image approved and copied
 */
router.post("/:phone/approve", approveImage);

/**
 * @swagger
 * /api/app/design/{phone}/request-edit:
 *   post:
 *     summary: Request edits on a design image
 *     tags: [Design]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fileId:
 *                 type: string
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Edit request created with notes document
 */
router.post("/:phone/request-edit", requestImageEdit);
router.post("/:phone/remove-note", removeNote);

module.exports = router;
