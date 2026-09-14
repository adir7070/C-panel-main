const express = require("express");
const router = express.Router();
const { getSession, updateSession } = require("../../services/wow/session.service");
const { getBrief } = require("../../services/wow/brief.service");
const cheerio = require("cheerio");
const { LIVE_UPDATE_SCRIPT } = require("../../services/wow/live-edit-script");
const wowUpload = require("../../middlewares/wow-upload.middleware");
const backblazeService = require("../../services/backblaze.service");
const { processEditorChat } = require("../../services/wow/editor-chat.service");

// POST /api/editor/ai-change — free-text change request via AI
router.post('/ai-change', async (req, res, next) => {
  try {
    const { sessionId, prompt } = req.body;
    if (!sessionId || !prompt) {
      return res.status(400).json({ error: true, message: 'sessionId and prompt required' });
    }

    const { actions, reply } = await processEditorChat([], prompt);

    if (actions.length > 0) {
      const session = await getSession(sessionId);
      for (const action of actions) {
        if (action.type === 'text') {
          session.edits.texts = session.edits.texts || {};
          session.edits.texts[action.field] = action.value;
        } else if (action.type === 'color') {
          session.edits.colors = session.edits.colors || {};
          session.edits.colors[action.field] = action.value;
        } else if (action.type === 'icon') {
          session.edits.texts = session.edits.texts || {};
          session.edits.texts[action.field] = action.value;
        }
      }
      await updateSession(sessionId, { edits: session.edits });
    }

    res.json({ ok: true, reply, actionsCount: actions.length });
  } catch (err) {
    next(err);
  }
});

// PUT /api/editor/update — עדכון שדה בודד
router.put('/update', async (req, res, next) => {
  try {
    const { sessionId, field, value, type } = req.body;
    if (!sessionId || !field) {
      res.status(400).json({ error: true, message: 'חסר sessionId או field' });
      return;
    }

    const session = await getSession(sessionId);
    const editKey = type === 'color' ? 'colors' : type === 'image' ? 'images' : type === 'link' ? 'links' : 'texts';
    const storedValue = type === 'text' ? value.replace(/\n/g, '<br>') : value;
    session.edits[editKey][field] = storedValue;

    await updateSession(sessionId, { edits: session.edits, status: 'editing' });
    res.json({ status: 'updated' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/editor/upload-image — העלאת תמונה
router.put(
  '/upload-image',
  wowUpload.single('image'),
  async (req, res, next) => {
    try {
      const { sessionId, field } = req.body;
      const file = req.file;

      if (!file || !sessionId || !field) {
        res.status(400).json({ error: true, message: 'חסר נתונים' });
        return;
      }

      // Upload to Backblaze — replaces legacy /uploads/editor/<sessionId>/<filename>
      const filename = `${Date.now()}-${field}-${file.originalname || 'image'}`;
      const uploadPath = `wow/editor/${sessionId}/${filename}`;
      const up = await backblazeService.uploadImage(uploadPath, file.buffer, file.mimetype);
      const imageUrl = up.publicUrl;

      const session = await getSession(sessionId);
      session.edits.images[field] = imageUrl;
      await updateSession(sessionId, { edits: session.edits, status: 'editing' });

      res.json({ status: 'uploaded', imageUrl });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/editor/toggle-section — הסתרה/הצגה של סקשן
router.put('/toggle-section', async (req, res, next) => {
  try {
    const { sessionId, sectionId, hidden } = req.body;
    if (!sessionId || !sectionId) {
      res.status(400).json({ error: true, message: 'חסר נתונים' });
      return;
    }

    const session = await getSession(sessionId);
    const hiddenSections = session.edits.hiddenSections || [];

    if (hidden && !hiddenSections.includes(sectionId)) {
      hiddenSections.push(sectionId);
    } else if (!hidden) {
      const idx = hiddenSections.indexOf(sectionId);
      if (idx > -1) hiddenSections.splice(idx, 1);
    }

    session.edits.hiddenSections = hiddenSections;
    await updateSession(sessionId, { edits: session.edits, status: 'editing' });
    res.json({ status: 'updated' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/editor/colors — עדכון צבעים
router.put('/colors', async (req, res, next) => {
  try {
    const { sessionId, colors } = req.body;
    if (!sessionId || !colors) {
      res.status(400).json({ error: true, message: 'חסר נתונים' });
      return;
    }

    const session = await getSession(sessionId);
    session.edits.colors = { ...session.edits.colors, ...colors };
    await updateSession(sessionId, { edits: session.edits, status: 'editing' });
    res.json({ status: 'updated' });
  } catch (err) {
    next(err);
  }
});

// GET /api/editor/preview/:sessionId — תצוגה מקדימה
router.get('/preview/:sessionId', async (req, res, next) => {
  try {
    const session = await getSession(req.params.sessionId);
    const geminiHtml = session.edits.geminiHtml;

    if (!geminiHtml) {
      // Still generating — show loading screen with auto-refresh
      const loadingHtml = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700&display=swap" rel="stylesheet">
  <title>מייצר את האתר שלך...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #fafafa; font-family: 'Heebo', sans-serif; direction: rtl;
      overflow: hidden;
    }

    /* Floating background orbs */
    .orb {
      position: fixed; border-radius: 50%; pointer-events: none;
      filter: blur(80px); opacity: 0.08;
    }
    .orb-1 { width: 400px; height: 400px; top: -10%; right: -5%; background: radial-gradient(circle, #645DD7, transparent 70%); animation: orbFloat 20s ease-in-out infinite; }
    .orb-2 { width: 350px; height: 350px; bottom: -8%; left: -8%; background: radial-gradient(circle, #FB62F6, transparent 70%); animation: orbFloat 25s ease-in-out infinite reverse; }
    .orb-3 { width: 250px; height: 250px; top: 40%; left: 30%; background: radial-gradient(circle, #B3FFFC, transparent 70%); animation: orbFloat 18s ease-in-out infinite 3s; }

    @keyframes orbFloat {
      0%, 100% { transform: translate(0, 0) scale(1); }
      33% { transform: translate(30px, -25px) scale(1.1); }
      66% { transform: translate(-20px, 20px) scale(0.95); }
    }

    .wrap {
      text-align: center; position: relative; z-index: 1;
      display: flex; flex-direction: column; align-items: center;
    }

    /* Orbital loader */
    .loader-container { position: relative; width: 120px; height: 120px; margin-bottom: 32px; }

    .ring {
      position: absolute; inset: 0; border-radius: 50%;
      border: 2px solid transparent;
    }
    .ring-1 {
      border-top-color: #645DD7; border-right-color: #FB62F6;
      animation: spin 3s linear infinite;
      filter: drop-shadow(0 0 6px rgba(100,93,215,0.3));
    }
    .ring-2 {
      inset: 12px;
      border-bottom-color: #B3FFFC; border-left-color: #645DD7;
      animation: spin 2s linear infinite reverse;
      filter: drop-shadow(0 0 4px rgba(179,255,252,0.3));
    }
    .ring-3 {
      inset: 24px;
      border-top-color: #FB62F6; border-right-color: #F2FF49;
      animation: spin 4s linear infinite;
      opacity: 0.5;
    }

    /* Center pulsing dot */
    .center-dot {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 16px; height: 16px; border-radius: 50%;
      background: linear-gradient(135deg, #645DD7, #FB62F6);
      animation: pulse 2s ease-in-out infinite;
      box-shadow: 0 0 20px rgba(100,93,215,0.4);
    }

    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse {
      0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.8; }
      50% { transform: translate(-50%, -50%) scale(1.3); opacity: 1; }
    }

    /* Text */
    h2 {
      font-size: 1.15rem; font-weight: 500; color: #111;
      margin-bottom: 8px; letter-spacing: -0.5px;
    }
    .subtitle {
      font-size: 0.8rem; color: #aaa; font-weight: 300;
      margin-bottom: 24px;
    }

    /* Progress bar */
    .progress-track {
      width: 200px; height: 3px; border-radius: 3px;
      background: #eee; overflow: hidden;
    }
    .progress-fill {
      height: 100%; border-radius: 3px;
      background: linear-gradient(90deg, #645DD7, #FB62F6, #B3FFFC);
      background-size: 200% 100%;
      animation: gradientShift 2s ease infinite, grow 30s ease-out forwards;
    }
    @keyframes gradientShift {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes grow {
      0% { width: 5%; }
      50% { width: 60%; }
      80% { width: 85%; }
      100% { width: 92%; }
    }

    /* Floating particles */
    .particle {
      position: fixed; border-radius: 50%; pointer-events: none;
      animation: particleFloat linear infinite;
    }
    @keyframes particleFloat {
      0% { transform: translateY(100vh) scale(0); opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { transform: translateY(-10vh) scale(1); opacity: 0; }
    }
  </style>
  <script>setTimeout(() => location.reload(), 4000)</script>
</head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="orb orb-3"></div>

  <!-- Floating particles -->
  <div class="particle" style="width:4px;height:4px;background:#645DD7;left:15%;animation-duration:12s;animation-delay:0s;opacity:0.15"></div>
  <div class="particle" style="width:3px;height:3px;background:#FB62F6;left:45%;animation-duration:15s;animation-delay:2s;opacity:0.12"></div>
  <div class="particle" style="width:5px;height:5px;background:#B3FFFC;left:75%;animation-duration:10s;animation-delay:4s;opacity:0.1"></div>
  <div class="particle" style="width:3px;height:3px;background:#F2FF49;left:30%;animation-duration:14s;animation-delay:6s;opacity:0.12"></div>
  <div class="particle" style="width:4px;height:4px;background:#FF4242;left:60%;animation-duration:11s;animation-delay:1s;opacity:0.1"></div>

  <div class="wrap">
    <div class="loader-container">
      <div class="ring ring-1"></div>
      <div class="ring ring-2"></div>
      <div class="ring ring-3"></div>
      <div class="center-dot"></div>
    </div>
    <h2>Gemini מעצב את האתר שלך...</h2>
    <p class="subtitle">יוצר עיצוב ייחודי בהתאם לשפה העיצובית</p>
    <div class="progress-track">
      <div class="progress-fill"></div>
    </div>
  </div>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(loadingHtml);
    }

    let html = geminiHtml;

    // Apply saved color overrides
    const savedColors = session.edits.colors || {};
    if (Object.keys(savedColors).length > 0) {
      const colorCss = Object.entries(savedColors)
        .map(([k, v]) => `  ${k}: ${v} !important;`)
        .join('\n');
      html = html.replace('</head>', `<style id="wow-saved-colors">:root {\n${colorCss}\n}</style>\n</head>`);

      // Also replace hardcoded colors in inline styles + CSS
      // Find original values of each CSS var from :root, then replace globally
      const rootMatch = geminiHtml.match(/:root\s*\{([^}]+)\}/);
      if (rootMatch) {
        for (const [varName, newColor] of Object.entries(savedColors)) {
          const origMatch = rootMatch[1].match(new RegExp(varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;]+);'));
          if (origMatch) {
            const origColor = origMatch[1].trim();
            if (origColor && origColor !== newColor) {
              // Replace all occurrences of the original color with the new one
              const escaped = origColor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              html = html.replace(new RegExp(escaped, 'gi'), newColor);
            }
          }
        }
      }
    }

    // Apply hidden sections
    const hiddenSections = session.edits.hiddenSections || [];
    for (const secId of hiddenSections) {
      html = html.replace(
        new RegExp(`(<[^>]+id="${secId}"[^>]*>)`, 'i'),
        (m) => m.replace('>', ' style="display:none!important">')
      );
    }

    // Persist script — re-applies saved text/image edits after live-edit assigns IDs
    const savedTexts = session.edits.texts || {};
    const savedImages = session.edits.images || {};
    const persistScript = `<script>
(function() {
  var savedTexts = ${JSON.stringify(savedTexts)};
  var savedImages = ${JSON.stringify(savedImages)};
  window.addEventListener('load', function() {
    for (var k in savedTexts) {
      document.querySelectorAll('[data-inject="'+k+'"]').forEach(function(el) {
        el.innerHTML = savedTexts[k];
      });
    }
    for (var ik in savedImages) {
      document.querySelectorAll('[data-inject-src="'+ik+'"]').forEach(function(el) {
        if (el.tagName === 'IMG') el.src = savedImages[ik];
        else el.style.backgroundImage = 'url('+savedImages[ik]+')';
      });
    }
  });
})();
</script>`;

    if (html.includes('</body>')) {
      html = html.replace('</body>', `${persistScript}\n${LIVE_UPDATE_SCRIPT}\n</body>`);
    } else {
      html += persistScript + LIVE_UPDATE_SCRIPT;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// GET /api/editor/fields/:sessionId — שדות לעריכה (Gemini: CSS vars מה-HTML)
router.get('/fields/:sessionId', async (req, res, next) => {
  try {
    const session = await getSession(req.params.sessionId);
    const brief = await getBrief(session.briefId);
    const geminiHtml = session.edits.geminiHtml || '';

    // Extract color vars from :root block
    const colorFields = [];
    // Try all :root blocks (there might be multiple style tags)
    const rootRegex = /:root\s*\{([^}]+)\}/g;
    let rootMatch;
    while ((rootMatch = rootRegex.exec(geminiHtml)) !== null) {
      const varRegex = /(--[\w-]+)\s*:\s*([^;]+);/g;
      let m;
      while ((m = varRegex.exec(rootMatch[1])) !== null) {
        const key = m[1].trim();
        const val = session.edits.colors[key] || m[2].trim();
        // Include all CSS custom properties (not just color-named ones)
        if (!colorFields.some(c => c.key === key)) {
          colorFields.push({ key, value: val });
        }
      }
    }

    // Fallback: if no CSS vars found, extract dominant colors from inline styles
    if (colorFields.length === 0) {
      const hexColors = new Set();
      const hexRegex = /#[0-9a-fA-F]{3,8}/g;
      let hm;
      const cssBlocks = geminiHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
      for (const block of cssBlocks) {
        while ((hm = hexRegex.exec(block)) !== null) {
          if (hm[0].length >= 4 && hm[0].length <= 9) hexColors.add(hm[0]);
        }
      }
      // Take first few unique colors as editable
      const colors = [...hexColors].slice(0, 6);
      if (colors.length > 0) {
        colorFields.push({ key: '--primary', value: session.edits.colors['--primary'] || colors[0] });
        if (colors[1]) colorFields.push({ key: '--secondary', value: session.edits.colors['--secondary'] || colors[1] });
        if (colors[2]) colorFields.push({ key: '--accent', value: session.edits.colors['--accent'] || colors[2] });
        if (colors[3]) colorFields.push({ key: '--text-color', value: session.edits.colors['--text-color'] || colors[3] });
        if (colors[4]) colorFields.push({ key: '--bg-color', value: session.edits.colors['--bg-color'] || colors[4] });
      }
    }

    // ── Extract ALL real text + images from HTML using cheerio ──
    const $ = cheerio.load(geminiHtml);
    const savedTexts = session.edits.texts || {};
    const savedImages = session.edits.images || {};
    const textFields = [];
    const imageFields = [];
    const seenTextKeys = new Set();
    const seenImgKeys = new Set();

    // Find section context for an element
    const getSection = (el) => {
      const sec = $(el).closest("section[id], div[id], article[id]");
      return sec.length ? sec.attr("id").toLowerCase() : "general";
    };

    // Extract text from headings + paragraphs + buttons/links with text
    $("h1, h2, h3, h4, h5, h6, p, blockquote, figcaption, [data-inject]").each((i, el) => {
      const $el = $(el);
      const injectKey = $el.attr("data-inject");
      const text = $el.text().trim();
      if (!text || text.length < 2 || text.length > 500) return;

      const section = getSection(el);
      const tag = el.tagName.toLowerCase();
      const key = injectKey || `${section}-${tag}-${i}`;
      if (seenTextKeys.has(key)) return;
      seenTextKeys.add(key);

      const label = tag.startsWith("h") ? "כותרת" : tag === "p" ? "טקסט" : "תוכן";
      textFields.push({
        key,
        value: savedTexts[key] || text,
        section,
        label: `${label} (${section})`,
      });
    });

    // Also include CTA buttons
    $("a, button").each((i, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      if (!text || text.length < 2 || text.length > 60) return;
      const injectKey = $el.attr("data-inject");
      const section = getSection(el);
      const key = injectKey || `${section}-cta-${i}`;
      if (seenTextKeys.has(key)) return;
      seenTextKeys.add(key);
      textFields.push({ key, value: savedTexts[key] || text, section, label: `כפתור (${section})` });
    });

    // Include any saved text keys not found in HTML
    for (const [k, v] of Object.entries(savedTexts)) {
      if (!seenTextKeys.has(k)) {
        textFields.push({ key: k, value: v, section: "saved", label: k });
      }
    }

    // Extract all images
    $("img[src]").each((i, el) => {
      const $el = $(el);
      const src = $el.attr("src") || "";
      if (!src || src.startsWith("data:") || src.length < 5) return;
      const injectKey = $el.attr("data-inject-src");
      const alt = $el.attr("alt") || "";
      const section = getSection(el);
      const key = injectKey || `${section}-img-${i}`;
      if (seenImgKeys.has(key)) return;
      seenImgKeys.add(key);
      imageFields.push({
        key,
        value: savedImages[key] || src,
        section,
        label: alt ? `${alt} (${section})` : `תמונה (${section})`,
      });
    });

    // Background images in inline styles
    $("[style]").each((i, el) => {
      const style = $(el).attr("style") || "";
      const match = style.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (!match || match[1].startsWith("data:")) return;
      const section = getSection(el);
      const key = `${section}-bg-${i}`;
      if (seenImgKeys.has(key)) return;
      seenImgKeys.add(key);
      imageFields.push({ key, value: savedImages[key] || match[1], section, label: `רקע (${section})` });
    });

    for (const [k, v] of Object.entries(savedImages)) {
      if (!seenImgKeys.has(k)) {
        imageFields.push({ key: k, value: v, section: "saved", label: k });
      }
    }

    // Links
    const linkFields = [];
    $("a[data-inject-href]").each((i, el) => {
      const key = $(el).attr("data-inject-href");
      const href = $(el).attr("href") || "";
      linkFields.push({ key, value: href, section: "links" });
    });

    res.json({
      texts: textFields,
      images: imageFields,
      links: linkFields,
      colors: colorFields,
      geminiMode: true,
      businessName: brief.businessName,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
