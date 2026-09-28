import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename } from 'node:path';
import type { SendOptions, UploadReceipt } from '../application/model.js';
import { UploadError, type CiirUploader } from '../application/ports.js';

const UPLOAD_PATH = 'api/indexer/ciir-uploads';
const TOKEN_PATH = 'api/indexer/auth/token';
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 60 * 1000;

interface HttpResponse {
  status: number;
  body: string;
}

/**
 * Uploads `ciir.jsonl` to the code-ciir-indexer (same contract as the C# generator's
 * `--send`, spec 03): multipart with `projectId` BEFORE `ciirFile`, streamed from disk, Bearer
 * token optional (given directly or obtained from the indexer's token gateway). Error messages
 * never contain the token or the client secret.
 */
export class HttpCiirUploader implements CiirUploader {
  async upload(ciirFile: string, options: SendOptions, signal: AbortSignal): Promise<UploadReceipt> {
    const token = await this.token(options, signal);
    const boundary = `----code-brain-angular-${randomBytes(12).toString('hex')}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\n${options.projectId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="ciirFile"; filename="${basename(ciirFile)}"\r\n` +
        'Content-Type: application/x-ndjson\r\n\r\n',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const size = (await stat(ciirFile)).size;

    const response = await send(
      endpoint(options.baseUrl, UPLOAD_PATH),
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': head.length + size + tail.length,
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      options.insecure,
      UPLOAD_TIMEOUT_MS,
      signal,
      async (write, end) => {
        await write(head);
        for await (const chunk of createReadStream(ciirFile)) {
          await write(chunk as Buffer);
        }
        await write(tail);
        end();
      },
    );

    if (response.status < 200 || response.status >= 300) {
      throw new UploadError(
        `The indexer rejected the upload (HTTP ${response.status})${problemDetail(response.body)}.`,
      );
    }
    const receipt = parseJson(response.body) as Partial<UploadReceipt> | undefined;
    return { uploadId: String(receipt?.uploadId ?? ''), status: String(receipt?.status ?? 'unknown') };
  }

  private async token(options: SendOptions, signal: AbortSignal): Promise<string | undefined> {
    const credentials = options.credentials;
    if (!credentials) {
      return undefined;
    }
    if (credentials.kind === 'bearer') {
      return credentials.token;
    }

    const body = Buffer.from(
      JSON.stringify({ clientId: credentials.clientId, clientSecret: credentials.clientSecret }),
    );
    const response = await send(
      endpoint(options.baseUrl, TOKEN_PATH),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Accept: 'application/json',
        },
      },
      options.insecure,
      TOKEN_TIMEOUT_MS,
      signal,
      async (write, end) => {
        await write(body);
        end();
      },
    );

    switch (response.status) {
      case 200: {
        const accessToken = (parseJson(response.body) as { accessToken?: unknown } | undefined)?.accessToken;
        if (typeof accessToken !== 'string' || accessToken === '') {
          throw new UploadError('The indexer token endpoint returned no accessToken.');
        }
        return accessToken;
      }
      case 401:
        throw new UploadError('The indexer refused the client credentials (HTTP 401).');
      case 404:
        throw new UploadError(
          'The indexer has no token endpoint (authentication is disabled): omit --clientId/--clientSecret or use --token.',
        );
      case 502:
        throw new UploadError('The indexer could not reach its identity provider (HTTP 502).');
      default:
        throw new UploadError(
          `Could not obtain an access token (HTTP ${response.status})${problemDetail(response.body)}.`,
        );
    }
  }
}

/** Relative endpoints only resolve under a path prefix (e.g. /code-brain) when the base ends with a slash. */
function endpoint(baseUrl: URL, path: string): URL {
  const base = new URL(baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`);
  return new URL(path, base);
}

function send(
  url: URL,
  options: RequestOptions,
  insecure: boolean,
  timeoutMs: number,
  signal: AbortSignal,
  writeBody: (write: (chunk: Buffer) => Promise<void>, end: () => void) => Promise<void>,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        ...options,
        signal,
        timeout: timeoutMs,
        ...(url.protocol === 'https:' && insecure ? { rejectUnauthorized: false } : {}),
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error(`Request to ${url.origin} timed out.`)));
    request.on('error', (error) =>
      reject(new UploadError(`Could not reach the indexer at ${url.origin}: ${error.message}`)),
    );

    const write = (chunk: Buffer): Promise<void> =>
      new Promise((done) => {
        if (request.write(chunk)) {
          done();
        } else {
          request.once('drain', done);
        }
      });
    writeBody(write, () => request.end()).catch((error: unknown) => request.destroy(error as Error));
  });
}

function problemDetail(body: string): string {
  const problem = parseJson(body) as { detail?: unknown; title?: unknown } | undefined;
  const detail = problem?.detail ?? problem?.title;
  return typeof detail === 'string' && detail !== '' ? `: ${detail}` : '';
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
