/**
 * Media Proxy — downloads remote media to server memory before sending to AI.
 *
 * Required because OpenAI vision cannot access signed CDN URLs (fbcdn.net, etc.).
 * Converts image/video buffer to inline base64 data URLs.
 */

const axios = require("axios");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
const TIMEOUT_MS = 20_000;

// Common mime-type fallbacks by extension
const EXT_MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", avif: "image/avif",
};

function detectMimeType(url, contentTypeHeader) {
  if (contentTypeHeader) {
    const base = contentTypeHeader.split(";")[0].trim();
    if (base.startsWith("image/")) return base;
  }
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return EXT_MIME[ext] || "image/jpeg";
}

/**
 * Downloads an image URL and returns an inline base64 data URL.
 * Handles fbcdn.net, S3, Backblaze, and any other HTTP source.
 *
 * @param {string} url
 * @returns {Promise<string>} "data:image/jpeg;base64,..."
 */
async function downloadImageAsBase64(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_IMAGE_BYTES,
    headers: {
      // Mimic a browser request to avoid CDN blocks
      "User-Agent": "Mozilla/5.0 (compatible; IconiqBot/1.0)",
    },
  });

  const mimeType = detectMimeType(url, response.headers["content-type"]);
  const base64 = Buffer.from(response.data).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

module.exports = { downloadImageAsBase64 };
