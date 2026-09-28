import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { AnalysisResult } from '../src/application/model.js';
import type { ProgressReporter } from '../src/application/ports.js';
import { composeHandler } from '../src/cli/composition.js';
import type { CiirDocument } from '../src/core/model.js';
import { SCHEMA_PATH } from '../src/serialization/file-artifact-writer.js';

export const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURE = join(REPOSITORY_ROOT, 'fixtures', 'basic-angular-app');

export const SILENT_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };
export const SILENT_PROGRESS: ProgressReporter = {
  projectsDiscovered() {},
  projectStarted() {},
  projectCompleted() {},
};

export function temporaryDirectory(prefix = 'code-brain-angular-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface AnalysisRun {
  result: AnalysisResult;
  outputDirectory: string;
  raw: string;
  documents: CiirDocument[];
}

export async function analyze(
  inputPath: string,
  options: { includeSource?: boolean; includeTests?: boolean; failOnError?: boolean } = {},
): Promise<AnalysisRun> {
  const outputDirectory = temporaryDirectory();
  const handler = composeHandler(
    { name: 'code-brain-angular', version: '0.0.0-test' },
    SILENT_LOGGER,
    SILENT_PROGRESS,
  );
  const result = await handler.handle(
    {
      inputPath,
      outputDirectory,
      includeSource: options.includeSource ?? false,
      includeTests: options.includeTests ?? false,
      failOnError: options.failOnError ?? false,
    },
    new AbortController().signal,
  );
  const raw = readFileSync(join(outputDirectory, 'ciir.jsonl'), 'utf8');
  const documents = raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as CiirDocument);
  return { result, outputDirectory, raw, documents };
}

export function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function schemaValidator(): (document: unknown) => string[] {
  // Ajv and ajv-formats are CommonJS; require() sidesteps their ESM default-export typings.
  const require = createRequire(import.meta.url);
  const { Ajv2020 } = require('ajv/dist/2020') as {
    Ajv2020: new (options: object) => { compile(schema: unknown): ValidateFunction };
  };
  const addFormats = require('ajv-formats') as (ajv: unknown) => void;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(readJson(SCHEMA_PATH));
  return (document) =>
    validate(document)
      ? []
      : (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath} ${error.message}`);
}

export function byQualifiedName(
  documents: CiirDocument[],
  qualifiedName: string,
  kind?: string,
): CiirDocument {
  const found = documents.find((d) => d.symbol.qualifiedName === qualifiedName && (!kind || d.kind === kind));
  if (!found) {
    throw new Error(`No document '${qualifiedName}'${kind ? ` (${kind})` : ''}.`);
  }
  return found;
}

export function angularOf(document: CiirDocument): Record<string, unknown> {
  return (document.extensions?.['angular'] ?? {}) as Record<string, unknown>;
}
