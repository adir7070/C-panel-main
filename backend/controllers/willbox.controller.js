const multer = require("multer");
const { ObjectId } = require("mongodb");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const backblazeService = require("../services/backblaze.service");
const DB = require("../utils/DB");

const COLLECTION = "willbox_invoices";
const invoices = () => DB.collection(COLLECTION);

// --- Multer setup (reuse same pattern as image-proxy) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/heic",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}`));
  },
});

// --- Gemini setup for invoice extraction ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

const EXTRACTION_PROMPT = `You are an invoice data extraction assistant. Analyze the provided invoice image and extract all data.

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "business_name": "string or null",
  "invoice_number": "string or null",
  "invoice_date": "string or null",
  "due_date": "string or null",
  "subtotal": number or null,
  "vat_amount": number or null,
  "total_amount": number or null,
  "currency": "ILS",
  "line_items": [
    {
      "description": "string",
      "quantity": number,
      "unit_price": number,
      "total": number
    }
  ],
  "notes": "string or null"
}

Rules:
- If a field is not found in the image, use null
- For amounts, use numbers (not strings)
- Support Hebrew, English, and mixed-language invoices
- Extract ALL line items visible in the invoice
- currency should be the 3-letter ISO code (ILS, USD, EUR, etc.)`;

// --- Controllers ---

/**
 * GET /api/willbox?phone=X
 * List all invoices for a user
 */
exports.getInvoices = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ success: false, error: "phone is required" });
    }

    console.log(`🔍 [Willbox] Listing invoices for ${phone}`);

    const docs = await invoices()
      .find({ phone })
      .sort({ created_at: -1 })
      .toArray();

    res.json({ success: true, data: docs, total: docs.length });
  } catch (error) {
    console.error("❌ [Willbox] Error listing invoices:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * GET /api/willbox/:id
 * Get single invoice
 */
exports.getInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid invoice ID" });
    }

    const doc = await invoices().findOne({ _id: new ObjectId(id) });
    if (!doc) {
      return res.status(404).json({ success: false, error: "Invoice not found" });
    }

    res.json({ success: true, data: doc });
  } catch (error) {
    console.error("❌ [Willbox] Error getting invoice:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/willbox/upload
 * Upload invoice image → Backblaze B2 → save metadata to MongoDB
 * Form fields: image (file), phone (string)
 */
exports.uploadInvoice = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No image file provided" });
    }

    const phone = (req.body.phone || "").trim();
    if (!phone) {
      return res.status(400).json({ success: false, error: "phone is required" });
    }

    // Build filename with timestamp
    const mimeToExt = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/heic": "heic",
    };
    const ext = mimeToExt[req.file.mimetype] || "jpg";
    const fileName = `invoice-${Date.now()}.${ext}`;
    const b2Path = `uploads/willbox/${phone}/${fileName}`;

    console.log(`📤 [Willbox] Uploading ${b2Path}`);

    await backblazeService.uploadImage(b2Path, req.file.buffer, req.file.mimetype);

    const serverBaseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const imageUrl = `${serverBaseUrl}/api/img?url=${encodeURIComponent(b2Path)}`;

    // Save to MongoDB
    const doc = {
      phone,
      image_url: imageUrl,
      image_path: b2Path,
      status: "uploaded",
      extracted_data: null,
      raw_ai_response: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const result = await invoices().insertOne(doc);
    doc._id = result.insertedId;

    console.log(`✅ [Willbox] Invoice uploaded: ${doc._id}`);

    res.json({ success: true, data: doc });
  } catch (error) {
    console.error("❌ [Willbox] Upload error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/willbox/:id/extract
 * Download image from B2, send to Gemini for extraction, save result
 */
exports.extractInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid invoice ID" });
    }

    const doc = await invoices().findOne({ _id: new ObjectId(id) });
    if (!doc) {
      return res.status(404).json({ success: false, error: "Invoice not found" });
    }

    // Mark as extracting
    await invoices().updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "extracting", updated_at: new Date() } },
    );

    console.log(`🤖 [Willbox] Extracting data from invoice ${id}`);

    // Download image from Backblaze
    const imageFile = await backblazeService.downloadImageByPath(doc.image_path);
    const imageBase64 = imageFile.buffer.toString("base64");

    // Send to Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent([
      { inlineData: { mimeType: imageFile.contentType, data: imageBase64 } },
      EXTRACTION_PROMPT,
    ]);
    const response = await result.response;
    const rawText = response.text();

    console.log(`🤖 [Willbox] Gemini raw response length: ${rawText.length}`);

    // Parse JSON from response (strip markdown fences if present)
    let extracted;
    try {
      const jsonStr = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      extracted = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error("❌ [Willbox] Failed to parse Gemini response:", rawText);
      await invoices().updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "uploaded", raw_ai_response: rawText, updated_at: new Date() } },
      );
      return res.status(422).json({
        success: false,
        error: "AI returned invalid data. Please try again.",
        raw: rawText,
      });
    }

    // Save extracted data
    await invoices().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "extracted",
          extracted_data: extracted,
          raw_ai_response: rawText,
          updated_at: new Date(),
        },
      },
    );

    const updated = await invoices().findOne({ _id: new ObjectId(id) });
    console.log(`✅ [Willbox] Extraction complete for ${id}`);

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error("❌ [Willbox] Extraction error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PUT /api/willbox/:id
 * Update extracted_data (user edits) and save
 */
exports.updateInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid invoice ID" });
    }

    const { extracted_data } = req.body;
    if (!extracted_data || typeof extracted_data !== "object") {
      return res.status(400).json({ success: false, error: "extracted_data is required" });
    }

    const result = await invoices().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          extracted_data,
          status: "saved",
          updated_at: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: "Invoice not found" });
    }

    const updated = await invoices().findOne({ _id: new ObjectId(id) });
    console.log(`✅ [Willbox] Invoice ${id} updated and saved`);

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error("❌ [Willbox] Update error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * DELETE /api/willbox/:id
 * Delete an invoice and its image from B2
 */
exports.deleteInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid invoice ID" });
    }

    const doc = await invoices().findOne({ _id: new ObjectId(id) });
    if (!doc) {
      return res.status(404).json({ success: false, error: "Invoice not found" });
    }

    // B2 image cleanup skipped — deleteImage is not functional yet

    await invoices().deleteOne({ _id: new ObjectId(id) });
    console.log(`✅ [Willbox] Invoice ${id} deleted`);

    res.json({ success: true });
  } catch (error) {
    console.error("❌ [Willbox] Delete error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ─── Generate PDF from invoice data ───
exports.generatePdf = async (req, res) => {
  try {
    const { title, subtitle, invoices: invoiceList, grandTotal, footer } = req.body;
    if (!invoiceList || !invoiceList.length) return res.status(400).json({ success: false, error: "invoices required" });

    const PDFDocument = require("pdfkit");
    const path = require("path");
    const fetch = require("node-fetch");

    const RTL = { features: ["rtla"] };
    const fontPath = path.join(__dirname, "../assets/fonts/Arial.ttf");
    const fontBoldPath = path.join(__dirname, "../assets/fonts/ArialBold.ttf");
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];

    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=invoices.pdf");
      res.send(pdfBuffer);
    });

    doc.registerFont("Arial", fontPath);
    doc.registerFont("ArialBold", fontBoldPath);

    const pageW = 515;
    const startX = 40;
    const centerX = startX + pageW / 2;

    // Helper: render centered text with Hebrew label + LTR value side by side
    function centeredMixed(label, value, y, opts = {}) {
      const fontSize = opts.fontSize || 13;
      const fontName = opts.fontBold ? "ArialBold" : "Arial";
      doc.font(fontName).fontSize(fontSize);
      const labelW = doc.widthOfString(label, RTL);
      const valueW = doc.widthOfString(value);
      const gap = 4;
      const totalW = labelW + gap + valueW;
      const x = centerX - totalW / 2;
      doc.fillColor(opts.color || "#333");
      doc.font(fontName).fontSize(fontSize).text(value, x, y);
      doc.font(fontName).fontSize(fontSize).text(label, x + valueW + gap, y, RTL);
    }

    // ─── Header ───
    doc.rect(0, 0, 595, 80).fill("#0091FF");
    doc.font("ArialBold").fontSize(24).fillColor("#fff").text(title || "סיכום חשבוניות", startX, 20, { width: pageW, align: "center", ...RTL });
    if (subtitle) {
      doc.font("Arial").fontSize(13).fillColor("#e0e0ff").text(subtitle, startX, 50, { width: pageW, align: "center" });
    }
    doc.y = 100;

    // ─── Invoice Cards ───
    function drawInvoice(inv) {
      const ed = inv.extracted_data || {};
      const y = doc.y;
      const currency = ed.currency === "USD" ? "$" : ed.currency === "EUR" ? "€" : "₪";

      doc.roundedRect(startX, y, pageW, 120, 8).lineWidth(1).strokeColor("#E5E5EA").stroke();

      // Invoice number badge
      if (ed.invoice_number) {
        doc.roundedRect(startX + 10, y + 10, 60, 24, 4).fill("#0091FF");
        doc.font("ArialBold").fontSize(10).fillColor("#fff").text("#" + ed.invoice_number, startX + 12, y + 16, { width: 56, align: "center" });
      }

      // Business name
      doc.font("ArialBold").fontSize(14).fillColor("#333").text(ed.business_name || "-", startX + 80, y + 14, { width: pageW - 90, ...RTL });
      doc.font("Arial").fontSize(11).fillColor("#888").text(ed.invoice_date || "", startX + 80, y + 34);

      const amountY = y + 65;

      // Subtotal
      doc.font("Arial").fontSize(10).fillColor("#888").text("לפני מע״מ", startX + 20, amountY, RTL);
      doc.font("ArialBold").fontSize(13).fillColor("#333").text(
        ed.subtotal != null ? currency + Number(ed.subtotal).toLocaleString() : "-",
        startX + 20, amountY + 16
      );

      // VAT
      doc.font("Arial").fontSize(10).fillColor("#888").text("מע״מ", startX + 160, amountY, RTL);
      doc.font("ArialBold").fontSize(13).fillColor("#333").text(
        ed.vat_amount != null ? currency + Number(ed.vat_amount).toLocaleString() : "-",
        startX + 160, amountY + 16
      );

      // Total (highlighted)
      doc.roundedRect(startX + 340, amountY - 5, 165, 45, 6).fill("#E8F5E9");
      doc.font("Arial").fontSize(10).fillColor("#2E7D32").text("סה״כ", startX + 350, amountY, RTL);
      doc.font("ArialBold").fontSize(16).fillColor("#2E7D32").text(
        ed.total_amount != null ? currency + Number(ed.total_amount).toLocaleString() : "-",
        startX + 350, amountY + 16
      );

      doc.y = y + 130;
    }

    for (let i = 0; i < invoiceList.length; i++) {
      if (doc.y > 680) doc.addPage();
      drawInvoice(invoiceList[i]);
      doc.moveDown(0.3);
    }

    // ─── Grand Total ───
    doc.moveDown(0.5);
    const totY = doc.y;
    doc.rect(startX, totY, pageW, 50).fill("#F5F5F7");
    if (grandTotal) {
      centeredMixed("סה״כ כללי:", grandTotal.replace(/[^₪$€\d,.]/g, "").trim() || "", totY + 14, { fontSize: 18, fontBold: true, color: "#333" });
    }

    // ─── Footer ───
    const footY = totY + 70;
    if (footer) {
      centeredMixed("הופק על ידי", "Iconiq · " + new Date().toLocaleDateString("he-IL"), footY, { fontSize: 9, color: "#bbb" });
    }

    doc.end();
  } catch (error) {
    console.error("❌ [Willbox] generatePdf error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Export multer for route middleware
exports.upload = upload;
