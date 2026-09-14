const express = require("express");
const router = express.Router();
const c = require("../controllers/coins.controller");

router.post("/load", c.loadCoins);
router.get("/balance", c.getBalance);
router.get("/can-afford", c.canAfford);
router.post("/add", c.addCoins);
router.post("/deduct", c.deductCoins);

// Overview stats & paginated user list
router.get("/overview/stats", c.getOverviewStats);
router.get("/overview/users", c.getOverviewUsers);

// Customer lookup (cache-first → Fireberry)
router.get("/customer", c.getCustomer);

// Transaction history
router.get("/transactions", c.getTransactions);

// Coin packages (public)
router.get("/packages", c.getPackages);

// Coin packages admin CRUD
router.get("/packages/admin", c.getPackagesAdmin);
router.post("/packages", c.createPackage);
router.put("/packages/:packageId", c.updatePackage);
router.delete("/packages/:packageId", c.deletePackage);

// Action prices
router.get("/actions", c.getActions);
router.put("/actions/:action", c.upsertAction);
router.delete("/actions/:action", c.deleteAction);

module.exports = router;
