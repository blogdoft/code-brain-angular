/**
 * The CIIR model. These types mirror `schemas/ciir.schema.json` (schema 1.2) one-to-one; the
 * schema is the authoritative contract and every document this generator emits is validated
 * against it by the test suite.
 */

export const SCHEMA_VERSION = '1.2';

export type CiirKind =
  | 'project'
  | 'namespace'
  | 'type'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field'
  | 'event'
  | 'function'
  | 'file'
  | 'parameter'
  | 'database'
  | 'table'
  | 'column'
  | 'view'
  | 'procedure'
  | 'function_db'
  | 'trigger'
  | 'configuration'
  | 'configuration_key'
  | 'endpoint'
  | 'message';

export interface CiirSymbol {
  name: string;
  qualifiedName: string;
  canonicalName: string;
  container?: string;
}

export interface CiirRange {
  startLine: number;
  startColumn?: number;
  endLine: number;
  endColumn?: number;
}

export interface CiirSourceLocation {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  hash?: string;
  text?: string;
}

export type CiirDocumentationFormat =
  'xml-doc' | 'javadoc' | 'jsdoc' | 'tsdoc' | 'docstring' | 'markdown' | 'plain' | 'unknown';

export interface CiirDocumentation {
  format: CiirDocumentationFormat;
  source: 'declared' | 'unknown';
  summary?: string;
  remarks?: string;
  parameters?: { name: string; description: string }[];
  returns?: string;
  exceptions?: { type: string; description?: string }[];
}

export type CiirCommentKind = 'line' | 'block' | 'todo' | 'fixme' | 'warning' | 'note';

export interface CiirComment {
  kind: CiirCommentKind;
  text: string;
  location: CiirRange;
}

export type CiirRelationKind =
  | 'contains'
  | 'inherits'
  | 'implements'
  | 'overrides'
  | 'calls'
  | 'constructs'
  | 'reads'
  | 'writes'
  | 'throws'
  | 'catches';

export type CiirResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'external' | 'dynamic';

export type CiirResolutionOrigin =
  'project' | 'solution' | 'dependency' | 'framework' | 'runtime' | 'external_service' | 'unknown';

export interface CiirRelation {
  kind: CiirRelationKind;
  target: { id?: string; symbol: string };
  resolution: { status: CiirResolutionStatus; origin: CiirResolutionOrigin; reason?: string };
  location?: CiirRange;
}

export type CiirConditionKind =
  | 'if'
  | 'else_if'
  | 'switch'
  | 'switch_expression'
  | 'while'
  | 'do_while'
  | 'for'
  | 'foreach'
  | 'conditional_expression'
  | 'guard';

export interface CiirCondition {
  kind: CiirConditionKind;
  expression: string;
  location: CiirRange;
  reads?: string[];
}

export interface CiirControlFlow {
  basicBlockCount: number;
  cyclomaticComplexity: number;
  hasBranches: boolean;
  hasLoops: boolean;
}

export type CiirAccessibility =
  'unknown' | 'private' | 'private_protected' | 'protected' | 'internal' | 'protected_internal' | 'public';

export type CiirModifier =
  | 'const'
  | 'static'
  | 'readonly'
  | 'volatile'
  | 'extern'
  | 'virtual'
  | 'abstract'
  | 'sealed'
  | 'override'
  | 'unsafe'
  | 'partial'
  | 'required'
  | 'async';

export interface CiirParameter {
  name: string;
  type: string;
}

export type CiirTypeKind = 'class' | 'interface' | 'struct' | 'record' | 'enum' | 'delegate' | 'unknown';

export interface CiirTypeInfo {
  typeKind: CiirTypeKind;
  accessibility: CiirAccessibility;
  modifiers?: CiirModifier[];
  genericParameters?: string[];
}

export interface CiirMethodInfo {
  accessibility: CiirAccessibility;
  modifiers?: CiirModifier[];
  parameters?: CiirParameter[];
  returnType?: string;
  embeddingReturnType?: string;
}

export interface CiirPropertyInfo {
  accessibility: CiirAccessibility;
  modifiers?: CiirModifier[];
  type: string;
  hasGetter: boolean;
  hasSetter: boolean;
}

export interface CiirMemberInfo {
  accessibility: CiirAccessibility;
  modifiers?: CiirModifier[];
  type: string;
}

export type CiirConfigurationValueType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';

/** Language/framework-specific data that does not belong in the universal model. */
export type CiirExtensions = Record<string, Record<string, unknown>>;

/**
 * The root envelope of a single CIIR record: one statically observable entity, serialized as one
 * line of `ciir.jsonl`.
 */
export interface CiirDocument {
  schemaVersion: string;
  id: string;
  kind: CiirKind;
  language: string;
  project: string;
  symbol: CiirSymbol;
  source?: CiirSourceLocation;
  additionalSourceLocations?: CiirSourceLocation[];
  documentation?: CiirDocumentation;
  comments?: CiirComment[];
  relations?: CiirRelation[];
  conditions?: CiirCondition[];
  controlFlow?: CiirControlFlow;
  type?: CiirTypeInfo;
  method?: CiirMethodInfo;
  property?: CiirPropertyInfo;
  field?: CiirMemberInfo;
  event?: CiirMemberInfo;
  configurationKey?: { valueType: CiirConfigurationValueType };
  file?: { sizeBytes: number };
  embeddingText?: string;
  embeddingTextStrategy?: string;
  embeddingTextHash?: string;
  extensions?: CiirExtensions;
}

/**
 * The canonical property order of a serialized document (matches the C# generator, whose JSON
 * order follows its record declaration order).
 */
export const DOCUMENT_PROPERTY_ORDER: readonly (keyof CiirDocument)[] = [
  'schemaVersion',
  'id',
  'kind',
  'language',
  'project',
  'symbol',
  'source',
  'additionalSourceLocations',
  'documentation',
  'comments',
  'relations',
  'conditions',
  'controlFlow',
  'type',
  'method',
  'property',
  'field',
  'event',
  'configurationKey',
  'file',
  'embeddingText',
  'embeddingTextStrategy',
  'embeddingTextHash',
  'extensions',
];
