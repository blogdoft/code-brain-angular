import { createHash } from 'node:crypto';

/**
 * The single SHA-256 utility used wherever the CIIR contract needs a deterministic content hash
 * (document `id`, `source.hash`, `embeddingTextHash`, manifest file hashes).
 */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** `sha256:<lowercase hex>` of the UTF-8 bytes of `content`. */
export function sha256Prefixed(content: string | Uint8Array): string {
  return `sha256:${sha256Hex(content)}`;
}
