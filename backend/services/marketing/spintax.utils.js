"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Spintax Regex Engine (Feature 30)
//
// Parses spintax templates and returns a unique random variation each call.
//
// Syntax:
//   {option1|option2|option3}  →  one of the options chosen at random
//   Nesting supported: {Hi|{Hey|Yo}} {there|{man|buddy}}
//
// Usage:
//   const { spintax, spintaxPreview } = require('./spintax.utils');
//   spintax("{שלום|היי} {לקוח יקר|חבר}")  →  "היי חבר"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a random integer in [0, max).
 * @param {number} max
 * @returns {number}
 */
function randomInt(max) {
  return Math.floor(Math.random() * max);
}

/**
 * Resolve one innermost `{a|b|c}` group — no nested braces inside.
 * @param {string} group  - Content between braces, e.g. "שלום|היי|hey"
 * @returns {string}      - One randomly chosen option
 */
function resolveGroup(group) {
  const options = group.split("|");
  if (options.length === 1) return options[0]; // No pipe — treat as literal
  return options[randomInt(options.length)];
}

/**
 * Resolve a spintax template string into one random variation.
 *
 * Algorithm: repeatedly find and replace the innermost `{...}` group
 * (guaranteed to contain no nested braces) until none remain.
 *
 * @param {string} template - e.g. "{שלום|היי} {שם}, מה {שלומך|נשמע}?"
 * @returns {string}        - Resolved variation, e.g. "היי שם, מה נשמע?"
 */
function spintax(template) {
  if (typeof template !== "string") return String(template);

  // Matches innermost { } — no braces allowed inside (prevents partial matches)
  const INNERMOST = /\{([^{}]*)\}/g;

  let result = template;
  let iterations = 0;
  const MAX_ITERATIONS = 500; // safety guard against malformed templates

  while (INNERMOST.test(result)) {
    if (++iterations > MAX_ITERATIONS) {
      console.warn("[Spintax] Max iterations reached — possible malformed template");
      break;
    }
    result = result.replace(INNERMOST, (_, group) => resolveGroup(group));
  }

  return result;
}

/**
 * Returns ALL possible variations of a spintax template (for preview/testing).
 * Warning: combinatorial explosion — use only on small templates.
 *
 * @param {string} template
 * @returns {string[]}  - Array of all possible resolved strings
 */
function spintaxPreview(template) {
  if (typeof template !== "string") return [String(template)];

  const INNERMOST = /\{([^{}]*)\}/;

  function expand(str) {
    const match = str.match(INNERMOST);
    if (!match) return [str];

    const [full, group] = match;
    const options = group.split("|");
    const results = [];

    for (const option of options) {
      const replaced = str.replace(full, option);
      results.push(...expand(replaced));
    }

    return results;
  }

  return [...new Set(expand(template))]; // dedupe identical variations
}

/**
 * Check if a string contains spintax syntax.
 * @param {string} text
 * @returns {boolean}
 */
function hasSpintax(text) {
  return typeof text === "string" && /\{[^{}]*\|[^{}]*\}/.test(text);
}

/**
 * Count the number of unique variations a spintax template can produce.
 * Uses multiplication of options per group (ignores nesting for speed).
 *
 * @param {string} template
 * @returns {number}
 */
function spintaxVariationCount(template) {
  if (!hasSpintax(template)) return 1;

  const INNERMOST = /\{([^{}]*)\}/g;
  let count = 1;
  let match;

  // Rough count (flattened — good enough for display purposes)
  const flat = template;
  const re = new RegExp(INNERMOST.source, "g");
  while ((match = re.exec(flat)) !== null) {
    const options = match[1].split("|");
    count *= options.length;
  }

  return count;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  spintax,
  spintaxPreview,
  hasSpintax,
  spintaxVariationCount,
};
