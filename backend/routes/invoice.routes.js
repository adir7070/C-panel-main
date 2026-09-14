const express = require("express");
const {
  createInvoice,
  createInvoiceDemo,
  downloadInvoiceFile,
} = require("../controllers/invoice.controller");

const router = express.Router();

/**
 * @swagger
 * /api/invoice/create:
 *   post:
 *     summary: Create an invoice
 *     tags: [Invoice]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               customer:
 *                 type: object
 *                 properties:
 *                   name:  { type: string, example: "ישראל ישראלי" }
 *                   email: { type: string, example: "israel@example.com" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     description: { type: string, example: "שירות פרסום" }
 *                     quantity:    { type: integer, example: 1 }
 *                     price:       { type: number, example: 500 }
 *     responses:
 *       200:
 *         description: Invoice created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fileName: { type: string, example: "invoice_20260212.pdf" }
 *                 url:      { type: string, format: uri }
 *       500:
 *         description: Server error
 */
router.post("/create", createInvoice);

/**
 * @swagger
 * /api/invoice/demo:
 *   get:
 *     summary: Generate a demo invoice (for testing)
 *     tags: [Invoice]
 *     responses:
 *       200:
 *         description: Demo invoice generated
 */
router.get("/demo", createInvoiceDemo);

/**
 * @swagger
 * /api/invoice/files/{fileName}:
 *   get:
 *     summary: Download an invoice file
 *     tags: [Invoice]
 *     parameters:
 *       - in: path
 *         name: fileName
 *         required: true
 *         schema: { type: string }
 *         example: "invoice_20260212.pdf"
 *     responses:
 *       200:
 *         description: Invoice file (PDF)
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: File not found
 */
router.get("/files/:fileName", downloadInvoiceFile);

module.exports = router;
