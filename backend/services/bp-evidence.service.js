'use strict';

/**
 * bp-evidence.service.js
 * Heuristic email classification + financial scoring engine for BillPilot.
 * Ported from evidence.service.ts — no ML, keyword-based only.
 */

// ─── Keyword lists ────────────────────────────────────────────────────────────

const HE_INVOICE = ['חשבונית', 'חשבוניות', 'חשבונית מס', 'חשבונית מס קבלה', 'מספר חשבונית', 'החשבונית שלך', 'להורדת החשבונית', 'צפייה בחשבונית', 'צפה בחשבונית', 'הורדת חשבונית'];
const HE_RECEIPT = ['קבלה', 'קבלות', 'הקבלה שלך', 'להצגת קבלה', 'מספר קבלה'];
const HE_PAYMENT = ['תשלום', 'אישור תשלום', 'שולם', 'חיוב', 'זיכוי', 'החזר'];
const HE_ORDER   = ['הזמנה', 'מספר הזמנה', 'אישור הזמנה'];

const EN_INVOICE = ['invoice', 'tax invoice', 'invoice number', 'download invoice', 'view invoice', 'open invoice', 'billing statement'];
const EN_RECEIPT = ['receipt', 'payment receipt', 'receipt number', 'download receipt', 'view receipt'];
const EN_PAYMENT = ['payment confirmation', 'paid', 'amount paid', 'total paid', 'charged', 'billing', 'bill', 'payment'];
const EN_ORDER   = ['order confirmation', 'order number', 'order #'];

const NEWSLETTER_SIGNALS = ['unsubscribe', 'opt-out', 'mailing list', 'newsletter', 'הסר מרשימה', 'הסרה מרשימת תפוצה'];
const MARKETING_SIGNALS  = ['special offer', 'limited time', 'sale ends', 'discount code', 'promo code', 'click here to shop', 'shop now'];

const INVOICE_LINK_TEXTS  = ['invoice', 'חשבונית', 'download invoice', 'view invoice', 'להורדת חשבונית', 'צפה בחשבונית', 'הורד חשבונית'];
const RECEIPT_LINK_TEXTS  = ['receipt', 'קבלה', 'download receipt', 'view receipt', 'הורד קבלה', 'להצגת קבלה'];
const DOWNLOAD_LINK_TEXTS = ['download', 'הורדה', 'הורד', 'pdf', 'print'];
const BILLING_URL_PARTS   = ['invoice', 'receipt', 'billing', 'payment', 'חשבונית', 'קבלה'];
const LOGIN_SIGNALS       = ['login', 'sign in', 'session expired', 'access denied', 'unauthorized', 'התחברות', 'כניסה לחשבון', 'פג תוקף'];

// ─── Evidence weights ─────────────────────────────────────────────────────────

const W = {
  subjectInvoice:        30,
  subjectReceipt:        28,
  subjectPayment:        18,
  subjectOrder:          10,
  bodyInvoice:           22,
  bodyReceipt:           20,
  bodyPayment:           14,
  pdfAttachment:         25,
  imageAttachment:       15,
  attachmentNameInvoice: 35,
  attachmentNameReceipt: 32,
  linkTextInvoice:       40,
  linkTextReceipt:       36,
  linkTextDownload:      25,
  urlInvoice:            30,
  urlReceipt:            28,
  urlBilling:            22,
  urlEndsPdf:            25,
  amountDetected:        15,
  dateDetected:           8,
  vatDetected:           25,
  totalDetected:         18,
  businessTaxId:         25,
  invoiceNumber:         35,
  receiptNumber:         32,
  paymentMethod:         12,
  orderNumber:           10,
  pdfDownloaded:         45,
  ocrInvoice:            45,
  ocrReceipt:            42,
  ocrVat:                30,
  ocrTotal:              25,
  newsletter:           -35,
  marketing:            -25,
  onlyUnsubscribe:      -20,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function containsAny(text, keywords) {
  const lower = (text || '').toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

function extractAmounts(text) {
  return /(\d{1,3}(,\d{3})*(\.\d{2})?|\d+\.\d{2})\s*(₪|ils|usd|\$|€|eur)/i.test(text) ||
    /סה"כ\s*:?\s*\d+/i.test(text) ||
    /total\s*:?\s*\d+/i.test(text);
}

function extractDates(text) {
  return /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(text) ||
    /\d{4}-\d{2}-\d{2}/.test(text);
}

function extractVat(text) {
  return /מע"מ|vat|tax\s+\d+%|\d+%\s+vat/i.test(text);
}

function extractInvoiceNumber(text) {
  return /מספר\s+חשבונית|invoice\s+#|inv[-\s]?\d+|invoice\s+number/i.test(text) ||
    /#\s*\d{4,}/i.test(text);
}

function extractReceiptNumber(text) {
  return /מספר\s+קבלה|receipt\s+#|rec[-\s]?\d+|receipt\s+number/i.test(text);
}

function extractBusinessTaxId(text) {
  return /ח\.פ|ע\.מ|עוסק\s+מורשה|c\.n\.|tax\s+id|vat\s+number|\d{9}/i.test(text);
}

function extractPaymentMethod(text) {
  return /visa|mastercard|amex|paypal|bit|אשראי|credit\s+card|bank\s+transfer|העברה\s+בנקאית/i.test(text);
}

function normalizeUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return (url || '').toLowerCase();
  }
}

// ─── Evidence engine ──────────────────────────────────────────────────────────

/**
 * Run the full evidence scoring engine against a normalized email object.
 *
 * @param {{
 *   subject: string,
 *   fromEmail: string,
 *   fromName: string,
 *   bodyText: string,
 *   bodyHtml: string,
 *   attachments: Array<{ filename: string, mimeType: string, size: number }>,
 *   links: Array<{ text: string, url: string }>
 * }} email
 * @returns {{
 *   scores: { financialIntentScore, documentEvidenceScore, documentAvailabilityScore, extractionConfidenceScore },
 *   confidence: number,
 *   evidence: object[],
 *   candidateLinks: object[]
 * }}
 */
function runEvidenceEngine(email) {
  const evidence = [];
  const allText = `${email.subject} ${email.fromEmail} ${email.bodyText}`;

  let financialIntentRaw = 0;
  let documentEvidenceRaw = 0;
  let documentAvailabilityRaw = 0;

  // Subject signals
  if (containsAny(email.subject, [...HE_INVOICE, ...EN_INVOICE])) {
    evidence.push({ type: 'subject_invoice', value: email.subject, weight: W.subjectInvoice });
    documentEvidenceRaw += W.subjectInvoice;
  }
  if (containsAny(email.subject, [...HE_RECEIPT, ...EN_RECEIPT])) {
    evidence.push({ type: 'subject_receipt', value: email.subject, weight: W.subjectReceipt });
    documentEvidenceRaw += W.subjectReceipt;
  }
  if (containsAny(email.subject, [...HE_PAYMENT, ...EN_PAYMENT])) {
    evidence.push({ type: 'subject_payment', value: email.subject, weight: W.subjectPayment });
    financialIntentRaw += W.subjectPayment;
  }
  if (containsAny(email.subject, [...HE_ORDER, ...EN_ORDER])) {
    evidence.push({ type: 'subject_order', value: email.subject, weight: W.subjectOrder });
    financialIntentRaw += W.subjectOrder;
  }

  // Body signals
  if (containsAny(email.bodyText, [...HE_INVOICE, ...EN_INVOICE])) {
    evidence.push({ type: 'body_invoice', value: 'keyword found', weight: W.bodyInvoice });
    documentEvidenceRaw += W.bodyInvoice;
  }
  if (containsAny(email.bodyText, [...HE_RECEIPT, ...EN_RECEIPT])) {
    evidence.push({ type: 'body_receipt', value: 'keyword found', weight: W.bodyReceipt });
    documentEvidenceRaw += W.bodyReceipt;
  }
  if (containsAny(email.bodyText, [...HE_PAYMENT, ...EN_PAYMENT])) {
    evidence.push({ type: 'body_payment', value: 'keyword found', weight: W.bodyPayment });
    financialIntentRaw += W.bodyPayment;
  }

  // Financial field signals
  if (extractAmounts(allText)) {
    evidence.push({ type: 'amount_detected', value: 'amount found', weight: W.amountDetected });
    financialIntentRaw += W.amountDetected;
  }
  if (extractDates(allText)) {
    evidence.push({ type: 'date_detected', value: 'date found', weight: W.dateDetected });
    financialIntentRaw += W.dateDetected;
  }
  if (extractVat(allText)) {
    evidence.push({ type: 'vat_detected', value: 'VAT found', weight: W.vatDetected });
    documentEvidenceRaw += W.vatDetected;
  }
  if (/סה"כ|total/i.test(allText)) {
    evidence.push({ type: 'total_detected', value: 'total found', weight: W.totalDetected });
    documentEvidenceRaw += W.totalDetected;
  }
  if (extractInvoiceNumber(allText)) {
    evidence.push({ type: 'invoice_number', value: 'invoice number found', weight: W.invoiceNumber });
    documentEvidenceRaw += W.invoiceNumber;
  }
  if (extractReceiptNumber(allText)) {
    evidence.push({ type: 'receipt_number', value: 'receipt number found', weight: W.receiptNumber });
    documentEvidenceRaw += W.receiptNumber;
  }
  if (extractBusinessTaxId(allText)) {
    evidence.push({ type: 'business_tax_id', value: 'tax id found', weight: W.businessTaxId });
    documentEvidenceRaw += W.businessTaxId;
  }
  if (extractPaymentMethod(allText)) {
    evidence.push({ type: 'payment_method', value: 'payment method found', weight: W.paymentMethod });
    financialIntentRaw += W.paymentMethod;
  }
  if (containsAny(allText, [...HE_ORDER, ...EN_ORDER])) {
    evidence.push({ type: 'order_number', value: 'order signal found', weight: W.orderNumber });
    financialIntentRaw += W.orderNumber;
  }

  // Attachment signals
  const attachments = email.attachments || [];
  const hasPdf   = attachments.some(a => a.mimeType === 'application/pdf');
  const hasImage = attachments.some(a => a.mimeType && a.mimeType.startsWith('image/'));

  if (hasPdf) {
    evidence.push({ type: 'pdf_attachment', value: 'PDF found', weight: W.pdfAttachment });
    documentEvidenceRaw     += W.pdfAttachment;
    documentAvailabilityRaw += W.pdfAttachment;
  }
  if (hasImage) {
    evidence.push({ type: 'image_attachment', value: 'image found', weight: W.imageAttachment });
    documentEvidenceRaw     += W.imageAttachment;
    documentAvailabilityRaw += W.imageAttachment;
  }
  for (const att of attachments) {
    const fname = (att.filename || '').toLowerCase();
    if (containsAny(fname, ['invoice', 'חשבונית', 'inv_', 'inv-'])) {
      evidence.push({ type: 'attachment_name_invoice', value: att.filename, weight: W.attachmentNameInvoice });
      documentEvidenceRaw += W.attachmentNameInvoice;
    } else if (containsAny(fname, ['receipt', 'קבלה', 'rec_', 'rec-'])) {
      evidence.push({ type: 'attachment_name_receipt', value: att.filename, weight: W.attachmentNameReceipt });
      documentEvidenceRaw += W.attachmentNameReceipt;
    }
  }

  // Link signals + candidate links
  const candidateLinks = [];
  const links = email.links || [];

  for (const link of links) {
    const ltext = (link.text || '').toLowerCase();
    const lurl  = (link.url  || '').toLowerCase();
    let linkScore = 0;

    if (containsAny(ltext, INVOICE_LINK_TEXTS)) {
      evidence.push({ type: 'link_text_invoice', value: link.text, weight: W.linkTextInvoice });
      documentEvidenceRaw     += W.linkTextInvoice;
      documentAvailabilityRaw += W.linkTextInvoice;
      linkScore += W.linkTextInvoice;
    }
    if (containsAny(ltext, RECEIPT_LINK_TEXTS)) {
      evidence.push({ type: 'link_text_receipt', value: link.text, weight: W.linkTextReceipt });
      documentEvidenceRaw     += W.linkTextReceipt;
      documentAvailabilityRaw += W.linkTextReceipt;
      linkScore += W.linkTextReceipt;
    }
    if (containsAny(ltext, DOWNLOAD_LINK_TEXTS)) {
      evidence.push({ type: 'link_text_download', value: link.text, weight: W.linkTextDownload });
      documentAvailabilityRaw += W.linkTextDownload;
      linkScore += W.linkTextDownload;
    }
    if (containsAny(lurl, BILLING_URL_PARTS)) {
      const urlWeight = lurl.includes('invoice') ? W.urlInvoice
        : lurl.includes('receipt') ? W.urlReceipt
        : W.urlBilling;
      evidence.push({ type: 'url_financial', value: normalizeUrl(link.url), weight: urlWeight });
      documentEvidenceRaw     += urlWeight;
      documentAvailabilityRaw += urlWeight;
      linkScore += urlWeight;
    }
    if (lurl.endsWith('.pdf') || lurl.includes('.pdf?')) {
      evidence.push({ type: 'url_ends_pdf', value: normalizeUrl(link.url), weight: W.urlEndsPdf });
      documentAvailabilityRaw += W.urlEndsPdf;
      linkScore += W.urlEndsPdf;
    }
    if (containsAny(ltext, LOGIN_SIGNALS) || containsAny(lurl, ['login', 'signin', 'auth'])) {
      evidence.push({ type: 'login_signal', value: link.text || link.url, weight: 0 });
    }

    if (linkScore > 0 && link.url && link.url.startsWith('https://')) {
      candidateLinks.push({ text: link.text, url: link.url, score: Math.min(100, linkScore) });
    }
  }

  candidateLinks.sort((a, b) => b.score - a.score);

  // Negative signals
  if (containsAny(allText, NEWSLETTER_SIGNALS)) {
    evidence.push({ type: 'newsletter_signal', value: 'newsletter detected', weight: W.newsletter });
    financialIntentRaw  += W.newsletter;
    documentEvidenceRaw += W.newsletter;
  }
  if (containsAny(allText, MARKETING_SIGNALS)) {
    evidence.push({ type: 'marketing_signal', value: 'marketing detected', weight: W.marketing });
    financialIntentRaw  += W.marketing;
    documentEvidenceRaw += W.marketing;
  }

  // Normalize scores to 0–100
  const MAX_FINANCIAL = W.subjectPayment + W.bodyPayment + W.amountDetected + W.dateDetected + W.paymentMethod + W.orderNumber + W.subjectOrder;
  const MAX_EVIDENCE  = W.subjectInvoice + W.bodyInvoice + W.pdfAttachment + W.attachmentNameInvoice + W.linkTextInvoice + W.urlInvoice + W.vatDetected + W.invoiceNumber + W.businessTaxId + W.totalDetected;
  const MAX_AVAIL     = W.pdfAttachment + W.linkTextInvoice + W.urlInvoice + W.urlEndsPdf;

  const financialIntentScore      = Math.max(0, Math.min(100, Math.round((financialIntentRaw  / MAX_FINANCIAL) * 100)));
  const documentEvidenceScore     = Math.max(0, Math.min(100, Math.round((documentEvidenceRaw  / MAX_EVIDENCE)  * 100)));
  const documentAvailabilityScore = Math.max(0, Math.min(100, Math.round((documentAvailabilityRaw / MAX_AVAIL) * 100)));
  const extractionConfidenceScore = 0;

  const confidence = Math.min(100, Math.round(
    financialIntentScore      * 0.35 +
    documentEvidenceScore     * 0.45 +
    documentAvailabilityScore * 0.20,
  ));

  return {
    scores: { financialIntentScore, documentEvidenceScore, documentAvailabilityScore, extractionConfidenceScore },
    confidence,
    evidence,
    candidateLinks,
  };
}

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Classify an email based on its evidence result.
 * @param {object} result  Return value of runEvidenceEngine()
 * @returns {{ type: string, confidence: number, recommendedAction: string, scores: object, evidence: object[], candidateLinks: object[] }}
 */
function classifyEmail(result) {
  const { scores, confidence, evidence, candidateLinks } = result;
  const { financialIntentScore, documentEvidenceScore, documentAvailabilityScore } = scores;

  const hasAttachment  = evidence.some(e => ['pdf_attachment', 'image_attachment'].includes(e.type));
  const hasReceiptAtt  = evidence.some(e => e.type === 'attachment_name_receipt');
  const hasInvoiceLink = candidateLinks.length > 0 && evidence.some(e => e.type === 'link_text_invoice' || e.type === 'url_financial');
  const hasReceiptLink = candidateLinks.length > 0 && evidence.some(e => e.type === 'link_text_receipt');
  const hasLoginSignal = evidence.some(e => e.type === 'login_signal');
  const hasInvoiceKw   = evidence.some(e => ['subject_invoice', 'body_invoice', 'invoice_number'].includes(e.type));
  const hasReceiptKw   = evidence.some(e => ['subject_receipt', 'body_receipt', 'receipt_number'].includes(e.type));
  const hasPaymentKw   = evidence.some(e => ['subject_payment', 'body_payment'].includes(e.type));
  const hasAmount      = evidence.some(e => e.type === 'amount_detected');
  const hasOrderKw     = evidence.some(e => e.type === 'order_number');
  const hasNewsletter  = evidence.some(e => e.type === 'newsletter_signal');

  if (!hasAttachment && financialIntentScore < 10 && documentEvidenceScore < 10) {
    return { type: 'NOT_FINANCIAL', confidence: 95, recommendedAction: 'IGNORE', scores, evidence, candidateLinks };
  }

  if (hasLoginSignal && candidateLinks.length > 0) {
    return { type: 'LOGIN_REQUIRED', confidence: 85, recommendedAction: 'ASK_USER_TO_LOGIN', scores, evidence, candidateLinks };
  }

  if (hasAttachment && (documentEvidenceScore >= 10 || financialIntentScore >= 10)) {
    if (hasReceiptAtt || (hasReceiptKw && !hasInvoiceKw)) {
      return { type: 'RECEIPT_ATTACHMENT', confidence, recommendedAction: 'DOWNLOAD_ATTACHMENT', scores, evidence, candidateLinks };
    }
    return { type: 'INVOICE_ATTACHMENT', confidence, recommendedAction: 'DOWNLOAD_ATTACHMENT', scores, evidence, candidateLinks };
  }

  if (candidateLinks.length > 0 && documentAvailabilityScore >= 20) {
    if (hasReceiptLink && !hasInvoiceLink) {
      return { type: 'RECEIPT_LINK', confidence, recommendedAction: 'OPEN_CANDIDATE_LINK', scores, evidence, candidateLinks };
    }
    return { type: 'INVOICE_LINK', confidence, recommendedAction: 'OPEN_CANDIDATE_LINK', scores, evidence, candidateLinks };
  }

  if (hasPaymentKw && hasAmount && !hasAttachment && candidateLinks.length === 0) {
    if (documentEvidenceScore >= 20) {
      return { type: 'EMAIL_RECEIPT', confidence, recommendedAction: 'SAVE_EMAIL_AS_DOCUMENT', scores, evidence, candidateLinks };
    }
    if (financialIntentScore >= 50) {
      return { type: 'PAYMENT_CONFIRMATION_MISSING_INVOICE', confidence, recommendedAction: 'ADD_TO_MISSING_DOCUMENTS', scores, evidence, candidateLinks };
    }
  }

  if (financialIntentScore >= 60 && documentEvidenceScore < 20) {
    return { type: 'PAYMENT_CONFIRMATION_MISSING_INVOICE', confidence, recommendedAction: 'ADD_TO_MISSING_DOCUMENTS', scores, evidence, candidateLinks };
  }

  if (hasOrderKw && !hasPaymentKw && !hasAttachment && candidateLinks.length === 0) {
    return { type: 'ORDER_CONFIRMATION', confidence, recommendedAction: 'SEND_TO_USER_REVIEW', scores, evidence, candidateLinks };
  }

  if (confidence >= 35 && confidence < 60) {
    if (hasPaymentKw || hasInvoiceKw || hasReceiptKw) {
      return { type: 'FINANCIAL_MAYBE', confidence, recommendedAction: 'SEND_TO_USER_REVIEW', scores, evidence, candidateLinks };
    }
    return { type: 'NOT_FINANCIAL', confidence: 55, recommendedAction: 'IGNORE', scores, evidence, candidateLinks };
  }

  if (confidence < 35) {
    if (hasNewsletter) {
      return { type: 'NOT_FINANCIAL', confidence: 80, recommendedAction: 'IGNORE', scores, evidence, candidateLinks };
    }
    return { type: 'NOT_FINANCIAL', confidence: 60, recommendedAction: 'IGNORE', scores, evidence, candidateLinks };
  }

  return { type: 'UNKNOWN_FINANCIAL', confidence, recommendedAction: 'SEND_TO_AI_REVIEW', scores, evidence, candidateLinks };
}

// ─── Score financial intent ───────────────────────────────────────────────────

/**
 * Score a single email's financial intent (0–100).
 * Convenience wrapper around runEvidenceEngine.
 * @param {object} emailData  Normalized email
 * @returns {number}
 */
function scoreFinancialIntent(emailData) {
  const result = runEvidenceEngine(emailData);
  return result.scores.financialIntentScore;
}

// ─── Extract candidate links ──────────────────────────────────────────────────

/**
 * Find URLs from HTML/text that likely point to financial documents.
 * @param {string} html
 * @param {string} text
 * @returns {object[]} candidateLinks sorted by score
 */
function extractCandidateLinks(html, text) {
  const links = [];

  // Parse <a href="..."> tags from HTML
  const hrefRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = hrefRe.exec(html || '')) !== null) {
    const url  = match[1];
    const body = match[2].replace(/<[^>]+>/g, '').trim();
    if (url && url.startsWith('http')) links.push({ text: body, url });
  }

  // Also scan plain-text URLs
  const urlRe = /https?:\/\/[^\s"'<>)]+/g;
  const textUrls = (text || '').match(urlRe) || [];
  for (const url of textUrls) {
    if (!links.some(l => l.url === url)) links.push({ text: '', url });
  }

  // Score them using evidence engine
  const result = runEvidenceEngine({ subject: '', fromEmail: '', fromName: '', bodyText: text || '', bodyHtml: html || '', attachments: [], links });
  return result.candidateLinks;
}

// ─── Post-OCR confidence recalculation ────────────────────────────────────────

/**
 * Recalculate confidence scores after OCR text is available.
 * @param {object} scores  Prior scores object from runEvidenceEngine
 * @param {string} ocrText
 * @returns {{ extractionConfidenceScore: number, confidence: number }}
 */
function recalculateConfidenceAfterOcr(scores, ocrText) {
  let extractionRaw = 0;
  const MAX_EXTRACTION = W.ocrInvoice + W.ocrVat + W.ocrTotal + W.businessTaxId;

  if (containsAny(ocrText, [...HE_INVOICE, ...EN_INVOICE])) extractionRaw += W.ocrInvoice;
  if (containsAny(ocrText, [...HE_RECEIPT, ...EN_RECEIPT])) extractionRaw += W.ocrReceipt;
  if (extractVat(ocrText))         extractionRaw += W.ocrVat;
  if (/סה"כ|total/i.test(ocrText)) extractionRaw += W.ocrTotal;
  if (extractBusinessTaxId(ocrText)) extractionRaw += W.businessTaxId;

  const extractionConfidenceScore = Math.min(100, Math.round((extractionRaw / MAX_EXTRACTION) * 100));

  const confidence = Math.min(100, Math.round(
    scores.financialIntentScore      * 0.20 +
    scores.documentEvidenceScore     * 0.30 +
    scores.documentAvailabilityScore * 0.20 +
    extractionConfidenceScore        * 0.30,
  ));

  return { extractionConfidenceScore, confidence };
}

module.exports = {
  runEvidenceEngine,
  classifyEmail,
  scoreFinancialIntent,
  extractCandidateLinks,
  recalculateConfidenceAfterOcr,
};
