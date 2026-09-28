import type { IndexerCredentials, SendOptions } from '../application/model.js';

export const BASE_URL_ENVIRONMENT_VARIABLE = 'CIIR_BASE_URL';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RawSendOptions {
  send?: string | boolean;
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
  token?: string;
  insecure?: boolean;
}

export type SendOptionsResult =
  { ok: true; options?: SendOptions; warnings: string[] } | { ok: false; error: string };

/**
 * Validates `--send` and its companions before any analysis starts (fail fast in CI):
 * base URL = `--send` value, else `CIIR_BASE_URL`; `--projectId` required; `--token` wins over
 * client credentials; only one of `--clientId`/`--clientSecret` is ignored with a warning.
 */
export function createSendOptions(raw: RawSendOptions, environment: NodeJS.ProcessEnv): SendOptionsResult {
  if (raw.send === undefined || raw.send === false) {
    return { ok: true, warnings: [] };
  }

  const explicit = typeof raw.send === 'string' ? raw.send.trim() : '';
  const candidate = explicit !== '' ? explicit : environment[BASE_URL_ENVIRONMENT_VARIABLE]?.trim();
  if (!candidate) {
    return {
      ok: false,
      error: `--send needs a <base-url>: the ${BASE_URL_ENVIRONMENT_VARIABLE} environment variable is not defined, so the URL must be given.`,
    };
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(candidate);
  } catch {
    return {
      ok: false,
      error: `Invalid indexer base URL '${candidate}': expected an absolute http/https URL.`,
    };
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    return {
      ok: false,
      error: `Invalid indexer base URL '${candidate}': expected an absolute http/https URL.`,
    };
  }

  if (!raw.projectId || !GUID.test(raw.projectId.trim())) {
    return {
      ok: false,
      error: '--send requires --projectId <guid> (the id of a project already registered in the indexer).',
    };
  }

  const warnings: string[] = [];
  let credentials: IndexerCredentials | undefined;
  if (raw.token) {
    credentials = { kind: 'bearer', token: raw.token };
  } else if (raw.clientId && raw.clientSecret) {
    credentials = { kind: 'client', clientId: raw.clientId, clientSecret: raw.clientSecret };
  } else if (raw.clientId || raw.clientSecret) {
    warnings.push(
      'Both --clientId and --clientSecret are required for client credentials; sending without authentication.',
    );
  }
  if (raw.insecure) {
    warnings.push(
      '--insecure: the TLS/SSL certificate of the indexer will NOT be validated. Use only on trusted networks.',
    );
  }

  return {
    ok: true,
    options: { baseUrl, projectId: raw.projectId.trim(), credentials, insecure: raw.insecure === true },
    warnings,
  };
}
