/**
 * WOW Ads — Brand palette extractor
 *
 * Pulls a renderer-ready palette from one of three sources, in order:
 *   1. brief.preferredColors (manager-supplied hex codes)
 *   2. sharp histogram of the logo PNG (dominant non-near-white colors)
 *   3. visualType preset (when there's no logo and no brand colors yet)
 *
 * Output shape exactly matches what wow-ads-layout-renderer.service.js
 * consumes — keys are flat so the renderer can read palette.primary
 * etc. without further mapping.
 *
 *   {
 *     background: "#F8FAFC",  // panel/canvas tint
 *     panel:      "#FFFFFF",  // brand panel surface
 *     primary:    "#0F172A",  // headline + dark text
 *     secondary:  "#84CC16",  // accent / cta gradient stop 2
 *     accent:     "#CBD5E1",  // dividers, soft strokes
 *     text:       "#0F172A",
 *     mutedText:  "#475569",
 *     ctaBg:      "#84CC16",
 *     ctaText:    "#FFFFFF",
 *     border:     "#E2E8F0",
 *   }
 *
 * Note: we tolerate logos with a baked-in white background — the histogram
 * step skips near-white and near-black bins so the dominant brand color
 * actually wins, not the white card the logo was uploaded with.
 */

const sharp = require("sharp");
const tinycolor = require("tinycolor2");

const VISUAL_TYPE_PRESETS = {
  luxury:     { primary: "#23324A", secondary: "#D19393", accent: "#D8C2A5", background: "#F7F2EA" },
  clean:      { primary: "#0F172A", secondary: "#0EA5E9", accent: "#CBD5E1", background: "#F8FAFC" },
  dark:       { primary: "#0B0F1A", secondary: "#84CC16", accent: "#475569", background: "#111827" },
  playful:    { primary: "#1D4ED8", secondary: "#F59E0B", accent: "#EF4444", background: "#FEF9C3" },
  industrial: { primary: "#0F172A", secondary: "#84CC16", accent: "#475569", background: "#F1F5F9" },
  food:       { primary: "#7C2D12", secondary: "#F59E0B", accent: "#FCA5A5", background: "#FFF7EC" },
  beauty:     { primary: "#831843", secondary: "#F472B6", accent: "#FDF2F8", background: "#FBF3F1" },
  tech:       { primary: "#1E293B", secondary: "#06B6D4", accent: "#A5B4FC", background: "#F8FAFC" },
  "local-business": { primary: "#1E3A8A", secondary: "#0EA5E9", accent: "#FBBF24", background: "#F8FAFC" },
  "app-ui":   { primary: "#111827", secondary: "#6366F1", accent: "#A5B4FC", background: "#F9FAFB" },
};

/**
 * Derive a soft branded background from a primary color WITHOUT letting
 * the result land on a muddy mid-tone. We HSL-clamp to high lightness
 * (>= 92%) and low saturation (<= 18%) so the background reads as a
 * neutral branded surface even when the primary is dark + saturated.
 *
 * Why the clamp: tinycolor's lighten+desaturate alone produced #D7B7AC
 * from a deep #7C2D12 primary — visually a mid-tone clay color, not a
 * cream background. Forcing the HSL ceiling fixes that without losing
 * the brand hue.
 */
function makeSoftBackground(primary, fallback = "#F8F4ED") {
  if (!primary) return fallback;
  try {
    const c = tinycolor(primary);
    if (!c.isValid()) return fallback;
    const hsl = c.toHsl();
    hsl.l = Math.max(hsl.l, 0.92);
    hsl.s = Math.min(hsl.s, 0.18);
    return tinycolor(hsl).toHexString().toUpperCase();
  } catch {
    return fallback;
  }
}

/**
 * Ensure foreground/background have at least AA contrast (4.5:1).
 *
 * Strategy: if the brand's chosen text color (e.g. primary or accent)
 * doesn't have AA contrast against the background, walk down the HSL
 * lightness curve in 5% steps (with saturation pinned high) until we
 * pass the threshold. Falls back to near-black after 12 steps so we
 * always return a readable color.
 *
 * Why this matters: the WOW Ads renderer paints headlines + body text
 * directly in code. A pale brand primary on a cream background made
 * "פסגת הצל" headlines almost invisible (real production case 2026-06-09).
 * Without this, every soft-brand client (bakery, beauty, kids) ships
 * unreadable text.
 */
function ensureReadableText(textColor, backgroundColor, minRatio = 4.5) {
  try {
    let fg = tinycolor(textColor);
    const bg = tinycolor(backgroundColor);
    if (!fg.isValid() || !bg.isValid()) return "#0F172A";
    /* Already readable? Take it as-is. */
    if (tinycolor.readability(fg, bg) >= minRatio) {
      return fg.toHexString().toUpperCase();
    }
    /* Walk lightness down step by step preserving hue. We keep the hue
       so the text still feels brand-colored — it just darkens enough
       to be readable on the soft background. */
    const hsl = fg.toHsl();
    for (let step = 0; step < 14; step++) {
      hsl.l = Math.max(0.04, hsl.l - 0.05);
      /* Boost saturation slightly as we darken so the color doesn't go
         flat gray. Cap at 0.78. */
      hsl.s = Math.min(0.78, hsl.s + 0.04);
      const candidate = tinycolor(hsl);
      if (tinycolor.readability(candidate, bg) >= minRatio) {
        return candidate.toHexString().toUpperCase();
      }
    }
    /* Last resort — near-black, guaranteed readable on any light bg. */
    return "#0F172A";
  } catch {
    return "#0F172A";
  }
}

function normalizeHex(input) {
  if (!input) return null;
  const c = tinycolor(input);
  return c.isValid() ? c.toHexString().toUpperCase() : null;
}

/**
 * Reject candidates that would make terrible "primary" colors.
 * - Too light (lightness > 82%) — would render invisible on a cream bg
 * - Too desaturated (saturation < 12%) — gray that doesn't read as a brand
 * - Insufficient contrast vs. pure white (< 2.5) — likely cream/beige/sand
 *
 * Returns true when the color is UNUSABLE as primary and we should fall
 * through to the next source (visualType preset or a known-dark default).
 */
function isBadPrimaryColor(hex) {
  if (!hex) return true;
  try {
    const c = tinycolor(hex);
    if (!c.isValid()) return true;
    const hsl = c.toHsl();
    if (hsl.l > 0.82) return true;
    if (hsl.s < 0.12) return true;
    if (tinycolor.readability(hex, "#FFFFFF") < 2.5) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Pick the dominant non-trivial color from a logo buffer.
 * Returns null when logo is null/missing or processing fails.
 */
async function dominantLogoColor(logoBuffer) {
  if (!logoBuffer) return null;
  try {
    /* Downsize first — full-res histogram is wasteful and noisy. 64×64 is
       enough to extract the dominant hue while still letting small mark
       details contribute. */
    const { data, info } = await sharp(logoBuffer)
      .resize(64, 64, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    /* Bucket colors into a coarse 32-step-per-channel histogram so noisy
       JPEG/PNG variation lands in the same bin. Skip transparent pixels
       and pixels too close to white/black/gray. */
    const buckets = new Map();
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const a = channels === 4 ? data[i + 3] : 255;
      if (a < 200) continue;
      /* skip near-white */
      if (r > 235 && g > 235 && b > 235) continue;
      /* skip near-black */
      if (r < 25 && g < 25 && b < 25) continue;
      /* skip near-gray (low saturation) */
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min < 18) continue;
      const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
      const existing = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
      existing.r += r; existing.g += g; existing.b += b; existing.n += 1;
      buckets.set(key, existing);
    }
    if (buckets.size === 0) return null;
    /* Top bucket by count, average its samples back to a single hex. */
    let top = null;
    for (const [, v] of buckets) {
      if (!top || v.n > top.n) top = v;
    }
    const hex = tinycolor({
      r: Math.round(top.r / top.n),
      g: Math.round(top.g / top.n),
      b: Math.round(top.b / top.n),
    }).toHexString().toUpperCase();
    return hex;
  } catch (err) {
    console.warn("[wow-ads:palette] dominantLogoColor failed:", err.message);
    return null;
  }
}

/**
 * Build a complete renderer-ready palette.
 * Inputs: brief.preferredColors (optional), logoBuffer (optional), visualType (optional).
 *
 * Every text-bearing field in the returned palette is run through
 * finalizePanelPalette() so it has at least AA contrast against the
 * background — prevents the "invisible white headline on cream" failure
 * seen on the פסגת הצל production session.
 */
async function buildPalette({ preferredColors = null, logoBuffer = null, visualType = "clean" } = {}) {
  const preset = VISUAL_TYPE_PRESETS[visualType] || VISUAL_TYPE_PRESETS.clean;

  /* Primary candidate sourcing — strictest first, fallthrough on reject.
     Critically: a candidate that's too light, too desaturated, or too
     close to white gets REJECTED (isBadPrimaryColor) instead of being
     used. Without this, a cream-background JPG logo would yield a cream
     primary → invisible text on a cream background. */
  let primary = normalizeHex(preferredColors?.primary);
  if (isBadPrimaryColor(primary)) {
    primary = await dominantLogoColor(logoBuffer);
  }
  if (isBadPrimaryColor(primary)) {
    primary = preset.primary;
  }
  if (isBadPrimaryColor(primary)) {
    /* Final fallback — guaranteed-dark navy. Better to lose brand color
       fidelity than ship an invisible-text ad. */
    primary = "#0F172A";
  }

  const secondary =
    normalizeHex(preferredColors?.secondary) ||
    preset.secondary;

  const accent =
    normalizeHex(preferredColors?.accent) ||
    preset.accent;

  /* Background priority:
       1. preferredColors.background (manager override)
       2. visualType preset (curated cream/blush/cool tones per industry)
       3. makeSoftBackground(primary) (HSL-clamped soft tint of primary) */
  const background =
    normalizeHex(preferredColors?.background) ||
    preset.background ||
    makeSoftBackground(primary);

  /* CTA color: prefer secondary if it has decent saturation/contrast on
     panel, else primary. Keeps the CTA from being washed out when the
     brand only supplied a single muted accent. */
  const secondaryC = tinycolor(secondary);
  const ctaBg = secondaryC.getBrightness() > 60 && secondaryC.toHsv().s > 0.35
    ? secondary
    : primary;

  /* CTA text: black or white depending on luminance of the button bg.
     tinycolor's mostReadable() returns the better of #FFF / #000. */
  const ctaText = tinycolor.mostReadable(ctaBg, ["#FFFFFF", "#0F172A"]).toHexString().toUpperCase();

  /* Muted text — primary, softened. Border — accent, softened. */
  const mutedTextRaw = tinycolor(primary).lighten(28).toHexString().toUpperCase();
  const border       = tinycolor(accent).lighten(10).toHexString().toUpperCase();

  /* AA-guarantee pass — every text-bearing field is validated against
     the panel surface and bumped to a readable derivative if needed.
     The renderer should now use palette.text / palette.textMuted /
     palette.iconColor / palette.benefitText (all guarded) instead of
     palette.primary directly. */
  const panel = background; /* renderer paints text onto the soft bg, not pure white */
  const text         = ensureReadableText(primary,       panel);
  const textMuted    = ensureReadableText(mutedTextRaw,  panel);
  const benefitText  = ensureReadableText(primary,       panel);
  const iconColor    = ensureReadableText(primary,       panel);
  const ctaTextSafe  = ensureReadableText(ctaText,       ctaBg);

  return {
    background,
    panel:     "#FFFFFF",
    primary,
    secondary,
    accent,
    /* AA-guarded text fields — renderer reads these, not the raw brand colors. */
    text,
    textMuted,
    benefitText,
    iconColor,
    /* Legacy aliases — old code may still read these names. */
    mutedText: textMuted,
    ctaBg,
    ctaText: ctaTextSafe,
    border,
  };
}

module.exports = {
  buildPalette,
  dominantLogoColor,
  makeSoftBackground,
  ensureReadableText,
  isBadPrimaryColor,
  VISUAL_TYPE_PRESETS,
};
