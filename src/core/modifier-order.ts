import type { CiirModifier } from './model.js';

/** The single canonical modifier order (identical to the C# generator's `CiirModifierOrder`). */
export const CANONICAL_MODIFIER_ORDER: readonly CiirModifier[] = [
  'const',
  'static',
  'readonly',
  'volatile',
  'extern',
  'virtual',
  'abstract',
  'sealed',
  'override',
  'unsafe',
  'partial',
  'required',
  'async',
];

/** Deduplicates and sorts modifiers into canonical order, regardless of declaration order. */
export function sortModifiers(modifiers: Iterable<CiirModifier>): CiirModifier[] {
  const present = new Set(modifiers);
  return CANONICAL_MODIFIER_ORDER.filter((modifier) => present.has(modifier));
}
