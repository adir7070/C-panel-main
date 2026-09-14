const router = require("express").Router();
const ctrl = require("../controllers/customers.controller");

// GET /api/customers/by-phone?phone=05XXXXXXXX[&refresh=true]
router.get("/by-phone", ctrl.getByPhone);

// GET /api/customers/is-new?phone=05XXXXXXXX
router.get("/is-new", ctrl.isNew);

// GET /api/customers/search?q=...
router.get("/search", ctrl.search);

// GET /api/customers/characterization/:phone
router.get("/characterization/:phone", ctrl.getCharacterization);

module.exports = router;
