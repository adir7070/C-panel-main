/**
 * Media Detection Utility — V2 Ad Creative Pipeline
 *
 * Detects image vs video with priority-ordered signals:
 *   1. Facebook creative video_id / video_data (highest confidence)
 *   2. Content-Type header from HEAD/GET probe
 *   3. URL file extension
 *   4. Fallback → assume image
 */

const axios = require("axios");

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "webm", "mkv", "m4v", "3gp"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_UA = "Mozilla/5.0 (compatible; IconiqBot/1.0)";

// Known Facebook thumbnail URL path fragments
const FB_THUMBNAIL_PATHS = [
  "/v/t15.5256/",
  "/t15.5256/",
  "/v/t1.18169/",
  "p720x720",
  "_n.jpg",
  "/p320x320",
  "/p480x480",
];

// ─── Sync helpers ─────────────────────────────────────────────────────────────

function parseUrlInfo(url) {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const rawPath = parsed.pathname;
    const ext = rawPath.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
    return {
      host: parsed.hostname,
      path: rawPath,
      extension: ext,
      queryKeys: [...parsed.searchParams.keys()],
      hasFbcdn: parsed.hostname.includes("fbcdn.net"),
      hasFacebook: parsed.hostname.includes("facebook.com"),
    };
  } catch {
    return { parseError: true };
  }
}

// ─── Async HEAD/GET probe ──────────────────────────────────────────────────────

async function probeMediaUrl(url) {
  const headers = { "User-Agent": PROBE_UA };

  // Try HEAD first (cheap, no body)
  try {
    const r = await axios.head(url, { timeout: PROBE_TIMEOUT_MS, maxRedirects: 5, headers });
    return {
      success: true,
      method: "head",
      status: r.status,
      contentType: r.headers["content-type"]?.split(";")[0]?.trim() || null,
      contentLength: parseInt(r.headers["content-length"] || "0", 10) || 0,
      acceptRanges: r.headers["accept-ranges"] || null,
      finalUrl: r.request?.res?.responseUrl || url,
    };
  } catch {
    // HEAD failed → try range GET (first 1KB only)
    try {
      const r = await axios.get(url, {
        timeout: PROBE_TIMEOUT_MS,
        maxRedirects: 5,
        headers: { ...headers, Range: "bytes=0-1023" },
        responseType: "arraybuffer",
        maxContentLength: 4096,
      });
      const contentRange = r.headers["content-range"];
      const totalSize = contentRange
        ? parseInt(contentRange.split("/")[1] || "0", 10)
        : parseInt(r.headers["content-length"] || "0", 10) || 0;
      return {
        success: true,
        method: "get_range",
        status: r.status,
        contentType: r.headers["content-type"]?.split(";")[0]?.trim() || null,
        contentLength: totalSize,
        acceptRanges: r.headers["accept-ranges"] || null,
        finalUrl: r.request?.res?.responseUrl || url,
      };
    } catch (err) {
      return {
        success: false,
        method: "failed",
        error: err.message,
        contentType: null,
        contentLength: 0,
        finalUrl: url,
      };
    }
  }
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Priority-ordered media type detection.
 * @param {{ url, contentType, contentLength, fbCreativeData }} opts
 * @returns {{ type: "image"|"video"|"unknown", confidence: number, reason: string, videoId?: string }}
 */
function detectMediaType({ url, contentType, contentLength, fbCreativeData }) {
  const urlInfo = parseUrlInfo(url);
  const ext = urlInfo.extension;

  // Priority 1: Facebook creative signals (definitive)
  if (fbCreativeData) {
    const spec = fbCreativeData.object_story_spec;
    const videoId = fbCreativeData.video_id
      || spec?.video_data?.video_id
      || spec?.video_id;
    if (videoId) {
      return { type: "video", confidence: 10, reason: "fb_creative_video_id", videoId };
    }
    if (spec?.video_data) {
      return { type: "video", confidence: 9, reason: "fb_creative_video_data" };
    }
  }

  // Priority 2: Content-Type header
  if (contentType?.startsWith("video/")) {
    return { type: "video", confidence: 9, reason: "content_type_video" };
  }
  if (contentType?.startsWith("image/")) {
    // Edge case: image MIME but video extension (shouldn't happen but log it)
    if (VIDEO_EXTENSIONS.has(ext)) {
      return { type: "video", confidence: 7, reason: "extension_video_overrides_image_mime" };
    }
    return { type: "image", confidence: 8, reason: "content_type_image" };
  }

  // Priority 3: URL extension
  if (VIDEO_EXTENSIONS.has(ext)) {
    return { type: "video", confidence: 7, reason: "extension_video" };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { type: "image", confidence: 6, reason: "extension_image" };
  }

  // Priority 4: Fallback
  return { type: "image", confidence: 2, reason: "fallback_image" };
}

// ─── Thumbnail detection ──────────────────────────────────────────────────────

/**
 * Returns true when the URL is almost certainly a video thumbnail, not the video itself.
 * Requires at least 2 independent signals.
 */
function isLikelyThumbnail({ url, contentType, contentLength, fbCreativeData }) {
  const reasons = [];

  if (FB_THUMBNAIL_PATHS.some((p) => url?.includes(p))) reasons.push("fb_thumbnail_path_pattern");
  if (contentLength > 0 && contentLength < 20 * 1024) reasons.push("file_under_20kb");

  const urlInfo = parseUrlInfo(url);
  if (urlInfo.hasFbcdn && !VIDEO_EXTENSIONS.has(urlInfo.extension)) {
    reasons.push("fbcdn_no_video_extension");
  }

  if (contentType?.startsWith("image/") && fbCreativeData) {
    const spec = fbCreativeData.object_story_spec;
    const hasVideo = !!(fbCreativeData.video_id || spec?.video_data);
    if (hasVideo) reasons.push("image_mime_but_fb_creative_has_video");
  }

  return { isLikely: reasons.length >= 2, reasons };
}

// ─── Facebook creative signal extractor ──────────────────────────────────────

function extractFbCreativeSignals(adCreative) {
  if (!adCreative) return null;
  const spec = adCreative.object_story_spec;
  const videoId = adCreative.video_id
    || spec?.video_data?.video_id
    || spec?.video_id
    || null;
  return {
    hasObjectStorySpec: !!spec,
    hasVideoData: !!spec?.video_data,
    hasVideoId: !!videoId,
    hasImageData: !!spec?.link_data || !!spec?.photo_data,
    hasImageUrl: !!(spec?.link_data?.picture || spec?.photo_data?.url || adCreative.image_url),
    hasThumbnailUrl: !!(spec?.video_data?.image_url || adCreative.thumbnail_url),
    videoId,
    thumbnailUrlPreview: (spec?.video_data?.image_url || adCreative.thumbnail_url || "")?.substring(0, 120) || null,
    imageUrlPreview: (spec?.link_data?.picture || spec?.photo_data?.url || adCreative.image_url || "")?.substring(0, 120) || null,
  };
}

module.exports = {
  parseUrlInfo,
  probeMediaUrl,
  detectMediaType,
  isLikelyThumbnail,
  extractFbCreativeSignals,
};
