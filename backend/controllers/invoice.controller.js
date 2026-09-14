const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer"); // שימוש ב-Puppeteer בלבד

// --- Utility Functions ---

function escapeHtml(value) {
  const s = String(value ?? "");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validatePayload(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "חסר גוף בקשה תקין" };
  }

  const { businessName, month, year, transactions } = body;

  if (!isNonEmptyString(businessName))
    return { ok: false, message: "חסר businessName תקין" };

  const monthStr = String(month ?? "").trim();
  const yearStr = String(year ?? "").trim();

  if (!monthStr) return { ok: false, message: "חסר month" };
  if (!yearStr) return { ok: false, message: "חסר year" };

  let tx = [];
  if (transactions == null) tx = [];
  else if (Array.isArray(transactions)) tx = transactions;
  else return { ok: false, message: "transactions חייב להיות מערך" };

  const normalized = [];
  for (let i = 0; i < tx.length; i++) {
    const t = tx[i];
    if (!t || typeof t !== "object")
      return { ok: false, message: `transaction[${i}] לא תקין` };

    const date = String(t.date ?? "").trim();
    const transaction_id = String(t.transaction_id ?? "").trim();
    const payment_method = String(t.payment_method ?? "").trim();
    const status = String(t.status ?? "").trim();

    if (!date) return { ok: false, message: `transaction[${i}].date חסר` };
    if (!transaction_id)
      return { ok: false, message: `transaction[${i}].transaction_id חסר` };

    const amount = toNumber(t.amount);
    if (amount == null)
      return { ok: false, message: `transaction[${i}].amount לא מספר` };

    normalized.push({ date, transaction_id, payment_method, status, amount });
  }

  return {
    ok: true,
    value: {
      businessName: businessName.trim(),
      month: monthStr,
      year: yearStr,
      transactions: normalized,
    },
  };
}

function buildInvoiceHtml({ businessName, month, year, transactions }) {
  let total = 0;
  let rowsHtml = "";

  if (transactions.length > 0) {
    for (const t of transactions) {
      const amount = Number(t.amount) || 0;
      total += amount;

      const statusLabel = t.status === "completed" ? "הושלם" : t.status || "";

      rowsHtml += `
        <tr>
          <td>${escapeHtml(t.date)}</td>
          <td>${escapeHtml(t.transaction_id)}</td>
          <td>${escapeHtml(t.payment_method || "")}</td>
          <td>${escapeHtml(statusLabel)}</td>
          <td>${amount.toLocaleString("he-IL", { minimumFractionDigits: 2 })} ₪</td>
        </tr>
      `;
    }
  } else {
    rowsHtml = `<tr><td colspan="5" style="text-align:center;">אין עסקאות להצגה</td></tr>`;
  }

  const totalFormatted = total.toLocaleString("he-IL", {
    minimumFractionDigits: 2,
  });

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>חשבונית מס</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&display=swap');
    @page { size: A4; margin: 0; }

    body { margin: 0; padding: 20mm; font-family: 'Heebo', sans-serif; font-size: 11px; color: #333; direction: rtl;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }

    .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:25mm; }
    .invoice-meta { text-align:left; }
    .invoice-meta p { margin:0; font-size:12px; line-height:1.6; }

    .bill-to { margin-bottom:15mm; font-size:14px; }

    .transactions-table { width:100%; border-collapse:collapse; margin-bottom:15mm; }
    .transactions-table th, .transactions-table td { padding:8px 10px; border-bottom:1px solid #eee; text-align:right; white-space:nowrap; }
    .transactions-table th { background:#f9f9f9; font-weight:700; color:#555; border-bottom:2px solid #ddd; }
    .transactions-table th:last-child, .transactions-table td:last-child { text-align:left; }

    .totals { width:40%; max-width:300px; margin-right:auto; margin-left:0; }
    .totals-table td { padding:8px 10px; }
    .totals-table .label { font-weight:700; text-align:right; }
    .totals-table .value { text-align:left; }
    .total-row td { font-weight:700; font-size:14px; border-top:2px solid #333; padding-top:10px; }
  </style>
</head>
<body dir="rtl">
  <div class="header">
    <div></div>
    <div class="invoice-meta">
      <p><strong>תאריך הפקה:</strong> ${new Date().toLocaleDateString("he-IL")}</p>
      <p><strong>תקופת חיוב:</strong> ${escapeHtml(month)}/${escapeHtml(year)}</p>
    </div>
  </div>

  <div class="bill-to">
    <p><strong>חיוב עבור:</strong> ${escapeHtml(businessName)}</p>
  </div>

  <table class="transactions-table">
    <thead>
      <tr>
        <th>תאריך</th>
        <th>מזהה עסקה</th>
        <th>אמצעי תשלום</th>
        <th>סטטוס</th>
        <th>סכום</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>

  <div class="totals">
    <table class="totals-table">
      <tbody>
        <tr><td class="label">סכום ביניים:</td><td class="value">${totalFormatted} ₪</td></tr>
        <tr><td class="label">מע"מ (0%):</td><td class="value">0.00 ₪</td></tr>
        <tr class="total-row"><td class="label">סה"כ לתשלום:</td><td class="value">${totalFormatted} ₪</td></tr>
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

// --- PDF Generation Logic (Optimized for Heroku & Local) ---
async function htmlToPdfBufferOLD(html) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // קריטי ל-Heroku/Docker
        "--disable-gpu",
        "--single-process",
      ],
      // שימוש בנתיב המותקן ב-Heroku אם קיים, אחרת ברירת מחדל מקומית
      // הקוד המעודכן:
      executablePath:
        process.env.GOOGLE_CHROME_BIN ||
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        puppeteer.executablePath(),
    });

    const page = await browser.newPage();

    // טעינת התוכן עם המתנה לטעינת הרשת (פונטים וכו')
    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 60000, // 60 שניות טיימאוט למקרה של איטיות
    });

    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });
  } catch (error) {
    console.error("Puppeteer Launch Error:", error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

async function htmlToPdfBuffer(html) {
  let browser = null;

  // עדכון רשימת הנתיבים כדי שתכלול את המשתנה של ה-Buildpack החדש
  const possiblePaths = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    (() => { try { return puppeteer.executablePath(); } catch { return null; } })(), // Puppeteer bundled Chromium
    "/app/.chrome-for-testing/chrome-linux64/chrome", // Heroku Buildpack
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser", // Ubuntu apt
    "/usr/bin/chromium",         // Ubuntu/Debian minimal
    "/snap/bin/chromium",        // Snap package
  ];

  // סינון נתיבים לא רלוונטיים ומציאת הראשון שקיים פיזית
  const executablePath = possiblePaths.find((p) => p && fs.existsSync(p));

  if (!executablePath) {
    console.error(
      "CRITICAL: Could not find Chrome executable in any known path!",
    );
    console.error("Searched in:", possiblePaths);
    throw new Error("Chrome Executable not found on server");
  }

  console.log("Launching Puppeteer with executable:", executablePath);

  try {
    browser = await puppeteer.launch({
      executablePath: executablePath,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
      ],
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });
  } catch (error) {
    console.error("Puppeteer Launch Error:", error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

function getBaseUrlFromRequest(req) {
  // בדיקת פרוטוקול (ב-Heroku ה-SSL מסתיים ב-Load Balancer ולכן צריך x-forwarded)
  const proto = req.headers["x-forwarded-proto"]
    ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim()
    : req.protocol;

  const host = req.headers["x-forwarded-host"]
    ? String(req.headers["x-forwarded-host"]).split(",")[0].trim()
    : req.get("host");

  return `${proto}://${host}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.access(dir, fs.constants.W_OK);
}

function scheduleDelete(filePath, ttlSeconds) {
  const ms = Math.max(5, Number(ttlSeconds || 60)) * 1000;
  setTimeout(() => {
    // בדיקה אם הקובץ קיים לפני מחיקה למניעת שגיאות ב-Log
    fs.access(filePath, fs.constants.F_OK, (err) => {
      if (!err) {
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) console.error("Error deleting file:", unlinkErr);
        });
      }
    });
  }, ms);
}

async function writePdfFile(buffer, dir, ttlSeconds) {
  const id = crypto.randomBytes(16).toString("hex");
  const fileName = `invoice-${id}.pdf`;
  const filePath = path.join(dir, fileName);

  await fsp.writeFile(filePath, buffer);
  scheduleDelete(filePath, ttlSeconds);

  return { fileName, filePath };
}

// Shared PDF utilities — used by receipts.controller.js as well
exports.htmlToPdfBuffer = htmlToPdfBuffer;
exports.writePdfFile = writePdfFile;
exports.ensureDir = ensureDir;
exports.scheduleDelete = scheduleDelete;
exports.getBaseUrlFromRequest = getBaseUrlFromRequest;

// --- Controllers ---
exports.createInvoice = async (req, res) => {
  const check = validatePayload(req.body);
  if (!check.ok)
    return res.status(400).json({ ok: false, error: check.message });

  const ttlSeconds = Number(process.env.INVOICE_TTL_SECONDS || 120);

  try {
    const html = buildInvoiceHtml(check.value);
    const pdfBuffer = await htmlToPdfBuffer(html);

    // Check if caller wants a file URL (createfileurl=true in query or body)
    const wantFileUrl =
      String(
        req.query?.createfileurl || req.body?.createfileurl || "",
      ).toLowerCase() === "true" || req.body?.createfileurl === true;

    if (wantFileUrl) {
      // Save file and return URL
      const dir =
        process.env.INVOICE_PDF_DIR || path.join(__dirname, "..", "invoices");
      await ensureDir(dir);

      const { fileName, filePath } = await writePdfFile(
        pdfBuffer,
        dir,
        ttlSeconds,
      );

      const baseUrl = getBaseUrlFromRequest(req);
      const url = `${baseUrl}/api/invoice/files/${encodeURIComponent(fileName)}`;
      console.log("Invoice generated successfully:", {
        url,
        ttlSeconds,
        file: path.basename(filePath),
      });

      return res.status(200).json({
        url,
        expires_in_seconds: ttlSeconds,
        file: path.basename(filePath),
      });
    }

    // Default: Return PDF buffer directly as attachment (no file saved)
    const fileName = `invoice-${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Expires-In", String(ttlSeconds));
    console.log("Invoice generated successfully (buffer sent)");

    return res.status(200).send(pdfBuffer);
  } catch (e) {
    console.error("Error in createInvoice:", e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "שגיאה ביצירת חשבונית" });
  }
};

exports.downloadInvoiceFile = async (req, res) => {
  try {
    const dir =
      process.env.INVOICE_PDF_DIR || path.join(__dirname, "..", "invoices");
    const fileName = String(req.params.fileName || "");

    // אבטחה בסיסית: מניעת Directory Traversal
    const safeName = path.basename(fileName);
    if (!safeName || safeName.includes("..")) {
      throw new Error("Invalid filename");
    }

    const filePath = path.join(dir, safeName);

    await fsp.access(filePath, fs.constants.R_OK);

    res.setHeader("Content-Type", "application/pdf");
    // להורדה ישירה:
    // res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

    // לצפייה בדפדפן (Inline):
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);

    return res.sendFile(filePath);
  } catch (e) {
    return res
      .status(404)
      .json({ ok: false, error: "הקובץ לא נמצא, פג תוקף, או שגיאת נתיב" });
  }
};

// --- Demo endpoint: יוצר חשבונית עם נתוני דמה ---
exports.createInvoiceDemo = async (req, res) => {
  req.body = {
    businessName: "דוגמה בע״מ",
    month: "01",
    year: "2026",
    transactions: [
      {
        date: "2026-01-01",
        transaction_id: "T-1001",
        payment_method: "אשראי",
        status: "completed",
        amount: 199.9,
      },
      {
        date: "2026-01-03",
        transaction_id: "T-1002",
        payment_method: "Bit",
        status: "completed",
        amount: "50.50",
      },
      {
        date: "2026-01-07",
        transaction_id: "T-1003",
        payment_method: "PayPal",
        status: "pending",
        amount: 120,
      },
    ],
    createfileurl: true, // ברירת מחדל לדמו - החזרת קישור
  };
  return exports.createInvoice(req, res);
};
