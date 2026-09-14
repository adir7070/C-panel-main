const { DB } = require("../config/db");

module.exports = async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const agent = await DB.collection("agents").findOne({ token });

    if (!agent || agent.role !== "admin") {
      return res.status(403).json({ message: "Forbidden — admin only" });
    }

    req.adminAgent = agent;
    next();
  } catch (err) {
    console.error("[AdminAuth]", err.message);
    res.status(500).json({ message: "Auth error" });
  }
};
