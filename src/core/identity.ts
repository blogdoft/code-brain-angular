import { sha256Prefixed } from './hashing.js';
import type { CiirKind } from './model.js';

const SEPARATOR = '|';

/**
 * Builds the canonical key hashed into a document id: `language|project|kind|canonicalName`.
 * This is the same rule the C# reference implementation (`Ciir.Core.Identity.CiirIdentity`)
 * uses, so ids are reproducible across generators.
 */
export function buildCanonicalKey(
  language: string,
  projectIdentity: string,
  kind: CiirKind,
  canonicalSymbolIdentity: string,
): string {
  return [language, projectIdentity, kind, canonicalSymbolIdentity].join(SEPARATOR);
}

/** Computes the deterministic `sha256:<hex>` id of a CIIR document. */
export function computeId(
  language: string,
  projectIdentity: string,
  kind: CiirKind,
  canonicalSymbolIdentity: string,
): string {
  return sha256Prefixed(buildCanonicalKey(language, projectIdentity, kind, canonicalSymbolIdentity));
}
