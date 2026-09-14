/**
 * site-screenshot.service.js
 *
 * Captures a full-page screenshot of a public URL using Puppeteer and
 * caches the PNG to disk. Subsequent requests for the same URL serve
 * from the cache instantly. Used by the works-catalog public page to
 * render scrolling previews of landing pages we built for clients.
 *
 * Cache location: public/agent-screenshots/{sha1(url)}.png
 * Cache TTL: 7 days (re-captures after that). Force-refresh: ?force=1
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer");

const CACHE_DIR = path.join(__dirname, "..", "public", "agent-screenshots");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cachePath(url) {
  const hash = crypto.createHash("sha1").update(url).digest("hex");
  return path.join(CACHE_DIR, `${hash}.png`);
}

/* Single in-flight per URL — prevents thundering-herd if two requests
   for the same URL arrive while the first capture is still running. */
const inflight = new Map();

async function captureFullPage(url) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 25_000 });
    /* Give late-loading hero images / fonts a beat to settle. */
    await new Promise(r => setTimeout(r, 1500));
    /* Trigger lazy-loaded sections by scrolling once top → bottom → top. */
    await page.evaluate(async () => {
      const h = document.body.scrollHeight;
      window.scrollTo(0, h);
      await new Promise(r => setTimeout(r, 600));
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 300));
    });
    const buf = await page.screenshot({ type: "png", fullPage: true });
    return buf;
  } finally {
    await browser.close();
  }
}

async function getScreenshot(url, { force = false } = {}) {
  const file = cachePath(url);
  if (!force && fs.existsSync(file)) {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      return fs.readFileSync(file);
    }
  }
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    const buf = await captureFullPage(url);
    fs.writeFileSync(file, buf);
    return buf;
  })();
  inflight.set(url, job);
  try {
    return await job;
  } finally {
    inflight.delete(url);
  }
}

module.exports = { getScreenshot };
