const NUMERIC_VALUE_TOKEN_PATTERN = /^(?:[$\u20AC\u00A3\u00A5\u20B9]?\d[\d,]*(?:\.\d+)?(?:%|k|m|b|l|cr|hrs?|hours?|mins?|minutes?|days?|weeks?|months?|years?|yr|yrs|km|mi|miles?|kg|g|gb|tb|mb)?)$/i;
const NUMERIC_CUE_TOKEN_PATTERN = /^(?:under|within|around|about|approximately|approx|near|below|above|over|at|least|more|less|than|up|to|upto|from|between|budget|price|cost|per|for|only|just|exactly|max|min|minimum|maximum|adult|adults|child|children|kid|kids|person|people|seat|seats|item|items|day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|hr|hrs|mins|km|mi|mile|miles|kg|g|gb|tb|mb|rs|inr|usd|eur|gbp|jpy|percent)$/i;

function normalizeRefinementToken(token: string): string {
  return token
    .replace(/^[^a-z0-9$\u20AC\u00A3\u00A5\u20B9%]+/i, "")
    .replace(/[^a-z0-9$\u20AC\u00A3\u00A5\u20B9%]+$/i, "");
}

export function isShortNumericRefinement(userText: string): boolean {
  const normalized = userText.trim().toLowerCase();
  if (!normalized || normalized.length > 40 || !/\d/.test(normalized)) {
    return false;
  }

  const tokens = normalized
    .replace(/[\/_-]+/g, " ")
    .split(/\s+/)
    .map(normalizeRefinementToken)
    .filter(Boolean);

  if (tokens.length === 0 || tokens.length > 6) {
    return false;
  }

  let numericTokenCount = 0;

  for (const token of tokens) {
    if (NUMERIC_VALUE_TOKEN_PATTERN.test(token)) {
      numericTokenCount += 1;
      continue;
    }

    if (NUMERIC_CUE_TOKEN_PATTERN.test(token)) {
      continue;
    }

    return false;
  }

  return numericTokenCount >= 1;
}

export function getNumericRefinementInstruction(userText: string): string {
  if (!isShortNumericRefinement(userText)) {
    return "";
  }

  return "The latest user message is a short numeric refinement. Preserve every digit exactly as written and treat it as a refinement of the recent conversation instead of paraphrasing, rounding, or swapping in a nearby value.";
}
