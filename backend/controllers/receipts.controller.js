const path = require("path");
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const {
  htmlToPdfBuffer,
  writePdfFile,
  ensureDir,
  scheduleDelete,
  getBaseUrlFromRequest,
} = require("./invoice.controller");

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatAmount(n) {
  return Number(n || 0).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildReceiptHtml(receipt) {
  const amountFormatted = formatAmount(receipt.amount);
  const dateFormatted = formatDate(receipt.createdAt);
  const typeLabel = receipt.type === "package" ? "חבילת פרסום" : "חבילת מטבעות";
  const coinsRow = receipt.coinsGranted > 0
    ? `<tr class="coins-row"><td>מטבעות שנוספו לחשבון</td><td dir="ltr">${Number(receipt.coinsGranted).toLocaleString("he-IL")} מטבעות</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>קבלה ${escapeHtml(receipt.receiptNumber)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;700;800&display=swap');
    @page { size: A4; margin: 0; }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Heebo', sans-serif;
      direction: rtl;
      background: #fff;
      color: #1a1a2e;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Header ── */
    .header {
      background: linear-gradient(135deg, #0091FF 0%, #005FCC 100%);
      padding: 36px 48px 32px;
      color: #fff;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .company-block .company-name {
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -0.5px;
    }
    .company-block .company-tagline {
      font-size: 13px;
      opacity: 0.75;
      margin-top: 4px;
    }
    .receipt-meta {
      text-align: left;
      background: rgba(255,255,255,0.15);
      border-radius: 12px;
      padding: 14px 20px;
    }
    .receipt-meta .receipt-label {
      font-size: 11px;
      opacity: 0.8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .receipt-meta .receipt-number {
      font-size: 17px;
      font-weight: 700;
      margin-top: 2px;
      direction: ltr;
      text-align: left;
    }
    .receipt-meta .receipt-date {
      font-size: 13px;
      opacity: 0.85;
      margin-top: 6px;
      direction: rtl;
    }

    /* ── Body ── */
    .body { padding: 40px 48px; }

    /* ── Client section ── */
    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #6b7280;
      margin-bottom: 8px;
    }
    .client-card {
      background: #f8faff;
      border: 1px solid #e0ecff;
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 32px;
    }
    .client-card .client-phone {
      font-size: 18px;
      font-weight: 700;
      color: #0091FF;
      direction: ltr;
      text-align: right;
    }
    .client-card .client-name {
      font-size: 14px;
      color: #374151;
      margin-top: 4px;
    }

    /* ── Items table ── */
    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 28px;
    }
    .items-table thead th {
      background: #f1f5ff;
      padding: 12px 16px;
      font-size: 12px;
      font-weight: 700;
      color: #374151;
      text-align: right;
      border-bottom: 2px solid #d1e0ff;
    }
    .items-table thead th:last-child { text-align: left; }
    .items-table tbody td {
      padding: 14px 16px;
      font-size: 14px;
      color: #1a1a2e;
      border-bottom: 1px solid #f0f0f5;
      text-align: right;
      vertical-align: middle;
    }
    .items-table tbody td:last-child { text-align: left; font-weight: 600; }
    .items-table .type-badge {
      display: inline-block;
      background: #e8f4ff;
      color: #0066cc;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 20px;
      margin-top: 4px;
    }
    .coins-row td { color: #6b7280; font-size: 13px; }

    /* ── Total box ── */
    .total-box {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 36px;
    }
    .total-card {
      background: linear-gradient(135deg, #0091FF 0%, #005FCC 100%);
      color: #fff;
      border-radius: 14px;
      padding: 20px 28px;
      min-width: 220px;
      text-align: left;
    }
    .total-card .total-label {
      font-size: 12px;
      opacity: 0.8;
      margin-bottom: 6px;
    }
    .total-card .total-amount {
      font-size: 28px;
      font-weight: 800;
      direction: ltr;
    }
    .total-card .total-note {
      font-size: 11px;
      opacity: 0.7;
      margin-top: 4px;
    }

    /* ── Thank you banner ── */
    .thankyou {
      text-align: center;
      padding: 18px;
      background: #f8faff;
      border-radius: 12px;
      margin-bottom: 32px;
    }
    .thankyou .thankyou-text {
      font-size: 15px;
      font-weight: 600;
      color: #0091FF;
    }
    .thankyou .thankyou-sub {
      font-size: 12px;
      color: #6b7280;
      margin-top: 4px;
    }

    /* ── Footer ── */
    .footer {
      border-top: 1px solid #e5e7eb;
      padding-top: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .footer .footer-brand {
      font-size: 14px;
      font-weight: 700;
      color: #0091FF;
    }
    .footer .footer-info {
      font-size: 11px;
      color: #9ca3af;
      text-align: left;
    }

    /* Divider */
    .divider {
      height: 3px;
      background: linear-gradient(to right, #0091FF, #005FCC, transparent);
      margin-bottom: 32px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="company-block">
      <div class="company-name">Iconiq Media</div>
      <div class="company-tagline">פלטפורמת שיווק דיגיטלי מתקדמת</div>
    </div>
    <div class="receipt-meta">
      <div class="receipt-label">קבלה</div>
      <div class="receipt-number">${escapeHtml(receipt.receiptNumber)}</div>
      <div class="receipt-date">תאריך: ${escapeHtml(dateFormatted)}</div>
    </div>
  </div>

  <div class="body">
    <div class="divider"></div>

    <div class="section-title">פרטי לקוח</div>
    <div class="client-card">
      <div class="client-phone">${escapeHtml(receipt.phone)}</div>
      ${receipt.clientName ? `<div class="client-name">${escapeHtml(receipt.clientName)}</div>` : ""}
    </div>

    <div class="section-title">פרטי הרכישה</div>
    <table class="items-table">
      <thead>
        <tr>
          <th>תיאור</th>
          <th>סכום</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            ${escapeHtml(receipt.description)}
            <br><span class="type-badge">${typeLabel}</span>
          </td>
          <td>₪${amountFormatted}</td>
        </tr>
        ${coinsRow}
      </tbody>
    </table>

    <div class="total-box">
      <div class="total-card">
        <div class="total-label">סה"כ שולם</div>
        <div class="total-amount">₪${amountFormatted}</div>
        <div class="total-note">כולל מע"מ</div>
      </div>
    </div>

    <div class="thankyou">
      <div class="thankyou-text">תודה שבחרת ב-Iconiq Media!</div>
      <div class="thankyou-sub">הרכישה שלך תורמת לצמיחת העסק שלך</div>
    </div>

    <div class="footer">
      <div class="footer-brand">Iconiq Media</div>
      <div class="footer-info">
        iconiqmedia.co.il<br>
        support@iconiqmedia.co.il
      </div>
    </div>
  </div>
</body>
</html>`;
}

/* GET /api/receipts?phone=xxx */
exports.getReceipts = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: "חסר phone" });

    const receipts = await getDB()
      .collection("client_receipts")
      .find({ phone: String(phone) })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json({ success: true, receipts });
  } catch (err) {
    console.error("[Receipts] getReceipts:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* GET /api/receipts/:id/pdf */
exports.downloadReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    let receipt;
    try {
      receipt = await getDB()
        .collection("client_receipts")
        .findOne({ _id: new ObjectId(id) });
    } catch {
      return res.status(400).json({ error: "מזהה קבלה לא תקין" });
    }
    if (!receipt) return res.status(404).json({ error: "קבלה לא נמצאה" });

    // Fetch client name if available
    const user = await getDB()
      .collection("users")
      .findOne({ phone: receipt.phone }, { projection: { name: 1 } });
    receipt.clientName = user?.name || null;

    const html = buildReceiptHtml(receipt);
    const pdfBuffer = await htmlToPdfBuffer(html);

    const ttlSeconds = Number(process.env.INVOICE_TTL_SECONDS || 3600);
    const dir = process.env.INVOICE_PDF_DIR || path.join(__dirname, "..", "invoices");
    await ensureDir(dir);

    const id16 = require("crypto").randomBytes(8).toString("hex");
    const fileName = `receipt-${id16}.pdf`;
    const filePath = require("path").join(dir, fileName);
    require("fs/promises").writeFile(filePath, pdfBuffer);
    scheduleDelete(filePath, ttlSeconds);

    const baseUrl = getBaseUrlFromRequest(req);
    const url = `${baseUrl}/api/invoice/files/${encodeURIComponent(fileName)}`;

    res.json({ success: true, url, expires_in_seconds: ttlSeconds });
  } catch (err) {
    console.error("[Receipts] downloadReceipt:", err.message);
    res.status(500).json({ error: err.message });
  }
};
