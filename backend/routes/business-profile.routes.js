const express = require("express");
const router = express.Router();
const { getBusinessProfile, saveBusinessProfile, addService, addImages, removeImage } = require("../controllers/business-profile.controller");

/**
 * @swagger
 * tags:
 *   name: BusinessProfile
 *   description: Business profile management
 */

/**
 * @swagger
 * /api/business-profile:
 *   get:
 *     summary: Get business profile by phone
 *     tags: [BusinessProfile]
 *     parameters:
 *       - in: query
 *         name: phone
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Business profile data
 *       404:
 *         description: Not found
 */
router.get("/", getBusinessProfile);

/**
 * @swagger
 * /api/business-profile:
 *   post:
 *     summary: Save business profile
 *     tags: [BusinessProfile]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *             properties:
 *               phone:
 *                 type: string
 *               businessName:
 *                 type: string
 *               businessPhone:
 *                 type: string
 *               address:
 *                 type: string
 *               email:
 *                 type: string
 *               categoryKey:
 *                 type: string
 *               subCategoryKey:
 *                 type: string
 *               services:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     title:
 *                       type: string
 *                     description:
 *                       type: string
 *                     price:
 *                       type: string
 *     responses:
 *       200:
 *         description: Saved successfully
 */
router.post("/", saveBusinessProfile);
router.post("/service", addService);
router.post("/add-images", addImages);
router.post("/remove-image", removeImage);

module.exports = router;
