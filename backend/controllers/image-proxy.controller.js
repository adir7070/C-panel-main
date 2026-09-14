const multer = require("multer");
const backblazeService = require("../services/backblaze.service");
const { getDB } = require("../config/db");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}`));
  },
});

const batchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}`));
  },
});

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/webm", "video/3gpp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}`));
  },
});

/**
 * Upload image to Backblaze and return proxy URL
 */
const uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No image file provided" });
    }

    const rawName = (req.body.name || "").trim();
    if (!rawName) {
      return res
        .status(400)
        .json({ success: false, error: "Missing 'name' field" });
    }

    const phone = (req.body.phone || "").trim();
    const folder = (req.body.folder || "").trim();
    const ALLOWED_FOLDERS = ["coins", "agent"];
    const phoneRegex = /^[0-9]{9,15}$/;
    const subDir = phone && phoneRegex.test(phone)
      ? phone
      : (folder && ALLOWED_FOLDERS.includes(folder) ? folder : "agent");

    // Determine extension from mime type if not in name
    const mimeToExt = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    const hasExt = /\.(jpg|jpeg|png|webp|gif)$/i.test(rawName);
    const fileName = hasExt
      ? rawName
      : `${rawName}.${mimeToExt[req.file.mimetype] || "png"}`;

    // Prevent path traversal
    if (fileName.includes("..") || fileName.includes("\\")) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid file name" });
    }

    const b2Path = `uploads/${subDir}/${fileName}`;
    await backblazeService.uploadImage(
      b2Path,
      req.file.buffer,
      req.file.mimetype,
    );

    const serverBaseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const proxyUrl = `${serverBaseUrl}/api/img?url=${encodeURIComponent(b2Path)}`;

    console.log(`[Upload] Uploaded ${b2Path} → ${proxyUrl}`);

    res.json({
      success: true,
      url: proxyUrl,
      path: b2Path,
    });
  } catch (error) {
    console.error("[Upload] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Get customer gallery - returns list of proxy URLs
 */
const getCustomerGallery = async (req, res) => {
  try {
    const { phone } = req.params;
    const serverBaseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    console.log({ serverBaseUrl });

    console.log(`[Gallery] Fetching gallery for phone: ${phone}`);

    const phoneRegex = /^[0-9]{9,11}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        error: "Invalid phone number format",
      });
    }

    const allImages = await backblazeService.listClientImages(phone);
    // Exclude user-uploaded gallery images (ugc_ prefix) — they live in
    // the service/general categories, not in the "app created" gallery
    const images = allImages.filter(img => !img.fileName.includes("/ugc_"));
    const proxyUrls = images.map((img) =>
      `${serverBaseUrl}/api/img?url=${encodeURIComponent(img.fileName)}`
    );

    console.log(`[Gallery] Found ${proxyUrls.length} image(s) for ${phone}`);

    res.json({
      success: true,
      phone: phone,
      images: proxyUrls,
      count: proxyUrls.length,
    });
  } catch (error) {
    console.error("[Gallery] Error:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to fetch gallery",
    });
  }
};

/**
 * Upload video to Backblaze and return proxy URL
 */
const uploadVideo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No video file provided" });
    }

    const rawName = (req.body.name || "").trim();
    if (!rawName) {
      return res.status(400).json({ success: false, error: "Missing 'name' field" });
    }

    const phone = (req.body.phone || "").trim();

    const mimeToExt = {
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/x-msvideo": "avi",
      "video/x-matroska": "mkv",
      "video/webm": "webm",
      "video/3gpp": "3gp",
    };
    const hasExt = /\.(mp4|mov|avi|mkv|webm|3gp)$/i.test(rawName);
    const fileName = hasExt ? rawName : `${rawName}.${mimeToExt[req.file.mimetype] || "mp4"}`;

    if (fileName.includes("..") || fileName.includes("\\")) {
      return res.status(400).json({ success: false, error: "Invalid file name" });
    }

    const subDir = phone && /^[0-9]{9,15}$/.test(phone) ? phone : "videos";
    const b2Path = `uploads/${subDir}/${fileName}`;
    await backblazeService.uploadImage(b2Path, req.file.buffer, req.file.mimetype);

    const serverBaseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const proxyUrl = `${serverBaseUrl}/api/video?url=${encodeURIComponent(b2Path)}`;

    console.log(`[Upload Video] Uploaded ${b2Path} → ${proxyUrl}`);

    res.json({ success: true, url: proxyUrl, path: b2Path });
  } catch (error) {
    console.error("[Upload Video] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Proxy video from Backblaze
 */
const proxyVideo = async (req, res) => {
  try {
    const fullPath = req.query.url || "";
    if (!fullPath) return res.status(400).json({ error: "Missing 'url' query parameter" });
    const videoData = await backblazeService.downloadImageByPath(fullPath);

    res.set({
      "Content-Type": videoData.contentType || "video/mp4",
      "Content-Length": videoData.size,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `inline; filename="${videoData.fileName}"`,
    });

    res.send(videoData.buffer);
  } catch (error) {
    console.error("[Video Proxy] Error:", error.message);
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: "Video not found" });
    }
    res.status(404).json({ error: "Failed to load video" });
  }
};

/**
 * Proxy image from Backblaze
 */
const proxyImage = async (req, res) => {
  try {
    const fullPath = req.query.url || "";
    if (fullPath.length == 0)
      return res.status(400).json({ error: "Missing 'url' query parameter" });
    const imageData = await backblazeService.downloadImageByPath(fullPath);

    res.set({
      "Content-Type":        imageData.contentType,
      "Content-Length":      imageData.size,
      "Cache-Control":       "public, max-age=604800, immutable",
      "Content-Disposition": `inline; filename="${imageData.fileName}"`,
    });

    res.send(imageData.buffer);
  } catch (error) {
    console.error("[Proxy] Error:", error.message);

    if (error.message.includes("not found")) {
      return res.status(404).json({ error: "Image not found" });
    }
    res.status(404).json({ error: "Failed to load image" });
  }
};

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}`));
  },
});

/**
 * Upload PDF to Backblaze and return proxy URL
 */
const uploadPdf = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No PDF file provided" });
    }

    const originalName = req.file.originalname || `document_${Date.now()}.pdf`;
    const safeName = originalName.replace(/[^a-zA-Z0-9א-ת._\-() ]/g, "_");
    const fileName = safeName.endsWith(".pdf") ? safeName : `${safeName}.pdf`;

    if (fileName.includes("..") || fileName.includes("\\")) {
      return res.status(400).json({ success: false, error: "Invalid file name" });
    }

    const phone = (req.body.phone || "").trim();
    const subDir = phone && /^[0-9]{9,15}$/.test(phone) ? phone : "agent";
    const b2Path = `uploads/${subDir}/${Date.now()}_${fileName}`;

    await backblazeService.uploadImage(b2Path, req.file.buffer, "application/pdf");

    const serverBaseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const proxyUrl = `${serverBaseUrl}/api/file?url=${encodeURIComponent(b2Path)}`;

    console.log(`[Upload PDF] Uploaded ${b2Path} → ${proxyUrl}`);

    res.json({ success: true, url: proxyUrl, path: b2Path, fileName: originalName });
  } catch (error) {
    console.error("[Upload PDF] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Proxy file from Backblaze (inline for browser viewing / download)
 */
const proxyFile = async (req, res) => {
  try {
    const fullPath = req.query.url || "";
    if (!fullPath) return res.status(400).json({ error: "Missing 'url' query parameter" });
    const fileData = await backblazeService.downloadImageByPath(fullPath);

    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.set({
      "Content-Type": fileData.contentType || "application/octet-stream",
      "Content-Length": fileData.size,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `${disposition}; filename="${fileData.fileName}"`,
    });

    res.send(fileData.buffer);
  } catch (error) {
    console.error("[File Proxy] Error:", error.message);
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: "File not found" });
    }
    res.status(404).json({ error: "Failed to load file" });
  }
};

/**
 * Dynamic multer middleware — reads allowed MIME types from MongoDB at request time.
 * This way adding new types via the admin panel takes effect immediately without restart.
 */
const fileUpload = (req, res, next) => {
  getDB()
    .collection("allowed_file_types")
    .find({})
    .toArray()
    .then((types) => {
      const allowedMimes = types.map((t) => t.mimeType);
      const maxSizeMb = types.reduce((max, t) => Math.max(max, t.maxSizeMb || 25), 25);

      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxSizeMb * 1024 * 1024 },
        fileFilter: (_req, file, cb) => {
          if (allowedMimes.length === 0 || allowedMimes.includes(file.mimetype)) {
            cb(null, true);
          } else {
            cb(new Error(`סוג קובץ לא מורשה: ${file.mimetype}`));
          }
        },
      });

      upload.single("file")(req, res, next);
    })
    .catch(next);
};

/**
 * Upload a document file to Backblaze and return a proxy URL.
 * POST /api/upload-file
 */
const uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file provided" });
    }

    const originalName = req.file.originalname || `file_${Date.now()}`;
    const safeName = originalName.replace(/[^a-zA-Z0-9א-ת._\-() ]/g, "_");

    if (safeName.includes("..") || safeName.includes("\\")) {
      return res.status(400).json({ success: false, error: "Invalid file name" });
    }

    const phone = (req.body.phone || "").trim();
    const subDir = phone && /^[0-9]{9,15}$/.test(phone) ? phone : "agent";
    const b2Path = `uploads/${subDir}/${Date.now()}_${safeName}`;

    await backblazeService.uploadImage(b2Path, req.file.buffer, req.file.mimetype);

    const serverBaseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const proxyUrl = `${serverBaseUrl}/api/file?url=${encodeURIComponent(b2Path)}`;
    const ext = safeName.split(".").pop()?.toLowerCase() || "";

    console.log(`[Upload File] Uploaded ${b2Path} → ${proxyUrl}`);

    res.json({ success: true, url: proxyUrl, path: b2Path, fileName: originalName, mimeType: req.file.mimetype, ext });
  } catch (error) {
    console.error("[Upload File] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

/**
 * Upload multiple images in one request, B2 uploads run 3 at a time
 * POST /api/upload-images-batch
 */
const uploadImagesBatch = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: "No image files provided" });
    }

    const phone = (req.body.phone || "").trim();
    const phoneRegex = /^[0-9]{9,15}$/;
    const subDir = phone && phoneRegex.test(phone) ? phone : "agent";
    const serverBaseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;

    const mimeToExt = {
      "image/jpeg": "jpg", "image/jpg": "jpg",
      "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    };

    const urls = [];

    for (const batch of chunkArray(req.files, 3)) {
      const batchUrls = await Promise.all(
        batch.map(async (file) => {
          const ext = mimeToExt[file.mimetype] || "jpg";
          // Store under post/ prefix (readable by the B2 key) with ugc_ prefix
          // to distinguish from AI-generated content in getCustomerGallery
          const fileName = `ugc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
          const b2Path = `post/${subDir}/${fileName}`;
          await backblazeService.uploadImage(b2Path, file.buffer, file.mimetype);
          return `${serverBaseUrl}/api/img?url=${encodeURIComponent(b2Path)}`;
        })
      );
      urls.push(...batchUrls);
    }

    res.json({ success: true, urls });
  } catch (error) {
    console.error("[UploadBatch] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  getCustomerGallery,
  proxyImage,
  uploadImage,
  upload,
  batchUpload,
  uploadImagesBatch,
  proxyVideo,
  uploadVideo,
  videoUpload,
  pdfUpload,
  uploadPdf,
  proxyFile,
  fileUpload,
  uploadFile,
};
