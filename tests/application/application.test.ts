import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnalyzeInputHandler } from '../../src/application/analyze-input-handler.js';
import { resolveInput } from '../../src/application/input-resolver.js';
import { ExitCode } from '../../src/application/model.js';
import type { CiirWriterSession, CodeAnalyzer } from '../../src/application/ports.js';
import { UploadError } from '../../src/application/ports.js';
import { discoverProjects } from '../../src/application/project-discovery.js';
import type { CiirDocument } from '../../src/core/model.js';
import { FIXTURE, REPOSITORY_ROOT, SILENT_LOGGER, SILENT_PROGRESS, temporaryDirectory } from '../helpers.js';

function write(path: string, content = '{}'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('resolveInput', () => {
  it('recognizes workspaces, project files and directories', () => {
    expect(resolveInput(join(FIXTURE, 'angular.json'))).toMatchObject({
      ok: true,
      input: { type: 'workspace' },
    });
    expect(resolveInput(join(FIXTURE, 'tsconfig.app.json'))).toMatchObject({
      ok: true,
      input: { type: 'project' },
    });
    expect(resolveInput(join(FIXTURE, 'package.json'))).toMatchObject({
      ok: true,
      input: { type: 'project' },
    });
    expect(resolveInput(FIXTURE)).toMatchObject({ ok: true, input: { type: 'directory' } });
  });

  it('rejects missing and unsupported paths', () => {
    expect(resolveInput(join(FIXTURE, 'nope'))).toMatchObject({ ok: false });
    expect(resolveInput(join(FIXTURE, 'deploy.yaml'))).toMatchObject({ ok: false });
  });
});

describe('discoverProjects', () => {
  it('reads every project of an angular.json with its source root and tsconfig', () => {
    const { projects } = discoverProjects({ type: 'workspace', path: join(FIXTURE, 'angular.json') });
    expect(projects.map((p) => [p.name, p.kind])).toEqual([
      ['demo-app', 'angular'],
      ['shared-lib', 'angular'],
    ]);
    expect(projects[0]!.sourceRoot).toBe(join(FIXTURE, 'src'));
    expect(projects[0]!.configFile).toBe(join(FIXTURE, 'tsconfig.app.json'));
    expect(projects[1]!.configFile).toBe(join(FIXTURE, 'projects/shared-lib/tsconfig.lib.json'));
  });

  it('lets an Angular workspace claim its tree, so nested package.json files are not separate projects', () => {
    const { projects } = discoverProjects({ type: 'directory', path: join(REPOSITORY_ROOT, 'fixtures') });
    expect(projects.map((p) => p.name).sort()).toEqual(['demo-app', 'shared-lib']);
  });

  it('treats package.json + tsconfig.json in one directory as a single project and excludes nested projects', () => {
    const root = temporaryDirectory();
    write(join(root, 'package.json'), '{"name":"monorepo"}');
    write(join(root, 'tsconfig.json'));
    write(join(root, 'packages/api/package.json'), '{"name":"@acme/api"}');
    write(join(root, 'node_modules/dep/package.json'), '{"name":"dep"}');

    const { projects } = discoverProjects({ type: 'directory', path: root });
    expect(projects.map((p) => [p.name, p.kind])).toEqual([
      ['@acme/api', 'javascript'],
      ['monorepo', 'typescript'],
    ]);
    expect(projects.find((p) => p.name === 'monorepo')!.excludedDirs).toEqual([join(root, 'packages/api')]);
  });
});

describe('AnalyzeInputHandler', () => {
  const document: CiirDocument = {
    schemaVersion: '1.2',
    id: 'sha256:1',
    kind: 'type',
    language: 'typescript',
    project: 'p',
    symbol: { name: 'A', qualifiedName: 'a#A', canonicalName: 'a#A' },
    relations: [
      {
        kind: 'calls',
        target: { symbol: 'x()' },
        resolution: { status: 'unresolved', origin: 'unknown', reason: 'why' },
      },
    ],
  };

  function handlerWith(analyzers: CodeAnalyzer[], written: CiirDocument[], uploadFails = false) {
    const session: CiirWriterSession = {
      write: async (doc) => void written.push(doc),
      close: async () => ({ path: 'ciir.jsonl', records: written.length, sha256: 'sha256:x' }),
      abort: async () => undefined,
    };
    const files = new Map<string, unknown>();
    return {
      files,
      handler: new AnalyzeInputHandler({
        generator: { name: 'code-brain-angular', version: 't' },
        analyzers,
        writer: { open: async () => session },
        artifacts: {
          writeSchema: async () => ({ path: 'ciir.schema.json', sha256: 'sha256:s' }),
          writeJson: async (_dir, name, content) => void files.set(name, content),
        },
        uploader: {
          upload: async () => {
            if (uploadFails) {
              throw new UploadError('boom');
            }
            return { uploadId: 'u1', status: 'pending' };
          },
        },
        progress: SILENT_PROGRESS,
        logger: SILENT_LOGGER,
        clock: () => new Date('2026-09-28T10:00:00.123Z'),
      }),
    };
  }

  const emitting: CodeAnalyzer = {
    name: 'fake',
    analyze: async (context) => {
      await context.emit(document);
      return { filesAnalyzed: 1, filesIgnored: 2, failures: [], warnings: [] };
    },
  };
  const failing: CodeAnalyzer = {
    name: 'broken',
    analyze: async () => {
      throw new Error('kaput');
    },
  };
  const options = {
    inputPath: FIXTURE,
    outputDirectory: '/unused',
    includeSource: false,
    includeTests: false,
    failOnError: false,
  };

  it('streams documents and writes manifest and report statistics', async () => {
    const written: CiirDocument[] = [];
    const { handler, files } = handlerWith([emitting], written);
    const result = await handler.handle(options, new AbortController().signal);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(written).toEqual([document]);
    expect(files.get('manifest.json')).toMatchObject({
      format: 'ciir',
      schemaVersion: '1.2',
      generator: { name: 'code-brain-angular' },
      input: { type: 'directory', path: '.' },
      generatedAt: '2026-09-28T10:00:00Z',
      statistics: { projects: 2, filesAnalyzed: 1, types: 1, relations: 1, unresolvedRelations: 1 },
    });
    expect(files.get('analysis-report.json')).toMatchObject({
      success: true,
      documents: { analyzed: 1, ignored: 2 },
      relations: { resolved: 0, unresolved: 1 },
      unresolvedRelations: [
        { source: 'a#A', relation: 'calls', target: 'x()', status: 'unresolved', reason: 'why' },
      ],
    });
  });

  it('records an unexpected analyzer failure and continues; --fail-on-error turns it into exit 1', async () => {
    const written: CiirDocument[] = [];
    const lenient = await handlerWith([failing, emitting], written).handler.handle(
      options,
      new AbortController().signal,
    );
    expect(lenient.exitCode).toBe(ExitCode.Success);
    expect(lenient.failures).toHaveLength(1);
    expect(written).toHaveLength(1);

    const strict = await handlerWith([failing], []).handler.handle(
      { ...options, failOnError: true },
      new AbortController().signal,
    );
    expect(strict.exitCode).toBe(ExitCode.AnalysisFailure);
  });

  it('returns InvalidInput for a missing path', async () => {
    const result = await handlerWith([], []).handler.handle(
      { ...options, inputPath: '/does/not/exist' },
      new AbortController().signal,
    );
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
  });

  it('uploads after a successful analysis and maps upload failures to exit 5', async () => {
    const send = { baseUrl: new URL('http://indexer'), projectId: 'p', insecure: false };
    const ok = await handlerWith([emitting], []).handler.handle(
      { ...options, send },
      new AbortController().signal,
    );
    expect(ok.upload).toEqual({ uploadId: 'u1', status: 'pending' });

    const failed = await handlerWith([emitting], [], true).handler.handle(
      { ...options, send },
      new AbortController().signal,
    );
    expect(failed.exitCode).toBe(ExitCode.UploadFailure);
    expect(failed.message).toBe('boom');
  });

  it('returns Cancelled when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await handlerWith([emitting], []).handler.handle(options, controller.signal);
    expect(result.exitCode).toBe(ExitCode.Cancelled);
  });
});

describe('architecture boundary', () => {
  const sources = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name));

  it.each(['core', 'application'])('src/%s never imports typescript or @angular/*', (layer) => {
    for (const file of sources(join(REPOSITORY_ROOT, 'src', layer))) {
      const content = readFileSync(file, 'utf8');
      expect(content, file).not.toMatch(/from\s+['"](typescript|@angular\/[^'"]+)['"]/);
    }
  });

  it('src/core depends on nothing but itself and node built-ins', () => {
    for (const file of sources(join(REPOSITORY_ROOT, 'src', 'core'))) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      expect(
        imports.filter((i) => !i.startsWith('./') && !i.startsWith('node:')),
        file,
      ).toEqual([]);
    }
  });
});
