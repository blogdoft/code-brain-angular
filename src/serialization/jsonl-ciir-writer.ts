import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import type { CiirDocument } from '../core/model.js';
import type { CiirWriter, CiirWriterSession, WrittenFile } from '../application/ports.js';
import { CIIR_FILE_NAME } from '../application/analyze-input-handler.js';
import { serializeDocument } from './document-serializer.js';

/** Streams documents to `ciir.jsonl`, one per line, hashing the bytes as they are written. */
export class JsonlCiirWriter implements CiirWriter {
  async open(outputDirectory: string): Promise<CiirWriterSession> {
    await mkdir(outputDirectory, { recursive: true });
    const path = join(outputDirectory, CIIR_FILE_NAME);
    const stream = createWriteStream(path, { encoding: 'utf8' });
    await once(stream, 'open');
    return new JsonlSession(path, stream);
  }
}

class JsonlSession implements CiirWriterSession {
  private readonly hash = createHash('sha256');
  private records = 0;
  private failure: Error | undefined;

  constructor(
    private readonly path: string,
    private readonly stream: WriteStream,
  ) {
    stream.on('error', (error) => {
      this.failure = error;
    });
  }

  async write(document: CiirDocument): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    const line = `${serializeDocument(document)}\n`;
    this.hash.update(line, 'utf8');
    this.records++;
    if (!this.stream.write(line)) {
      await once(this.stream, 'drain');
    }
  }

  async close(): Promise<WrittenFile> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    if (this.failure) {
      throw this.failure;
    }
    return { path: CIIR_FILE_NAME, records: this.records, sha256: `sha256:${this.hash.digest('hex')}` };
  }

  async abort(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
    await rm(this.path, { force: true });
  }
}
