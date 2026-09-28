import ts from 'typescript';
import { toPosixRelative } from '../application/file-walker.js';
import { sha256Prefixed } from '../core/hashing.js';
import type {
  CiirAccessibility,
  CiirComment,
  CiirCommentKind,
  CiirDocumentation,
  CiirModifier,
  CiirRange,
  CiirSourceLocation,
} from '../core/model.js';
import { sortModifiers } from '../core/modifier-order.js';
import { languageOf } from './project-files.js';

/** 1-based line/column range of `[start, end)` in `sourceFile`. */
export function rangeOf(sourceFile: ts.SourceFile, start: number, end: number): Required<CiirRange> {
  const from = sourceFile.getLineAndCharacterOfPosition(start);
  const to = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    startLine: from.line + 1,
    startColumn: from.character + 1,
    endLine: to.line + 1,
    endColumn: to.character + 1,
  };
}

export function nodeRange(node: ts.Node): Required<CiirRange> {
  const sourceFile = node.getSourceFile();
  return rangeOf(sourceFile, node.getStart(sourceFile), node.getEnd());
}

/**
 * The declaration's source evidence: path relative to the analysis root (forward slashes),
 * 1-based span without leading trivia (decorators included), and the SHA-256 of the exact span.
 */
export function sourceLocationOf(
  node: ts.Node,
  rootDirectory: string,
  includeSource: boolean,
): CiirSourceLocation {
  const sourceFile = node.getSourceFile();
  const start = ts.isSourceFile(node) ? 0 : node.getStart(sourceFile);
  const text = sourceFile.text.slice(start, node.getEnd());
  return {
    path: toPosixRelative(rootDirectory, sourceFile.fileName),
    ...rangeOf(sourceFile, start, node.getEnd()),
    hash: sha256Prefixed(text),
    ...(includeSource ? { text } : {}),
  };
}

const MARKERS: readonly [string, CiirCommentKind][] = [
  ['TODO', 'todo'],
  ['FIXME', 'fixme'],
  ['WARNING', 'warning'],
  ['NOTE', 'note'],
];

/**
 * Ordinary `//` and `/* *\/` comments in `node`'s full span - its leading trivia included, as
 * Roslyn's `DescendantTrivia` does - with JSDoc `/** *\/` excluded (that is documentation) and any
 * span in `excluded` skipped (e.g. class members, which carry their own comments).
 */
export function commentsWithin(node: ts.Node, excluded: readonly ts.Node[] = []): CiirComment[] {
  const sourceFile = node.getSourceFile();
  const text = sourceFile.text;
  const start = node.getFullStart();
  const end = node.getEnd();
  const seen = new Set<number>();
  const comments: CiirComment[] = [];

  const collect = (position: number): void => {
    for (const range of ts.getLeadingCommentRanges(text, position) ?? []) {
      if (seen.has(range.pos) || range.pos < start || range.end > end) {
        continue;
      }
      seen.add(range.pos);
      if (excluded.some((child) => range.pos >= child.getFullStart() && range.end <= child.getEnd())) {
        continue;
      }
      const raw = text.slice(range.pos, range.end);
      if (raw.startsWith('/**')) {
        continue;
      }
      const isLine = range.kind === ts.SyntaxKind.SingleLineCommentTrivia;
      const cleaned = isLine
        ? raw.replace(/^\/+/, '').trim()
        : raw
            .replace(/^\/\*+/, '')
            .replace(/\*+\/$/, '')
            .trim();
      if (cleaned === '') {
        continue;
      }
      const marker = MARKERS.find(([prefix]) => cleaned.toUpperCase().startsWith(prefix));
      comments.push({
        kind: marker ? marker[1] : isLine ? 'line' : 'block',
        text: cleaned,
        location: rangeOf(sourceFile, range.pos, range.end),
      });
    }
  };

  // Every comment is the leading trivia of some token, so visiting every node/token start finds them all.
  const visit = (current: ts.Node): void => {
    collect(current.getFullStart());
    current.getChildren(sourceFile).forEach(visit);
  };
  visit(node);

  return comments.sort(
    (a, b) =>
      a.location.startLine - b.location.startLine ||
      (a.location.startColumn ?? 0) - (b.location.startColumn ?? 0),
  );
}

/** JSDoc/TSDoc of a declaration (`tsdoc` in TypeScript files, `jsdoc` in JavaScript). */
export function documentationOf(node: ts.Node): CiirDocumentation | undefined {
  const holder =
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    node.parent.declarations.length === 1
      ? node.parent.parent
      : node;
  const docs = (ts.getJSDocCommentsAndTags(holder).filter(ts.isJSDoc) as ts.JSDoc[]).slice(-1);
  const jsDoc = docs[0];
  if (!jsDoc) {
    return undefined;
  }

  const format = languageOf(node.getSourceFile().fileName) === 'typescript' ? 'tsdoc' : 'jsdoc';
  const summary = clean(ts.getTextOfJSDocComment(jsDoc.comment));
  let remarks: string | undefined;
  let returns: string | undefined;
  const parameters: { name: string; description: string }[] = [];
  const exceptions: { type: string; description?: string }[] = [];

  for (const tag of jsDoc.tags ?? []) {
    const comment = clean(ts.getTextOfJSDocComment(tag.comment));
    if (ts.isJSDocParameterTag(tag)) {
      parameters.push({ name: tag.name.getText(), description: comment?.replace(/^-\s*/, '') ?? '' });
    } else if (ts.isJSDocReturnTag(tag)) {
      returns = comment;
    } else if (ts.isJSDocThrowsTag(tag)) {
      const type = tag.typeExpression?.type.getText();
      exceptions.push({ type: type ?? 'unknown', ...(comment ? { description: comment } : {}) });
    } else if (tag.tagName.text === 'remarks') {
      remarks = comment;
    }
  }

  if (!summary && !remarks && !returns && parameters.length === 0 && exceptions.length === 0) {
    return undefined;
  }
  return {
    format,
    source: 'declared',
    ...(summary ? { summary } : {}),
    ...(remarks ? { remarks } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(returns ? { returns } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

function clean(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

/** Class-member accessibility (explicit modifier, `#private`, default public). */
export function memberAccessibility(node: ts.Declaration): CiirAccessibility {
  const flags = ts.getCombinedModifierFlags(node);
  if (flags & ts.ModifierFlags.Private) {
    return 'private';
  }
  if (flags & ts.ModifierFlags.Protected) {
    return 'protected';
  }
  const name = ts.getNameOfDeclaration(node);
  if (name && ts.isPrivateIdentifier(name)) {
    return 'private';
  }
  return 'public';
}

/** Top-level accessibility: exported = public, module-private = internal. */
export function topLevelAccessibility(node: ts.Declaration): CiirAccessibility {
  const target = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  const flags = ts.getCombinedModifierFlags(target as ts.Declaration);
  if (flags & ts.ModifierFlags.Export || flags & ts.ModifierFlags.ExportDefault) {
    return 'public';
  }
  const sourceFile = node.getSourceFile();
  return ts.isExternalModule(sourceFile) ? 'internal' : 'public';
}

export function modifiersOf(node: ts.Declaration): CiirModifier[] | undefined {
  const target = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  const flags = ts.getCombinedModifierFlags(target as ts.Declaration);
  const modifiers: CiirModifier[] = [];
  if (flags & ts.ModifierFlags.Const) {
    modifiers.push('const');
  }
  if (ts.isVariableDeclaration(node) && node.parent.flags & ts.NodeFlags.Const) {
    modifiers.push('const');
  }
  if (flags & ts.ModifierFlags.Static) {
    modifiers.push('static');
  }
  if (flags & ts.ModifierFlags.Readonly) {
    modifiers.push('readonly');
  }
  if (flags & ts.ModifierFlags.Ambient) {
    modifiers.push('extern');
  }
  if (flags & ts.ModifierFlags.Abstract) {
    modifiers.push('abstract');
  }
  if (flags & ts.ModifierFlags.Override) {
    modifiers.push('override');
  }
  if (flags & ts.ModifierFlags.Async) {
    modifiers.push('async');
  }
  const sorted = sortModifiers(modifiers);
  return sorted.length > 0 ? sorted : undefined;
}
