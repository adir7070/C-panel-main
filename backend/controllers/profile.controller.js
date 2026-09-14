const { getDB } = require("../config/db");
const { updatePageIdByToken } = require("../services/fireberry.service");
const {
  getCustomerByPhone,
} = require("../services/fireberry-customers.service");

const setProfile = async (req, res) => {
  try {
    const { phone, pageId, websiteUrl, logoBase64 } = req.body;
    if (!phone || !pageId) {
      return res
        .status(400)
        .json({ success: false, message: "phone and pageId are required" });
    }

    await getDB()
      .collection("profiles")
      .updateOne(
        { phone, pageId },
        { $set: { websiteUrl, logoBase64, updatedAt: new Date() } },
        { upsert: true },
      );

    res.json({ success: true });
  } catch (err) {
    console.error("profile/set error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const getProfile = async (req, res) => {
  try {
    const { phone, pageId } = req.query;
    if (!phone || !pageId) {
      return res
        .status(400)
        .json({ success: false, message: "phone and pageId are required" });
    }

    const [profile, fireberryCustomer] = await Promise.all([
      getDB().collection("profiles").findOne({ phone, pageId }),
      getCustomerByPhone(phone).catch(() => null),
    ]);
    console.log({ fireberryCustomer });

    const websiteUrl =
      fireberryCustomer?.websiteUrl || profile?.websiteUrl || null;
    const logoBase64 = profile?.logoBase64 || null;

    if (!profile && !fireberryCustomer) {
      return res
        .status(404)
        .json({ phone, pageId, websiteUrl: null, logoBase64: null });
    }

    res.json({
      phone,
      pageId,
      websiteUrl,
      logoBase64,
      hasLogo: fireberryCustomer?.hasLogo ?? null,
    });
  } catch (err) {
    console.error("profile/get error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateFireberryPageId = async (req, res) => {
  try {
    const { userToken, pageId } = req.body;
    if (!userToken || !pageId) {
      return res
        .status(400)
        .json({ success: false, message: "userToken and pageId are required" });
    }

    const recordId = await updatePageIdByToken(userToken, pageId);
    if (!recordId) {
      return res
        .status(404)
        .json({
          success: false,
          message: "No Fireberry record found for this token",
        });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("profile/update-page-id error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── pageId-only endpoints (no phone required) ───────────────────────────────

const setProfileByPage = async (req, res) => {
  try {
    const { pageId, websiteUrl, logoBase64 } = req.body;
    if (!pageId) {
      return res
        .status(400)
        .json({ success: false, message: "pageId is required" });
    }

    const updates = { updatedAt: new Date() };
    if (websiteUrl !== undefined) updates.websiteUrl = websiteUrl;
    if (logoBase64 !== undefined) updates.logoBase64 = logoBase64;

    await getDB()
      .collection("profiles_by_page")
      .updateOne(
        { pageId },
        { $set: updates },
        { upsert: true },
      );

    res.json({ success: true });
  } catch (err) {
    console.error("profile/set-by-page error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const getProfileByPage = async (req, res) => {
  try {
    const { pageId } = req.query;
    if (!pageId) {
      return res
        .status(400)
        .json({ success: false, message: "pageId is required" });
    }

    const profile = await getDB()
      .collection("profiles_by_page")
      .findOne({ pageId });

    if (!profile) {
      return res
        .status(404)
        .json({ pageId, websiteUrl: null, logoBase64: null });
    }

    res.json({
      pageId,
      websiteUrl: profile.websiteUrl || null,
      logoBase64: profile.logoBase64 || null,
    });
  } catch (err) {
    console.error("profile/get-by-page error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = { setProfile, getProfile, updateFireberryPageId, setProfileByPage, getProfileByPage };
