/**
 * ad-languages.service.js — the single source of truth for multi-language ad
 * generation across BOTH pipelines (paid: wow-ads, organic: wow-organic-ads).
 *
 * The client's ad language lives on business_profiles.language (a 2-letter
 * code). When it's missing everything defaults to Hebrew, so existing clients'
 * ads are byte-for-byte unchanged — multi-language is strictly additive.
 *
 * Adding a language = one entry in LANGUAGES below. The two directive helpers
 * (copyLanguageDirective / imageTextDirective) return the EXACT legacy Hebrew
 * instruction for "he" and a native-language instruction otherwise, so callers
 * just swap their hardcoded "בעברית בלבד" line for a helper call.
 */

const DEFAULT_LANG = "he";

const LANGUAGES = {
  he: { code: "he", name: "Hebrew",     native: "עברית",      dir: "rtl", script: "Hebrew",   transliterate: true  },
  en: { code: "en", name: "English",    native: "English",    dir: "ltr", script: "Latin",    transliterate: false },
  ar: { code: "ar", name: "Arabic",     native: "العربية",    dir: "rtl", script: "Arabic",   transliterate: false },
  ru: { code: "ru", name: "Russian",    native: "Русский",    dir: "ltr", script: "Cyrillic", transliterate: false },
  fr: { code: "fr", name: "French",     native: "Français",   dir: "ltr", script: "Latin",    transliterate: false },
  es: { code: "es", name: "Spanish",    native: "Español",    dir: "ltr", script: "Latin",    transliterate: false },
  de: { code: "de", name: "German",     native: "Deutsch",    dir: "ltr", script: "Latin",    transliterate: false },
  pt: { code: "pt", name: "Portuguese", native: "Português",  dir: "ltr", script: "Latin",    transliterate: false },
  it: { code: "it", name: "Italian",    native: "Italiano",   dir: "ltr", script: "Latin",    transliterate: false },
  uk: { code: "uk", name: "Ukrainian",  native: "Українська", dir: "ltr", script: "Cyrillic", transliterate: false },
};

/** Resolve a language code → its config, falling back to Hebrew for unknown/empty. */
function getLang(code) {
  return LANGUAGES[String(code || "").toLowerCase().trim()] || LANGUAGES[DEFAULT_LANG];
}

function isRTL(code)   { return getLang(code).dir === "rtl"; }
function isHebrew(code){ return getLang(code).code === "he"; }

/** List for UI dropdowns: [{ code, name, native, dir }]. */
function listLanguages() {
  return Object.values(LANGUAGES).map(({ code, name, native, dir }) => ({ code, name, native, dir }));
}

/**
 * Instruction for the COPY-generation prompts (headline/description/CTA).
 * "he" returns the legacy Hebrew line verbatim (behaviour unchanged).
 */
function copyLanguageDirective(code) {
  const L = getLang(code);
  if (L.code === "he") return "כתוב בעברית בלבד.";
  return `Write ALL ad copy in ${L.name} (${L.native}) only — natural, fluent, native ${L.name} as a local ${L.name}-speaking copywriter would write. Do NOT use Hebrew or any other language. Keep it punchy and idiomatic for a native ${L.name} audience.`;
}

/**
 * Instruction for the ON-IMAGE text-rendering prompts (what the image model
 * must paint). "he" returns the legacy Hebrew RTL directive verbatim.
 */
function imageTextDirective(code) {
  const L = getLang(code);
  if (L.code === "he") {
    return "All copy is in HEBREW (right-to-left). Render every Hebrew glyph exactly and legibly with a clean, modern Hebrew sans-serif (Heebo / Assistant / Rubik). Maintain proper RTL flow — NEVER render Hebrew text flowing left-to-right — right-aligned to the panel's inner edge.";
  }
  const flow  = L.dir === "rtl" ? "right-to-left (RTL)" : "left-to-right (LTR)";
  const align = L.dir === "rtl" ? "right-aligned" : "left-aligned";
  return `All copy is in ${L.name} (${L.script} script, written ${flow}). Render every ${L.name} character exactly, correctly and legibly with a clean, modern sans-serif that fully supports the ${L.script} script. Text flows ${flow} and is ${align}. Do NOT render any Hebrew text anywhere in the image.`;
}

/** Short label for a prompt header, e.g. "בעברית" / "in English". */
function inLanguagePhrase(code) {
  const L = getLang(code);
  return L.code === "he" ? "בעברית" : `in ${L.name}`;
}

module.exports = {
  LANGUAGES, DEFAULT_LANG,
  getLang, isRTL, isHebrew, listLanguages,
  copyLanguageDirective, imageTextDirective, inLanguagePhrase,
};
