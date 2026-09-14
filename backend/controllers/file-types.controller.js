const { getDB } = require("../config/db");
const { v4: uuidv4 } = require("uuid");

const col = () => getDB().collection("allowed_file_types");
const agentsCol = () => getDB().collection("agents");
const settingsCol = () => getDB().collection("app_settings");

/** Mapping from file extension to MIME type(s).
 *  When an admin adds a type by extension only, we look up the MIME here.
 *  If unknown, we fall back to "application/octet-stream".
 */
const EXT_TO_MIME = {
  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  md: "text/markdown",

  // Archives
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  tgz: "application/gzip",

  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",

  // Video
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  "3gp": "video/3gpp",

  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  weba: "audio/webm",

  // Code / data
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "application/typescript",
  tsx: "text/tsx",
  jsx: "text/jsx",
  yaml: "application/yaml",
  yml: "application/yaml",
  sql: "application/sql",
  log: "text/plain",

  // Fonts
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",

  // Other common formats
  apk: "application/vnd.android.package-archive",
  exe: "application/vnd.microsoft.portable-executable",
  dmg: "application/x-apple-diskimage",
  iso: "application/x-iso9660-image",
  wasm: "application/wasm",
};


/** Helper — verify admin token from Authorization header */
async function requireAdmin(req, res) {
  const bearerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  if (!bearerToken) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const agent = await agentsCol().findOne({ token: bearerToken });
  if (!agent || agent.role !== "admin") {
    res.status(403).json({ error: "Forbidden — admin only" });
    return null;
  }
  return agent;
}

/**
 * GET /api/file-types
 * Public — used by mobile app to fetch allowed types dynamically.
 */
exports.getFileTypes = async (req, res) => {
  try {
    const types = await col().find({}).sort({ label: 1 }).toArray();
    res.json({ success: true, types });
  } catch (err) {
    console.error("[FileTypes] getFileTypes error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/file-types/admin
 * Admin auth — same data, used by webapp settings panel.
 */
exports.getFileTypesAdmin = async (req, res) => {
  const agent = await requireAdmin(req, res);
  if (!agent) return;

  try {
    const types = await col().find({}).sort({ label: 1 }).toArray();
    res.json({ success: true, types });
  } catch (err) {
    console.error("[FileTypes] getFileTypesAdmin error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/file-types
 * Admin only — add a new allowed file type.
 * Body: { ext, label, maxSizeMb? }
 * The server resolves the MIME type automatically from the extension.
 */
exports.addFileType = async (req, res) => {
  const agent = await requireAdmin(req, res);
  if (!agent) return;

  try {
    const { ext, label, maxSizeMb = 25 } = req.body;
    if (!ext || !label) {
      return res
        .status(400)
        .json({ success: false, error: "ext ו-label חובה" });
    }

    const cleanExt = ext.trim().toLowerCase().replace(/^\./, "");
    const mimeType = EXT_TO_MIME[cleanExt] || "application/octet-stream";

    // Prevent duplicates by extension
    const existing = await col().findOne({ ext: cleanExt });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, error: `סיומת .${cleanExt} כבר קיימת` });
    }

    const doc = {
      _id: uuidv4(),
      mimeType,
      ext: cleanExt,
      label: label.trim(),
      maxSizeMb: Number(maxSizeMb) || 25,
      createdAt: new Date(),
    };

    await col().insertOne(doc);
    console.log("[FileTypes] Added:", doc.ext, "→", doc.mimeType);
    res.json({ success: true, type: doc });
  } catch (err) {
    console.error("[FileTypes] addFileType error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/file-types/upload-limits
 * Public — used by mobile app to know how many files can be selected.
 */
exports.getUploadLimits = async (req, res) => {
  try {
    const doc = await settingsCol().findOne({ _id: "upload_limits" });
    res.json({ success: true, maxFiles: doc?.maxFiles ?? 10 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * PUT /api/file-types/upload-limits
 * Admin only — set max files allowed per upload.
 * Body: { maxFiles }
 */
exports.setUploadLimits = async (req, res) => {
  const agent = await requireAdmin(req, res);
  if (!agent) return;
  try {
    const maxFiles = Math.max(1, parseInt(req.body.maxFiles) || 10);
    await settingsCol().updateOne(
      { _id: "upload_limits" },
      { $set: { maxFiles, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, maxFiles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * DELETE /api/file-types/:id
 * Admin only — remove a file type by _id.
 */
exports.deleteFileType = async (req, res) => {
  const agent = await requireAdmin(req, res);
  if (!agent) return;

  try {
    const { id } = req.params;
    const result = await col().deleteOne({ _id: id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: "לא נמצא" });
    }
    console.log("[FileTypes] Deleted:", id);
    res.json({ success: true });
  } catch (err) {
    console.error("[FileTypes] deleteFileType error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
