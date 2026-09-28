import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flatten } from '../../src/configuration/configuration-analyzer.js';
import { analyze, byQualifiedName, schemaValidator, temporaryDirectory } from '../helpers.js';

describe('flatten', () => {
  it('produces colon-separated key paths for every node, containers included', () => {
    expect(flatten({ a: { b: [true, null] }, c: 1 })).toEqual([
      ['a', 'object'],
      ['a:b', 'array'],
      ['a:b:0', 'boolean'],
      ['a:b:1', 'null'],
      ['c', 'number'],
    ]);
  });
});

describe('ConfigurationAnalyzer', () => {
  it('captures package.json keys without values, YAML as file metadata, all schema-valid', async () => {
    const root = temporaryDirectory();
    const secret = 'super-secret-token-value';
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', config: { apiKey: secret } }));
    writeFileSync(join(root, 'ci.yml'), 'on: push\n');
    writeFileSync(join(root, 'broken.yaml'), '::: not yaml, never parsed');

    const run = await analyze(root);
    expect(run.raw).not.toContain(secret);

    const key = byQualifiedName(run.documents, 'package.json:config:apiKey');
    expect(key).toMatchObject({
      kind: 'configuration_key',
      language: 'json',
      project: 'Configuration',
      symbol: { name: 'apiKey', canonicalName: 'package.json#config:apiKey', container: 'package.json' },
      configurationKey: { valueType: 'string' },
    });
    expect(byQualifiedName(run.documents, 'ci.yml')).toMatchObject({
      kind: 'file',
      language: 'yaml',
      file: { sizeBytes: 9 },
    });
    expect(byQualifiedName(run.documents, 'broken.yaml').kind).toBe('file');

    const validate = schemaValidator();
    expect(run.documents.flatMap((d) => validate(d))).toEqual([]);
  });

  it('records invalid JSON as a failure instead of aborting', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'angular.json'), '{ nope');
    const run = await analyze(root);
    expect(run.result.failures).toEqual([expect.objectContaining({ category: 'configuration' })]);
  });
});
