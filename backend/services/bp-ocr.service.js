'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

const MAX_IMAGE_BYTES = 4.9 * 1024 * 1024; // Claude limit is 5MB — stay under

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalizes a vendor/entity name for deduplication and matching.
 * Lowercases, trims, collapses whitespace, removes punctuation but keeps Hebrew.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s֐-׿]/g, '') // keep Hebrew chars (U+0590–U+05FF)
    .trim();
}

/**
 * Parses a date string and returns a Date, or undefined if invalid.
 * @param {string} dateStr
 * @returns {Date|undefined}
 */
function parseDate(dateStr) {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Compresses an image buffer if it exceeds 4.9 MB.
 * PDFs are passed through untouched.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function compressIfNeeded(buffer, mimeType) {
  if (mimeType === 'application/pdf' || buffer.length <= MAX_IMAGE_BYTES) {
    return { buffer, mimeType };
  }
  const mb = (buffer.length / 1024 / 1024).toFixed(1);
  console.info(`[OCR] Image ${mb}MB — compressing before Claude`);
  const compressed = await sharp(buffer)
    .resize({ width: 3000, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  console.info(`[OCR] Compressed to ${(compressed.length / 1024 / 1024).toFixed(1)}MB`);
  return { buffer: compressed, mimeType: 'image/jpeg' };
}

/**
 * Returns a configured Anthropic SDK client.
 * @returns {Anthropic}
 */
function getAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  return new Anthropic({ apiKey });
}

// ─── Claude OCR ───────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are an expert at extracting structured data from invoices and receipts. Be thorough and precise.

Analyze this document and extract ALL available information in this exact JSON format:

{
  "vendor": {
    "name": "string — the issuing business/vendor name",
    "taxId": "string or null — VAT number / business registration / tax ID",
    "address": "string or null",
    "phone": "string or null",
    "email": "string or null"
  },
  "customer": {
    "name": "string or null — the recipient/buyer name",
    "taxId": "string or null — customer VAT/tax number"
  },
  "documentNumber": "string or null — invoice/receipt number",
  "referenceNumber": "string or null — PO number, order reference, or external reference",
  "documentType": "invoice | receipt | credit_note | proforma | delivery_note | other",
  "dates": {
    "issued": "YYYY-MM-DD or null",
    "due": "YYYY-MM-DD or null — payment due date"
  },
  "currency": "3-letter ISO code — detect from symbols: $ = USD, ₪ or ש״ח = ILS, € = EUR, £ = GBP. Default ILS only if document is clearly in Hebrew with no currency symbol.",
  "exchangeRate": "number or null",
  "amounts": {
    "subtotal": "number or null — before tax/VAT",
    "vatRate": "number or null — VAT percentage (e.g. 17 for 17%)",
    "vatAmount": "number or null — VAT amount in document currency",
    "total": "number — REQUIRED, final amount due",
    "discount": "number or null — discount amount",
    "paid": "number or null — amount already paid",
    "outstanding": "number or null — remaining balance"
  },
  "paymentMethod": "cash | credit_card | bank_transfer | check | other | null",
  "paymentReference": "string or null — check number, transaction ID, bank reference",
  "lineItems": [
    {
      "lineNumber": "number",
      "description": "string — item/service description",
      "itemCode": "string or null — SKU/product code",
      "quantity": "number or null",
      "unit": "string or null — unit of measure",
      "unitPrice": "number or null",
      "vatRate": "number or null",
      "discount": "number or null",
      "total": "number — line total"
    }
  ],
  "confidence": "number (0-100)"
}

IMPORTANT:
- For currency: look for $, USD, dollar → return "USD". Look for ₪, ש״ח, שקל, ILS → return "ILS". Look for €, EUR → return "EUR". Do NOT default to ILS if there is a dollar sign.
- Extract ALL line items, even if there are many.
- Return ONLY valid JSON, no markdown, no explanation.`;

/**
 * Calls Claude claude-sonnet-4-5 vision to extract structured data from a document buffer.
 * @param {Buffer} rawBuffer
 * @param {string} rawMimeType
 * @returns {Promise<{ engine: string, overallConfidence: number, extraction: object }>}
 */
async function runClaude(rawBuffer, rawMimeType) {
  const { buffer, mimeType } = await compressIfNeeded(rawBuffer, rawMimeType);
  const base64 = buffer.toString('base64');
  const isPdf = mimeType === 'application/pdf';

  /** @type {Array} */
  let messageContent;
  if (isPdf) {
    messageContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      },
      { type: 'text', text: EXTRACTION_PROMPT },
    ];
  } else {
    messageContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 },
      },
      { type: 'text', text: EXTRACTION_PROMPT },
    ];
  }

  const response = await getAnthropicClient().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: messageContent }],
  });

  const text = response.content[0] && response.content[0].type === 'text'
    ? response.content[0].text
    : '';

  // Strip markdown code fences if present
  let jsonText = text.trim();
  if (jsonText.startsWith('```')) {
    const match = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) jsonText = match[1];
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.error('[OCR] Claude returned invalid JSON', { text });
    return { engine: 'claude', overallConfidence: 0, extraction: {} };
  }

  const confidence = parsed.confidence || 80;
  const vendor = parsed.vendor || null;
  const customer = parsed.customer || null;
  const amounts = parsed.amounts || null;
  const dates = parsed.dates || null;
  const lineItemsRaw = Array.isArray(parsed.lineItems) ? parsed.lineItems : [];
  const extractedCurrency = parsed.currency || 'ILS';

  return {
    engine: 'claude',
    overallConfidence: confidence,
    extraction: {
      documentType: parsed.documentType || undefined,
      vendor: vendor && vendor.name
        ? {
            name: vendor.name,
            normalizedName: normalizeName(vendor.name),
            taxId: vendor.taxId || undefined,
            address: vendor.address || undefined,
            phone: vendor.phone || undefined,
            email: vendor.email || undefined,
            confidence,
          }
        : undefined,
      customer: customer && customer.name
        ? {
            name: customer.name,
            taxId: customer.taxId || undefined,
            confidence,
          }
        : undefined,
      documentNumber: parsed.documentNumber || undefined,
      referenceNumber: parsed.referenceNumber || undefined,
      currency: extractedCurrency,
      exchangeRate: parsed.exchangeRate || undefined,
      dates: {
        issued: dates && dates.issued ? parseDate(dates.issued) : undefined,
        due: dates && dates.due ? parseDate(dates.due) : undefined,
        confidence,
      },
      amounts: amounts
        ? {
            subtotal: amounts.subtotal || undefined,
            vatRate: amounts.vatRate || undefined,
            vatAmount: amounts.vatAmount || undefined,
            total: amounts.total || undefined,
            discount: amounts.discount || undefined,
            paid: amounts.paid || undefined,
            outstanding: amounts.outstanding || undefined,
            confidence,
          }
        : undefined,
      paymentMethod: parsed.paymentMethod || undefined,
      paymentReference: parsed.paymentReference || undefined,
      lineItems: lineItemsRaw.map((item, idx) => ({
        lineNumber: item.lineNumber || idx + 1,
        description: item.description || undefined,
        itemCode: item.itemCode || undefined,
        quantity: item.quantity || undefined,
        unit: item.unit || undefined,
        unitPrice: item.unitPrice || undefined,
        vatRate: item.vatRate || undefined,
        discount: item.discount || undefined,
        total: item.total || undefined,
        confidence,
      })),
    },
  };
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────

/**
 * Runs the full OCR pipeline on a document buffer using Claude vision.
 * @param {Buffer} buffer - Raw file buffer
 * @param {string} mimeType - MIME type (e.g. 'image/jpeg', 'application/pdf')
 * @returns {Promise<{ engine: string, overallConfidence: number, extraction: object }>}
 */
async function runOcrPipeline(buffer, mimeType) {
  const startTime = Date.now();
  console.info('[OCR] Starting OCR pipeline — Claude Vision');

  try {
    const result = await runClaude(buffer, mimeType);
    console.info(
      `[OCR] Claude OCR done in ${Date.now() - startTime}ms, confidence: ${result.overallConfidence.toFixed(0)}%`
    );
    return result;
  } catch (err) {
    console.error('[OCR] Claude OCR failed', err);
    throw err;
  }
}

module.exports = { runOcrPipeline, normalizeName };
