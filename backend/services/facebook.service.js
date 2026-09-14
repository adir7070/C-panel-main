const axios = require("axios");

const FB_API_VERSION = process.env.FACEBOOK_API_VERSION || "v23.0";
const BASE_URL = `https://graph.facebook.com/${FB_API_VERSION}`;

/**
 * Fetch all ads for an ad account.
 * @param {string} actId - The ad account ID (e.g., act_123456).
 * @param {string} accessToken - User access token.
 * @returns {Promise<Array>} List of ads.
 */
exports.getAds = async (actId, accessToken) => {
  try {
    const url = `${BASE_URL}/${actId}/ads`;
    const response = await axios.get(url, {
      params: {
        access_token: accessToken,
        fields:
          "id,name,adset_id,campaign_id,status,creative{title,body,object_story_spec}",
        limit: 100, // Reasonable limit
      },
    });
    return response.data.data || [];
  } catch (error) {
    console.error(
      "Error fetching ads from Facebook:",
      error.response?.data || error.message
    );
    throw new Error("Failed to fetch ads from Facebook");
  }
};

/**
 * Fetch insights for a specific object (ad/adset/campaign).
 * @param {string} objectId - The ID of the object.
 * @param {string} accessToken - User access token.
 * @returns {Promise<Object>} Insights data object or null.
 */
exports.getInsights = async (objectId, accessToken) => {
  try {
    const url = `${BASE_URL}/${objectId}/insights`;
    const response = await axios.get(url, {
      params: {
        access_token: accessToken,
        fields:
          "impressions,spend,clicks,inline_link_clicks,actions,quality_ranking,conversion_rate_ranking,engagement_rate_ranking",
        level: "ad",
      },
    });
    return response.data.data?.[0] || null;
  } catch (error) {
    const fbCode = error.response?.data?.error?.code;
    if (fbCode === 4 || fbCode === 17 || fbCode === 32) {
      // Re-throw rate limit errors so callers that care can detect and stop
      throw Object.assign(error, { isRateLimit: true });
    }
    console.warn(
      `Warning: Failed to fetch insights for object ${objectId}:`,
      error.response?.data?.error?.message || error.message
    );
    return null;
  }
};

/**
 * Fetch detailed creative info for an ad (used for high-res validation if needed).
 * @param {string} adId - Ad ID.
 * @param {string} accessToken - User access token.
 */
/**
 * Publish a single photo post to a Facebook page.
 */
exports.publishPhoto = async (pageToken, pageId, imageUrl, caption) => {
  const res = await axios.post(`${BASE_URL}/${pageId}/photos`, null, {
    params: { url: imageUrl, caption, published: true, access_token: pageToken },
  });
  return { postId: res.data.post_id || res.data.id };
};

/**
 * Publish a multi-photo carousel post to a Facebook page.
 * Step 1: upload each photo as unpublished → get media_fbid
 * Step 2: create feed post with attached_media array
 */
exports.publishCarousel = async (pageToken, pageId, imageUrls, caption) => {
  const mediaIds = await Promise.all(
    imageUrls.map((url) =>
      axios
        .post(`${BASE_URL}/${pageId}/photos`, null, {
          params: { url, published: false, access_token: pageToken },
        })
        .then((r) => r.data.id)
    )
  );

  const res = await axios.post(`${BASE_URL}/${pageId}/feed`, null, {
    params: {
      message: caption,
      attached_media: JSON.stringify(mediaIds.map((id) => ({ media_fbid: id }))),
      access_token: pageToken,
    },
  });
  return { postId: res.data.id };
};

/**
 * Fetch the source video URL for a Facebook video asset.
 * Used to resolve a real video URL from a video_id found in ad creative data.
 */
exports.getVideoSource = async (videoId, accessToken) => {
  const url = `${BASE_URL}/${videoId}`;
  const response = await axios.get(url, {
    params: { fields: "source,picture,format", access_token: accessToken },
    timeout: 10_000,
  });
  return response.data; // { source: "https://...", picture: "https://..." }
};

exports.getAdDetails = async (adId, accessToken) => {
    try {
        const url = `${BASE_URL}/${adId}`;
        const response = await axios.get(url, {
            params: {
                access_token: accessToken,
                fields: "name,adset_id,campaign_id,status,creative{id,object_type,title,body,effective_object_story_id,object_story_spec,thumbnail_url,image_url,instagram_permalink_url,asset_feed_spec}"
            }
        });
        return response.data;
    } catch (error) {
        console.error(`Error fetching ad details for ${adId}:`, error.message);
        return null;
    }
}
