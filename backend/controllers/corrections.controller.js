const {
  getOrCreateClientFolder,
  getOrCreateSubfolder,
  uploadFile,
  makeFilePublic,
  getDriveClient,
} = require("../services/google-drive.service");
const { getDB } = require("../config/db");
const { updateProjectStatus } = require("../services/fireberry-projects.service");

const pendingCollection = () => getDB().collection("pending_corrections");
const roundsCollection = () => getDB().collection("correction_rounds");

const CORRECTION_TYPE_LABELS = {
  text: "שינוי טקסט",
  image: "תמונה",
  icons: "אייקונים",
  colors: "צבעים",
  design: "עיצוב",
  other: "אחר",
};

/**
 * Create a Google Doc from HTML content (supports embedded images).
 * Uses Drive API upload with convert — mimeType text/html → google doc.
 */
async function createHtmlDocument(folderId, title, htmlContent) {
  console.log(`[Drive] Creating HTML document "${title}" in folder ${folderId}`);
  const drive = await getDriveClient();
  const { Readable } = require("stream");
  const stream = new Readable();
  stream.push(htmlContent);
  stream.push(null);

  const res = await drive.files.create({
    resource: {
      name: title,
      mimeType: "application/vnd.google-apps.document",
      parents: [folderId],
    },
    media: {
      mimeType: "text/html",
      body: stream,
    },
    fields: "id, name",
  });
  console.log(`[Drive] ✅ Created HTML doc: "${res.data.name}" (ID: ${res.data.id})`);
  return res.data;
}

/**
 * POST /api/app/corrections/:phone/submit
 * Receive corrections array + screenshots, create Google Doc with embedded images.
 */
exports.submitCorrections = async (req, res) => {
  const { phone } = req.params;
  const { corrections, screenshots, projectId, nextStatusCode } = req.body;

  if (!phone) return res.status(400).json({ success: false, message: "phone is required" });
  if (!corrections?.length) return res.status(400).json({ success: false, message: "no corrections provided" });

  try {
    // 1. Get/create client folder
    const clientFolderId = await getOrCreateClientFolder(phone);
    if (!clientFolderId) {
      return res.status(500).json({ success: false, message: "Could not find/create client Drive folder" });
    }

    // 2. Create subfolder structure
    const correctionsFolderId = await getOrCreateSubfolder(clientFolderId, "תיקוני אתר");
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, "0")}.${String(now.getMonth() + 1).padStart(2, "0")}.${now.getFullYear()}`;
    const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const roundFolderId = await getOrCreateSubfolder(correctionsFolderId, `תיקונים ${dateStr} ${timeStr}`);

    // 3. Upload screenshots and get public URLs for embedding
    const screenshotImageUrls = [];
    if (screenshots?.length) {
      for (let i = 0; i < screenshots.length; i++) {
        try {
          if (!screenshots[i]) { screenshotImageUrls.push(null); continue; }
          const base64Data = screenshots[i].replace(/^data:image\/\w+;base64,/, "");
          const buffer = Buffer.from(base64Data, "base64");
          const filename = `correction_${i + 1}.png`;
          const file = await uploadFile(roundFolderId, filename, buffer, "image/png");
          await makeFilePublic(file.id);
          // Use the direct image URL for embedding in HTML
          screenshotImageUrls.push(`https://drive.google.com/uc?export=view&id=${file.id}`);
        } catch (err) {
          console.error(`[Corrections] Failed to upload screenshot ${i + 1}:`, err.message);
          screenshotImageUrls.push(null);
        }
      }
    }

    // 4. Build HTML document with embedded images
    let html = `
      <html dir="rtl"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;direction:rtl;">
      <h1 style="color:#333;">סבב תיקוני אתר — ${dateStr}</h1>
      <p style="color:#888;">נוצר ב-${timeStr} | ${corrections.length} תיקונים</p>
      <hr style="border:1px solid #ddd;">
    `;

    for (let i = 0; i < corrections.length; i++) {
      const c = corrections[i];
      const typeLabel = CORRECTION_TYPE_LABELS[c.type] || c.type;
      const imgUrl = screenshotImageUrls[i];

      html += `
        <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;">
          <h2 style="color:#EF4444;margin:0 0 8px;">תיקון #${i + 1}</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:4px 8px;font-weight:bold;width:80px;vertical-align:top;">עמוד:</td><td style="padding:4px 8px;"><a href="${c.pageUrl || "#"}">${c.pageUrl || ""}</a></td></tr>
            <tr><td style="padding:4px 8px;font-weight:bold;vertical-align:top;">סוג:</td><td style="padding:4px 8px;">${typeLabel}</td></tr>
            <tr><td style="padding:4px 8px;font-weight:bold;vertical-align:top;">תיאור:</td><td style="padding:4px 8px;">${c.description || ""}</td></tr>
            ${c.elementText ? `<tr><td style="padding:4px 8px;font-weight:bold;vertical-align:top;">אלמנט:</td><td style="padding:4px 8px;font-size:12px;color:#666;">${c.elementText}</td></tr>` : ""}
          </table>
          ${imgUrl ? `<div style="margin-top:12px;"><img src="${imgUrl}" style="max-width:600px;border:1px solid #ddd;border-radius:4px;" /></div>` : ""}
        </div>
      `;
    }

    html += `</body></html>`;

    const docTitle = `תיקוני אתר — ${dateStr} ${timeStr}`;

    // 5. Create Google Doc from HTML
    const doc = await createHtmlDocument(roundFolderId, docTitle, html);

    // 6. Store record in MongoDB
    await roundsCollection().insertOne({
      phone,
      docId: doc.id,
      folderId: roundFolderId,
      correctionsCount: corrections.length,
      corrections,
      createdAt: new Date(),
    });

    // 7. Update Fireberry project status if provided
    if (projectId && nextStatusCode != null) {
      try {
        await updateProjectStatus(projectId, nextStatusCode);
        console.log(`✅ [Corrections] Updated Fireberry project ${projectId} → status ${nextStatusCode}`);
      } catch (err) {
        console.error(`⚠️ [Corrections] Failed to update Fireberry status:`, err.message);
        // Don't fail the whole request — doc was created successfully
      }
    }

    // 8. Clear pending corrections
    await pendingCollection().deleteOne({ phone });

    console.log(`✅ [Corrections] Created doc "${docTitle}" for ${phone} with ${corrections.length} corrections`);

    res.json({
      success: true,
      docId: doc.id,
      docUrl: `https://docs.google.com/document/d/${doc.id}/edit`,
      folderId: roundFolderId,
    });
  } catch (err) {
    console.error("❌ [Corrections] submitCorrections error:", err.message);
    res.status(500).json({ success: false, message: "Server error", details: err.message });
  }
};

/**
 * POST /api/app/corrections/:phone/pending
 * Save pending corrections (auto-save draft).
 */
exports.savePending = async (req, res) => {
  const { phone } = req.params;
  const { corrections } = req.body;

  if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

  try {
    await pendingCollection().updateOne(
      { phone },
      { $set: { phone, corrections: corrections || [], updatedAt: new Date() } },
      { upsert: true },
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ [Corrections] savePending error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET /api/app/corrections/:phone/pending
 * Load pending corrections.
 */
exports.loadPending = async (req, res) => {
  const { phone } = req.params;
  if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

  try {
    const doc = await pendingCollection().findOne({ phone });
    res.json({ success: true, data: doc?.corrections || [] });
  } catch (err) {
    console.error("❌ [Corrections] loadPending error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
