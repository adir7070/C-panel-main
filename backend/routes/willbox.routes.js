const express = require("express");
const willboxController = require("../controllers/willbox.controller");

const router = express.Router();

/**
 * @swagger
 * /api/willbox:
 *   get:
 *     summary: List all invoices for a user
 *     tags: [Willbox]
 *     parameters:
 *       - in: query
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *         example: "0501234567"
 *     responses:
 *       200:
 *         description: List of invoices
 */
router.get("/", willboxController.getInvoices);

/**
 * @swagger
 * /api/willbox/upload:
 *   post:
 *     summary: Upload an invoice image
 *     tags: [Willbox]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *               phone:
 *                 type: string
 *                 example: "0501234567"
 *     responses:
 *       200:
 *         description: Invoice uploaded successfully
 */
router.post(
  "/upload",
  (req, res, next) => {
    willboxController.upload.single("image")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, error: err.message });
      }
      next();
    });
  },
  willboxController.uploadInvoice,
);

/**
 * @swagger
 * /api/willbox/generate-pdf:
 *   post:
 *     summary: Generate PDF from HTML
 *     tags: [Willbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               html:
 *                 type: string
 *     responses:
 *       200:
 *         description: PDF file
 */
router.post("/generate-pdf", willboxController.generatePdf);

/**
 * @swagger
 * /api/willbox/{id}:
 *   get:
 *     summary: Get a single invoice
 *     tags: [Willbox]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Invoice details
 */
router.get("/:id", willboxController.getInvoice);

/**
 * @swagger
 * /api/willbox/{id}/extract:
 *   post:
 *     summary: Extract data from invoice image using AI
 *     tags: [Willbox]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Extracted invoice data
 */
router.post("/:id/extract", willboxController.extractInvoice);

/**
 * @swagger
 * /api/willbox/{id}:
 *   put:
 *     summary: Update invoice extracted data (user edits)
 *     tags: [Willbox]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               extracted_data:
 *                 type: object
 *     responses:
 *       200:
 *         description: Invoice updated
 */
router.put("/:id", willboxController.updateInvoice);

/**
 * @swagger
 * /api/willbox/{id}:
 *   delete:
 *     summary: Delete an invoice and its image
 *     tags: [Willbox]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Invoice deleted
 */
router.delete("/:id", willboxController.deleteInvoice);

module.exports = router;
