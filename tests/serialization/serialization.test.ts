import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Prefixed } from '../../src/core/hashing.js';
import type { CiirDocument } from '../../src/core/model.js';
import { serializeDocument } from '../../src/serialization/document-serializer.js';
import { FileArtifactWriter, SCHEMA_PATH } from '../../src/serialization/file-artifact-writer.js';
import { JsonlCiirWriter } from '../../src/serialization/jsonl-ciir-writer.js';
import { temporaryDirectory } from '../helpers.js';

const document = {
  embeddingText: 'Entity: type',
  symbol: { name: 'A', qualifiedName: 'a#A', canonicalName: 'a#A', container: undefined },
  kind: 'type',
  id: 'sha256:1',
  schemaVersion: '1.2',
  language: 'typescript',
  project: 'p',
  relations: [],
  comments: undefined,
  type: { typeKind: 'class', accessibility: 'public', modifiers: [] },
  extensions: { angular: { inputs: [], template: { usedPipes: [] } } },
} as unknown as CiirDocument;

describe('serializeDocument', () => {
  it('uses the canonical property order and omits empty/undefined values everywhere', () => {
    expect(serializeDocument(document)).toBe(
      '{"schemaVersion":"1.2","id":"sha256:1","kind":"type","language":"typescript","project":"p",' +
        '"symbol":{"name":"A","qualifiedName":"a#A","canonicalName":"a#A"},' +
        '"type":{"typeKind":"class","accessibility":"public"},"embeddingText":"Entity: type"}',
    );
  });
});

describe('JsonlCiirWriter', () => {
  it('writes one document per line and reports the count and the hash of the bytes', async () => {
    const directory = temporaryDirectory();
    const session = await new JsonlCiirWriter().open(directory);
    await session.write(document);
    await session.write(document);
    const written = await session.close();

    const content = readFileSync(join(directory, 'ciir.jsonl'), 'utf8');
    expect(content.split('\n')).toHaveLength(3);
    expect(written).toEqual({ path: 'ciir.jsonl', records: 2, sha256: sha256Prefixed(content) });
  });
});

describe('FileArtifactWriter', () => {
  it('copies the contract schema verbatim', async () => {
    const directory = temporaryDirectory();
    const written = await new FileArtifactWriter().writeSchema(directory);
    expect(readFileSync(join(directory, 'ciir.schema.json'), 'utf8')).toBe(readFileSync(SCHEMA_PATH, 'utf8'));
    expect(written.sha256).toBe(sha256Prefixed(readFileSync(SCHEMA_PATH)));
  });
});
