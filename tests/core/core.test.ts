import { describe, expect, it } from 'vitest';
import {
  attachEmbeddingText,
  buildEmbeddingText,
  INCLUDE_ALL_POLICY,
} from '../../src/core/embedding-text.js';
import { sha256Prefixed } from '../../src/core/hashing.js';
import { buildCanonicalKey, computeId } from '../../src/core/identity.js';
import type { CiirDocument } from '../../src/core/model.js';
import { sortModifiers } from '../../src/core/modifier-order.js';

describe('identity', () => {
  it('uses the language|project|kind|canonicalName key shared with the C# generator', () => {
    expect(buildCanonicalKey('typescript', 'app', 'method', 'src/a#A.b(string)')).toBe(
      'typescript|app|method|src/a#A.b(string)',
    );
  });

  it('is deterministic and prefixed', () => {
    const id = computeId('typescript', 'app', 'type', 'src/a#A');
    expect(id).toBe(computeId('typescript', 'app', 'type', 'src/a#A'));
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('distinguishes overloads, kinds and projects', () => {
    const ids = new Set([
      computeId('typescript', 'app', 'method', 'src/a#A.b(string)'),
      computeId('typescript', 'app', 'method', 'src/a#A.b(number)'),
      computeId('typescript', 'app', 'field', 'src/a#A.b(string)'),
      computeId('typescript', 'lib', 'method', 'src/a#A.b(string)'),
    ]);
    expect(ids.size).toBe(4);
  });

  it('hashes the UTF-8 bytes (known SHA-256 vector)', () => {
    expect(sha256Prefixed('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('sortModifiers', () => {
  it('uses the canonical order regardless of declaration order and removes duplicates', () => {
    expect(sortModifiers(['async', 'static', 'readonly', 'static', 'override'])).toEqual([
      'static',
      'readonly',
      'override',
      'async',
    ]);
  });
});

describe('embeddingText (semantic-v1)', () => {
  const document: CiirDocument = {
    schemaVersion: '1.2',
    id: 'sha256:0',
    kind: 'method',
    language: 'typescript',
    project: 'app',
    symbol: {
      name: 'pay',
      qualifiedName: 'src/o#O.pay',
      canonicalName: 'src/o#O.pay(Order)',
      container: 'src/o#O',
    },
    documentation: { format: 'tsdoc', source: 'declared', summary: 'Pays an order.' },
    method: {
      accessibility: 'public',
      parameters: [{ name: 'order', type: 'Order' }],
      returnType: 'Promise<Order>',
      embeddingReturnType: 'Order',
    },
    comments: [{ kind: 'todo', text: 'TODO: retry', location: { startLine: 1, endLine: 1 } }],
    relations: [
      {
        kind: 'calls',
        target: { symbol: 'src/h#H.post()' },
        resolution: { status: 'resolved', origin: 'project' },
      },
      {
        kind: 'reads',
        target: { symbol: 'src/o#Order.total' },
        resolution: { status: 'resolved', origin: 'project' },
      },
      {
        kind: 'throws',
        target: { symbol: 'src/e#InvalidOrderError' },
        resolution: { status: 'resolved', origin: 'project' },
      },
    ],
    conditions: [{ kind: 'guard', expression: 'order.total <= 0', location: { startLine: 2, endLine: 2 } }],
  };

  it('follows the fixed section order and omits empty sections', () => {
    expect(buildEmbeddingText(document, INCLUDE_ALL_POLICY)).toBe(
      [
        'Entity: method',
        'Qualified name: src/o#O.pay',
        'Container: src/o#O',
        'Documentation: Pays an order.',
        'Parameters:',
        '- order: Order',
        'Returns: Order',
        'Comments:',
        '- TODO: retry',
        'Reads:',
        '- src/o#Order.total',
        'Calls:',
        '- src/h#H.post()',
        'Throws:',
        '- src/e#InvalidOrderError',
        'Conditions:',
        '- order.total <= 0',
      ].join('\n'),
    );
  });

  it('places framework lines right after the container', () => {
    const text = buildEmbeddingText(document, {
      ...INCLUDE_ALL_POLICY,
      frameworkLines: () => ['Framework: Angular service'],
    });
    expect(text.split('\n').slice(2, 4)).toEqual(['Container: src/o#O', 'Framework: Angular service']);
  });

  it('attaches the strategy and the hash of the exact text', () => {
    const attached = attachEmbeddingText(document, INCLUDE_ALL_POLICY);
    expect(attached.embeddingTextStrategy).toBe('semantic-v1');
    expect(attached.embeddingTextHash).toBe(sha256Prefixed(attached.embeddingText!));
  });
});
