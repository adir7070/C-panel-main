// OpenAI pricing per 1M tokens (USD) — update when pricing changes.
const RATES = {
  "gpt-4o":        { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":   { input: 0.15,  output: 0.60  },
  "gpt-4-turbo":   { input: 10.00, output: 30.00 },
};

/**
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} estimated cost in USD (rounded to 6 decimal places)
 */
function estimateCost(model, inputTokens, outputTokens) {
  const rates = RATES[model] ?? RATES["gpt-4o"];
  const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

module.exports = { estimateCost };
