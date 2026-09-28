import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Prefixed } from '../core/hashing.js';
import type { ArtifactWriter, WrittenFile } from '../application/ports.js';

export const SCHEMA_FILE_NAME = 'ciir.schema.json';

/** `schemas/ciir.schema.json` at the package root (same relative location from `src/` and `dist/`). */
export const SCHEMA_PATH = fileURLToPath(new URL('../../schemas/ciir.schema.json', import.meta.url));

export class FileArtifactWriter implements ArtifactWriter {
  async writeSchema(outputDirectory: string): Promise<WrittenFile> {
    const content = await readFile(SCHEMA_PATH);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, SCHEMA_FILE_NAME), content);
    return { path: SCHEMA_FILE_NAME, sha256: sha256Prefixed(content) };
  }

  async writeJson(outputDirectory: string, fileName: string, content: unknown): Promise<void> {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, fileName), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  }
}
