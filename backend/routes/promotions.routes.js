const express = require("express");
const router = express.Router();
const c = require("../controllers/promotions.controller");

// Public
router.get("/", c.getActive);
router.get("/:id", c.getOne);

// Admin CRUD
router.get("/admin/all", c.getAll);
router.post("/", c.create);
router.put("/:id", c.update);
router.patch("/:id/toggle", c.toggle);
router.delete("/:id", c.remove);


module.exports = router;
