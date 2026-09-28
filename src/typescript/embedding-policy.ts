import type { EmbeddingTextPolicy } from '../core/embedding-text.js';
import type { CiirComment, CiirDocument, CiirRelation } from '../core/model.js';

const NOISY_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
  Console: new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'table']),
  Array: new Set([
    'map',
    'filter',
    'forEach',
    'push',
    'pop',
    'shift',
    'unshift',
    'find',
    'findIndex',
    'some',
    'every',
    'includes',
    'indexOf',
    'reduce',
    'slice',
    'splice',
    'join',
    'concat',
    'sort',
    'flat',
    'flatMap',
    'at',
    'isArray',
    'from',
    'of',
  ]),
  ReadonlyArray: new Set([
    'map',
    'filter',
    'forEach',
    'find',
    'some',
    'every',
    'includes',
    'indexOf',
    'reduce',
    'slice',
    'join',
  ]),
  String: new Set([
    'trim',
    'toLowerCase',
    'toUpperCase',
    'split',
    'replace',
    'replaceAll',
    'includes',
    'startsWith',
    'endsWith',
    'slice',
    'substring',
    'padStart',
    'padEnd',
    'indexOf',
    'toString',
  ]),
  Object: new Set(['keys', 'values', 'entries', 'assign', 'freeze', 'fromEntries']),
  ObjectConstructor: new Set(['keys', 'values', 'entries', 'assign', 'freeze', 'fromEntries']),
  ArrayConstructor: new Set(['isArray', 'from', 'of']),
  JSON: new Set(['stringify', 'parse']),
  Math: new Set(['max', 'min', 'round', 'floor', 'ceil', 'abs', 'random']),
  PromiseConstructor: new Set(['resolve', 'reject', 'all', 'allSettled', 'race']),
  Promise: new Set(['then', 'catch', 'finally']),
  Map: new Set(['get', 'set', 'has', 'delete']),
  Set: new Set(['add', 'has', 'delete']),
  Number: new Set(['toFixed', 'toString']),
  'rxjs#Observable': new Set(['pipe']),
};

const NOISY_FUNCTIONS = new Set([
  '@angular/core#inject',
  '@angular/core#signal',
  '@angular/core#computed',
  '@angular/core#input',
  '@angular/core#output',
  '@angular/core#model',
  'setTimeout',
  'clearTimeout',
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
]);

const MARKED_COMMENTS = new Set(['todo', 'fixme', 'warning', 'note']);

/**
 * The TypeScript/Angular noise policy: extremely generic calls (console, common Array/String/
 * Object methods, Angular DI/signal factories, ...) stay in `relations` but are left out of
 * `embeddingText`; comments only appear with an explicit marker. Also renders the optional
 * `Framework` section from `extensions.angular`.
 */
export class TypeScriptNoiseEmbeddingTextPolicy implements EmbeddingTextPolicy {
  shouldIncludeRelation(relation: CiirRelation): boolean {
    if (relation.kind !== 'calls') {
      return true;
    }
    const name = relation.target.symbol.split('(')[0]!;
    if (NOISY_FUNCTIONS.has(name)) {
      return false;
    }
    const lastDot = name.lastIndexOf('.');
    if (lastDot < 0) {
      return true;
    }
    return !NOISY_MEMBERS[name.slice(0, lastDot)]?.has(name.slice(lastDot + 1));
  }

  shouldIncludeComment(comment: CiirComment): boolean {
    return MARKED_COMMENTS.has(comment.kind);
  }

  shouldIncludeCondition(): boolean {
    return true;
  }

  frameworkLines(document: CiirDocument): string[] {
    const angular = document.extensions?.['angular'] as AngularExtension | undefined;
    if (!angular) {
      return [];
    }
    const lines: string[] = [];

    if (angular.artifact) {
      lines.push(`Framework: Angular ${angular.artifact.replace(/_/g, ' ')}`);
    } else if (angular.signal) {
      lines.push(`Framework: Angular ${angular.signal} signal`);
    }
    if (angular.selector) {
      lines.push(`Selector: ${angular.selector}`);
    }
    if (angular.pipeName) {
      lines.push(`Pipe name: ${angular.pipeName}`);
    }
    list(lines, 'Injects', angular.injects);
    list(
      lines,
      'Inputs',
      angular.inputs?.map((input) => input.alias ?? input.name),
    );
    list(
      lines,
      'Outputs',
      angular.outputs?.map((output) => output.alias ?? output.name),
    );
    list(lines, 'Template uses', [
      ...(angular.template?.usedComponents ?? []),
      ...(angular.template?.usedDirectives ?? []),
      ...(angular.template?.usedPipes ?? []),
    ]);
    list(
      lines,
      'Routes',
      angular.routes?.map((route) => {
        const target =
          route.component ??
          route.loadComponent ??
          route.loadChildren ??
          (route.redirectTo !== undefined ? `redirect '${route.redirectTo}'` : undefined);
        return target ? `${route.path} -> ${target}` : route.path;
      }),
    );
    list(
      lines,
      'HTTP',
      angular.httpCalls?.map((call) => `${call.method} ${call.url}`),
    );
    return lines;
  }
}

interface AngularExtension {
  artifact?: string;
  signal?: string;
  selector?: string;
  pipeName?: string;
  injects?: string[];
  inputs?: { name: string; alias?: string }[];
  outputs?: { name: string; alias?: string }[];
  template?: { usedComponents?: string[]; usedDirectives?: string[]; usedPipes?: string[] };
  routes?: {
    path: string;
    component?: string;
    loadComponent?: string;
    loadChildren?: string;
    redirectTo?: string;
  }[];
  httpCalls?: { method: string; url: string }[];
}

function list(lines: string[], label: string, items: readonly string[] | undefined): void {
  if (items && items.length > 0) {
    lines.push(`${label}:`, ...items.map((item) => `- ${item}`));
  }
}
