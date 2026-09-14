const { getProjectsByPhone, getProjectsByAccountId, updateProjectStatus } = require("../services/fireberry-projects.service");

exports.getByPhone = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: "phone query param is required" });
    }

    console.log(`🏗️ [Projects] GET /projects?phone=${phone}`);
    const projects = await getProjectsByPhone(phone);
    res.json({ success: true, data: projects });
  } catch (error) {
    console.error("❌ [Projects] Error:", error.message);
    res.status(500).json({ error: "Failed to fetch projects", details: error.message });
  }
};

exports.getByAccountId = async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!accountId) {
      return res.status(400).json({ success: false, error: "accountId is required" });
    }
    const projects = await getProjectsByAccountId(accountId);
    res.json({ success: true, data: projects });
  } catch (error) {
    console.error("❌ [Projects] getByAccountId error:", error.message);
    res.status(500).json({ success: false, error: "Failed to fetch projects", details: error.message });
  }
};

/**
 * PUT /api/projects/:projectId/status
 * Update project status in Fireberry.
 */
exports.updateStatus = async (req, res) => {
  const { projectId } = req.params;
  const { statusCode } = req.body;

  if (!projectId) return res.status(400).json({ success: false, message: "projectId is required" });
  if (statusCode == null) return res.status(400).json({ success: false, message: "statusCode is required" });

  try {
    await updateProjectStatus(projectId, statusCode);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [Projects] updateStatus error:", error.message);
    res.status(500).json({ success: false, message: "Failed to update status", details: error.message });
  }
};
