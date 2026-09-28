import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { CssSelector, SelectorMatcher } from '@angular/compiler';
import type { OwnedFile } from '../project-files.js';

export interface DeclarableEntry {
  kind: 'component' | 'directive';
  selector: string;
  qualifiedName: string;
}

/**
 * The run-wide index of Angular declarables (components/directives by selector, pipes by name),
 * built from every analyzed file of every project, so templates can be matched against
 * declarables of other projects too (e.g. a shared library).
 */
export interface AngularIndex {
  matcher: SelectorMatcher<DeclarableEntry>;
  pipes: ReadonlyMap<string, string>;
}

const DECORATED = /@(Component|Directive|Pipe)\s*\(/;

/**
 * Cheap syntactic pre-pass: only files mentioning a decorator are parsed, and no syntax tree is
 * retained afterwards.
 */
export function buildAngularIndex(files: readonly OwnedFile[]): AngularIndex {
  const matcher = new SelectorMatcher<DeclarableEntry>();
  const pipes = new Map<string, string>();

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    if (!DECORATED.test(text)) {
      continue;
    }

    const sourceFile = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, false);
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) {
        continue;
      }
      const qualifiedName = `${file.modulePath}#${statement.name.text}`;
      for (const decorator of ts.getDecorators(statement) ?? []) {
        indexDecorator(decorator, qualifiedName, matcher, pipes);
      }
    }
  }

  return { matcher, pipes };
}

function indexDecorator(
  decorator: ts.Decorator,
  qualifiedName: string,
  matcher: SelectorMatcher<DeclarableEntry>,
  pipes: Map<string, string>,
): void {
  const call = decorator.expression;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
    return;
  }
  const metadata = call.arguments[0];
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) {
    return;
  }
  const decoratorName = call.expression.text;

  if (decoratorName === 'Pipe') {
    const name = stringProperty(metadata, 'name');
    if (name) {
      pipes.set(name, qualifiedName);
    }
    return;
  }
  if (decoratorName !== 'Component' && decoratorName !== 'Directive') {
    return;
  }
  const selector = stringProperty(metadata, 'selector');
  if (!selector) {
    return;
  }
  try {
    matcher.addSelectables(CssSelector.parse(selector), {
      kind: decoratorName === 'Component' ? 'component' : 'directive',
      selector,
      qualifiedName,
    });
  } catch {
    // An unparsable selector cannot match anything; Angular itself would reject it.
  }
}

export function stringProperty(literal: ts.ObjectLiteralExpression, name: string): string | undefined {
  const initializer = propertyInitializer(literal, name);
  return initializer && (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
    ? initializer.text
    : undefined;
}

export function propertyInitializer(
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) {
      return property.initializer;
    }
  }
  return undefined;
}

export function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}
