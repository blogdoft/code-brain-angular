import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Directories never used for discovery or analysis (build output, dependencies, VCS, caches). */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.angular',
  '.git',
  '.nx',
  '.next',
  '.cache',
  'tmp',
]);

/**
 * Recursively lists files under `root` (skipping {@link EXCLUDED_DIRECTORIES} and `skipDirs`),
 * in a deterministic (sorted) order.
 */
export function walkFiles(
  root: string,
  accept: (fileName: string) => boolean,
  skipDirs: readonly string[] = [],
): string[] {
  const results: string[] = [];
  const skip = new Set(skipDirs);

  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && !skip.has(full)) {
          visit(full);
        }
      } else if (entry.isFile() && accept(entry.name)) {
        results.push(full);
      }
    }
  };

  visit(root);
  return results;
}

/** `path` relative to `root`, always with forward slashes (`.` for the root itself). */
export function toPosixRelative(root: string, path: string): string {
  const rel = relative(root, path).split(sep).join('/');
  return rel === '' ? '.' : rel;
}

/** Whether `path` is `directory` itself or lies beneath it. */
export function isWithin(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}
