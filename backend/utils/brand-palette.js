/**
 * brand-palette — single source of truth for converting a client's
 * `preferredColors` map into the palette string we pass to AI prompts
 * (logo / ads / organic-ads / LP).
 *
 * The map historically held 3 named slots (primary / secondary / accent)
 * and was hand-formatted at every callsite. We've since opened it up to
 * 3 additional slots (extra1 / extra2 / extra3) — every consumer should
 * use this helper instead of hand-rolling its own format string, so new
 * slots reach every AI pipeline without N more code edits.
 *
 * Empty / missing / blank values are skipped silently.
 */

const NAMED_ORDER = ["primary", "secondary", "accent"];
const EXTRA_KEYS  = ["extra1", "extra2", "extra3"];

function isHex(v) {
  return typeof v === "string" && /^#?[0-9A-Fa-f]{3,8}$/.test(v.trim()) && v.trim() !== "";
}

/**
 * Plain English-style: `primary=#X, secondary=#Y, accent=#Z, extra=#A, extra=#B`.
 * Used by wow-ads, wow-organic-ads, wow-lp prompts.
 *
 * @param {Record<string,string>} preferredColors
 * @param {object} [opts]
 * @param {{primary?:string,secondary?:string,accent?:string}} [opts.defaults]
 *   Fallbacks used if the matching named slot is empty. Extras have no defaults.
 * @returns {string} — empty string if nothing usable was provided AND no defaults.
 */
function formatBrandPalette(preferredColors, opts = {}) {
  const p = preferredColors || {};
  const d = opts.defaults || {};
  const parts = [];
  for (const key of NAMED_ORDER) {
    const v = isHex(p[key]) ? p[key] : (isHex(d[key]) ? d[key] : null);
    if (v) parts.push(`${key}=${v}`);
  }
  for (const key of EXTRA_KEYS) {
    if (isHex(p[key])) parts.push(`${key.replace("extra", "extra")}=${p[key]}`);
  }
  return parts.join(", ");
}

/**
 * Bare list of hex values in canonical order (primary → secondary → accent →
 * extra1 → extra2 → extra3), filtering out empties. Use this when the
 * consumer wants a `string[]` palette (e.g. the logo generator expanding
 * to 9 tones).
 */
function brandColorList(preferredColors) {
  const p = preferredColors || {};
  const out = [];
  for (const key of [...NAMED_ORDER, ...EXTRA_KEYS]) {
    if (isHex(p[key])) out.push(p[key]);
  }
  return out;
}

module.exports = { formatBrandPalette, brandColorList };
