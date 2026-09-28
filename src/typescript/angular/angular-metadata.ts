import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { toPosixRelative } from '../../application/file-walker.js';
import { sha256Prefixed } from '../../core/hashing.js';
import type { CiirRelation } from '../../core/model.js';
import { angularImportName, skipOuter, type SymbolNaming } from '../symbol-naming.js';
import type { TargetResolver } from '../target-resolver.js';
import { propertyInitializer, propertyName, stringProperty, type AngularIndex } from './angular-index.js';
import { analyzeTemplate, type TemplateOrigin } from './template-analyzer.js';

export interface AngularContext {
  checker: ts.TypeChecker;
  naming: SymbolNaming;
  targets: TargetResolver;
  index: AngularIndex;
  rootDirectory: string;
  warnings: string[];
}

const CLASS_ARTIFACTS: Readonly<Record<string, string>> = {
  Component: 'component',
  Directive: 'directive',
  Pipe: 'pipe',
  Injectable: 'service',
  NgModule: 'module',
};

const REFERENCE_LISTS: Readonly<Record<string, readonly string[]>> = {
  component: ['imports', 'providers', 'viewProviders', 'hostDirectives'],
  directive: ['providers', 'hostDirectives'],
  module: ['declarations', 'imports', 'exports', 'providers', 'bootstrap'],
};

const LIFECYCLE_HOOKS = [
  'ngOnChanges',
  'ngOnInit',
  'ngDoCheck',
  'ngAfterContentInit',
  'ngAfterContentChecked',
  'ngAfterViewInit',
  'ngAfterViewChecked',
  'ngOnDestroy',
];

const SIGNAL_FACTORIES: Readonly<Record<string, string>> = {
  signal: 'signal',
  computed: 'computed',
  linkedSignal: 'linkedSignal',
  input: 'input',
  model: 'model',
  output: 'output',
  outputFromObservable: 'output',
  resource: 'resource',
  rxResource: 'resource',
  httpResource: 'resource',
  viewChild: 'viewChild',
  viewChildren: 'viewChildren',
  contentChild: 'contentChild',
  contentChildren: 'contentChildren',
  toSignal: 'toSignal',
};

const FUNCTIONAL_ARTIFACTS: Readonly<Record<string, string>> = {
  CanActivateFn: 'guard',
  CanActivateChildFn: 'guard',
  CanDeactivateFn: 'guard',
  CanMatchFn: 'guard',
  ResolveFn: 'resolver',
  HttpInterceptorFn: 'interceptor',
  ApplicationConfig: 'application_config',
};

export interface ClassArtifact {
  extension: Record<string, unknown>;
  relations: CiirRelation[];
}

/** The Angular artifact a class declares through its decorator, with its metadata and template facts. */
export function classArtifact(node: ts.ClassDeclaration, context: AngularContext): ClassArtifact | undefined {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const call = decorator.expression;
    const callee = ts.isCallExpression(call) ? call.expression : call;
    const artifact = CLASS_ARTIFACTS[angularImportName(callee, context.checker) ?? ''];
    if (!artifact) {
      continue;
    }
    const metadata =
      ts.isCallExpression(call) && call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0])
        ? call.arguments[0]
        : undefined;
    return describeArtifact(node, artifact, metadata, context);
  }
  return undefined;
}

function describeArtifact(
  node: ts.ClassDeclaration,
  artifact: string,
  metadata: ts.ObjectLiteralExpression | undefined,
  context: AngularContext,
): ClassArtifact {
  const extension: Record<string, unknown> = { artifact };
  let relations: CiirRelation[] = [];

  if (metadata) {
    copyLiteral(extension, metadata, 'selector');
    copyLiteral(extension, metadata, 'exportAs');
    copyBoolean(extension, metadata, 'standalone');
    if (artifact === 'pipe') {
      const name = stringProperty(metadata, 'name');
      if (name) {
        extension['pipeName'] = name;
      }
      copyBoolean(extension, metadata, 'pure');
    }
    if (artifact === 'service') {
      const providedIn = propertyInitializer(metadata, 'providedIn');
      if (providedIn) {
        extension['providedIn'] = literalOrReference(providedIn, context);
      }
    }
    const changeDetection = propertyInitializer(metadata, 'changeDetection');
    if (changeDetection) {
      extension['changeDetection'] = ts.isPropertyAccessExpression(changeDetection)
        ? changeDetection.name.text
        : changeDetection.getText();
    }
    for (const key of REFERENCE_LISTS[artifact] ?? []) {
      const initializer = propertyInitializer(metadata, key);
      if (initializer) {
        extension[key] = references(initializer, context);
      }
    }
    if (artifact === 'component') {
      const styles = styleUrls(node, metadata, context.rootDirectory);
      if (styles.length > 0) {
        extension['styleUrls'] = styles;
      }
      const template = templateOf(node, metadata, context);
      if (template) {
        extension['template'] = template.extension;
        relations = template.relations;
      }
    }
  }

  const hooks = LIFECYCLE_HOOKS.filter((hook) =>
    node.members.some((member) => ts.isMethodDeclaration(member) && member.name.getText() === hook),
  );
  if (hooks.length > 0) {
    extension['lifecycleHooks'] = hooks;
  }

  return { extension, relations };
}

function templateOf(
  node: ts.ClassDeclaration,
  metadata: ts.ObjectLiteralExpression,
  context: AngularContext,
): { extension: Record<string, unknown>; relations: CiirRelation[] } | undefined {
  const sourceFile = node.getSourceFile();
  let text: string;
  let origin: TemplateOrigin;
  let path: string | undefined;

  const inline = propertyInitializer(metadata, 'template');
  const url = stringProperty(metadata, 'templateUrl');
  if (inline && (ts.isStringLiteral(inline) || ts.isNoSubstitutionTemplateLiteral(inline))) {
    text = inline.text;
    origin = { kind: 'inline', sourceFile, offset: inline.getStart(sourceFile) + 1 };
  } else if (url) {
    const file = resolve(dirname(sourceFile.fileName), url);
    path = toPosixRelative(context.rootDirectory, file);
    if (!existsSync(file)) {
      context.warnings.push(
        `Template '${path}' referenced by '${toPosixRelative(context.rootDirectory, sourceFile.fileName)}' was not found.`,
      );
      return { extension: { path }, relations: [] };
    }
    text = readFileSync(file, 'utf8');
    origin = { kind: 'file', path };
  } else {
    return undefined;
  }

  const symbol = node.name && context.checker.getSymbolAtLocation(node.name);
  if (!symbol) {
    return undefined;
  }
  const facts = analyzeTemplate(
    text,
    origin,
    context.checker.getDeclaredTypeOfSymbol(symbol),
    context.checker,
    context.targets,
    context.index,
  );
  facts.errors.forEach((error) => context.warnings.push(`Template parse error: ${error}`));

  return {
    extension: {
      ...(path ? { path } : {}),
      hash: sha256Prefixed(text),
      usedComponents: facts.usedComponents,
      usedDirectives: facts.usedDirectives,
      usedPipes: facts.usedPipes,
      unresolvedElements: facts.unresolvedElements,
    },
    relations: facts.relations,
  };
}

function styleUrls(
  node: ts.ClassDeclaration,
  metadata: ts.ObjectLiteralExpression,
  rootDirectory: string,
): string[] {
  const directory = dirname(node.getSourceFile().fileName);
  const single = stringProperty(metadata, 'styleUrl');
  const list = propertyInitializer(metadata, 'styleUrls');
  const urls = [
    ...(single ? [single] : []),
    ...(list && ts.isArrayLiteralExpression(list)
      ? list.elements.filter(ts.isStringLiteralLike).map((element) => element.text)
      : []),
  ];
  return urls.map((url) => toPosixRelative(rootDirectory, resolve(directory, url)));
}

/** Per-member Angular facts: input/output declarations and signal kinds. */
export function memberAngularInfo(
  member: ts.PropertyDeclaration,
  checker: ts.TypeChecker,
): { input?: Record<string, unknown>; output?: Record<string, unknown>; signal?: string } {
  const name = member.name.getText();
  const info: { input?: Record<string, unknown>; output?: Record<string, unknown>; signal?: string } = {};

  for (const decorator of ts.getDecorators(member) ?? []) {
    const call = decorator.expression;
    const callee = ts.isCallExpression(call) ? call.expression : call;
    const decoratorName = angularImportName(callee, checker);
    const argument = ts.isCallExpression(call) ? call.arguments[0] : undefined;
    if (decoratorName === 'Input') {
      const options = argument && ts.isObjectLiteralExpression(argument) ? argument : undefined;
      const alias =
        argument && ts.isStringLiteralLike(argument)
          ? argument.text
          : options && stringProperty(options, 'alias');
      const required = options
        ? propertyInitializer(options, 'required')?.kind === ts.SyntaxKind.TrueKeyword
        : false;
      info.input = { name, ...(alias ? { alias } : {}), required, signal: false };
    } else if (decoratorName === 'Output') {
      const alias = argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
      info.output = { name, ...(alias ? { alias } : {}) };
    }
  }

  const initializer = member.initializer && skipOuter(member.initializer);
  if (!initializer || !ts.isCallExpression(initializer)) {
    return info;
  }
  const { factory, required } = signalFactory(initializer.expression, checker);
  if (!factory) {
    return info;
  }
  info.signal = SIGNAL_FACTORIES[factory];

  const args = initializer.arguments;
  if (factory === 'input' || factory === 'model') {
    const options = optionsArgument(required ? args[0] : args[1]);
    const alias = options && stringProperty(options, 'alias');
    info.input = { name, ...(alias ? { alias } : {}), required, signal: true };
    if (factory === 'model') {
      info.output = { name: `${alias ?? name}Change` };
    }
  } else if (factory === 'output' || factory === 'outputFromObservable') {
    const options = optionsArgument(factory === 'output' ? args[0] : args[1]);
    const alias = options && stringProperty(options, 'alias');
    info.output = { name, ...(alias ? { alias } : {}) };
  }
  return info;
}

function signalFactory(
  callee: ts.Expression,
  checker: ts.TypeChecker,
): { factory?: string; required: boolean } {
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'required') {
    const base = angularImportName(callee.expression, checker);
    return base && SIGNAL_FACTORIES[base] ? { factory: base, required: true } : { required: false };
  }
  const name = angularImportName(callee, checker);
  return name && SIGNAL_FACTORIES[name] ? { factory: name, required: false } : { required: false };
}

function optionsArgument(argument: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  return argument && ts.isObjectLiteralExpression(argument) ? argument : undefined;
}

/** Types injected through constructor parameters (`constructor(private http: HttpClient)`, `@Inject(TOKEN)`). */
export function constructorInjections(
  constructor: ts.ConstructorDeclaration,
  context: AngularContext,
): string[] {
  const injected: string[] = [];
  for (const parameter of constructor.parameters) {
    const token = (ts.getDecorators(parameter) ?? [])
      .map((decorator) => decorator.expression)
      .find(
        (call): call is ts.CallExpression =>
          ts.isCallExpression(call) && angularImportName(call.expression, context.checker) === 'Inject',
      )?.arguments[0];
    if (token) {
      const name = referenceName(token, context);
      if (name) {
        injected.push(name);
      }
      continue;
    }
    if (parameter.type && ts.isTypeReferenceNode(parameter.type)) {
      const name = referenceName(parameter.type.typeName, context);
      if (name) {
        injected.push(name);
      }
    }
  }
  return injected;
}

/** Angular facts of a top-level variable: functional guards/resolvers/interceptors and route tables. */
export function variableAngularInfo(
  declaration: ts.VariableDeclaration,
  context: AngularContext,
): Record<string, unknown> | undefined {
  const typeName = declaredTypeName(declaration, context.checker);
  const artifact = typeName ? FUNCTIONAL_ARTIFACTS[typeName] : undefined;
  if (artifact) {
    return { artifact };
  }
  if (typeName === 'Routes' || typeName === 'Route[]') {
    const initializer = declaration.initializer && skipOuter(declaration.initializer);
    const routes =
      initializer && ts.isArrayLiteralExpression(initializer) ? routeEntries(initializer, '', context) : [];
    return { artifact: 'routes', routes };
  }
  return undefined;
}

/** Name of the declared (or `satisfies`/`as`) type when it is imported from `@angular/*`. */
function declaredTypeName(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): string | undefined {
  const initializer = declaration.initializer;
  const typeNode =
    declaration.type ??
    (initializer && (ts.isSatisfiesExpression(initializer) || ts.isAsExpression(initializer))
      ? initializer.type
      : undefined);
  if (!typeNode) {
    return undefined;
  }
  if (
    ts.isArrayTypeNode(typeNode) &&
    ts.isTypeReferenceNode(typeNode.elementType) &&
    ts.isIdentifier(typeNode.elementType.typeName)
  ) {
    const name = angularImportName(typeNode.elementType.typeName, checker);
    return name ? `${name}[]` : undefined;
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return angularImportName(typeNode.typeName, checker);
  }
  return undefined;
}

function routeEntries(
  array: ts.ArrayLiteralExpression,
  parentPath: string,
  context: AngularContext,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      continue;
    }
    const segment = stringProperty(element, 'path') ?? '';
    const path = `/${[parentPath, segment].filter((part) => part !== '').join('/')}`.replace(/\/+/g, '/');
    const entry: Record<string, unknown> = { path };

    const component = propertyInitializer(element, 'component');
    if (component) {
      entry['component'] = referenceName(component, context) ?? component.getText();
    }
    for (const key of ['loadComponent', 'loadChildren']) {
      const loader = propertyInitializer(element, key);
      if (loader) {
        entry[key] = lazyTarget(loader, context) ?? normalize(loader.getText());
      }
    }
    const redirectTo = propertyInitializer(element, 'redirectTo');
    if (redirectTo) {
      entry['redirectTo'] = ts.isStringLiteralLike(redirectTo)
        ? redirectTo.text
        : normalize(redirectTo.getText());
    }
    copyLiteral(entry, element, 'pathMatch');
    copyLiteral(entry, element, 'title');
    for (const key of ['canActivate', 'canActivateChild', 'canDeactivate', 'canMatch', 'providers']) {
      const initializer = propertyInitializer(element, key);
      if (initializer) {
        entry[key] = references(initializer, context);
      }
    }
    const resolveMap = propertyInitializer(element, 'resolve');
    if (resolveMap && ts.isObjectLiteralExpression(resolveMap)) {
      entry['resolve'] = Object.fromEntries(
        resolveMap.properties
          .filter(ts.isPropertyAssignment)
          .map((property) => [
            propertyName(property.name) ?? property.name.getText(),
            referenceName(property.initializer, context) ?? normalize(property.initializer.getText()),
          ]),
      );
    }

    entries.push(entry);

    const children = propertyInitializer(element, 'children');
    if (children && ts.isArrayLiteralExpression(children)) {
      entries.push(...routeEntries(children, path, context));
    } else if (children) {
      entry['children'] = referenceName(children, context) ?? normalize(children.getText());
    }
  }
  return entries;
}

/** `() => import('./x').then(m => m.X)` → the qualified name of `X` (or of the module's default export). */
function lazyTarget(loader: ts.Expression, context: AngularContext): string | undefined {
  let importCall: ts.CallExpression | undefined;
  let member: string | undefined;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      importCall = node;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'then' &&
      node.arguments[0] &&
      (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      const body = node.arguments[0].body;
      if (ts.isPropertyAccessExpression(body)) {
        member = body.name.text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(loader);

  const specifier = importCall?.arguments[0];
  if (!specifier || !ts.isStringLiteralLike(specifier)) {
    return undefined;
  }
  const moduleSymbol = context.checker.getSymbolAtLocation(specifier);
  const moduleFile = moduleSymbol?.valueDeclaration;
  const prefix =
    moduleFile && ts.isSourceFile(moduleFile) ? context.naming.modulePrefix(moduleFile) : undefined;
  return `${prefix ?? specifier.text}#${member ?? 'default'}`;
}

function references(initializer: ts.Expression, context: AngularContext): string[] {
  const elements = ts.isArrayLiteralExpression(initializer) ? initializer.elements : [initializer];
  return elements.map((element) => referenceName(element, context) ?? normalize(element.getText()));
}

function literalOrReference(expression: ts.Expression, context: AngularContext): string {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return 'null';
  }
  return referenceName(expression, context) ?? normalize(expression.getText());
}

/** The qualified name of the declaration an identifier/`a.b` expression refers to. */
function referenceName(
  expression: ts.Expression | ts.EntityName,
  context: AngularContext,
): string | undefined {
  const node = ts.isQualifiedName(expression)
    ? expression.right
    : ts.isPropertyAccessExpression(expression)
      ? expression.name
      : expression;
  if (!ts.isIdentifier(node)) {
    return undefined;
  }
  const symbol = context.checker.getSymbolAtLocation(node);
  const declaration = symbol && context.naming.primaryDeclaration(context.naming.resolveAlias(symbol));
  return declaration ? context.naming.qualifiedNameOf(declaration) : undefined;
}

function copyLiteral(
  target: Record<string, unknown>,
  literal: ts.ObjectLiteralExpression,
  key: string,
): void {
  const value = stringProperty(literal, key);
  if (value !== undefined) {
    target[key] = value;
  }
}

function copyBoolean(
  target: Record<string, unknown>,
  literal: ts.ObjectLiteralExpression,
  key: string,
): void {
  const value = propertyInitializer(literal, key);
  if (value?.kind === ts.SyntaxKind.TrueKeyword || value?.kind === ts.SyntaxKind.FalseKeyword) {
    target[key] = value.kind === ts.SyntaxKind.TrueKeyword;
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
