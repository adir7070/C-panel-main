const { DB } = require("../config/db");

async function requireAdmin(req, res) {
  const bearerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  if (!bearerToken) {
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }
  const agent = await DB.collection("agents").findOne({ token: bearerToken });
  if (!agent || agent.role !== "admin") {
    res.status(403).json({ message: "Forbidden — admin only" });
    return null;
  }
  return agent;
}

module.exports = { requireAdmin };
