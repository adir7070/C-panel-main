const express = require("express");
const crypto = require("crypto");
const { DB } = require("../config/db");
const requireAdmin = require("../middlewares/admin-auth.middleware");

const dashboard = require("../controllers/app-admin/dashboard");
const users = require("../controllers/app-admin/users");
const activity = require("../controllers/app-admin/activity");
const revenue = require("../controllers/app-admin/revenue");
const leads = require("../controllers/app-admin/leads");
const content = require("../controllers/app-admin/content");
const logs = require("../controllers/app-admin/logs");
const metrics = require("../controllers/app-admin/metrics");
const adminCtrl = require("../controllers/admin.controller");

const router = express.Router();

// ─── Public: Login ────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password)
      return res.status(400).json({ message: "Name and password required" });

    const hashed = crypto.createHash("sha256").update(password + "iconiq2024").digest("hex");
    const agent = await DB.collection("agents").findOne({ name, password: hashed });
    if (!agent) return res.status(401).json({ message: "Invalid credentials" });
    if (agent.role !== "admin") return res.status(403).json({ message: "Admin access required" });

    res.json({ agent: { _id: agent._id, name: agent.name, role: agent.role, token: agent.token } });
  } catch (err) {
    console.error("[AppAdmin/Login]", err.message);
    res.status(500).json({ message: "Login failed" });
  }
});

// ─── Protected routes ─────────────────────────────────────────────────────────
router.use(requireAdmin);

// Dashboard
router.get("/dashboard/overview", dashboard.getOverview);
router.get("/dashboard/charts", dashboard.getChartData);
router.get("/dashboard/activity", dashboard.getRecentActivity);

// Users
router.get("/users", users.list);
router.get("/users/:phone", users.getByPhone);

// Activity
router.get("/activity/stats", activity.getStats);
router.get("/activity/timeline", activity.getTimeline);
router.get("/activity/by-hour", activity.getByHour);
router.get("/activity/recent", activity.getRecent);
router.get("/activity/top-users", activity.getTopUsers);

// Revenue
router.get("/revenue/stats", revenue.getStats);
router.get("/revenue/chart", revenue.getChart);
router.get("/revenue/by-action", revenue.getByAction);
router.get("/revenue/transactions", revenue.listTransactions);

// Leads
router.get("/leads", leads.list);
router.get("/leads/stats", leads.getStats);

// Content
router.get("/content/stats", content.getStats);
router.get("/content/jobs", content.listJobs);
router.get("/content/images", content.listImages);

// Logs
router.get("/log", logs.query);

// Metrics
router.get("/metrics/active-users", metrics.getActiveUsers);
router.get("/metrics/quotes-stats", metrics.getQuotesStats);
router.get("/metrics/details/:type", metrics.getMetricDetails);

// Managers
router.get("/managers", adminCtrl.listAdminAgents);
router.patch("/managers/:id", adminCtrl.updateAdminAgent);
router.delete("/managers/:id", adminCtrl.deactivateAdminAgent);
router.post("/managers/:id/avatar", adminCtrl.adminAgentAvatarUploadMw, adminCtrl.uploadAdminAgentAvatar);

// App Activity
router.get("/user-activity/:phone", activity.getUserActivity);
router.get("/user-activity/:phone/summary", activity.getUserActivitySummary);
router.get("/app-activity/overview", activity.getAppActivityOverview);
router.get("/app-activity/recent", activity.getAppActivityRecent);
router.get("/app-activity/sessions", activity.getAppActivitySessions);
router.get("/app-activity/paths", activity.getAppActivityPaths);
router.get("/app-activity/dropoffs", activity.getAppActivityDropoffs);
router.get("/app-activity/by-hour", activity.getAppActivityByHour);
router.get("/app-activity/by-day", activity.getAppActivityByDay);

module.exports = router;
