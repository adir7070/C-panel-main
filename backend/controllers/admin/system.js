const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

exports.getHealth = async (req, res) => {
  try {
    const db = DB.getDB();
    const dbPing = await db.admin().ping();
    const memUsage = process.memoryUsage();

    res.json({
      status: "ok",
      uptime: process.uptime(),
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      },
      dbConnected: dbPing?.ok === 1,
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Admin/System] health:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
};

exports.getSettings = async (req, res) => {
  try {
    const settings = await col("settings").find({}).toArray();
    res.json({ settings });
  } catch (err) {
    console.error("[Admin/System] settings:", err.message);
    res.status(500).json({ message: "Failed to get settings" });
  }
};

exports.updateSetting = async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    await col("settings").updateOne(
      { key },
      { $set: { key, value, updatedAt: new Date() } },
      { upsert: true }
    );

    res.json({ message: "Setting updated" });
  } catch (err) {
    console.error("[Admin/System] updateSetting:", err.message);
    res.status(500).json({ message: "Failed to update setting" });
  }
};

exports.getCollectionStats = async (req, res) => {
  try {
    const db = DB.getDB();
    const collections = await db.listCollections().toArray();

    const stats = await Promise.all(
      collections.map(async (c) => {
        const count = await db.collection(c.name).estimatedDocumentCount();
        return { name: c.name, count };
      })
    );

    stats.sort((a, b) => b.count - a.count);
    res.json({ collections: stats });
  } catch (err) {
    console.error("[Admin/System] collections:", err.message);
    res.status(500).json({ message: "Failed to get collection stats" });
  }
};
