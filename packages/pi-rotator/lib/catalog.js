// Catalog metadata cannot override transport, credentials or operation type.
export const CATALOG_FIELDS = ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap"];

function cleanText(value) {
  return value?.constructor === String && value.trim() ? value : undefined;
}

function cleanCount(value) {
  return Number.isFinite(value) ? value : undefined;
}

function cleanReasoning(value) {
  return value === true || value === false ? value : undefined;
}

function cleanInput(value) {
  return Array.isArray(value) && value.every(entry => entry?.constructor === String) ? value : undefined;
}

function cleanCost(value) {
  if (!value || value.constructor !== Object) return undefined;
  const entries = Object.entries(value).filter(([, amount]) => Number.isFinite(amount));

  return entries.length ? Object.fromEntries(entries) : undefined;
}

function cleanMap(value) {
  return value && value.constructor === Object ? value : undefined;
}

const FIELD_CLEANERS = { id: cleanText, name: cleanText, reasoning: cleanReasoning, input: cleanInput, cost: cleanCost, contextWindow: cleanCount, maxTokens: cleanCount, thinkingLevelMap: cleanMap };

// Saved catalogs are hand-editable JSON: malformed fields are dropped so one
// corrupt entry degrades to template defaults instead of breaking discovery
// or publishing garbage ids into the model picker.
export function modelMetadata(model) {
  if (!model || model.constructor !== Object) return {};

  return Object.fromEntries(CATALOG_FIELDS.flatMap(field => {
    const clean = FIELD_CLEANERS[field](model[field]);

    return clean === undefined ? [] : [[field, clean]];
  }));
}
