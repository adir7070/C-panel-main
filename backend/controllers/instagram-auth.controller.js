const axios = require("axios");
const { updateInstagramToken } = require("../services/fireberry.service");

const {
  IG_APP_ID,
  IG_APP_SECRET,
  FB_APP_ID,
  FB_APP_SECRET,
  FB_API_VERSION,
  BASE_URL,
} = process.env;

const IG_REDIRECT_URI = `${BASE_URL}/api/instagram/auth/callback`;
const FB_REDIRECT_URI = `${BASE_URL}/api/instagram/auth/fb-callback`;

// GET /api/instagram/auth/ig-login-url?returnUrl=https://localhost:3334
exports.getIgLoginUrl = (req, res) => {
  const returnUrl = req.query.returnUrl || "";
  const phone = req.query.phone || "";
  const scope = [
    "instagram_business_basic",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
    "instagram_business_content_publish",
    "instagram_business_manage_insights",
  ].join(",");

  const state = Buffer.from(JSON.stringify({ returnUrl, phone })).toString("base64");
  const url = `https://www.instagram.com/oauth/authorize?client_id=${IG_APP_ID}&redirect_uri=${encodeURIComponent(IG_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
  res.json({ success: true, url });
};

// GET /api/instagram/auth/fb-login-url
exports.getFbLoginUrl = (req, res) => {
  const scope = [
    "pages_show_list",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_content_publish",
    "instagram_manage_comments",
    "instagram_manage_insights",
    "business_management",
  ].join(",");

  const url = `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(FB_REDIRECT_URI)}&scope=${scope}&response_type=code`;
  res.json({ success: true, url });
};

// GET /api/instagram/auth/callback — Instagram OAuth callback
exports.igCallback = async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).json({ success: false, message: "Missing code" });

  // Parse return URL and phone from state
  let returnUrl = "";
  let phone = "";
  try {
    const stateData = JSON.parse(Buffer.from(state || "", "base64").toString());
    returnUrl = stateData.returnUrl || "";
    phone = stateData.phone || "";
  } catch (_) {}

  try {
    // Exchange code for short-lived token
    const form = new URLSearchParams();
    form.append("client_id", IG_APP_ID);
    form.append("client_secret", IG_APP_SECRET);
    form.append("grant_type", "authorization_code");
    form.append("redirect_uri", IG_REDIRECT_URI);
    form.append("code", code);

    const { data: tokenData } = await axios.post(
      "https://api.instagram.com/oauth/access_token",
      form.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    console.log("IG Token response:", JSON.stringify(tokenData));

    if (tokenData.error_message) throw new Error(tokenData.error_message);

    const shortToken = tokenData.access_token;
    const igUserId = tokenData.user_id;

    // Exchange for long-lived token
    const { data: longData } = await axios.get(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${IG_APP_SECRET}&access_token=${shortToken}`
    );
    console.log("IG Long-lived token:", JSON.stringify(longData));

    const igToken = longData.access_token || shortToken;

    // Get user profile
    const { data: profile } = await axios.get(
      `https://graph.instagram.com/v21.0/me?fields=user_id,username,name,profile_picture_url,account_type&access_token=${igToken}`
    );
    console.log("IG Profile:", JSON.stringify(profile));

    const result = {
      igUserId: profile.user_id || igUserId,
      username: profile.username,
      name: profile.name,
      picture: profile.profile_picture_url,
      accountType: profile.account_type,
      accessToken: igToken,
      expiresIn: longData.expires_in,
    };

    // Save token to Fireberry
    if (phone) {
      updateInstagramToken(phone, igToken).catch((e) =>
        console.error("[Fireberry] Failed to save IG token:", e.message)
      );
    }

    if (returnUrl) {
      const redirectUrl = new URL(returnUrl);
      redirectUrl.searchParams.set("ig_auth", JSON.stringify(result));
      return res.redirect(redirectUrl.toString());
    }

    res.json({ success: true, data: result });
  } catch (e) {
    const msg = e.response?.data?.error_message || e.response?.data?.error?.message || e.message;
    console.error("IG Auth error:", msg);

    if (returnUrl) {
      const redirectUrl = new URL(returnUrl);
      redirectUrl.searchParams.set("ig_error", msg);
      return res.redirect(redirectUrl.toString());
    }
    res.status(500).json({ success: false, message: "Instagram auth failed: " + msg });
  }
};

// GET /api/instagram/auth/fb-callback — Facebook OAuth callback
exports.fbCallback = async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ success: false, message: "Missing code" });

  try {
    // Exchange code for user token
    const { data: tokenData } = await axios.get(
      `https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(FB_REDIRECT_URI)}&client_secret=${FB_APP_SECRET}&code=${code}`
    );

    if (tokenData.error) throw new Error(tokenData.error.message);
    const userToken = tokenData.access_token;

    // Get pages
    const { data: pagesData } = await axios.get(
      `https://graph.facebook.com/${FB_API_VERSION}/me/accounts?fields=id,name,access_token&limit=100&access_token=${userToken}`
    );
    const pages = pagesData.data || [];

    // Get Instagram accounts for each page
    const igAccounts = [];
    for (const page of pages) {
      const { data: igData } = await axios.get(
        `https://graph.facebook.com/${FB_API_VERSION}/${page.id}?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${page.access_token}`
      );
      if (igData.instagram_business_account) {
        igAccounts.push({
          igId: igData.instagram_business_account.id,
          username: igData.instagram_business_account.username,
          name: igData.instagram_business_account.name,
          picture: igData.instagram_business_account.profile_picture_url,
          pageId: page.id,
          pageName: page.name,
          pageToken: page.access_token,
        });
      }
    }

    res.json({
      success: true,
      data: {
        userToken,
        pages: pages.map((p) => ({ id: p.id, name: p.name })),
        igAccounts,
      },
    });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error("FB Auth error:", msg);
    res.status(500).json({ success: false, message: "Facebook auth failed: " + msg });
  }
};
