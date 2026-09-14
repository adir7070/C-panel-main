const path = require("path");
const fs = require("fs/promises");
const cheerio = require("cheerio");
const axios = require("axios");
const sessionService = require("./session.service");
const briefService = require("./brief.service");
const historyService = require("./history.service");
const backblazeService = require("../backblaze.service");

// WOW landing pages are published to Backblaze B2. (The former AWS S3 bucket
// "iconiq-backups" was lost when the AWS account was closed for non-payment.)
// KEY_PREFIX is the bucket path prefix under which each client's page + assets
// are stored; the same relative layout (index.html + images/) is preserved so
// the page's relative asset URLs resolve under the same B2 path.
const RAW_PREFIX = process.env.WOW_S3_KEY_PREFIX;
const KEY_PREFIX = (() => {
  const p = (RAW_PREFIX === undefined ? "wow/" : RAW_PREFIX).replace(/^\/+|\/+$/g, "");
  return p ? p + "/" : "";
})();

const normalizePhone = (phone) => String(phone || "").replace(/\D+/g, "") || "anonymous";

const extContentType = (filename) => {
  const ext = path.extname(filename).toLowerCase().replace(".", "");
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    ico: "image/x-icon",
    mp4: "video/mp4",
    webm: "video/webm",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    css: "text/css; charset=utf-8",
    js: "application/javascript",
  };
  return map[ext] || "application/octet-stream";
};

// Upload to Backblaze B2 under `key` and return its public by-name URL.
// `cacheControl` is accepted for call-site compatibility but not used (B2 sets
// caching at the bucket level).
const putObject = async (key, body, contentType, _cacheControl) => {
  const { publicUrl } = await backblazeService.uploadPublicFile(key, body, contentType);
  return publicUrl;
};

const applyEditsToHtml = (geminiHtml, edits) => {
  let html = geminiHtml;

  for (const [key, val] of Object.entries(edits.texts || {})) {
    const regex = new RegExp(`data-inject="${key}"[^>]*>[^<]*`, "g");
    html = html.replace(regex, (m) => m.replace(/>.*$/, `>${val}`));
  }

  for (const [key, val] of Object.entries(edits.images || {})) {
    const regex = new RegExp(`data-inject-src="${key}"[^>]*src="[^"]*"`, "g");
    html = html.replace(regex, (m) => m.replace(/src="[^"]*"/, `src="${val}"`));
  }

  const savedColors = edits.colors || {};
  const colorOverrides = Object.entries(savedColors)
    .filter(([k]) => k.startsWith("--"))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  if (colorOverrides) {
    html = html.replace(
      "</head>",
      `<style>:root {\n${colorOverrides}\n}</style>\n</head>`,
    );
    // Also replace hardcoded inline colors
    const rootMatch = geminiHtml.match(/:root\s*\{([^}]+)\}/);
    if (rootMatch) {
      for (const [varName, newColor] of Object.entries(savedColors)) {
        const origMatch = rootMatch[1].match(new RegExp(varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*([^;]+);"));
        if (origMatch) {
          const origColor = origMatch[1].trim();
          if (origColor && origColor !== newColor) {
            html = html.replace(new RegExp(origColor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), newColor);
          }
        }
      }
    }
  }

  if (edits.hiddenSections && edits.hiddenSections.length) {
    const $ = cheerio.load(html);
    for (const sel of edits.hiddenSections) {
      $(sel).remove();
    }
    html = $.html();
  }

  return html;
};

const isBackblazeUrl = (url) => /backblazeb2\.com/i.test(url);

// Fetch asset bytes + return a real filename.
// For Backblaze URLs, uses the authenticated B2 client and pulls the
// real filename from the `X-Bz-File-Name` header. For plain HTTPS, uses
// axios. For local paths (legacy), reads from disk.
const fetchAsset = async (url) => {
  if (isBackblazeUrl(url)) {
    const r = await backblazeService.downloadFileById(url);
    const filename = r.fileName ? path.basename(r.fileName) : "asset";
    return { buffer: r.buffer, filename, contentType: extContentType(filename) };
  }
  if (/^https?:\/\//i.test(url)) {
    const res = await axios.get(url, { responseType: "arraybuffer", timeout: 20_000 });
    let filename = "asset";
    try {
      const u = new URL(url);
      filename = path.basename(u.pathname) || filename;
    } catch { /* noop */ }
    return { buffer: Buffer.from(res.data), filename, contentType: extContentType(filename) };
  }
  const abs = url.startsWith("/") ? path.join(__dirname, "..", "..", url.replace(/^\//, "")) : url;
  const buffer = await fs.readFile(abs);
  const filename = path.basename(url.split("?")[0]) || "asset";
  return { buffer, filename, contentType: extContentType(filename) };
};

// Walk HTML, download every asset, then rewrite the HTML to use
// relative `images/<unique-filename>` paths.
// Returns { html, assets: Map<filename, {buffer, contentType}> }.
const collectAndRewriteAssets = async (html) => {
  const $ = cheerio.load(html);

  // ── Pass 1: collect every unique external URL we want to localize
  const discovered = new Set();
  const pickUrl = (raw) => {
    if (!raw) return null;
    const u = raw.trim();
    if (!u || u.startsWith("data:") || u.startsWith("#")) return null;
    // Only fetch http(s) URLs and absolute /uploads local paths
    if (!/^https?:\/\//i.test(u) && !u.startsWith("/")) return null;
    discovered.add(u);
    return u;
  };
  $("img[src]").each((_, el) => pickUrl($(el).attr("src")));
  $("source[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset") || "";
    for (const part of srcset.split(",")) pickUrl(part.trim().split(/\s+/)[0]);
  });
  $("[data-inject-src]").each((_, el) => pickUrl($(el).attr("src")));
  $("link[rel='icon'][href], link[rel='apple-touch-icon'][href]").each((_, el) =>
    pickUrl($(el).attr("href")),
  );
  $("video[src], video source[src], audio[src]").each((_, el) => pickUrl($(el).attr("src")));
  $("style").each((_, el) => {
    const raw = $(el).html() || "";
    raw.replace(/url\((['"]?)([^'")]+)\1\)/g, (_m, _q, u) => { pickUrl(u); return ""; });
  });
  $("[style]").each((_, el) => {
    const raw = $(el).attr("style") || "";
    raw.replace(/url\((['"]?)([^'")]+)\1\)/g, (_m, _q, u) => { pickUrl(u); return ""; });
  });

  // ── Pass 2: download each unique URL in parallel
  const urlMeta = new Map(); // origUrl -> { buffer, filename, contentType }
  await Promise.all(
    Array.from(discovered).map(async (u) => {
      try {
        urlMeta.set(u, await fetchAsset(u));
      } catch (err) {
        console.warn(`[wow/s3-publish] fetch failed ${u}: ${err.message}`);
      }
    }),
  );

  // ── Pass 3: de-dup filenames and build the final name map
  const takenNames = new Set();
  const finalName = new Map(); // origUrl -> finalFilename
  for (const [u, meta] of urlMeta) {
    const raw = meta.filename || "asset";
    const dot = raw.lastIndexOf(".");
    const base = dot > 0 ? raw.slice(0, dot) : raw;
    const ext = dot > 0 ? raw.slice(dot) : "";
    let candidate = raw, i = 1;
    while (takenNames.has(candidate)) { candidate = `${base}-${i}${ext}`; i++; }
    takenNames.add(candidate);
    finalName.set(u, candidate);
  }

  // ── Pass 4: rewrite the HTML to use `images/<finalFilename>`
  const assets = new Map(); // finalFilename -> { buffer, contentType }
  const toLocal = (rawUrl) => {
    if (!rawUrl) return null;
    const u = rawUrl.trim();
    if (!u || u.startsWith("data:") || u.startsWith("#")) return null;
    const n = finalName.get(u);
    if (!n) return null;
    if (!assets.has(n)) {
      const meta = urlMeta.get(u);
      assets.set(n, { buffer: meta.buffer, contentType: meta.contentType });
    }
    return `images/${n}`;
  };

  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    const local = toLocal(src);
    if (local) $(el).attr("src", local);
  });
  $("source[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset");
    if (!srcset) return;
    const rewritten = srcset
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const [u, ...rest] = trimmed.split(/\s+/);
        const local = toLocal(u);
        return local ? [local, ...rest].join(" ") : trimmed;
      })
      .join(", ");
    $(el).attr("srcset", rewritten);
  });
  $("[data-inject-src]").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;
    const local = toLocal(src);
    if (local) $(el).attr("src", local);
  });
  $("link[rel='icon'][href], link[rel='apple-touch-icon'][href]").each((_, el) => {
    const href = $(el).attr("href");
    const local = toLocal(href);
    if (local) $(el).attr("href", local);
  });
  $("video[src], video source[src], audio[src]").each((_, el) => {
    const src = $(el).attr("src");
    const local = toLocal(src);
    if (local) $(el).attr("src", local);
  });

  // Inline style url(...) in <style> tags and style attributes
  const rewriteCssUrls = (css) =>
    css.replace(/url\((['"]?)([^'")]+)\1\)/g, (_, q, u) => {
      const local = toLocal(u);
      return local ? `url(${q}${local}${q})` : `url(${q}${u}${q})`;
    });

  $("style").each((_, el) => {
    const raw = $(el).html();
    if (raw) $(el).html(rewriteCssUrls(raw));
  });
  $("[style]").each((_, el) => {
    const raw = $(el).attr("style");
    if (raw) $(el).attr("style", rewriteCssUrls(raw));
  });

  return { html: $.html(), assets };
};

const publish = async (sessionId, phone) => {
  const session = await sessionService.getSession(sessionId);
  if (!session.edits || !session.edits.geminiHtml) {
    throw new Error("Session has no generated HTML yet");
  }

  let brief = null;
  try {
    brief = await briefService.getBrief(session.briefId);
  } catch {
    brief = null;
  }

  const editedHtml = applyEditsToHtml(session.edits.geminiHtml, session.edits);
  const { html, assets } = await collectAndRewriteAssets(editedHtml);

  const phoneKey = normalizePhone(phone);
  const prefix = `${KEY_PREFIX}clients/${phoneKey}/${sessionId}`;

  // Upload the already-downloaded assets to S3 in parallel
  await Promise.all(
    Array.from(assets.entries()).map(async ([filename, { buffer, contentType }]) => {
      try {
        await putObject(
          `${prefix}/images/${filename}`,
          buffer,
          contentType || extContentType(filename),
          "public, max-age=31536000, immutable",
        );
      } catch (err) {
        console.warn(`[wow/s3-publish] Skipped asset ${filename}: ${err.message}`);
      }
    }),
  );

  const pageUrl = await putObject(
    `${prefix}/index.html`,
    Buffer.from(html, "utf-8"),
    "text/html; charset=utf-8",
    "no-cache, must-revalidate",
  );

  // Also upload ad images to S3 under /ads/ subfolder
  try {
    const { loadAdsJson } = require("./ads.service");
    const adsData = await loadAdsJson(sessionId);
    const allAds = (adsData && (adsData.generatedAds || adsData.ads)) || [];
    const adUploads = allAds
      .filter((a) => a.imageUrl)
      .map(async (ad, idx) => {
        try {
          const r = await fetchAsset(ad.imageUrl);
          const adKey = `${prefix}/ads/ad_${ad.id || idx + 1}.png`;
          await putObject(adKey, r.buffer, "image/png", "public, max-age=31536000, immutable");
        } catch (err) {
          console.warn(`[wow/s3-publish] Skipped ad ${ad.id}: ${err.message}`);
        }
      });
    await Promise.all(adUploads);
    console.log(`[wow/s3-publish] ${adUploads.length} ad images uploaded to S3`);
  } catch (err) {
    console.warn(`[wow/s3-publish] ads upload failed: ${err.message}`);
  }

  // Kept the `s3Url` field name for backward compatibility (read by
  // routes/wow/page.routes.js); it now holds the Backblaze by-name page URL.
  const s3Url = pageUrl;
  const proxyUrl = `${process.env.SERVER_BASE_URL || "https://api.iconiqmedia.co.il"}/api/wow/page/${sessionId}`;

  try {
    await historyService.recordPublish({
      phone: phoneKey,
      sessionId,
      briefId: session.briefId,
      url: proxyUrl,
      s3Url,
      businessName: brief ? brief.businessName : null,
    });
  } catch (err) {
    console.warn(`[wow/s3-publish] history record failed: ${err.message}`);
  }

  await sessionService.updateSession(sessionId, {
    status: "published",
    publishedAt: new Date().toISOString(),
    publishedUrl: proxyUrl,
  });

  return { url: proxyUrl };
};

module.exports = {
  publish,
};
