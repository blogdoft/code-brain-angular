import { sha256Prefixed } from './hashing.js';
import type { CiirComment, CiirCondition, CiirDocument, CiirRelation, CiirRelationKind } from './model.js';

/** The name of the deterministic generation strategy (shared with the C# generator). */
export const EMBEDDING_TEXT_STRATEGY = 'semantic-v1';

/**
 * Decides which facts are relevant enough to appear in `embeddingText`. The decision lives in
 * one testable place instead of scattered conditionals in the analyzer; filtered facts are still
 * kept in the document's `relations`/`comments`/`conditions`.
 */
export interface EmbeddingTextPolicy {
  shouldIncludeRelation(relation: CiirRelation): boolean;
  shouldIncludeComment(comment: CiirComment): boolean;
  shouldIncludeCondition(condition: CiirCondition): boolean;
  /**
   * Lines of the optional `Framework` section (placed right after `Container`), describing
   * framework-level facts such as an Angular component's selector. Empty when not applicable.
   */
  frameworkLines(document: CiirDocument): string[];
}

/** A policy that includes everything and adds no framework section. */
export const INCLUDE_ALL_POLICY: EmbeddingTextPolicy = {
  shouldIncludeRelation: () => true,
  shouldIncludeComment: () => true,
  shouldIncludeCondition: () => true,
  frameworkLines: () => [],
};

const RELATION_SECTIONS: readonly [CiirRelationKind, string][] = [
  ['reads', 'Reads'],
  ['writes', 'Writes'],
  ['calls', 'Calls'],
  ['constructs', 'Constructs'],
  ['throws', 'Throws'],
];

/**
 * Builds the `semantic-v1` projection: Entity, Qualified name, Container, [Framework],
 * Documentation, Remarks, Parameters, Returns, Comments, Reads, Writes, Calls, Constructs, Throws,
 * Conditions. Empty sections are omitted.
 */
export function buildEmbeddingText(document: CiirDocument, policy: EmbeddingTextPolicy): string {
  const lines = [`Entity: ${document.kind}`, `Qualified name: ${document.symbol.qualifiedName}`];

  if (document.symbol.container) {
    lines.push(`Container: ${document.symbol.container}`);
  }

  lines.push(...policy.frameworkLines(document));

  if (document.documentation?.summary) {
    lines.push(`Documentation: ${document.documentation.summary}`);
  }
  if (document.documentation?.remarks) {
    lines.push(`Remarks: ${document.documentation.remarks}`);
  }

  const parameters = document.method?.parameters ?? [];
  if (parameters.length > 0) {
    lines.push('Parameters:', ...parameters.map((parameter) => `- ${parameter.name}: ${parameter.type}`));
  }

  const returns = document.method?.embeddingReturnType ?? document.method?.returnType;
  if (returns) {
    lines.push(`Returns: ${returns}`);
  }

  appendList(
    lines,
    'Comments',
    (document.comments ?? []).filter((c) => policy.shouldIncludeComment(c)),
    (c) => c.text,
  );

  for (const [kind, label] of RELATION_SECTIONS) {
    const relevant = (document.relations ?? []).filter(
      (relation) => relation.kind === kind && policy.shouldIncludeRelation(relation),
    );
    appendList(lines, label, relevant, (relation) => relation.target.symbol);
  }

  appendList(
    lines,
    'Conditions',
    (document.conditions ?? []).filter((c) => policy.shouldIncludeCondition(c)),
    (c) => c.expression,
  );

  return lines.join('\n');
}

/** Returns a copy of `document` carrying `embeddingText`, its strategy and its hash. */
export function attachEmbeddingText(document: CiirDocument, policy: EmbeddingTextPolicy): CiirDocument {
  const embeddingText = buildEmbeddingText(document, policy);
  return {
    ...document,
    embeddingText,
    embeddingTextStrategy: EMBEDDING_TEXT_STRATEGY,
    embeddingTextHash: sha256Prefixed(embeddingText),
  };
}

function appendList<T>(lines: string[], label: string, items: T[], text: (item: T) => string): void {
  if (items.length === 0) {
    return;
  }
  lines.push(`${label}:`, ...items.map((item) => `- ${text(item)}`));
}
