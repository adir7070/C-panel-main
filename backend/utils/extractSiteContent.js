const axios = require("axios");

/**
 * Fetches a website URL and extracts clean text content to use as AI context.
 * Strips all HTML tags, scripts, styles and collapses whitespace.
 * @param {string} url - The website URL to fetch
 * @returns {Promise<string>} - Clean text, max ~3000 chars. Empty string on failure.
 */
const extractSiteContent = async (url) => {
  if (!url || typeof url !== "string") return "";

  try {
    const fullUrl = url.startsWith("http") ? url : `https://${url}`;

    const response = await axios.get(fullUrl, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; IconiqBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      maxContentLength: 500_000,
    });

    const html = response.data;
    if (typeof html !== "string") return "";

    // Remove script, style and noscript blocks entirely
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

    // Strip all remaining HTML tags
    text = text.replace(/<[^>]+>/g, " ");

    // Decode common HTML entities
    text = text
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // Collapse whitespace
    text = text.replace(/\s+/g, " ").trim();

    if (text.length > 3000) {
      text = text.substring(0, 3000) + "...";
    }

    return text;
  } catch (error) {
    console.warn(
      `[extractSiteContent] Failed to fetch ${url}: ${error.message}`,
    );
    return "";
  }
};

module.exports = extractSiteContent;
