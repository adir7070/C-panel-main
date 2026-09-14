/**
 * Social auto-publish — publishes generated organic posts to the client's
 * Facebook Page + Instagram immediately after generation (mobile HQ flow).
 *
 * Mirrors the proven app-side publish logic (iconiqApp make_request.ts
 * publishPostDirect): IG post / IG story / FB post / FB story, including the
 * IG media_publish 9007 ("media not ready") retry. The images are already
 * PUBLIC proxy URLs, so no pre-upload step is needed.
 *
 * Credentials precedence (mirrors campaign-brief injectCampaignToFacebook):
 *   1. The creds the app sent in the request (pageToken / pageId / igId / igToken)
 *   2. Fallback to getClientFbCredentials(phone) for Fireberry-managed clients.
 *
 * Kill-switch: MOBILE_SOCIAL_AUTOPUBLISH=false disables all publishing.
 */

const axios = require("axios");

const FB_VERSION = process.env.FACEBOOK_API_VERSION || "v23.0";
const GRAPH = `https://graph.facebook.com/${FB_VERSION}`;
/* DEFAULT-OFF until the updated app (which stops publishing client-side) is
   released — otherwise the old app's manual "publish now" + this server
   auto-publish would post DUPLICATES. Flip to default-on (=== "false") in a
   one-line commit once the new app build is live in the stores. */
const AUTOPUBLISH = process.env.MOBILE_SOCIAL_AUTOPUBLISH === "true";

/* IG: create media container → media_publish (retry on 9007 = not ready). */
async function igCreateAndPublish({ apiBase, igId, token, params }) {
  const create = await axios.post(`${apiBase}/${igId}/media`, null, {
    params: { ...params, access_token: token },
  });
  const creationId = create.data?.id;
  if (!creationId) throw new Error("IG media container returned no id");

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
    try {
      const pub = await axios.post(`${apiBase}/${igId}/media_publish`, null, {
        params: { creation_id: creationId, access_token: token },
      });
      if (pub.data?.id) return String(pub.data.id);
    } catch (e) {
      lastErr = e;
      const code = e.response?.data?.error?.code;
      if (code !== 9007) throw e; // only retry "media not ready"
    }
  }
  throw lastErr || new Error("IG publish failed after retries");
}

async function publishOne(postType, imageUrl, caption, creds) {
  const { pageToken, pageId, igId, igToken } = creds;
  const isDirectIg = igToken && (igToken.startsWith("IGAF") || igToken.startsWith("IGQA"));
  const igBase = isDirectIg ? "https://graph.instagram.com/v21.0" : GRAPH;

  switch (postType) {
    case "instagram_post": {
      if (!igId || !igToken) throw new Error("missing IG id/token");
      const id = await igCreateAndPublish({ apiBase: igBase, igId, token: igToken, params: { image_url: imageUrl, caption } });
      return { platform: "instagram", postId: id };
    }
    case "instagram_story": {
      if (!igId || !igToken) throw new Error("missing IG id/token");
      const id = await igCreateAndPublish({ apiBase: igBase, igId, token: igToken, params: { image_url: imageUrl, media_type: "STORIES" } });
      return { platform: "instagram", postId: id };
    }
    case "facebook_post": {
      if (!pageId || !pageToken) throw new Error("missing FB page id/token");
      const r = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
        params: { url: imageUrl, caption, published: true, access_token: pageToken },
      });
      return { platform: "facebook", postId: String(r.data?.post_id || r.data?.id) };
    }
    case "facebook_story": {
      if (!pageId || !pageToken) throw new Error("missing FB page id/token");
      const up = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
        params: { url: imageUrl, published: false, access_token: pageToken },
      });
      const st = await axios.post(`${GRAPH}/${pageId}/photo_stories`, null, {
        params: { photo_id: up.data?.id, access_token: pageToken },
      });
      return { platform: "facebook", postId: String(st.data?.id) };
    }
    default:
      throw new Error(`unknown postType "${postType}"`);
  }
}

/* Resolve publish credentials: prefer what the app sent, fall back to the
   Fireberry/users lookup (same resolver the cron + campaign-brief use). */
async function resolveCreds(payload) {
  let pageToken = payload.token || null;
  let pageId    = payload.pageId || null;
  let igId      = payload.instagram_id || null;
  let igToken   = payload.instagram_token || null;

  if (!pageToken || !pageId || !igToken || !igId) {
    try {
      const cpanel = require("../controllers/cpanel.controller");
      const creds = await cpanel.getClientFbCredentials(payload.phone);
      pageId  = pageId  || creds.pageId || null;
      igToken = igToken || creds.igToken || null;
      if (!pageToken && creds.userToken && pageId) {
        pageToken = await cpanel.getPageAccessToken(creds.userToken, pageId);
      }
      if (!igId && pageToken && pageId) {
        try {
          const r = await axios.get(`${GRAPH}/${pageId}`, {
            params: { fields: "instagram_business_account{id}", access_token: pageToken },
          });
          igId = r.data?.instagram_business_account?.id || null;
        } catch (_) {}
      }
    } catch (e) {
      console.warn(`[social-publish] cred resolve failed for ${payload.phone}: ${e.message}`);
    }
  }
  if (!igToken) igToken = pageToken; // last resort — page token may carry IG content-publish perms
  return { pageToken, pageId, igId, igToken };
}

/**
 * Publish every result to the platform implied by postType. Mutates each
 * result with { published, platform, postId } or { published:false, publishError }.
 * Never throws — a publish failure must not fail the generation job.
 *
 * @param {Array<{url:string, desc:string}>} results
 * @param {string} postType  instagram_post | instagram_story | facebook_post | facebook_story
 * @param {object} payload    { phone, token, pageId, instagram_id, instagram_token }
 */
async function autoPublishSocialPosts(results, postType, payload) {
  if (!AUTOPUBLISH) {
    console.log("[social-publish] disabled via MOBILE_SOCIAL_AUTOPUBLISH=false");
    return;
  }
  if (!Array.isArray(results) || results.length === 0) return;

  let creds;
  try {
    creds = await resolveCreds(payload);
  } catch (e) {
    console.error(`[social-publish] could not resolve creds: ${e.message}`);
    return;
  }

  console.log(`[social-publish] publishing ${results.length} post(s) type=${postType} pageId=${creds.pageId} igId=${creds.igId} hasPageToken=${!!creds.pageToken} hasIgToken=${!!creds.igToken}`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    try {
      const pub = await publishOne(postType, r.url, r.desc || "", creds);
      r.published = true;
      r.platform  = pub.platform;
      r.postId    = pub.postId;
      console.log(`[social-publish] ✅ ${i + 1}/${results.length} ${pub.platform} ${pub.postId}`);
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      r.published    = false;
      r.publishError = msg;
      console.error(`[social-publish] ❌ ${i + 1}/${results.length} failed: ${msg}`);
    }
  }
}

module.exports = { autoPublishSocialPosts };
