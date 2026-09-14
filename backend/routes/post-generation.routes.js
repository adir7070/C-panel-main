const router = require("express").Router();
const ctrl = require("../controllers/post-generation.controller");

// Conditionally apply multer: multipart for generation/refinement, JSON bypass for polling
router.post("/generate", (req, res, next) => {
  if (req.is("application/json")) {
    return next();
  }
  ctrl.uploadMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, ctrl.generate);

module.exports = router;
