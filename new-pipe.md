בדיוק.
וזה ההבדל בין “לייצר תמונה יפה” לבין “לייצר מודעה ברמה של סטודיו”.

מה שאתה מתאר עכשיו הוא לא רק image generation.
זה כבר מערכת קומפוזיציה עיצובית:

חיתוך בין אזור תמונה לאזור טקסט
מיקום מדויק ללוגו
בחירת פונטים
גודל כותרת
מיקום כותרת
סלוגן
CTA
3 יתרונות עם אייקונים
צבעים מותאמים למותג

ופה מגיעה האמת החשובה:

כדי להגיע לרמה הזאת באופן עקבי, אל תיתן למודל לעשות הכל לבד

המודל מצוין ב:

אווירה
צילום
subject
לוק פרימיום
קומפוזיציה כללית
השראה עיצובית
רקעים
סצנות
שילוב בין אלמנטים

אבל הוא לא הכלי הכי אמין לדברים שצריכים דיוק קשיח כמו:

פונט קבוע
גודל כותרת קבוע
CTA בדיוק באותו מקום
שלושה אייקונים מיושרים
קו הפרדה מדויק
לוגו במקום קבוע
רדיוסים אחידים
spacing עקבי
היררכיה טיפוגרפית שחוזרת על עצמה

ה־Images API של OpenAI מיועד ליצירה ועריכה של תמונות, אבל אם אתה רוצה שליטה חזקה על branding, טקסט וקומפוזיציה, אתה צריך לשלב בין image generation לבין layout rendering בקוד.

הפתרון הנכון: Hybrid Pipeline

במקום:

Prompt → Image

תעבוד ככה:

Brief
→ Creative Direction
→ Image Generation (photo / subject / background)
→ Deterministic Layout Engine
→ Final Ad

כלומר:

המודל מייצר
בעלת העסק
החנות / המרפסת / המסעדה
אווירה
צבעים
טקסטורת רקע
קומפוזיציה כללית
אולי גם shape guidance
הקוד שלך מרנדר
לוגו
כותרת
תיאור
סלוגן
CTA
3 יתרונות
אייקונים
מסגרת
חלוקה בין אזור תמונה לאזור טקסט
שכבות overlay
גרדיאנטים
מסכות
spacing

וזה מה שייתן לך את אותה רמה שוב ושוב.

המשפט הכי חשוב בכל הסיפור

אם חשוב לך שהפונט, הכותרת, ה־CTA, האייקונים והלוגו יהיו מושלמים, אל תבקש מהמודל לצייר אותם. תבקש ממנו לבנות את הוויזואל, ואז תניח אותם אתה בקוד.

זה כל הסוד.

איך זה נראה בפועל
שלב 1: Director JSON

ה־Creative Director שלך צריך להחזיר לא רק visualType, אלא גם layout spec.

לדוגמה:

{
  "conceptName": "Elegant Boutique Split",
  "visualType": "luxury",
  "layoutType": "curved-split-right-photo-left-copy",
  "photoSide": "right",
  "textPanelSide": "left",
  "panelShape": "soft-curve",
  "logoPosition": {
    "x": 110,
    "y": 110,
    "align": "left"
  },
  "headlineStyle": {
    "fontFamily": "Cormorant Garamond",
    "fontWeight": 600,
    "fontSize": 84,
    "lineHeight": 1.08,
    "colorPrimary": "#23324A",
    "colorAccent": "#D19393"
  },
  "bodyStyle": {
    "fontFamily": "Assistant",
    "fontWeight": 400,
    "fontSize": 30,
    "color": "#334155"
  },
  "ctaStyle": {
    "text": "בואי לגלות",
    "fontFamily": "Heebo",
    "fontWeight": 700,
    "fontSize": 30,
    "bg": "#D19393",
    "color": "#FFFFFF",
    "radius": 18
  },
  "benefits": [
    { "icon": "dress", "title": "קולקציה חדשה" },
    { "icon": "measure", "title": "התאמה אישית" },
    { "icon": "hanger", "title": "מבחר לוקים" }
  ],
  "palette": {
    "bg": "#F7F2EE",
    "primary": "#23324A",
    "accent": "#D19393",
    "secondary": "#D8C2A5"
  }
}

כלומר, ה־director כבר מתאר לך עיצוב, לא רק רעיון.

שלב 2: המודל מייצר רק את הוויזואל

במקום לבקש:
“תיצור מודעה גמורה עם לוגו, CTA ואייקונים”

תבקש:

אישה / בעל עסק
רקע מותאם
קומפוזיציה עם מקום לטקסט
צד ימין או שמאל פנוי
תחושת מותג
פרספקטיבה טובה
חיתוך מתאים

למשל:

Create a premium commercial visual for a women's boutique ad.
Show a stylish female boutique owner standing in an elegant boutique.
Keep the composition right-heavy, leaving a clean bright area on the left side for text overlay.
Use soft pastel blush, cream, and muted blue tones.
Create a polished, photorealistic, premium fashion atmosphere.
Do not include large text, CTA buttons, or graphic icons in the generated image.
Leave clean negative space for later design composition.

זה קריטי.

כי עכשיו המודל לא “נאבק” גם בצילום, גם בטקסט, גם בכפתור, גם באייקונים, גם בלוגו.

שלב 3: בקוד שלך אתה בונה את המודעה

ופה מגיע הקסם האמיתי.

אני ממליץ לך לא להשתמש ב־canvas רגיל בלבד אם אתה רוצה רמה גבוהה.
עדיף לעבוד עם:

SVG composition
ואז render ל־PNG דרך resvg
או HTML/CSS rendering מבוקר
ובשביל שילוב תמונה להשתמש ב־sharp
למה SVG?

כי SVG נותן לך שליטה מדויקת על:

טיפוגרפיה
לוגו
כפתורים
אייקונים
עיגולים
גרדיאנטים
מסכות
קווים
alignment
RTL

וזה חד בטירוף.

הארכיטקטורה שאני ממליץ לך
A. Image Layer

המודל יוצר:

רקע
subject
חנות / משרד / עסק
scene
B. Layout Layer

אתה בונה ב־SVG:

panel shape
text blocks
logo
CTA
icons
dividers
decorative elements
C. Final Composite

אתה מחבר:

background image
overlays
text layer
logo layer
icon row
מה צריך להיות deterministic

כל הדברים האלה לא אמורים להיות באחריות המודל:

1. Logo placement

מיקום לוגו צריך להגיע מטמפלט.

לדוגמה:

top-left
top-center
top-right

עם padding קבוע:

{ x: 90, y: 80, maxWidth: 240 }
2. Headline sizing

הכותרת צריכה להיות לפי token system, למשל:

heroXL
heroL
titleM

ולא “whatever the model feels”.

3. Font family

תבחר 3 משפחות קבועות לכל העולם שלך:

Heebo – מודרני ונקי
Assistant – קריא ורך
Rubik – דיגיטלי ועגול
לעולמות יוקרה אפשר להוסיף Cormorant Garamond או Playfair Display לכותרות

ואז לכל visualType יש font pairing קבוע.

לדוגמה:

const typographyPresets = {
  luxury: {
    headline: "Cormorant Garamond",
    body: "Assistant",
    cta: "Heebo"
  },
  tech: {
    headline: "Rubik",
    body: "Assistant",
    cta: "Heebo"
  },
  industrial: {
    headline: "Heebo",
    body: "Assistant",
    cta: "Heebo"
  },
  playful: {
    headline: "Rubik",
    body: "Assistant",
    cta: "Rubik"
  }
};
4. CTA

ה־CTA חייב להיות component.

לא ציור חופשי של המודל.

הוא צריך לקבל:

טקסט
bg color
text color
radius
horizontal padding
vertical padding
shadow
5. Benefits row

שלושת היתרונות עם האייקונים צריכים להיות שורת components.

למשל:

icon circle
title
optional divider

אל תיתן למודל לצייר את שלושת האייקונים וליישר אותם.
תשתמש בספריית אייקונים:

Lucide
Phosphor
Heroicons
Tabler

ואז תבנה אותם בעצמך.

6. Colors

הצבעים צריכים להגיע ממערכת צבעים, לא “טעם” של המודל.

איך לבחור צבעים אוטומטית

הייתי בונה color engine כזה:

Input
לוגו
business type
visual type
Output
primary
secondary
accent
neutral background
CTA color
icon tint
text dark

לדוגמה:

{
  primary: "#23324A",
  secondary: "#D19393",
  accent: "#D8C2A5",
  background: "#F7F2EE",
  text: "#23324A",
  mutedText: "#475569",
  ctaBg: "#D19393",
  ctaText: "#FFFFFF"
}
איך להפיק?
לחלץ 2–3 צבעים מהלוגו
לנקות צבעים קיצוניים
לבחור neutral מותאם
להוסיף preset לפי קטגוריה

למשל:

beauty → blush, beige, white
food → red, orange, cream
tech → blue, cyan, white
industrial → navy, gray, lime/green accent
luxury → ivory, gold, deep navy
איך לעשות את החיתוך בין תמונה לאזור טקסט

זה בדיוק מה שראית במודעת LUMI.

זה לא קסם.
זה shape system.

תייצר כמה מסכות קבועות:

straight split
curved split
diagonal split
arc overlay
soft blob panel
half-ellipse panel

למשל:

const layoutShapes = {
  curvedRight: "M ...",
  diagonalLeft: "M ...",
  softArch: "M ..."
};

ואז אתה משתמש ב־SVG path.
התמונה נמצאת מאחורי השכבה, והטקסט יושב בפאנל הקדמי.

כלומר:

קודם background
מעליו mask/panel
מעליו logo/text/button/icons

זה מה שנותן תחושה של מודעה “מעוצבת”, לא תמונה עם טקסט זרוק.

מה אתה צריך לעשות בפועל במערכת שלך
במקום שהמודל יחזיר “מודעה גמורה”

תעבור למבנה כזה:

creativeDirection

מוסיף:

layoutType
panelShape
textBlockStyle
logoPosition
ctaPosition
benefitsStyle
fontPreset
colorStrategy
imageGenerator

מייצר:

hero image only
no heavy final typography
composition with negative space
layoutRenderer

מרנדר:

final branded ad
logo
copy
CTA
benefits
icons
split mask
decorative shapes
איך תדע שהגעת לרמה הזאת

כשתבדוק 10 מודעות, ותראה שבכולן:

החיתוך בין תמונה לטקסט נראה intentional
הלוגו תמיד יושב נכון
הכותרת תמיד היררכית
ה־CTA תמיד חד וברור
האייקונים תמיד מיושרים
הצבעים תמיד מרגישים מותגיים
אין תחושת “AI pasted elements”
והמודעה נראית כאילו מעצב בנה template חכם

אז הגעת.

לא כשיצאה תמונה יפה אחת.
אלא כשה־system שלך מייצר את זה שוב ושוב.

ההמלצה הכי פרקטית שלי

אם אתה רוצה את אותה רמה שיצרנו פה, תבנה עכשיו עוד שכבה אחת בלבד:

renderAdLayout()

פונקציה שמקבלת:

{
  generatedImage,
  logo,
  headline,
  body,
  cta,
  slogan,
  benefits,
  creativeDirection,
  palette
}

ומחזירה:

PNG final ad

אם תעשה רק את זה, תקפוץ ברמה בצורה ענקית.

מה אני הייתי משתמש בו ב־Node.js

הסטאק שהייתי בוחר:

sharp — לעיבוד תמונות
@resvg/resvg-js — לרנדר SVG ל־PNG
node-canvas רק אם ממש צריך
tinycolor2 או lib דומה לצבעים
lucide-static או אייקונים SVG
Google Fonts / local font files ברישוי מתאים אצלך בשרת
מבנה נכון
/services
  wow-ads-direction.service.js
  wow-ads-image.service.js
  wow-ads-palette.service.js
  wow-ads-layout-renderer.service.js
  wow-ads-review.service.js
אם אני מתמצת את כל התשובה למשפט אחד

כדי להגיע לרמה של המודעה ששלחת, תן ל־OpenAI לייצר את התמונה, ותן לקוד שלך לבנות את העיצוב.

זה בדיוק ההבדל בין:

“AI generated ad”
לבין
“AI-powered ad system”



מעולה. הנה שלד חזק ל־wow-ads-layout-renderer.service.js.

זה מיועד להשתלב מעל הפייפליין שלך: המודל מייצר תמונת hero נקייה, והקובץ הזה מרנדר עליה את הלוגו, הכותרת, CTA, שלושת היתרונות, מסכות, צבעים ושכבות העיצוב. זה מתאים בדיוק לשכבת ה־WOW Ads שלך שבה כל מודעה כבר נשמרת עם creativeDirection, nanoPrompt, imageUrl ו־QA metadata.

// services/wow-ads-layout-renderer.service.js

import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import path from "path";
import fs from "fs/promises";

/**
 * Dependencies:
 * npm i sharp @resvg/resvg-js
 *
 * Recommended:
 * - Keep Hebrew fonts locally on the server.
 * - Do not use system fonts blindly in production.
 * - Use licensed fonts only.
 */

const DEFAULT_SIZE = 1024;

const DEFAULT_PALETTE = {
  background: "#F8FAFC",
  panel: "#FFFFFF",
  primary: "#0F172A",
  secondary: "#84CC16",
  accent: "#CBD5E1",
  text: "#0F172A",
  mutedText: "#475569",
  ctaBg: "#84CC16",
  ctaText: "#FFFFFF",
  border: "#E2E8F0",
};

const FONT_PRESETS = {
  luxury: {
    headline: "Assistant",
    body: "Assistant",
    cta: "Assistant",
    weightHeadline: 800,
  },
  clean: {
    headline: "Assistant",
    body: "Assistant",
    cta: "Assistant",
    weightHeadline: 800,
  },
  industrial: {
    headline: "Assistant",
    body: "Assistant",
    cta: "Assistant",
    weightHeadline: 900,
  },
  playful: {
    headline: "Rubik",
    body: "Assistant",
    cta: "Rubik",
    weightHeadline: 900,
  },
  tech: {
    headline: "Rubik",
    body: "Assistant",
    cta: "Rubik",
    weightHeadline: 900,
  },
};

const ICONS = {
  quality: `<path d="M12 2l2.8 6 6.2.7-4.6 4.2 1.2 6.1L12 16l-5.6 3 1.2-6.1L3 8.7 9.2 8z"/>`,
  service: `<path d="M8 12h8M12 8v8"/><circle cx="12" cy="12" r="9"/>`,
  custom: `<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M14 6l3 3"/>`,
  shield: `<path d="M12 2l7 4v6c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>`,
  calendar: `<path d="M7 2v4M17 2v4M4 8h16M5 5h14v15H5z"/>`,
  factory: `<path d="M3 21V9l6 4V9l6 4V5h6v16z"/>`,
  flag: `<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>`,
  diamond: `<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20M6 3l6 18 6-18"/>`,
  pergola: `<path d="M3 20V8h18v12M5 8l7-5 7 5M7 11h10M7 14h10"/>`,
  headset: `<path d="M4 14v-2a8 8 0 0116 0v2"/><path d="M4 14h4v6H4zM16 14h4v6h-4z"/>`,
};

function escapeXml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mergePalette(palette = {}) {
  return {
    ...DEFAULT_PALETTE,
    ...palette,
  };
}

function getFontPreset(visualType = "clean") {
  return FONT_PRESETS[visualType] || FONT_PRESETS.clean;
}

/**
 * Simple Hebrew line breaker.
 * Keeps text clean and predictable.
 */
function splitHebrewLines(text = "", maxChars = 16, maxLines = 3) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;

    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }

    if (lines.length === maxLines - 1) break;
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines;
}

function renderMultilineText({
  text,
  x,
  y,
  maxChars,
  maxLines,
  fontSize,
  lineHeight = 1.12,
  fill,
  fontFamily,
  fontWeight = 800,
  anchor = "middle",
  accentColor,
}) {
  const lines = splitHebrewLines(text, maxChars, maxLines);

  return lines
    .map((line, index) => {
      const isAccent = index === lines.length - 1 && accentColor;
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
          fill="${isAccent ? accentColor : fill}"
        >${escapeXml(line)}</text>
      `;
    })
    .join("");
}

function renderIcon({ icon = "quality", x, y, size = 44, color = "#0F172A" }) {
  const paths = ICONS[icon] || ICONS.quality;

  return `
    <svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24">
      <g
        fill="none"
        stroke="${color}"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        ${paths}
      </g>
    </svg>
  `;
}

function renderBenefits({ benefits = [], palette, fontPreset, y = 820 }) {
  const safeBenefits = benefits.slice(0, 3);

  while (safeBenefits.length < 3) {
    safeBenefits.push({
      icon: "quality",
      title: ["איכות גבוהה", "שירות אישי", "התאמה מדויקת"][safeBenefits.length],
    });
  }

  const itemWidth = 250;
  const startX = 137;

  return `
    <g>
      ${safeBenefits
        .map((benefit, index) => {
          const cx = startX + index * itemWidth;
          const iconX = cx - 26;
          const iconY = y;

          return `
            <g>
              <circle
                cx="${cx}"
                cy="${y + 28}"
                r="42"
                fill="${palette.panel}"
                stroke="${palette.secondary}"
                stroke-width="3"
              />
              ${renderIcon({
                icon: benefit.icon || "quality",
                x: iconX,
                y: iconY + 2,
                size: 52,
                color: palette.primary,
              })}
              <text
                x="${cx}"
                y="${y + 105}"
                direction="rtl"
                unicode-bidi="plaintext"
                text-anchor="middle"
                font-family="${fontPreset.body}"
                font-size="28"
                font-weight="800"
                fill="${palette.primary}"
              >${escapeXml(benefit.title)}</text>
            </g>

            ${
              index < 2
                ? `<line
                    x1="${cx + 125}"
                    y1="${y + 8}"
                    x2="${cx + 125}"
                    y2="${y + 120}"
                    stroke="${palette.border}"
                    stroke-width="2"
                  />`
                : ""
            }
          `;
        })
        .join("")}
    </g>
  `;
}

function getPanelPath(layoutType = "curved-split-left-text") {
  switch (layoutType) {
    case "diagonal-left-panel":
      return `M0 0 H560 L460 1024 H0 Z`;

    case "soft-blob-left-panel":
      return `M0 0 H535 C485 145 525 250 485 360 C445 490 510 640 455 790 C420 890 450 975 395 1024 H0 Z`;

    case "arch-left-panel":
      return `M0 0 H520 C450 130 455 260 500 390 C565 580 480 760 430 1024 H0 Z`;

    case "bottom-heavy-editorial":
      return `M0 0 H1024 V1024 H0 Z`;

    case "curved-split-left-text":
    default:
      return `M0 0 H555 C500 130 520 280 475 410 C425 555 500 735 430 1024 H0 Z`;
  }
}

function getImageClipPath(layoutType = "curved-split-left-text") {
  switch (layoutType) {
    case "diagonal-left-panel":
      return `M520 0 H1024 V1024 H460 Z`;

    case "soft-blob-left-panel":
      return `M500 0 H1024 V1024 H415 C465 845 425 700 475 550 C520 410 470 250 530 0 Z`;

    case "arch-left-panel":
      return `M490 0 H1024 V1024 H430 C480 780 565 570 500 390 C455 260 450 130 520 0 Z`;

    case "bottom-heavy-editorial":
      return `M0 0 H1024 V680 H0 Z`;

    case "curved-split-left-text":
    default:
      return `M510 0 H1024 V1024 H430 C500 735 425 555 475 410 C520 280 500 130 555 0 Z`;
  }
}

async function imageBufferToDataUri(buffer) {
  const metadata = await sharp(buffer).metadata();
  const format = metadata.format || "png";
  return `data:image/${format};base64,${buffer.toString("base64")}`;
}

async function normalizeHeroImage(heroBuffer, size = DEFAULT_SIZE) {
  return sharp(heroBuffer)
    .resize(size, size, {
      fit: "cover",
      position: "center",
    })
    .png()
    .toBuffer();
}

async function normalizeLogo(logoBuffer, maxWidth = 230) {
  if (!logoBuffer) return null;

  return sharp(logoBuffer)
    .trim({ background: "#ffffff", threshold: 18 })
    .resize({
      width: maxWidth,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}

/**
 * Optional: stronger white-background removal.
 * Best practice is to run this before saving logo assets.
 */
export async function removeWhiteLogoBackground(logoBuffer) {
  return sharp(logoBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      const channels = info.channels;
      const out = Buffer.from(data);

      for (let i = 0; i < out.length; i += channels) {
        const r = out[i];
        const g = out[i + 1];
        const b = out[i + 2];

        const isNearWhite = r > 238 && g > 238 && b > 238;
        const isLowSaturation = Math.max(r, g, b) - Math.min(r, g, b) < 14;

        if (isNearWhite && isLowSaturation) {
          out[i + 3] = 0;
        }
      }

      return sharp(out, {
        raw: {
          width: info.width,
          height: info.height,
          channels,
        },
      })
        .trim({ threshold: 8 })
        .png()
        .toBuffer();
    });
}

function buildSvg({
  heroDataUri,
  logoDataUri,
  ad,
  creativeDirection = {},
  palette,
  size = DEFAULT_SIZE,
}) {
  const visualType = creativeDirection.visualType || "clean";
  const layoutType = creativeDirection.layoutType || "curved-split-left-text";
  const fontPreset = getFontPreset(visualType);

  const headline = ad.headline || "";
  const description = ad.description || "";
  const cta = ad.cta || "דברו איתנו";

  const panelPath = getPanelPath(layoutType);
  const imageClipPath = getImageClipPath(layoutType);

  const isBottomEditorial = layoutType === "bottom-heavy-editorial";

  const logoX = isBottomEditorial ? 64 : 78;
  const logoY = isBottomEditorial ? 700 : 70;

  const headlineX = isBottomEditorial ? 512 : 278;
  const headlineY = isBottomEditorial ? 755 : 245;
  const headlineSize = isBottomEditorial ? 64 : 66;

  const bodyX = isBottomEditorial ? 512 : 278;
  const bodyY = isBottomEditorial ? 875 : 500;

  const ctaX = isBottomEditorial ? 352 : 94;
  const ctaY = isBottomEditorial ? 915 : 610;
  const ctaW = isBottomEditorial ? 320 : 370;
  const ctaH = 74;

  const benefitsY = isBottomEditorial ? 80 : 780;

  const benefits = creativeDirection.featurePills?.length
    ? creativeDirection.featurePills
    : [
        { icon: "shield", title: "שירות אמין" },
        { icon: "custom", title: "התאמה אישית" },
        { icon: "quality", title: "איכות גבוהה" },
      ];

  return `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="imageClip">
      <path d="${imageClipPath}" />
    </clipPath>

    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#000000" flood-opacity="0.18"/>
    </filter>

    <linearGradient id="ctaGradient" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${palette.ctaBg}" />
      <stop offset="100%" stop-color="${palette.secondary}" />
    </linearGradient>

    <linearGradient id="panelGradient" x1="0" x2="1">
      <stop offset="0%" stop-color="${palette.panel}" stop-opacity="0.98" />
      <stop offset="100%" stop-color="${palette.panel}" stop-opacity="0.92" />
    </linearGradient>
  </defs>

  <rect width="1024" height="1024" fill="${palette.background}" />

  <image
    href="${heroDataUri}"
    x="0"
    y="0"
    width="1024"
    height="1024"
    preserveAspectRatio="xMidYMid slice"
    clip-path="url(#imageClip)"
  />

  <path d="${panelPath}" fill="url(#panelGradient)" />

  <path
    d="${panelPath}"
    fill="none"
    stroke="${palette.accent}"
    stroke-width="3"
    opacity="0.75"
  />

  ${
    logoDataUri
      ? `<image
          href="${logoDataUri}"
          x="${logoX}"
          y="${logoY}"
          width="245"
          height="120"
          preserveAspectRatio="xMinYMin meet"
        />`
      : ""
  }

  ${renderMultilineText({
    text: headline,
    x: headlineX,
    y: headlineY,
    maxChars: isBottomEditorial ? 22 : 12,
    maxLines: 3,
    fontSize: headlineSize,
    lineHeight: 1.08,
    fill: palette.primary,
    accentColor: palette.secondary,
    fontFamily: fontPreset.headline,
    fontWeight: fontPreset.weightHeadline,
    anchor: "middle",
  })}

  <text
    x="${bodyX}"
    y="${bodyY}"
    direction="rtl"
    unicode-bidi="plaintext"
    text-anchor="middle"
    font-family="${fontPreset.body}"
    font-size="${isBottomEditorial ? 31 : 30}"
    font-weight="600"
    fill="${palette.mutedText}"
  >
    ${escapeXml(splitHebrewLines(description, isBottomEditorial ? 34 : 22, 2)[0] || "")}
  </text>

  <text
    x="${bodyX}"
    y="${bodyY + 42}"
    direction="rtl"
    unicode-bidi="plaintext"
    text-anchor="middle"
    font-family="${fontPreset.body}"
    font-size="${isBottomEditorial ? 31 : 30}"
    font-weight="600"
    fill="${palette.mutedText}"
  >
    ${escapeXml(splitHebrewLines(description, isBottomEditorial ? 34 : 22, 2)[1] || "")}
  </text>

  <g filter="url(#softShadow)">
    <rect
      x="${ctaX}"
      y="${ctaY}"
      width="${ctaW}"
      height="${ctaH}"
      rx="20"
      fill="url(#ctaGradient)"
    />
    <text
      x="${ctaX + ctaW / 2}"
      y="${ctaY + 48}"
      direction="rtl"
      unicode-bidi="plaintext"
      text-anchor="middle"
      font-family="${fontPreset.cta}"
      font-size="32"
      font-weight="900"
      fill="${palette.ctaText}"
    >${escapeXml(cta)}</text>
  </g>

  ${
    isBottomEditorial
      ? renderBenefits({ benefits, palette, fontPreset, y: benefitsY })
      : renderBenefits({ benefits, palette, fontPreset, y: benefitsY })
  }

  <path
    d="M0 970 C220 930 395 1010 620 965 C770 935 870 955 1024 920 V1024 H0 Z"
    fill="${palette.primary}"
    opacity="0.08"
  />

  <rect
    x="12"
    y="12"
    width="1000"
    height="1000"
    fill="none"
    stroke="${palette.primary}"
    stroke-width="2"
    opacity="0.18"
  />
</svg>
`;
}

/**
 * Main API:
 * generatedImageBuffer = hero / background image from OpenAI
 * logoBuffer = original logo
 * ad = { headline, description, cta }
 * creativeDirection = direction JSON from Art Director
 * palette = calculated palette or colors from brief/logo
 */
export async function renderAdLayout({
  generatedImageBuffer,
  logoBuffer,
  ad,
  creativeDirection = {},
  palette = {},
  outputPath = null,
  size = DEFAULT_SIZE,
}) {
  if (!generatedImageBuffer) {
    throw new Error("renderAdLayout: generatedImageBuffer is required");
  }

  const finalPalette = mergePalette({
    ...palette,
    ...(creativeDirection.palette || {}),
  });

  const hero = await normalizeHeroImage(generatedImageBuffer, size);

  let logo = null;

  if (logoBuffer) {
    try {
      const transparent = await removeWhiteLogoBackground(logoBuffer);
      logo = await normalizeLogo(transparent);
    } catch {
      logo = await normalizeLogo(logoBuffer);
    }
  }

  const heroDataUri = await imageBufferToDataUri(hero);
  const logoDataUri = logo ? await imageBufferToDataUri(logo) : null;

  const svg = buildSvg({
    heroDataUri,
    logoDataUri,
    ad,
    creativeDirection,
    palette: finalPalette,
    size,
  });

  const pngBuffer = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: size,
    },
    font: {
      loadSystemFonts: true,
    },
  }).render().asPng();

  const finalBuffer = await sharp(pngBuffer)
    .png({ quality: 100 })
    .toBuffer();

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, finalBuffer);
  }

  return {
    buffer: finalBuffer,
    svg,
    palette: finalPalette,
  };
}

/**
 * Example usage:
 *
 * const result = await renderAdLayout({
 *   generatedImageBuffer: heroBufferFromOpenAI,
 *   logoBuffer,
 *   ad: {
 *     headline: "הסטייל שלך מתחיל כאן",
 *     description: "קולקציית קיץ חדשה, לוקים מדויקים ושירות אישי",
 *     cta: "בואי לגלות",
 *   },
 *   creativeDirection: {
 *     visualType: "luxury",
 *     layoutType: "curved-split-left-text",
 *     featurePills: [
 *       { icon: "quality", title: "קולקציה חדשה" },
 *       { icon: "custom", title: "התאמה אישית" },
 *       { icon: "service", title: "שירות אישי" },
 *     ],
 *     palette: {
 *       primary: "#23324A",
 *       secondary: "#D19393",
 *       accent: "#D8C2A5",
 *       panel: "#F7F2EE",
 *       ctaBg: "#D19393",
 *     },
 *   },
 *   outputPath: "output/ad-final.png",
 * });
 */
חיבור מהיר לפייפליין שלך

אחרי generateAdImageBuffer, במקום להעלות ישר את התמונה, תעשה:

const layoutResult = await renderAdLayout({
  generatedImageBuffer: rawImageBuffer,
  logoBuffer,
  ad,
  creativeDirection: ad.creativeDirection,
  palette: ad.creativeDirection?.palette || brief.palette || {},
});

const finalBuffer = layoutResult.buffer;

ואז את finalBuffer אתה מעביר ל־squareizePreservingText, ל־B2, ול־QA.

השלב הבא שכדאי להוסיף: לגרום ל־Creative Director להחזיר palette ו־featurePills בפורמט שמתאים בדיוק ל־renderer הזה.