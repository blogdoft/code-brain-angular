import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SendOptions } from '../../src/application/model.js';
import { UploadError } from '../../src/application/ports.js';
import { HttpCiirUploader } from '../../src/indexer-client/http-ciir-uploader.js';
import { temporaryDirectory } from '../helpers.js';

interface Recorded {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server | undefined;

afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function fakeIndexer(
  respond: (request: Recorded) => { status: number; body?: unknown },
): Promise<{ baseUrl: URL; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const { status, body } = respond(recorded);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(body === undefined ? '' : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server!.address() as AddressInfo).port;
  return { baseUrl: new URL(`http://127.0.0.1:${port}/code-brain`), requests };
}

function ciirFile(): string {
  const path = join(temporaryDirectory(), 'ciir.jsonl');
  writeFileSync(path, '{"a":1}\n{"b":2}\n');
  return path;
}

const PROJECT_ID = '3f2b1c0e-0000-4000-8000-000000000001';

describe('HttpCiirUploader', () => {
  it('posts multipart with projectId before ciirFile, under the base path, without auth', async () => {
    const { baseUrl, requests } = await fakeIndexer(() => ({
      status: 202,
      body: { uploadId: 'u-1', status: 'pending' },
    }));
    const options: SendOptions = { baseUrl, projectId: PROJECT_ID, insecure: false };

    const receipt = await new HttpCiirUploader().upload(ciirFile(), options, new AbortController().signal);

    expect(receipt).toEqual({ uploadId: 'u-1', status: 'pending' });
    const [upload] = requests;
    expect(upload).toMatchObject({ method: 'POST', url: '/code-brain/api/indexer/ciir-uploads' });
    expect(upload!.headers.authorization).toBeUndefined();
    expect(upload!.body.indexOf('name="projectId"')).toBeLessThan(
      upload!.body.indexOf('name="ciirFile"; filename="ciir.jsonl"'),
    );
    expect(upload!.body).toContain(PROJECT_ID);
    expect(upload!.body).toContain('{"a":1}\n{"b":2}\n');
  });

  it('exchanges client credentials at the token gateway and sends the Bearer token', async () => {
    const { baseUrl, requests } = await fakeIndexer((request) =>
      request.url?.endsWith('/auth/token')
        ? { status: 200, body: { accessToken: 'jwt-123' } }
        : { status: 202, body: { uploadId: 'u', status: 'pending' } },
    );
    await new HttpCiirUploader().upload(
      ciirFile(),
      {
        baseUrl,
        projectId: PROJECT_ID,
        insecure: false,
        credentials: { kind: 'client', clientId: 'ci', clientSecret: 's3cr3t' },
      },
      new AbortController().signal,
    );
    expect(JSON.parse(requests[0]!.body)).toEqual({ clientId: 'ci', clientSecret: 's3cr3t' });
    expect(requests[1]!.headers.authorization).toBe('Bearer jwt-123');
  });

  it('maps a rejected upload to an UploadError carrying the problem detail but never the token', async () => {
    const { baseUrl } = await fakeIndexer(() => ({ status: 400, body: { detail: 'Unknown file' } }));
    const upload = new HttpCiirUploader().upload(
      ciirFile(),
      {
        baseUrl,
        projectId: PROJECT_ID,
        insecure: false,
        credentials: { kind: 'bearer', token: 'secret-jwt' },
      },
      new AbortController().signal,
    );
    await expect(upload).rejects.toBeInstanceOf(UploadError);
    await expect(upload).rejects.toThrow(/HTTP 400\): Unknown file/);
    await expect(upload).rejects.not.toThrow(/secret-jwt/);
  });

  it('explains a missing token endpoint (authentication disabled)', async () => {
    const { baseUrl } = await fakeIndexer(() => ({ status: 404 }));
    await expect(
      new HttpCiirUploader().upload(
        ciirFile(),
        {
          baseUrl,
          projectId: PROJECT_ID,
          insecure: false,
          credentials: { kind: 'client', clientId: 'a', clientSecret: 'b' },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/no token endpoint/);
  });
});
