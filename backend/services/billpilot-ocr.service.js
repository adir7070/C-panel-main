const { OpenAI } = require('openai');

const MAX_IMAGE_BYTES = 4.9 * 1024 * 1024;

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY || process.env.OpenAI_API_KEY });
}

async function compressIfNeeded(buffer, mimeType) {
  if (mimeType === 'application/pdf' || buffer.length <= MAX_IMAGE_BYTES) {
    return { buffer, mimeType };
  }
  try {
    const sharp = require('sharp');
    const compressed = await sharp(buffer)
      .resize({ width: 3000, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { buffer: compressed, mimeType: 'image/jpeg' };
  } catch {
    return { buffer, mimeType };
  }
}

const EXTRACTION_PROMPT = `You are an expert at extracting structured data from invoices and receipts. Analyze this document and extract ALL available information.

Return ONLY valid JSON with this structure (use null for missing fields):
{
  "documentType": "invoice|receipt|credit_note|other",
  "vendor": { "name": "", "taxId": null, "address": null, "phone": null, "email": null },
  "customer": { "name": null, "taxId": null },
  "documentNumber": null,
  "referenceNumber": null,
  "currency": "ILS",
  "exchangeRate": null,
  "dates": { "issued": "YYYY-MM-DD or null", "due": "YYYY-MM-DD or null" },
  "amounts": { "subtotal": null, "vatRate": null, "vatAmount": null, "total": null, "discount": null, "paid": null, "outstanding": null },
  "paymentMethod": null,
  "paymentReference": null,
  "lineItems": [{ "lineNumber": 1, "description": "", "quantity": null, "unitPrice": null, "total": null }],
  "confidence": 85
}`;

function normalizeName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function parseDate(str) {
  if (!str) return undefined;
  const d = new Date(str);
  return isNaN(d.getTime()) ? undefined : d;
}

async function runOcr(buffer, mimeType) {
  const { buffer: buf, mimeType: mime } = await compressIfNeeded(buffer, mimeType);
  const base64 = buf.toString('base64');
  const client = getClient();

  let content;
  if (mime === 'application/pdf') {
    content = [
      { type: 'text', text: EXTRACTION_PROMPT },
      {
        type: 'image_url',
        image_url: { url: `data:application/pdf;base64,${base64}`, detail: 'high' },
      },
    ];
  } else {
    content = [
      { type: 'text', text: EXTRACTION_PROMPT },
      {
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' },
      },
    ];
  }

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    max_tokens: 2000,
    temperature: 0,
  });

  const text = response.choices[0]?.message?.content || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('OCR returned no JSON');

  const parsed = JSON.parse(jsonMatch[0]);
  const confidence = Number(parsed.confidence) || 70;
  const vendor = parsed.vendor;
  const amounts = parsed.amounts;
  const dates = parsed.dates;
  const lineItems = Array.isArray(parsed.lineItems) ? parsed.lineItems : [];

  return {
    engine: 'gpt-4o',
    overallConfidence: confidence,
    extraction: {
      documentType: parsed.documentType || undefined,
      vendor: vendor?.name
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
      customer: parsed.customer?.name
        ? { name: parsed.customer.name, taxId: parsed.customer.taxId || undefined, confidence }
        : undefined,
      documentNumber: parsed.documentNumber || undefined,
      referenceNumber: parsed.referenceNumber || undefined,
      currency: parsed.currency || 'ILS',
      exchangeRate: parsed.exchangeRate || undefined,
      dates: {
        issued: parseDate(dates?.issued),
        due: parseDate(dates?.due),
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
      lineItems: lineItems.map((item, idx) => ({
        lineNumber: item.lineNumber || idx + 1,
        description: item.description || undefined,
        quantity: item.quantity || undefined,
        unitPrice: item.unitPrice || undefined,
        total: item.total || undefined,
        confidence,
      })),
    },
  };
}

module.exports = { runOcr };
