const multer = require("multer");

const fileFilter = (_req, file, cb) => {
  const allowed = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml',
    'image/gif', 'image/avif', 'image/heic', 'image/heif',
    'application/octet-stream',
  ];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(null, true); // accept all — let the pipeline handle unsupported formats
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = upload;
