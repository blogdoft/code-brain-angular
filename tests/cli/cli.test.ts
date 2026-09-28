import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/cli.js';
import { createSendOptions } from '../../src/cli/send-options.js';
import { isSplashSuppressed, renderSplash } from '../../src/cli/splash-screen.js';
import { FIXTURE, REPOSITORY_ROOT, temporaryDirectory } from '../helpers.js';

const MAIN = join(REPOSITORY_ROOT, 'dist', 'cli', 'main.js');
const GUID = '3f2b1c0e-0000-4000-8000-000000000001';

function capture() {
  let out = '';
  let err = '';
  return {
    output: { out: (text: string) => void (out += text), err: (text: string) => void (err += text) },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('splash screen', () => {
  it('renders banner, blog link and notices in that order', () => {
    const text = renderSplash('1.2.3');
    expect(text.indexOf('code-brain-angular 1.2.3')).toBeLessThan(
      text.indexOf('https://www.blogdoft.com.br/'),
    );
    expect(text.indexOf('https://www.blogdoft.com.br/')).toBeLessThan(text.indexOf('Requires Node.js'));
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it.each([
    [false, undefined, false],
    [true, undefined, true],
    [false, '1', true],
    [false, 'TRUE', true],
    [false, '0', false],
  ])('suppression (banner=%s, env=%s) -> %s', (noBanner, env, expected) => {
    expect(isSplashSuppressed(noBanner, env)).toBe(expected);
  });
});

describe('createSendOptions', () => {
  it('is a no-op without --send', () => {
    expect(createSendOptions({}, {})).toEqual({ ok: true, warnings: [] });
  });

  it('falls back to CIIR_BASE_URL and requires a projectId', () => {
    expect(createSendOptions({ send: true }, {})).toMatchObject({ ok: false });
    expect(createSendOptions({ send: true }, { CIIR_BASE_URL: 'https://x/code-brain' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('--projectId'),
    });
    const result = createSendOptions(
      { send: true, projectId: GUID },
      { CIIR_BASE_URL: 'https://x/code-brain' },
    );
    expect(result.ok && result.options?.baseUrl.href).toBe('https://x/code-brain');
  });

  it('rejects non-http URLs', () => {
    expect(createSendOptions({ send: 'ftp://x', projectId: GUID }, {})).toMatchObject({ ok: false });
  });

  it('prefers --token and warns about half client credentials', () => {
    const token = createSendOptions(
      { send: 'http://x', projectId: GUID, token: 't', clientId: 'a', clientSecret: 'b' },
      {},
    );
    expect(token.ok && token.options?.credentials).toEqual({ kind: 'bearer', token: 't' });
    const half = createSendOptions({ send: 'http://x', projectId: GUID, clientId: 'a' }, {});
    expect(half.ok && half.options?.credentials).toBeUndefined();
    expect(half.ok && half.warnings[0]).toMatch(/Both --clientId and --clientSecret/);
  });
});

describe('runCli (in-process)', () => {
  const signal = new AbortController().signal;

  it('prints help without the splash screen and exits 0', async () => {
    const io = capture();
    expect(await runCli(['--help'], io.output, {}, signal)).toBe(0);
    expect(io.out).toContain('Usage: code-brain-angular');
    expect(io.out).not.toContain('blogdoft');
  });

  it('exits 2 on missing arguments, bad input and invalid --send', async () => {
    expect(await runCli([], capture().output, {}, signal)).toBe(2);
    expect(await runCli(['/no/such/path', '--no-banner'], capture().output, {}, signal)).toBe(2);
    const io = capture();
    expect(await runCli([FIXTURE, '--no-banner', '-s', 'http://x'], io.output, {}, signal)).toBe(2);
    expect(io.err).toContain('--projectId');
  });

  it('accepts the -pi alias', async () => {
    const io = capture();
    // Invalid base URL makes it stop before analysis, after the alias has been parsed.
    expect(await runCli([FIXTURE, '--no-banner', '-s', 'nope', '-pi', GUID], io.output, {}, signal)).toBe(2);
    expect(io.err).toContain("Invalid indexer base URL 'nope'");
  });

  it('exits 4 on an unsupported Node.js version', async () => {
    expect(await runCli([FIXTURE, '--no-banner'], capture().output, {}, signal, '18.20.0')).toBe(4);
  });

  it('analyzes, shows the splash first, and exits 0', async () => {
    const io = capture();
    const output = temporaryDirectory();
    expect(await runCli([FIXTURE, '--output', output, '--no-progress'], io.output, {}, signal)).toBe(0);
    expect(io.out.startsWith('  ____')).toBe(true);
    expect(io.out).toContain('CIIR written to');
    for (const file of ['ciir.jsonl', 'ciir.schema.json', 'manifest.json', 'analysis-report.json']) {
      expect(existsSync(join(output, file)), file).toBe(true);
    }
  });
});

describe('code-brain-angular executable (subprocess)', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: REPOSITORY_ROOT, stdio: 'ignore' });
  }, 120_000);

  it('runs as a real process and exits 0', () => {
    const output = temporaryDirectory();
    const result = spawnSync(process.execPath, [MAIN, FIXTURE, '--output', output], {
      encoding: 'utf8',
      env: { ...process.env, CIIR_NOLOGO: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('blogdoft');
    expect(result.stdout).toContain('[1/2] demo-app');
  });

  it('prints the version without the splash', () => {
    const result = spawnSync(process.execPath, [MAIN, '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.0.0-local');
  });
});
