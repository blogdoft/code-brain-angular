import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { AnalysisInput } from './model.js';

export type InputResolution = { ok: true; input: AnalysisInput } | { ok: false; error: string };

const PROJECT_FILE = /^(tsconfig(\..+)?\.json|jsconfig\.json|package\.json)$/i;

/** Interprets the `<path>` argument purely by filesystem inspection. */
export function resolveInput(rawPath: string): InputResolution {
  const path = resolve(rawPath);

  if (!existsSync(path)) {
    return { ok: false, error: `Input path '${rawPath}' does not exist.` };
  }
  if (statSync(path).isDirectory()) {
    return { ok: true, input: { type: 'directory', path } };
  }

  const name = basename(path);
  if (name.toLowerCase() === 'angular.json') {
    return { ok: true, input: { type: 'workspace', path } };
  }
  if (PROJECT_FILE.test(name)) {
    return { ok: true, input: { type: 'project', path } };
  }

  return {
    ok: false,
    error: `Unsupported input '${rawPath}': expected a directory, angular.json, tsconfig*.json, jsconfig.json or package.json.`,
  };
}
