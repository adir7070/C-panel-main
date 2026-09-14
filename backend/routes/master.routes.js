const router = require("express").Router();
const ctrl = require("../controllers/master.controller");

// GET /api/master/:phone — fetch master record (status + copy)
router.get("/:phone", ctrl.getMaster);

// PUT /api/master/:phone/status — update statuscode
router.put("/:phone/status", ctrl.updateStatus);

// PUT /api/master/:phone/copy — update pcfsystemfield128 (copy JSON)
router.put("/:phone/copy", ctrl.updateCopy);

// POST /api/master/:phone/upload-image — upload product image to Drive
router.post(
  "/:phone/upload-image",
  (req, res, next) => {
    ctrl.uploadImageMiddleware(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, error: err.message });
      next();
    });
  },
  ctrl.uploadImage,
);

// POST /api/master/:phone/creative-edit — AI edit + Drive upload
router.post("/:phone/creative-edit", ctrl.creativeEdit);

module.exports = router;
