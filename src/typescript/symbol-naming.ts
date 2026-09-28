import ts from 'typescript';
import { toPosixRelative } from '../application/file-walker.js';
import type { CiirKind } from '../core/model.js';
import { modulePathOf, type OwnedFile } from './project-files.js';

const NODE_MODULES = '/node_modules/';

/** Where a declaration physically lives, which drives both its name prefix and its resolution. */
export type DeclarationOrigin =
  | { kind: 'owned'; file: OwnedFile }
  | { kind: 'library' }
  | { kind: 'runtime'; packageName: string }
  | { kind: 'package'; packageName: string }
  | { kind: 'unowned'; modulePath: string };

/**
 * Turns TypeScript symbols into CIIR names (`{module}#{Type}.{member}`) and classifies
 * declarations into CIIR kinds. The same classification decides which declarations get a
 * document and which relation targets get a `target.id`, so the two can never disagree.
 */
export class SymbolNaming {
  private readonly originCache = new Map<string, DeclarationOrigin>();

  constructor(
    private readonly program: ts.Program,
    private readonly checker: ts.TypeChecker,
    private readonly owners: ReadonlyMap<string, OwnedFile>,
    private readonly currentProjectRoot: string,
  ) {}

  originOf(sourceFile: ts.SourceFile): DeclarationOrigin {
    const cached = this.originCache.get(sourceFile.fileName);
    if (cached) {
      return cached;
    }
    const origin = this.computeOrigin(sourceFile);
    this.originCache.set(sourceFile.fileName, origin);
    return origin;
  }

  /** The module prefix of names declared in `sourceFile`, or undefined for global declarations. */
  modulePrefix(sourceFile: ts.SourceFile): string | undefined {
    const origin = this.originOf(sourceFile);
    switch (origin.kind) {
      case 'owned':
        return ts.isExternalModule(sourceFile) ? origin.file.modulePath : undefined;
      case 'package':
      case 'runtime':
        return ts.isExternalModule(sourceFile) ? origin.packageName : undefined;
      case 'unowned':
        return ts.isExternalModule(sourceFile) ? origin.modulePath : undefined;
      default:
        return undefined;
    }
  }

  /** Resolves import aliases to the symbol they finally refer to. */
  resolveAlias(symbol: ts.Symbol): ts.Symbol {
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        return this.checker.getAliasedSymbol(symbol);
      } catch {
        return symbol;
      }
    }
    return symbol;
  }

  /**
   * The declaration that represents a symbol: the implementation (the one with a body) when there
   * is one, otherwise the first declaration in (file, position) order.
   */
  primaryDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
    const declarations = [...(symbol.declarations ?? [])].sort(
      (a, b) =>
        compare(a.getSourceFile().fileName, b.getSourceFile().fileName) || a.getStart() - b.getStart(),
    );
    return declarations.find((declaration) => hasBody(declaration)) ?? declarations[0];
  }

  /** `{module}#{path}` for module declarations, `{path}` for globals; undefined for anonymous containers. */
  qualifiedNameOf(declaration: ts.Declaration): string | undefined {
    const located = this.symbolPath(declaration);
    if (located === undefined) {
      return undefined;
    }
    const prefix = located.ambientModule ?? this.modulePrefix(declaration.getSourceFile());
    return prefix === undefined ? located.path : `${prefix}#${located.path}`;
  }

  /** Qualified name, plus `(paramTypes)` for callables so overloads/signatures stay distinguishable. */
  canonicalNameOf(
    declaration: ts.Declaration,
    signatureDeclaration?: ts.SignatureDeclaration,
  ): string | undefined {
    const qualified = this.qualifiedNameOf(declaration);
    if (qualified === undefined) {
      return undefined;
    }
    const callable = signatureDeclaration ?? callableOf(declaration);
    return callable ? `${qualified}(${this.parameterTypes(callable).join(',')})` : qualified;
  }

  /** The canonical name of a symbol as a relation target. */
  targetNameOf(symbol: ts.Symbol, signatureDeclaration?: ts.SignatureDeclaration): string | undefined {
    const declaration = this.primaryDeclaration(symbol);
    if (!declaration) {
      return undefined;
    }
    const origin = this.originOf(declaration.getSourceFile());
    // Project symbols are named after their primary declaration so target ids match their
    // documents; external symbols after the overload actually resolved at the call site.
    return origin.kind === 'owned'
      ? this.canonicalNameOf(declaration)
      : this.canonicalNameOf(declaration, signatureDeclaration);
  }

  parameterTypes(callable: ts.SignatureDeclaration): string[] {
    return callable.parameters
      .filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'))
      .map((parameter) => {
        const text = this.typeText(this.checker.getTypeAtLocation(parameter));
        return parameter.dotDotDotToken ? `...${text}` : text;
      });
  }

  /** Deterministic, readable type text; anonymous object literal types collapse to `{...}`. */
  typeText(type: ts.Type): string {
    if (isAnonymousObjectType(type) && type.getCallSignatures().length === 0) {
      return '{...}';
    }
    const text = this.checker.typeToString(
      type,
      undefined,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    );
    return text.replace(/\s+/g, ' ').trim() || 'unknown';
  }

  /**
   * Which CIIR document kind a declaration is emitted as (undefined = it never gets a document:
   * locals, object-literal members, type-literal members, ...).
   */
  documentKindOf(declaration: ts.Declaration): CiirKind | undefined {
    if (ts.isSourceFile(declaration)) {
      return 'namespace';
    }
    if (
      ts.isClassDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration)
    ) {
      return isTopLevel(declaration) ? 'type' : undefined;
    }
    if (ts.isModuleDeclaration(declaration)) {
      return isTopLevel(declaration) && ts.isIdentifier(declaration.name) ? 'namespace' : undefined;
    }
    if (ts.isFunctionDeclaration(declaration)) {
      return isTopLevel(declaration) ? 'function' : undefined;
    }
    if (ts.isVariableDeclaration(declaration)) {
      if (!isTopLevelVariable(declaration) || !ts.isIdentifier(declaration.name)) {
        return undefined;
      }
      return isFunctionInitializer(declaration.initializer) ? 'function' : 'field';
    }
    const parent = declaration.parent;
    const inClass = parent && ts.isClassDeclaration(parent) && isTopLevel(parent);
    const inInterface = parent && ts.isInterfaceDeclaration(parent) && isTopLevel(parent);
    if (ts.isMethodDeclaration(declaration)) {
      return inClass ? 'method' : undefined;
    }
    if (ts.isMethodSignature(declaration)) {
      return inInterface ? 'method' : undefined;
    }
    if (ts.isConstructorDeclaration(declaration)) {
      return inClass ? 'constructor' : undefined;
    }
    if (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) {
      return inClass ? 'property' : undefined;
    }
    if (ts.isPropertySignature(declaration)) {
      return inInterface ? 'property' : undefined;
    }
    if (ts.isPropertyDeclaration(declaration)) {
      return inClass ? (isAngularOutput(declaration, this.checker) ? 'event' : 'field') : undefined;
    }
    if (ts.isParameter(declaration)) {
      return ts.isParameterPropertyDeclaration(declaration, declaration.parent) &&
        ts.isClassDeclaration(declaration.parent.parent) &&
        isTopLevel(declaration.parent.parent)
        ? 'field'
        : undefined;
    }
    if (ts.isEnumMember(declaration)) {
      return isTopLevel(declaration.parent) ? 'field' : undefined;
    }
    return undefined;
  }

  /** Simple (unqualified) name of a declaration. */
  simpleNameOf(declaration: ts.Declaration): string | undefined {
    if (ts.isConstructorDeclaration(declaration)) {
      return 'constructor';
    }
    if (ts.isSourceFile(declaration)) {
      return undefined;
    }
    const name = ts.getNameOfDeclaration(declaration);
    if (!name) {
      return ts.isClassDeclaration(declaration) || ts.isFunctionDeclaration(declaration)
        ? 'default'
        : undefined;
    }
    if (
      ts.isIdentifier(name) ||
      ts.isPrivateIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name)
    ) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name)) {
      return `[${name.expression.getText()}]`;
    }
    return undefined;
  }

  private symbolPath(declaration: ts.Declaration): { path: string; ambientModule?: string } | undefined {
    const segments: string[] = [];
    let ambientModule: string | undefined;
    let current: ts.Node | undefined = declaration;

    while (current && !ts.isSourceFile(current)) {
      if (
        ts.isModuleBlock(current) ||
        ts.isVariableDeclarationList(current) ||
        ts.isVariableStatement(current)
      ) {
        current = current.parent;
        continue;
      }
      if (ts.isModuleDeclaration(current)) {
        if (ts.isStringLiteral(current.name)) {
          ambientModule = current.name.text; // `declare module 'fs' { ... }`
          break;
        }
        if (current.flags & ts.NodeFlags.GlobalAugmentation) {
          break; // `declare global { ... }`: a global name.
        }
        segments.unshift(current.name.text);
        current = current.parent;
        continue;
      }
      if (ts.isParameter(current) && ts.isParameterPropertyDeclaration(current, current.parent)) {
        segments.unshift(this.simpleNameOf(current) ?? '?');
        current = current.parent.parent; // constructor → class
        continue;
      }
      if (isNamedContainerOrMember(current)) {
        const name = this.simpleNameOf(current as ts.Declaration);
        if (name === undefined) {
          return undefined;
        }
        segments.unshift(name);
        current = current.parent;
        continue;
      }
      return undefined; // declared inside an anonymous container (object/type literal, function body).
    }

    return segments.length > 0 ? { path: segments.join('.'), ambientModule } : undefined;
  }

  private computeOrigin(sourceFile: ts.SourceFile): DeclarationOrigin {
    const owned = this.owners.get(sourceFile.fileName);
    if (owned) {
      return { kind: 'owned', file: owned };
    }
    if (this.program.isSourceFileDefaultLibrary(sourceFile) || sourceFile.hasNoDefaultLib) {
      return { kind: 'library' };
    }
    const fileName = sourceFile.fileName.replace(/\\/g, '/');
    const index = fileName.lastIndexOf(NODE_MODULES);
    if (index >= 0) {
      const packageName = packageNameFrom(fileName.slice(index + NODE_MODULES.length));
      if (packageName === '@types/node') {
        return { kind: 'runtime', packageName: 'node' };
      }
      return {
        kind: 'package',
        packageName: packageName.startsWith('@types/') ? typesPackageTarget(packageName) : packageName,
      };
    }
    return { kind: 'unowned', modulePath: modulePathOf(this.currentProjectRoot, sourceFile.fileName) };
  }
}

/** `@types/scope__name` → `@scope/name`, `@types/lodash` → `lodash`. */
function typesPackageTarget(packageName: string): string {
  const inner = packageName.slice('@types/'.length);
  return inner.includes('__') ? `@${inner.replace('__', '/')}` : inner;
}

function packageNameFrom(pathInsideNodeModules: string): string {
  const parts = pathInsideNodeModules.split('/');
  return parts[0]!.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

export function isTopLevel(node: ts.Node): boolean {
  return ts.isSourceFile(node.parent) || ts.isModuleBlock(node.parent);
}

export function isTopLevelVariable(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent) && isTopLevel(list.parent);
}

export function isFunctionInitializer(
  initializer: ts.Expression | undefined,
): initializer is ts.ArrowFunction | ts.FunctionExpression {
  const unwrapped = initializer && skipOuter(initializer);
  return !!unwrapped && (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped));
}

export function skipOuter(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The signature a declaration contributes to its canonical name, if it is callable. */
export function callableOf(declaration: ts.Declaration): ts.SignatureDeclaration | undefined {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isConstructorDeclaration(declaration)
  ) {
    return declaration;
  }
  if (ts.isVariableDeclaration(declaration) && isFunctionInitializer(declaration.initializer)) {
    return skipOuter(declaration.initializer!) as ts.ArrowFunction | ts.FunctionExpression;
  }
  return undefined;
}

export function hasBody(declaration: ts.Declaration): boolean {
  return (
    (ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isConstructorDeclaration(declaration)) &&
    declaration.body !== undefined
  );
}

function isNamedContainerOrMember(node: ts.Node): boolean {
  return (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    (ts.isVariableDeclaration(node) && isTopLevelVariable(node)) ||
    ((ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
      ts.isClassLike(node.parent) &&
      !ts.isClassExpression(node.parent)) ||
    ((ts.isMethodSignature(node) ||
      ts.isPropertySignature(node) ||
      ts.isConstructSignatureDeclaration(node)) &&
      ts.isInterfaceDeclaration(node.parent)) ||
    ts.isEnumMember(node)
  );
}

function isAnonymousObjectType(type: ts.Type): boolean {
  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous) !== 0 &&
    !type.aliasSymbol
  );
}

/** Angular outputs (`@Output()`, `output()`, `outputFromObservable()`) are CIIR `event`s. */
export function isAngularOutput(declaration: ts.PropertyDeclaration, checker: ts.TypeChecker): boolean {
  const decorated = (ts.getDecorators(declaration) ?? []).some((decorator) => {
    const callee = ts.isCallExpression(decorator.expression)
      ? decorator.expression.expression
      : decorator.expression;
    return angularImportName(callee, checker) === 'Output';
  });
  if (decorated) {
    return true;
  }
  const initializer = declaration.initializer && skipOuter(declaration.initializer);
  if (!initializer || !ts.isCallExpression(initializer)) {
    return false;
  }
  const name = angularImportName(initializer.expression, checker);
  return name === 'output' || name === 'outputFromObservable';
}

/**
 * If `expression` (an identifier, or `ns.name` over a namespace import) refers to something
 * imported from an `@angular/*` package, returns the imported name. Works from the import
 * declaration itself, so it holds even when `node_modules` is missing.
 */
export function angularImportName(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const imported = importOf(expression, checker);
  return imported && imported.module.startsWith('@angular/') ? imported.name : undefined;
}

export function importOf(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): { module: string; name: string } | undefined {
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const namespace = importOf(expression.expression, checker);
    return namespace?.name === '*' ? { module: namespace.module, name: expression.name.text } : undefined;
  }
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol?.declarations?.[0];
  if (!declaration) {
    return undefined;
  }
  if (ts.isImportSpecifier(declaration)) {
    const module = declaration.parent.parent.parent.moduleSpecifier;
    return ts.isStringLiteral(module)
      ? { module: module.text, name: (declaration.propertyName ?? declaration.name).text }
      : undefined;
  }
  if (ts.isNamespaceImport(declaration)) {
    const module = declaration.parent.parent.moduleSpecifier;
    return ts.isStringLiteral(module) ? { module: module.text, name: '*' } : undefined;
  }
  return undefined;
}

export function relativeTo(root: string, path: string): string {
  return toPosixRelative(root, path);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
