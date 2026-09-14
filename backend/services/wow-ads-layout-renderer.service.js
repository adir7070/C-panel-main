/**
 * WOW Ads — Deterministic SVG Layout Renderer
 *
 * Takes a clean "hero" image produced by gpt-image-2 (subject + scene,
 * intentional negative space, NO text/logo/CTA inside) and composes
 * the final ad with the brand panel painted in code:
 *
 *   - logo (top-left of brand panel)
 *   - Hebrew transliteration beside the logo
 *   - giant Hebrew headline with one-word accent
 *   - description (multi-line)
 *   - rounded-pill CTA button
 *   - 3 feature pills (icon + label) at the bottom
 *   - curved/diagonal/scalloped divider between brand panel and hero
 *
 * Why deterministic:
 *   The model never gets right repeatedly: Hebrew character fidelity,
 *   logo pixel-accuracy, alignment of 3 pills, exact font weights,
 *   exact CTA radius. Painting these in SVG → resvg → PNG gives us
 *   100% repeatable output across sessions.
 *
 * Composition flow:
 *   heroBuffer  → normalize to AD_SIZE × AD_SIZE square
 *   logoBuffer  → trim white background, resize to maxWidth
 *   palette     → build a complete renderer-ready palette
 *   SVG path    → build the panel shape + clip path for the hero
 *   resvg.render → rasterize SVG to PNG
 *   sharp        → final PNG at quality 100
 */

const sharp = require("sharp");
const { Resvg } = require("@resvg/resvg-js");
const path = require("path");
const fs = require("fs");

const AD_SIZE = 1024;
const FONTS_DIR = path.join(__dirname, "..", "assets", "fonts");

/* Renderer version stamp — bump when spacing, typography, panel geometry,
   or icon set changes meaningfully. Stored on every rendered ad so admin
   KPIs can segment scores by renderer revision. */
const RENDERER_VERSION = "v1.2";

/* Preload font file paths so resvg can load them without scanning system
   fonts (Heroku containers have no useful Hebrew system fonts). Files
   referenced must exist in assets/fonts/. */
const FONT_FILES = ["Arial.ttf", "ArialBold.ttf", "SFHebrew.ttf"]
  .map(f => path.join(FONTS_DIR, f))
  .filter(p => fs.existsSync(p));

/* Map the Director's typographyStyle → an actual font family we have on
   disk. SFHebrew (San Francisco Hebrew) is the proper Hebrew face we
   ship with the repo; Arial is the Latin/fallback. The renderer uses
   these `font-family` values verbatim in SVG output — resvg matches
   them to the loaded TTF files by family name.
   To upgrade later: drop Heebo-Bold.ttf / Assistant-Bold.ttf / Rubik-Bold.ttf
   into assets/fonts/ and update the preset entries — no other changes. */
const FONT_PRESETS = {
  luxury:           { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 800 },
  clean:            { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 800 },
  dark:             { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 900 },
  industrial:       { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 900 },
  playful:          { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 900 },
  food:             { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 800 },
  beauty:           { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 700 },
  tech:             { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 800 },
  "local-business": { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 800 },
  "app-ui":         { headline: "SFHebrew", body: "SFHebrew", cta: "ArialBold", weightHeadline: 800 },
};

/* Vector icon library — small line-art glyphs for the 3-pill row.
   24×24 viewBox so they scale cleanly into the SVG. NEVER use emoji
   here — KLIQ reference ads all use vector icons. */
const ICONS = {
  // Generic
  quality:   `<path d="M12 2l2.8 6 6.2.7-4.6 4.2 1.2 6.1L12 16l-5.6 3 1.2-6.1L3 8.7 9.2 8z"/>`,
  service:   `<circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/>`,
  custom:    `<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M14 6l3 3"/>`,
  shield:    `<path d="M12 2l7 4v6c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>`,
  calendar:  `<path d="M7 2v4M17 2v4M4 8h16M5 5h14v15H5z"/>`,
  flag:      `<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>`,
  diamond:   `<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20M6 3l6 18 6-18"/>`,
  star:      `<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/>`,
  // Pet
  paw:       `<circle cx="6" cy="11" r="2"/><circle cx="18" cy="11" r="2"/><circle cx="9" cy="6" r="1.8"/><circle cx="15" cy="6" r="1.8"/><path d="M7.5 17c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4-2 4-4.5 4-4.5-1.5-4.5-4z"/>`,
  heart:     `<path d="M12 21s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 11c0 5.5-7 10-7 10z"/>`,
  // Dental
  tooth:     `<path d="M7 4c2-1 4-1 5 0 1-1 3-1 5 0 2 1.5 2 4 1.5 6.5-.5 2.5-1 5-1.5 7-.5 1.5-2.5 2-3 0-.5-1.5-.5-3-1-3s-.5 1.5-1 3c-.5 2-2.5 1.5-3 0-.5-2-1-4.5-1.5-7C5 8 5 5.5 7 4z"/>`,
  // Bakery / food
  wheat:     `<path d="M12 22V8M12 8c-2-2-4-2-4 1 0 2 2 3 4 3M12 8c2-2 4-2 4 1 0 2-2 3-4 3M12 13c-2-2-4-2-4 1 0 2 2 3 4 3M12 13c2-2 4-2 4 1 0 2-2 3-4 3M12 18c-2-2-4-2-4 1M12 18c2-2 4-2 4 1"/>`,
  flower:    `<circle cx="12" cy="12" r="2"/><circle cx="12" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="12" r="2.5"/>`,
  // Sport / bike
  gear:      `<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>`,
  mountain:  `<path d="M3 20l5-8 3 4 2-3 5 7H3z"/><circle cx="17" cy="6" r="1.5"/>`,
  // Travel
  plane:     `<path d="M3 12l18-8-4 18-5-6-5 2z"/>`,
  suitcase:  `<rect x="4" y="8" width="16" height="12" rx="1"/><path d="M9 8V5h6v3"/>`,
  // Beauty
  sparkle:   `<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5zM18 14l.7 2L21 17l-2.3.5L18 20l-.7-2.5L15 17l2.5-.5z"/>`,
  brush:     `<path d="M7 14c-2 1-3 3-3 6 3 0 5-1 6-3M7 14l8-8c1-1 3-1 4 0s1 3 0 4l-8 8"/>`,
  // Tech
  bolt:      `<path d="M13 2L4 14h6l-2 8 9-12h-6l2-8z"/>`,
  // Fashion
  hanger:    `<path d="M12 2a2 2 0 100 4 2 2 0 000-4zM12 6v4l-9 7h18l-9-7z"/>`,
  dress:     `<path d="M9 4l-1 4-3 4 3 1v9h8v-9l3-1-3-4-1-4z"/>`,
  measure:   `<rect x="2" y="9" width="20" height="6" rx="1"/><path d="M6 9v3M10 9v3M14 9v3M18 9v3"/>`,
  factory:   `<path d="M3 21V9l6 4V9l6 4V5h6v16z"/><path d="M7 17h2M11 17h2M15 17h2"/>`,
  pergola:   `<path d="M3 20V8h18v12M5 8l7-5 7 5M7 11h10M7 14h10"/>`,
  headset:   `<path d="M4 14v-2a8 8 0 0116 0v2"/><path d="M4 14h4v6H4zM16 14h4v6h-4z"/>`,
  smile:     `<circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M8 14c1.5 2 4.5 2 6 0"/>`,
  // Service / logistics
  truck:     `<path d="M2 17V7h12v10M14 11h4l3 3v3h-7"/><circle cx="6" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/>`,
  clock:     `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  // Outdoor / sun-shade (relevant for pergolas, awnings, sun protection)
  sun:       `<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>`,
  umbrella:  `<path d="M3 12a9 9 0 0118 0H3z"/><path d="M12 12v7a2 2 0 01-4 0"/>`,
  leaf:      `<path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14z"/><path d="M5 19l8-8"/>`,
  home:      `<path d="M3 12l9-8 9 8v8H3z"/><path d="M9 20v-6h6v6"/>`,
  hammer:    `<path d="M14 7l5-3 1 2-4 3M14 7l-9 9 3 3 9-9M14 7l3 3"/>`,
  award:     `<circle cx="12" cy="9" r="6"/><path d="M9 14l-2 8 5-3 5 3-2-8"/>`,
};

/* The 5 panel shapes ship as raw SVG paths so designers can extend the
   set without touching renderer code. The matched imageClipPath crops
   the hero photo to fit the panel's complementary shape. */
const PANEL_SHAPES = {
  "curved-split-left-text": {
    panel: `M0 0 H555 C500 130 520 280 475 410 C425 555 500 735 430 1024 H0 Z`,
    image: `M510 0 H1024 V1024 H430 C500 735 425 555 475 410 C520 280 500 130 555 0 Z`,
  },
  "diagonal-left-panel": {
    panel: `M0 0 H560 L460 1024 H0 Z`,
    image: `M520 0 H1024 V1024 H460 Z`,
  },
  "soft-blob-left-panel": {
    panel: `M0 0 H535 C485 145 525 250 485 360 C445 490 510 640 455 790 C420 890 450 975 395 1024 H0 Z`,
    image: `M500 0 H1024 V1024 H415 C465 845 425 700 475 550 C520 410 470 250 530 0 Z`,
  },
  "arch-left-panel": {
    panel: `M0 0 H520 C450 130 455 260 500 390 C565 580 480 760 430 1024 H0 Z`,
    image: `M490 0 H1024 V1024 H430 C480 780 565 570 500 390 C455 260 450 130 520 0 Z`,
  },
  "bottom-heavy-editorial": {
    panel: `M0 680 H1024 V1024 H0 Z`,
    image: `M0 0 H1024 V680 H0 Z`,
  },
};

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getFontPreset(visualType = "clean") {
  return FONT_PRESETS[visualType] || FONT_PRESETS.clean;
}

/**
 * Split a Hebrew (or any) string into <= maxLines lines, each <= maxChars.
 * Greedy word-by-word. Critically, on overflow we DO NOT drop trailing
 * words — they accumulate onto the final line. The renderer would rather
 * a tight last line than lose the headline's accent word entirely.
 */
function splitLines(text = "", maxChars = 16, maxLines = 3) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = current ? `${current} ${word}` : word;
    /* When we're already on the LAST allowed line, never break — keep
       appending so trailing words don't vanish. fitHeadlineConfig is
       supposed to pick a maxChars wide enough that this is rare. */
    if (lines.length === maxLines - 1) {
      current = next;
      continue;
    }
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Pick a headline layout config (maxChars, maxLines, fontSize multiplier)
 * based on character count. Longer headlines get more lines AND a smaller
 * font so they still fit the panel without orphaning the accent word.
 */
function fitHeadlineConfig(text = "", baseFontSize = 72) {
  const length = String(text).replace(/\s+/g, " ").trim().length;
  if (length <= 22) return { maxChars: 16, maxLines: 3, fontSize: baseFontSize };
  if (length <= 34) return { maxChars: 17, maxLines: 4, fontSize: Math.round(baseFontSize * 0.92) };
  if (length <= 48) return { maxChars: 18, maxLines: 4, fontSize: Math.round(baseFontSize * 0.84) };
  return                     { maxChars: 20, maxLines: 5, fontSize: Math.round(baseFontSize * 0.76) };
}

/**
 * Evenly distribute N items across a usable horizontal range.
 * Returns the center-X coordinate for item `index`.
 */
function getFeaturePillX(index, count, panelLeftX, panelRightX) {
  const usableWidth = panelRightX - panelLeftX;
  const step = usableWidth / count;
  return panelLeftX + step * index + step / 2;
}

/**
 * Render multi-line RTL Hebrew with optional accent word highlight.
 * The accent word receives `accentColor` fill; rest stays in `fill`.
 */
function renderMultilineText({
  text, x, y, maxChars, maxLines, fontSize,
  lineHeight = 1.12, fill, fontFamily, fontWeight = 800,
  anchor = "end", accentWord = "", accentColor = null,
}) {
  const lines = splitLines(text, maxChars, maxLines);
  return lines.map((line, index) => {
    /* If the accent word appears in this line, split into 3 spans
       so we can color the accent span differently. */
    if (accentWord && accentColor && line.includes(accentWord)) {
      const before = line.split(accentWord)[0];
      const after  = line.split(accentWord).slice(1).join(accentWord);
      return `
        <text
          x="${x}"
          y="${y + index * fontSize * lineHeight}"
          direction="rtl"
          unicode-bidi="plaintext"
          text-anchor="${anchor}"
          font-family="${fontFamily}"
          font-size="${fontSize}"
          font-weight="${fontWeight}"
          fill="${fill}"
        ><tspan>${escapeXml(before)}</tspan><tspan fill="${accentColor}">${escapeXml(accentWord)}</tspan><tspan>${escapeXml(after)}</tspan></text>
      `;
    }
    return `
      <text
        x="${x}"
        y="${y + index * fontSize * lineHeight}"
        direction="rtl"
        unicode-bidi="plaintext"
        text-anchor="${anchor}"
        font-family="${fontFamily}"
        font-size="${fontSize}"
        font-weight="${fontWeight}"
        fill="${fill}"
      >${escapeXml(line)}</text>
    `;
  }).join("");
}

function renderIcon({ icon = "quality", x, y, size = 44, color = "#0F172A", strokeWidth = 2.4 }) {
  const paths = ICONS[icon] || ICONS.quality;
  /* Stroke width bumped from 1.9 → 2.4 — thinner strokes were getting
     lost against soft backgrounds. Round caps + joins keep the line-art
     feel premium, not technical. */
  return `
    <svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24">
      <g fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
        ${paths}
      </g>
    </svg>
  `;
}

function renderFeaturePills({ benefits = [], palette, fontPreset, panelLeftX, panelRightX, y }) {
  if (!benefits.length) return "";
  const safe = benefits.slice(0, 3);
  /* Icon + label use the AA-guaranteed text colors (iconColor + benefitText)
     so they're always readable on the soft background — not the raw brand
     primary that could be a near-white pastel. */
  const iconColor = palette.iconColor || palette.text || palette.primary;
  const labelColor = palette.benefitText || palette.text || palette.primary;
  return `
    <g>
      ${safe.map((b, i) => {
        const cx = getFeaturePillX(i, safe.length, panelLeftX, panelRightX);
        return `
          <g>
            <circle cx="${cx}" cy="${y + 28}" r="36" fill="${palette.panel}" stroke="${palette.secondary}" stroke-width="2.5"/>
            ${renderIcon({ icon: b.icon || "quality", x: cx - 22, y: y + 6, size: 44, color: iconColor })}
            <text
              x="${cx}"
              y="${y + 95}"
              direction="rtl"
              unicode-bidi="plaintext"
              text-anchor="middle"
              font-family="${fontPreset.body}"
              font-size="22"
              font-weight="800"
              fill="${labelColor}"
            >${escapeXml(b.title || "")}</text>
          </g>
        `;
      }).join("")}
    </g>
  `;
}

async function imageBufferToDataUri(buffer, format = "png") {
  return `data:image/${format};base64,${buffer.toString("base64")}`;
}

async function normalizeHero(heroBuffer, size = AD_SIZE) {
  return sharp(heroBuffer)
    .resize(size, size, { fit: "cover", position: "center" })
    .png()
    .toBuffer();
}

/* Logo prep — light alpha cleanup + resize to fit the brand panel header.
   Soft fail: returns null instead of throwing so renderAdLayout can ship
   the ad without a programmatic logo when the buffer is unrecoverable. */
async function normalizeLogo(logoBuffer, maxWidth = 230) {
  if (!logoBuffer) return null;
  try {
    return await sharp(logoBuffer)
      .trim({ background: "#ffffff", threshold: 18 })
      .resize({ width: maxWidth, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (err) {
    console.warn("[wow-ads:renderer] normalizeLogo failed:", err.message);
    return logoBuffer;
  }
}

/* Strip a near-white logo background to alpha — same logic as the legacy
   composite path but as a standalone helper the renderer can call. */
async function stripWhiteBackground(logoBuffer) {
  try {
    const { data, info } = await sharp(logoBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const out = Buffer.from(data);
    for (let i = 0; i < out.length; i += channels) {
      const r = out[i], g = out[i + 1], b = out[i + 2];
      const isNearWhite = r > 238 && g > 238 && b > 238;
      const isLowSat = Math.max(r, g, b) - Math.min(r, g, b) < 14;
      if (isNearWhite && isLowSat) out[i + 3] = 0;
    }
    return sharp(out, { raw: { width: info.width, height: info.height, channels } })
      .trim({ threshold: 8 })
      .png()
      .toBuffer();
  } catch {
    return logoBuffer;
  }
}

function buildSvg({
  heroDataUri, logoDataUri, ad, direction, palette, size = AD_SIZE,
}) {
  const visualType = direction?.visualType   || "clean";
  const layoutType = direction?.panelLayoutType || "curved-split-left-text";
  const fontPreset = getFontPreset(visualType);
  const headline = ad.headline || "";
  const description = ad.description || "";
  const cta = ad.cta || "דברו איתנו";
  const transliteration = direction?.hebrewTransliteration || "";
  const accentWord = direction?.headlineAccentWord || "";

  const shapes = PANEL_SHAPES[layoutType] || PANEL_SHAPES["curved-split-left-text"];

  const isBottomEditorial = layoutType === "bottom-heavy-editorial";

  /* Panel geometry derived from the layout type. The panel's right
     "inner edge" is where Hebrew RTL text right-aligns to. */
  const panelInnerEdge = isBottomEditorial ? 60 : 60;
  const panelRightEdge = isBottomEditorial ? size - 60 : 530;
  const textRightAnchor = panelRightEdge;

  const logoX = isBottomEditorial ? 60 : 60;
  const logoY = isBottomEditorial ? 720 : 60;
  const logoH = 100;

  /* Headline is fit-to-content: longer text auto-shrinks font and gets
     more allowed lines. Prevents the previous bug where "מאפים טריים
     שמתחילים את היום נכון" lost its accent word "נכון" because the
     line breaker silently dropped it. */
  const headlineY = isBottomEditorial ? 780 : 240;
  const headlineBase = isBottomEditorial ? 60 : 72;
  const headlineFit = fitHeadlineConfig(headline, headlineBase);
  const headlineSize = headlineFit.fontSize;
  const headlineMaxChars = headlineFit.maxChars;
  const headlineMaxLines = headlineFit.maxLines;

  const bodyY  = isBottomEditorial ? 870 : 470;
  const bodyMaxChars = isBottomEditorial ? 30 : 22;

  const ctaY   = isBottomEditorial ? 920 : 560;
  const ctaW   = 280;
  const ctaH   = 64;
  const ctaX   = panelRightEdge - ctaW;

  const pillsY = isBottomEditorial ? 80 : 740;
  const benefits = Array.isArray(direction?.featurePills) ? direction.featurePills : [];
  /* If featurePills are strings (legacy v1.0/v1.1 schema), upgrade
     them to {icon, title} on the fly so the renderer can draw icons. */
  const normalizedPills = benefits.map(b => {
    if (typeof b === "string") return { icon: "quality", title: b };
    return { icon: b.icon || "quality", title: b.title || b.label || "" };
  }).filter(b => b.title);

  /* Decorative motifs from the direction — small line-art shapes
     scattered around the brand panel in the accent color. We render
     them as faint background ornaments so they don't fight the
     headline for attention. */
  const decorations = Array.isArray(direction?.decorations) ? direction.decorations : [];

  return `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="imageClip"><path d="${shapes.image}" /></clipPath>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity="0.18"/>
    </filter>
    <linearGradient id="ctaGradient" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${palette.ctaBg}" />
      <stop offset="100%" stop-color="${palette.secondary}" />
    </linearGradient>
  </defs>

  <rect width="${size}" height="${size}" fill="${palette.background}" />

  <image href="${heroDataUri}" x="0" y="0" width="${size}" height="${size}"
         preserveAspectRatio="xMidYMid slice" clip-path="url(#imageClip)" />

  <path d="${shapes.panel}" fill="${palette.background}" opacity="0.96" />

  ${decorations.slice(0, 4).map((_, i) => {
    /* Decorative dots placed along the panel edge — generic enough that
       the prompt's IRON LAW #4 ("industry-specific decorations") is
       still satisfied by the model when it draws the hero. The renderer
       only adds these subtle echoes for premium feel. */
    const dx = 80 + (i % 2) * 360;
    const dy = 180 + Math.floor(i / 2) * 380;
    return `<circle cx="${dx}" cy="${dy}" r="3" fill="${palette.accent}" opacity="0.6"/>`;
  }).join("")}

  ${logoDataUri ? `<image href="${logoDataUri}" x="${logoX}" y="${logoY}" height="${logoH}"
                          preserveAspectRatio="xMinYMin meet"/>` : ""}

  ${transliteration ? `
    <text x="${textRightAnchor}" y="${logoY + logoH + 10}"
          direction="rtl" unicode-bidi="plaintext" text-anchor="end"
          font-family="${fontPreset.body}" font-size="22" font-weight="600"
          fill="${palette.textMuted || palette.mutedText || palette.text}">${escapeXml(transliteration)}</text>
  ` : ""}

  ${renderMultilineText({
    text: headline,
    x: textRightAnchor,
    y: headlineY,
    maxChars: headlineMaxChars,
    maxLines: headlineMaxLines,
    fontSize: headlineSize,
    lineHeight: 1.05,
    fill: palette.text || palette.primary,
    fontFamily: fontPreset.headline,
    fontWeight: fontPreset.weightHeadline,
    anchor: "end",
    accentWord,
    accentColor: palette.secondary,
  })}

  ${splitLines(description, bodyMaxChars, 2).map((line, i) => `
    <text x="${textRightAnchor}" y="${bodyY + i * 32}"
          direction="rtl" unicode-bidi="plaintext" text-anchor="end"
          font-family="${fontPreset.body}" font-size="24" font-weight="500"
          fill="${palette.textMuted || palette.mutedText || palette.text}">${escapeXml(line)}</text>
  `).join("")}

  <g filter="url(#softShadow)">
    <rect x="${ctaX}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="${ctaH / 2}"
          fill="url(#ctaGradient)" />
    <text x="${ctaX + ctaW / 2}" y="${ctaY + ctaH / 2 + 9}"
          direction="rtl" unicode-bidi="plaintext" text-anchor="middle"
          font-family="${fontPreset.cta}" font-size="26" font-weight="900"
          fill="${palette.ctaText}">${escapeXml(cta)}</text>
  </g>

  ${renderFeaturePills({
    benefits: normalizedPills,
    palette,
    fontPreset,
    panelLeftX: panelInnerEdge,
    panelRightX: panelRightEdge,
    y: pillsY,
  })}
</svg>
`;
}

/**
 * Main API. Returns { buffer: Buffer, svg: string, palette }.
 *
 * Throws when generatedImageBuffer is missing or resvg fails — caller
 * (pipeline) catches and falls back to shipping the raw hero image.
 */
async function renderAdLayout({
  generatedImageBuffer,
  logoBuffer = null,
  ad,
  direction = {},
  palette,
  size = AD_SIZE,
}) {
  if (!generatedImageBuffer) {
    throw new Error("renderAdLayout: generatedImageBuffer is required");
  }
  if (!palette) {
    throw new Error("renderAdLayout: palette is required");
  }

  const hero = await normalizeHero(generatedImageBuffer, size);

  let logo = null;
  if (logoBuffer) {
    try {
      const transparent = await stripWhiteBackground(logoBuffer);
      logo = await normalizeLogo(transparent);
    } catch {
      logo = await normalizeLogo(logoBuffer);
    }
  }

  const heroDataUri = await imageBufferToDataUri(hero, "png");
  const logoDataUri = logo ? await imageBufferToDataUri(logo, "png") : null;

  const svg = buildSvg({ heroDataUri, logoDataUri, ad, direction, palette, size });

  const resvg = new Resvg(svg, {
    fitTo:   { mode: "width", value: size },
    font:    { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: "Arial" },
    /* Disable shape rendering quality drop — Hebrew letters need crisp
       edges; we'd rather spend the few ms than ship blurry glyphs. */
    shapeRendering: 2,
    textRendering:  2,
    imageRendering: 0,
  });
  const pngBuffer = resvg.render().asPng();

  /* Re-encode through sharp for stable PNG headers + size in case resvg
     emits a non-standard chunk order. Quality 100 — file size is fine
     for FB/IG creative assets (~200-400kb each). */
  const finalBuffer = await sharp(pngBuffer).png({ quality: 100 }).toBuffer();

  return { buffer: finalBuffer, svg, palette, rendererVersion: RENDERER_VERSION };
}

module.exports = {
  renderAdLayout,
  PANEL_SHAPES,
  ICONS,
  FONT_PRESETS,
  RENDERER_VERSION,
};
