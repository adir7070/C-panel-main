const DB = require("../utils/DB");
const driveService = require("../services/google-drive.service");

const COLLECTION = "design_statuses";

// Subfolder path: [phone] → לקמפיינר
// "מודעות מאושרות" and "מודעות לעריכה" are created inside לקמפיינר (siblings of נוי מאשרת)
const getDesignParentFolder = async (phone) => {
  const clientFolders = await driveService.searchFolders(phone);
  if (clientFolders.length === 0) throw new Error(`No folder found for ${phone}`);
  const clientFolderId = clientFolders[0].id;
  const campaignFolderId = await driveService.findSubfolder(clientFolderId, "לקמפיינר");
  if (!campaignFolderId) throw new Error(`Subfolder "לקמפיינר" not found for ${phone}`);
  return campaignFolderId;
};

/**
 * GET /api/app/design/:phone/images?page=1&limit=10
 */
const getDesignImages = async (req, res) => {
  try {
    const { phone } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    // Fetch images from: [phone] → לקמפיינר → נוי מאשרת
    const allImages = await driveService.getClientImagesFromPath(phone, ["לקמפיינר", "נוי מאשרת"]);

    // Fetch statuses from DB
    const statusDocs = await DB.collection(COLLECTION).find({ phone }).toArray();
    const statusMap = {};
    for (const doc of statusDocs) {
      statusMap[doc.fileId] = {
        status: doc.status,
        notes: doc.notes || null,
        notesHistory: doc.notesHistory || [],
        imageFolderId: doc.imageFolderId || null,
        copiedFileId: doc.copiedFileId || null,
        notesDocId: doc.notesDocId || null,
      };
    }

    // Merge and paginate
    const start = (page - 1) * limit;
    const paged = allImages.slice(start, start + limit);

    // Build images with revision detection
    const images = [];
    for (const file of paged) {
      const entry = statusMap[file.id];
      const img = {
        fileId: file.id,
        name: file.name,
        thumbnailUrl: `https://lh3.googleusercontent.com/d/${file.id}=w400`,
        fullUrl: `https://lh3.googleusercontent.com/d/${file.id}=w800`,
        webViewLink: file.webViewLink,
        createdTime: file.createdTime,
        status: entry?.status || "pending",
        notes: entry?.notes || null,
        notesHistory: entry?.notesHistory || [],
        revisedImageUrl: null,
        revisedFileId: null,
        approvedImageUrl: entry?.status === "approved" && entry.copiedFileId
          ? `https://lh3.googleusercontent.com/d/${entry.copiedFileId}=w400`
          : null,
      };

      // Check for revised image in the edit subfolder
      if (entry?.status === "edit_requested" && entry.imageFolderId) {
        try {
          const filesInFolder = await driveService.listFilesInFolder(entry.imageFolderId);
          // Find a file that is NOT the original copy and NOT the notes doc
          const revisedFile = filesInFolder.find(
            (f) => f.id !== entry.copiedFileId && f.id !== entry.notesDocId
          );
          if (revisedFile) {
            img.status = "revision_ready";
            img.revisedFileId = revisedFile.id;
            img.revisedImageUrl = `https://lh3.googleusercontent.com/d/${revisedFile.id}=w800`;
          }
        } catch (e) {
          console.warn(`[Design] Could not check revisions for ${file.id}:`, e.message);
        }
      }

      images.push(img);
    }

    return res.json({
      images,
      total: allImages.length,
      page,
      hasMore: start + limit < allImages.length,
    });
  } catch (error) {
    console.error("[Design] getDesignImages error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * GET /api/app/design/:phone/statuses
 */
const getDesignStatuses = async (req, res) => {
  try {
    const { phone } = req.params;
    const docs = await DB.collection(COLLECTION).find({ phone }).toArray();
    const statuses = {};
    for (const doc of docs) {
      statuses[doc.fileId] = { status: doc.status, notes: doc.notes || null, imageFolderId: doc.imageFolderId || null, approvedFolderId: doc.approvedFolderId || null };
    }
    return res.json({ statuses });
  } catch (error) {
    console.error("[Design] getDesignStatuses error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/app/design/:phone/approve
 * body: { fileId }
 */
const approveImage = async (req, res) => {
  try {
    const { phone } = req.params;
    const { fileId, revisedFileId } = req.body;

    if (!fileId) {
      return res.status(400).json({ success: false, error: "fileId required" });
    }

    // Get לקמפיינר folder, then get/create "מודעות מאושרות" subfolder inside it
    const parentFolderId = await getDesignParentFolder(phone);
    const approvedFolderId = await driveService.getOrCreateSubfolder(parentFolderId, "מודעות מאושרות");

    // Copy the revised image if available, otherwise copy the original
    const fileToCopy = revisedFileId || fileId;
    console.log(`[Design] Approving: fileId=${fileId}, revisedFileId=${revisedFileId}, fileToCopy=${fileToCopy}`);
    const copied = await driveService.copyFile(fileToCopy, approvedFolderId);
    console.log(`[Design] Approved ${revisedFileId ? "revised" : "original"} image → ${copied.id}`);

    // Upsert status in DB — keep imageFolderId for future edit cycles
    await DB.collection(COLLECTION).updateOne(
      { phone, fileId },
      {
        $set: {
          phone,
          fileId,
          status: "approved",
          approvedCopyId: copied.id,
          approvedFolderId,
          copiedFileId: copied.id,
          notes: null,
          notesHistory: [],
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    return res.json({ success: true, copiedFileId: copied.id });
  } catch (error) {
    console.error("[Design] approveImage error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/app/design/:phone/request-edit
 * body: { fileId, notes }
 *
 * Drive structure: לקמפיינר / מודעות לעריכה / {imageName} / (image copy + הערות עריכה doc)
 * First request  → create subfolder + copy image + create doc
 * Subsequent     → reuse subfolder + append to existing doc
 */
const requestImageEdit = async (req, res) => {
  try {
    const { phone } = req.params;
    const { fileId, notes } = req.body;

    if (!fileId || !notes) {
      return res.status(400).json({ success: false, error: "fileId and notes required" });
    }

    const parentFolderId = await getDesignParentFolder(phone);
    const editFolderId = await driveService.getOrCreateSubfolder(parentFolderId, "מודעות לעריכה");

    // Get original image name for naming strategy
    const imageName = await driveService.getFileName(fileId);
    const docName = "הערות עריכה";

    // Get or create a subfolder for this specific image
    const imageFolderId = await driveService.getOrCreateSubfolder(editFolderId, imageName);

    // Check if this is a re-edit after approval
    const existing = await DB.collection(COLLECTION).findOne({ phone, fileId });
    const isReEditAfterApproval = existing?.status === "approved";
    console.log(`[Design] Re-edit check: status=${existing?.status}, isReEdit=${isReEditAfterApproval}`);

    // Search for existing files inside the image subfolder
    const existingCopy = await driveService.findFileInFolder(imageFolderId, imageName);
    const existingDoc = await driveService.findFileInFolder(imageFolderId, docName);

    // Clean up edit folder: delete everything except the notes doc
    try {
      const allFiles = await driveService.listFilesInFolder(imageFolderId);
      for (const f of allFiles) {
        if (f.id !== existingDoc?.id) {
          if (isReEditAfterApproval || f.id !== existingCopy?.id) {
            await driveService.deleteFile(f.id);
            console.log(`[Design] Deleted file from edit folder: ${f.name} (${f.id})`);
          }
        }
      }
    } catch (e) {
      console.warn("[Design] Could not clean edit folder:", e.message);
    }

    let copiedFileId;
    let notesDocId;

    if (isReEditAfterApproval) {
      // Find the approved file in "מודעות מאושרות" by searching the folder
      const approvedFolderId = await driveService.getOrCreateSubfolder(parentFolderId, "מודעות מאושרות");
      const approvedFiles = await driveService.listFilesInFolder(approvedFolderId);
      // Find the most recent file matching this image name
      const approvedFile = approvedFiles.find(f => f.name === imageName) || approvedFiles.find(f => f.name.includes(imageName));

      if (approvedFile) {
        // Move approved version into edit folder
        console.log(`[Design] Found approved file in folder: ${approvedFile.name} (${approvedFile.id})`);
        const copied = await driveService.copyFile(approvedFile.id, imageFolderId, imageName);
        copiedFileId = copied.id;

        // Delete from approved folder
        try {
          await driveService.deleteFile(approvedFile.id);
          console.log(`[Design] Removed from מודעות מאושרות: ${approvedFile.id}`);
        } catch (e) {
          console.warn("[Design] Could not delete approved copy:", e.message);
        }
      } else {
        // Fallback: use DB reference or copy original
        const fallbackId = existing?.approvedCopyId || existing?.copiedFileId || fileId;
        console.log(`[Design] No approved file found in folder, using fallback: ${fallbackId}`);
        const copied = await driveService.copyFile(fallbackId, imageFolderId, imageName);
        copiedFileId = copied.id;
      }

      if (existingDoc) {
        notesDocId = existingDoc.id;
        await driveService.appendToDocument(notesDocId, notes);
        console.log(`[Design] Appended to existing doc in "${imageName}" folder`);
      } else {
        const notesDoc = await driveService.createTextDocument(imageFolderId, docName, notes);
        notesDocId = notesDoc.id;
        console.log(`[Design] Created new notes doc in "${imageName}" folder`);
      }
    } else if (existingCopy && existingDoc) {
      // Both exist — reuse and append
      copiedFileId = existingCopy.id;
      notesDocId = existingDoc.id;
      await driveService.appendToDocument(notesDocId, notes);
      console.log(`[Design] Appended to existing doc in "${imageName}" folder`);
    } else {
      // Create fresh image copy + notes doc in the image subfolder
      const copied = await driveService.copyFile(fileId, imageFolderId, imageName);
      copiedFileId = copied.id;

      const notesDoc = await driveService.createTextDocument(imageFolderId, docName, notes);
      notesDocId = notesDoc.id;
      console.log(`[Design] Created new folder "${imageName}" with copy + doc`);
    }

    // Upsert status in DB + push to notes history
    await DB.collection(COLLECTION).updateOne(
      { phone, fileId },
      {
        $set: {
          phone,
          fileId,
          status: "edit_requested",
          copiedFileId,
          notesDocId,
          imageFolderId,
          approvedCopyId: null,
          notes,
          updatedAt: new Date(),
        },
        $push: {
          notesHistory: {
            notes,
            createdAt: new Date(),
          },
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    return res.json({ success: true, copiedFileId, notesDocId });
  } catch (error) {
    console.error("[Design] requestImageEdit error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/app/design/:phone/remove-note
 * body: { fileId, noteIndex }
 *
 * Removes a specific note from notesHistory by index.
 * If no notes left, resets status to "pending" and clears Drive references.
 */
const removeNote = async (req, res) => {
  try {
    const { phone } = req.params;
    const { fileId, noteIndex } = req.body;

    if (!fileId || noteIndex === undefined) {
      return res.status(400).json({ success: false, error: "fileId and noteIndex required" });
    }

    const existing = await DB.collection(COLLECTION).findOne({ phone, fileId });
    if (!existing) {
      return res.status(404).json({ success: false, error: "No record found" });
    }

    const history = existing.notesHistory || [];
    if (noteIndex < 0 || noteIndex >= history.length) {
      return res.status(400).json({ success: false, error: "Invalid noteIndex" });
    }

    // Remove the note at index
    history.splice(noteIndex, 1);

    if (history.length === 0) {
      // No notes left — delete entire image subfolder from Drive, reset to pending
      if (existing.imageFolderId) {
        try { await driveService.deleteFile(existing.imageFolderId); } catch (e) {
          console.warn("[Design] Could not delete image folder:", e.message);
        }
      }

      await DB.collection(COLLECTION).updateOne(
        { phone, fileId },
        {
          $set: {
            status: "pending",
            notes: null,
            notesHistory: [],
            copiedFileId: null,
            notesDocId: null,
            imageFolderId: null,
            updatedAt: new Date(),
          },
        }
      );
    } else {
      // Rewrite the Google Doc with remaining notes
      if (existing.notesDocId) {
        try {
          const docContent = history.map((n, i) => `#${i + 1}\n${n.notes}`).join("\n---\n");
          await driveService.rewriteDocument(existing.notesDocId, docContent);
        } catch (e) {
          console.warn("[Design] Could not rewrite notes doc:", e.message);
        }
      }

      const latestNote = history[history.length - 1].notes;
      await DB.collection(COLLECTION).updateOne(
        { phone, fileId },
        {
          $set: {
            notes: latestNote,
            notesHistory: history,
            updatedAt: new Date(),
          },
        }
      );
    }

    return res.json({ success: true, notesHistory: history });
  } catch (error) {
    console.error("[Design] removeNote error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { getDesignImages, getDesignStatuses, approveImage, requestImageEdit, removeNote };
