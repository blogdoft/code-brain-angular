import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { attachEmbeddingText, INCLUDE_ALL_POLICY } from '../core/embedding-text.js';
import { sha256Prefixed } from '../core/hashing.js';
import { computeId } from '../core/identity.js';
import {
  SCHEMA_VERSION,
  type CiirConfigurationValueType,
  type CiirDocument,
  type CiirKind,
  type CiirSourceLocation,
} from '../core/model.js';
import { toPosixRelative, walkFiles } from '../application/file-walker.js';
import type { AnalysisContext, AnalyzerOutcome, CodeAnalyzer } from '../application/ports.js';

/** The fixed logical project of repository-wide configuration/file documents (same as the C# generator). */
export const CONFIGURATION_PROJECT = 'Configuration';

const JSON_CONFIGURATION_FILES = new Set(['package.json', 'angular.json']);
const YAML_FILE = /\.ya?ml$/i;

/**
 * Captures non-code artifacts anywhere under the analysis root: `package.json`/`angular.json` as
 * `configuration` + one `configuration_key` per flattened key path (values are NEVER captured,
 * only their JSON type), and `*.yaml`/`*.yml` as `file` metadata only.
 */
export class ConfigurationAnalyzer implements CodeAnalyzer {
  readonly name = CONFIGURATION_PROJECT;

  async analyze(context: AnalysisContext): Promise<AnalyzerOutcome> {
    const outcome: AnalyzerOutcome = { filesAnalyzed: 0, filesIgnored: 0, failures: [], warnings: [] };
    const files = walkFiles(
      context.rootDirectory,
      (name) => JSON_CONFIGURATION_FILES.has(name) || YAML_FILE.test(name),
    );

    for (const file of files) {
      context.signal.throwIfAborted();
      const relativePath = toPosixRelative(context.rootDirectory, file);
      const bytes = readFileSync(file);

      if (YAML_FILE.test(file)) {
        await context.emit(fileDocument(relativePath, bytes.length, sha256Prefixed(bytes)));
        outcome.filesAnalyzed++;
        continue;
      }

      const errors: ParseError[] = [];
      const content: unknown = parseJsonc(bytes.toString('utf8'), errors, { allowTrailingComma: true });
      if (errors.length > 0) {
        outcome.failures.push({
          project: CONFIGURATION_PROJECT,
          message: `'${relativePath}' is not valid JSON and was skipped.`,
          category: 'configuration',
        });
        continue;
      }

      await context.emit(configurationDocument(relativePath, sha256Prefixed(bytes)));
      for (const [keyPath, valueType] of flatten(content)) {
        await context.emit(configurationKeyDocument(relativePath, keyPath, valueType));
      }
      outcome.filesAnalyzed++;
    }

    return outcome;
  }
}

/** Flattens a JSON tree into `[colonSeparatedKeyPath, valueType]` pairs, containers included. */
export function flatten(value: unknown, prefix = ''): [string, CiirConfigurationValueType][] {
  const entries: [string, CiirConfigurationValueType][] = [];
  const children: [string, unknown][] = Array.isArray(value)
    ? value.map((child, index) => [String(index), child])
    : value !== null && typeof value === 'object'
      ? Object.entries(value)
      : [];

  for (const [key, child] of children) {
    const path = prefix ? `${prefix}:${key}` : key;
    entries.push([path, valueTypeOf(child)], ...flatten(child, path));
  }
  return entries;
}

function valueTypeOf(value: unknown): CiirConfigurationValueType {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

function fileLocation(relativePath: string, hash: string): CiirSourceLocation {
  return { path: relativePath, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, hash };
}

function baseDocument(
  kind: CiirKind,
  language: string,
  canonicalName: string,
): Pick<CiirDocument, 'schemaVersion' | 'id' | 'kind' | 'language' | 'project'> {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: computeId(language, CONFIGURATION_PROJECT, kind, canonicalName),
    kind,
    language,
    project: CONFIGURATION_PROJECT,
  };
}

function fileDocument(relativePath: string, sizeBytes: number, hash: string): CiirDocument {
  return attachEmbeddingText(
    {
      ...baseDocument('file', 'yaml', relativePath),
      symbol: { name: basename(relativePath), qualifiedName: relativePath, canonicalName: relativePath },
      source: fileLocation(relativePath, hash),
      file: { sizeBytes },
    },
    INCLUDE_ALL_POLICY,
  );
}

function configurationDocument(relativePath: string, hash: string): CiirDocument {
  return attachEmbeddingText(
    {
      ...baseDocument('configuration', 'json', relativePath),
      symbol: { name: basename(relativePath), qualifiedName: relativePath, canonicalName: relativePath },
      source: fileLocation(relativePath, hash),
    },
    INCLUDE_ALL_POLICY,
  );
}

function configurationKeyDocument(
  relativePath: string,
  keyPath: string,
  valueType: CiirConfigurationValueType,
): CiirDocument {
  const canonicalName = `${relativePath}#${keyPath}`;
  return attachEmbeddingText(
    {
      ...baseDocument('configuration_key', 'json', canonicalName),
      symbol: {
        name: keyPath.slice(keyPath.lastIndexOf(':') + 1),
        qualifiedName: `${relativePath}:${keyPath}`,
        canonicalName,
        container: relativePath,
      },
      configurationKey: { valueType },
    },
    INCLUDE_ALL_POLICY,
  );
}
