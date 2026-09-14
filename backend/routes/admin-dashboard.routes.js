const express = require("express");
const crypto = require("crypto");
const { DB } = require("../config/db");
const requireAdmin = require("../middlewares/admin-auth.middleware");

const dashboard = require("../controllers/admin/dashboard");
const users = require("../controllers/admin/users");
const leads = require("../controllers/admin/leads");
const finance = require("../controllers/admin/finance");
const whatsapp = require("../controllers/admin/whatsapp");
const content = require("../controllers/admin/content");
const support = require("../controllers/admin/support");
const appointments = require("../controllers/admin/appointments");
const system = require("../controllers/admin/system");

const router = express.Router();

// ─── Public: Login ────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password)
      return res.status(400).json({ message: "Name and password required" });

    const hashed = crypto
      .createHash("sha256")
      .update(password + "iconiq2024")
      .digest("hex");

    const agent = await DB.collection("agents").findOne({ name, password: hashed });
    if (!agent) return res.status(401).json({ message: "Invalid credentials" });
    if (agent.role !== "admin")
      return res.status(403).json({ message: "Admin access required" });

    res.json({
      agent: {
        _id: agent._id,
        name: agent.name,
        role: agent.role,
        token: agent.token,
      },
    });
  } catch (err) {
    console.error("[Admin/Login]", err.message);
    res.status(500).json({ message: "Login failed" });
  }
});

// ─── Protected routes ─────────────────────────────────────────────────────────
router.use(requireAdmin);

// Dashboard
router.get("/dashboard/overview", dashboard.getOverview);
router.get("/dashboard/activity", dashboard.getRecentActivity);
router.get("/dashboard/charts", dashboard.getChartData);

// Users
router.get("/users", users.list);
router.post("/users/sync-fireberry", users.syncFireberry);
router.get("/users/:phone", users.getByPhone);
router.put("/users/:phone", users.update);
router.get("/users/:phone/transactions", users.getTransactions);

// Leads
router.get("/leads", leads.list);
router.get("/leads/stats", leads.getStats);

// Finance
router.get("/finance/overview", finance.getOverview);
router.get("/finance/transactions", finance.listTransactions);
router.get("/finance/packages", finance.getPackages);
router.get("/finance/invoices", finance.listInvoices);

// WhatsApp
router.get("/whatsapp/sessions", whatsapp.listSessions);
router.get("/whatsapp/sms-logs", whatsapp.getSmsLogs);
router.delete("/whatsapp/sessions/:phone", whatsapp.disconnectSession);

// AI & Content
router.get("/content/stats", content.getStats);
router.get("/content/jobs", content.listJobs);

// Support
router.get("/support/chats", support.listChats);
router.get("/support/stats", support.getStats);
router.get("/support/agents", support.listAgents);

// Appointments
router.get("/appointments", appointments.list);
router.get("/appointments/stats", appointments.getStats);

// System
router.get("/system/health", system.getHealth);
router.get("/system/settings", system.getSettings);
router.put("/system/settings/:key", system.updateSetting);
router.get("/system/collections", system.getCollectionStats);

module.exports = router;
