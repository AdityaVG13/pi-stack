// Catalog metadata cannot override transport, credentials or operation type.
export const CATALOG_FIELDS = ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap"];

export function modelMetadata(model) {
  return Object.fromEntries(CATALOG_FIELDS.flatMap(field => model[field] === undefined ? [] : [[field, model[field]]]));
}
