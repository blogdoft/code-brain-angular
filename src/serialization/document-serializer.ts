import { DOCUMENT_PROPERTY_ORDER, type CiirDocument } from '../core/model.js';

/**
 * Serializes one document as a single JSON line: canonical top-level property order, and
 * `undefined`/`null`/empty arrays/empty objects omitted everywhere (the schema declares every
 * array `minItems: 1`, so an empty one would be invalid, not just noisy).
 */
export function serializeDocument(document: CiirDocument): string {
  const ordered: Record<string, unknown> = {};
  for (const key of DOCUMENT_PROPERTY_ORDER) {
    const value = prune(document[key]);
    if (value !== undefined) {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered);
}

function prune(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(prune).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const pruned = prune(child);
      if (pruned !== undefined) {
        result[key] = pruned;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return value;
}
