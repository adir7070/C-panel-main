const { DB } = require("../config/db");
const { ObjectId } = require("mongodb");

const col = () => DB.collection("subscription_plans");

exports.getPlans = async (req, res) => {
  try {
    const plans = await col().find({}).sort({ sortOrder: 1, _id: 1 }).toArray();
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.createPlan = async (req, res) => {
  try {
    const {
      name, description, monthlyPrice, yearlyPrice,
      coinsIncluded, isActive, sortOrder, color, tier,
      introEnabled, introPrice, introMonths,
    } = req.body;
    if (!name) return res.status(400).json({ success: false, error: "name is required" });

    const doc = {
      name,
      // Stable machine key (REGULAR/PRO/VIP) the subscription engine matches on.
      tier: tier ? String(tier).toUpperCase() : String(name).toUpperCase(),
      description: description || "",
      monthlyPrice: Number(monthlyPrice) || 0,
      yearlyPrice: Number(yearlyPrice) || 0,
      coinsIncluded: Number(coinsIncluded) || 0,
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      sortOrder: Number(sortOrder) || 0,
      color: color || "#0095ff",
      // First-month intro promo (e.g. ₪49 first month, then monthlyPrice).
      introEnabled: Boolean(introEnabled),
      introPrice: Number(introPrice) || 0,
      introMonths: Number(introMonths) || 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await col().insertOne(doc);
    res.json({ success: true, data: { ...doc, _id: result.insertedId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: "invalid id" });

    const {
      name, description, monthlyPrice, yearlyPrice,
      coinsIncluded, isActive, sortOrder, color, tier,
      introEnabled, introPrice, introMonths,
    } = req.body;

    const $set = { updatedAt: new Date() };
    if (name !== undefined) $set.name = name;
    if (tier !== undefined) $set.tier = String(tier).toUpperCase();
    if (description !== undefined) $set.description = description;
    if (monthlyPrice !== undefined) $set.monthlyPrice = Number(monthlyPrice);
    if (yearlyPrice !== undefined) $set.yearlyPrice = Number(yearlyPrice);
    if (coinsIncluded !== undefined) $set.coinsIncluded = Number(coinsIncluded);
    if (isActive !== undefined) $set.isActive = Boolean(isActive);
    if (sortOrder !== undefined) $set.sortOrder = Number(sortOrder);
    if (color !== undefined) $set.color = color;
    if (introEnabled !== undefined) $set.introEnabled = Boolean(introEnabled);
    if (introPrice !== undefined) $set.introPrice = Number(introPrice) || 0;
    if (introMonths !== undefined) $set.introMonths = Number(introMonths) || 1;

    const result = await col().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: "after" },
    );
    if (!result) return res.status(404).json({ success: false, error: "plan not found" });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: "invalid id" });
    const result = await col().deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: "plan not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
