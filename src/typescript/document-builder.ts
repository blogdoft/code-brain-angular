import ts from 'typescript';
import type { DiscoveredProject } from '../application/model.js';
import { attachEmbeddingText, type EmbeddingTextPolicy } from '../core/embedding-text.js';
import { computeId } from '../core/identity.js';
import {
  SCHEMA_VERSION,
  type CiirDocument,
  type CiirKind,
  type CiirMethodInfo,
  type CiirParameter,
  type CiirRelation,
  type CiirSourceLocation,
  type CiirSymbol,
} from '../core/model.js';
import {
  classArtifact,
  constructorInjections,
  memberAngularInfo,
  variableAngularInfo,
  type AngularContext,
} from './angular/angular-metadata.js';
import { controlFlowOf, extractConditions } from './flow-analysis.js';
import type { OwnedFile } from './project-files.js';
import type { BodyFacts, RelationExtractor } from './relation-extractor.js';
import {
  commentsWithin,
  documentationOf,
  memberAccessibility,
  modifiersOf,
  nodeRange,
  sourceLocationOf,
  topLevelAccessibility,
} from './source-evidence.js';
import { callableOf, isFunctionInitializer, skipOuter, type SymbolNaming } from './symbol-naming.js';
import type { TargetResolver } from './target-resolver.js';

export interface DocumentBuilderDependencies {
  project: DiscoveredProject;
  checker: ts.TypeChecker;
  naming: SymbolNaming;
  targets: TargetResolver;
  relations: RelationExtractor;
  angular: AngularContext;
  policy: EmbeddingTextPolicy;
  rootDirectory: string;
  includeSource: boolean;
}

type Draft = Omit<CiirDocument, 'schemaVersion' | 'id' | 'kind' | 'language' | 'project' | 'symbol'>;

const MEMBER_ORDER: Readonly<Partial<Record<CiirKind, number>>> = {
  constructor: 0,
  method: 1,
  property: 2,
  field: 3,
  event: 4,
};

/**
 * Turns one source file into CIIR documents: the module (`namespace`), its top-level
 * declarations in source order, and each type's members in canonical member order. One semantic
 * entity = one document, however many physical declarations (overloads, get/set, merging) it has.
 */
export class DocumentBuilder {
  private readonly emitted = new Set<ts.Symbol>();

  constructor(private readonly deps: DocumentBuilderDependencies) {}

  build(sourceFile: ts.SourceFile, file: OwnedFile): CiirDocument[] {
    const documents: CiirDocument[] = [this.moduleDocument(sourceFile, file)];
    const container = ts.isExternalModule(sourceFile) ? file.modulePath : undefined;
    this.statements(sourceFile.statements, file, container, documents);
    return documents;
  }

  private statements(
    statements: ts.NodeArray<ts.Statement>,
    file: OwnedFile,
    container: string | undefined,
    documents: CiirDocument[],
  ): void {
    for (const statement of statements) {
      if (ts.isClassDeclaration(statement)) {
        this.classDocuments(statement, file, container, documents);
      } else if (ts.isInterfaceDeclaration(statement)) {
        this.interfaceDocuments(statement, file, container, documents);
      } else if (ts.isEnumDeclaration(statement)) {
        this.enumDocuments(statement, file, container, documents);
      } else if (ts.isTypeAliasDeclaration(statement)) {
        this.push(documents, this.typeAliasDocument(statement, file, container));
      } else if (ts.isFunctionDeclaration(statement)) {
        this.push(documents, this.functionDocument(statement, file, container));
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          this.push(documents, this.variableDocument(declaration, file, container));
        }
      } else if (
        ts.isModuleDeclaration(statement) &&
        ts.isIdentifier(statement.name) &&
        statement.body &&
        ts.isModuleBlock(statement.body)
      ) {
        const namespace = this.namespaceDocument(statement, file);
        this.push(documents, namespace);
        this.statements(
          statement.body.statements,
          file,
          namespace?.symbol.qualifiedName ?? container,
          documents,
        );
      }
    }
  }

  // --- module ------------------------------------------------------------------------------

  private moduleDocument(sourceFile: ts.SourceFile, file: OwnedFile): CiirDocument {
    // Top-level statements that declare nothing (e.g. `bootstrapApplication(App, appConfig)`)
    // have no other home than the module itself.
    const executable = sourceFile.statements.filter((statement) => isExecutableStatement(statement));
    const facts = this.deps.relations.extract(executable);
    const name = file.modulePath.slice(file.modulePath.lastIndexOf('/') + 1);

    return this.finish(
      file,
      'namespace',
      { name, qualifiedName: file.modulePath, canonicalName: file.modulePath },
      {
        source: sourceLocationOf(sourceFile, this.deps.rootDirectory, this.deps.includeSource),
        relations: facts.relations,
        conditions: this.conditions(executable),
      },
    );
  }

  private namespaceDocument(node: ts.ModuleDeclaration, file: OwnedFile): CiirDocument | undefined {
    const symbol = this.symbolOf(node, undefined);
    if (!symbol || !this.claim(node)) {
      return undefined;
    }
    return this.finish(file, 'namespace', symbol, { source: this.source(node) });
  }

  // --- types -------------------------------------------------------------------------------

  private classDocuments(
    node: ts.ClassDeclaration,
    file: OwnedFile,
    container: string | undefined,
    documents: CiirDocument[],
  ): void {
    const symbol = this.symbolOf(node, container);
    if (!symbol || !this.claim(node)) {
      return;
    }

    const members: CiirDocument[] = [];
    const angularMembers: { inputs: unknown[]; outputs: unknown[]; injects: string[] } = {
      inputs: [],
      outputs: [],
      injects: [],
    };

    for (const member of node.members) {
      this.memberDocuments(member, file, symbol.qualifiedName, members, angularMembers);
    }

    const artifact = classArtifact(node, this.deps.angular);
    const angular = artifact
      ? {
          ...artifact.extension,
          inputs: angularMembers.inputs,
          outputs: angularMembers.outputs,
          injects: [...new Set(angularMembers.injects)],
        }
      : undefined;

    documents.push(
      this.finish(file, 'type', symbol, {
        source: this.source(node),
        additionalSourceLocations: this.additionalLocations(node),
        documentation: documentationOf(node),
        comments: commentsWithin(node, node.members),
        relations: [...this.heritage(node), ...(artifact?.relations ?? [])],
        type: {
          typeKind: 'class',
          accessibility: topLevelAccessibility(node),
          modifiers: modifiersOf(node),
          genericParameters: node.typeParameters?.map((parameter) => parameter.name.text),
        },
        extensions: angular ? { angular } : undefined,
      }),
      ...sortMembers(members),
    );
  }

  private interfaceDocuments(
    node: ts.InterfaceDeclaration,
    file: OwnedFile,
    container: string | undefined,
    documents: CiirDocument[],
  ): void {
    const symbol = this.symbolOf(node, container);
    if (!symbol || !this.claim(node)) {
      return;
    }
    const members: CiirDocument[] = [];
    // Declaration merging: members of every declaration belong to this one document.
    for (const declaration of this.declarationsOf(node).filter(ts.isInterfaceDeclaration)) {
      for (const member of declaration.members) {
        if (ts.isPropertySignature(member)) {
          this.push(members, this.propertySignatureDocument(member, file, symbol.qualifiedName));
        } else if (ts.isMethodSignature(member)) {
          this.push(members, this.methodDocument(member, file, symbol.qualifiedName, 'public'));
        }
      }
    }

    documents.push(
      this.finish(file, 'type', symbol, {
        source: this.source(node),
        additionalSourceLocations: this.additionalLocations(node),
        documentation: documentationOf(node),
        comments: commentsWithin(node, node.members),
        relations: this.heritage(node),
        type: {
          typeKind: 'interface',
          accessibility: topLevelAccessibility(node),
          modifiers: modifiersOf(node),
          genericParameters: node.typeParameters?.map((parameter) => parameter.name.text),
        },
      }),
      ...sortMembers(members),
    );
  }

  private enumDocuments(
    node: ts.EnumDeclaration,
    file: OwnedFile,
    container: string | undefined,
    documents: CiirDocument[],
  ): void {
    const symbol = this.symbolOf(node, container);
    if (!symbol || !this.claim(node)) {
      return;
    }
    const members: CiirDocument[] = [];
    for (const declaration of this.declarationsOf(node).filter(ts.isEnumDeclaration)) {
      for (const member of declaration.members) {
        const memberSymbol = this.symbolOf(member, symbol.qualifiedName);
        if (!memberSymbol || !this.claim(member)) {
          continue;
        }
        members.push(
          this.finish(file, 'field', memberSymbol, {
            source: this.source(member),
            documentation: documentationOf(member),
            field: { accessibility: 'public', type: symbol.qualifiedName },
          }),
        );
      }
    }

    documents.push(
      this.finish(file, 'type', symbol, {
        source: this.source(node),
        additionalSourceLocations: this.additionalLocations(node),
        documentation: documentationOf(node),
        comments: commentsWithin(node, node.members),
        type: { typeKind: 'enum', accessibility: topLevelAccessibility(node), modifiers: modifiersOf(node) },
      }),
      ...sortMembers(members),
    );
  }

  private typeAliasDocument(
    node: ts.TypeAliasDeclaration,
    file: OwnedFile,
    container: string | undefined,
  ): CiirDocument | undefined {
    const symbol = this.symbolOf(node, container);
    if (!symbol || !this.claim(node)) {
      return undefined;
    }
    const isDelegate = ts.isFunctionTypeNode(node.type) || ts.isConstructorTypeNode(node.type);
    return this.finish(file, 'type', symbol, {
      source: this.source(node),
      documentation: documentationOf(node),
      comments: commentsWithin(node),
      type: {
        typeKind: isDelegate ? 'delegate' : 'unknown',
        accessibility: topLevelAccessibility(node),
        modifiers: modifiersOf(node),
        genericParameters: node.typeParameters?.map((parameter) => parameter.name.text),
      },
      extensions: isDelegate ? undefined : { typescript: { declarationKind: 'type_alias' } },
    });
  }

  private heritage(node: ts.ClassDeclaration | ts.InterfaceDeclaration): CiirRelation[] {
    const relations: CiirRelation[] = [];
    for (const clause of node.heritageClauses ?? []) {
      // Interfaces "extending" interfaces are recorded as `implements`, as in the C# generator.
      const kind =
        clause.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassDeclaration(node)
          ? 'inherits'
          : 'implements';
      for (const type of clause.types) {
        const expression = skipOuter(type.expression);
        const nameNode = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
        const target = this.deps.checker.getSymbolAtLocation(nameNode);
        const relation = target
          ? this.deps.targets.relation(kind, target, nodeRange(type))
          : this.deps.targets.unresolved(
              kind,
              type.expression.getText(),
              'The base type could not be resolved.',
              nodeRange(type),
            );
        if (relation) {
          relations.push(relation);
        }
      }
    }
    return relations;
  }

  // --- class members -----------------------------------------------------------------------

  private memberDocuments(
    member: ts.ClassElement,
    file: OwnedFile,
    container: string,
    documents: CiirDocument[],
    angular: { inputs: unknown[]; outputs: unknown[]; injects: string[] },
  ): void {
    if (ts.isConstructorDeclaration(member)) {
      if (!member.body) {
        return; // an overload signature; the implementation carries the document.
      }
      const constructorDocument = this.methodDocument(member, file, container, memberAccessibility(member));
      this.push(documents, constructorDocument);
      angular.injects.push(...constructorInjections(member, this.deps.angular), ...this.lastFacts.injected);
      for (const parameter of member.parameters) {
        if (ts.isParameterPropertyDeclaration(parameter, member)) {
          this.push(documents, this.parameterPropertyDocument(parameter, file, container));
        }
      }
    } else if (ts.isMethodDeclaration(member)) {
      this.push(documents, this.methodDocument(member, file, container, memberAccessibility(member)));
      angular.injects.push(...this.lastFacts.injected);
    } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      this.push(documents, this.accessorDocument(member, file, container));
      angular.injects.push(...this.lastFacts.injected);
    } else if (ts.isPropertyDeclaration(member)) {
      const info = memberAngularInfo(member, this.deps.checker);
      if (info.input) {
        angular.inputs.push(info.input);
      }
      if (info.output) {
        angular.outputs.push(info.output);
      }
      this.push(documents, this.propertyDeclarationDocument(member, file, container, info.signal));
      angular.injects.push(...this.lastFacts.injected);
    }
  }

  /** Facts of the most recently analyzed body (read by the class to collect `inject()` calls). */
  private lastFacts: BodyFacts = { relations: [], httpCalls: [], injected: [] };

  private methodDocument(
    node: ts.MethodDeclaration | ts.MethodSignature | ts.ConstructorDeclaration,
    file: OwnedFile,
    container: string,
    accessibility: CiirMethodInfo['accessibility'],
  ): CiirDocument | undefined {
    this.lastFacts = { relations: [], httpCalls: [], injected: [] };
    const symbol = this.symbolOf(node, container);
    if (!symbol || !this.claim(node)) {
      return undefined;
    }
    const isConstructor = ts.isConstructorDeclaration(node);
    const body = ts.isMethodSignature(node) ? undefined : node.body;
    const facts = this.facts([...node.parameters, body]);
    const overrides = ts.isMethodDeclaration(node) ? this.overrides(node) : [];

    return this.finish(file, isConstructor ? 'constructor' : 'method', symbol, {
      source: this.source(node),
      additionalSourceLocations: this.additionalLocations(node),
      documentation: documentationOf(node),
      comments: commentsWithin(node),
      relations: [...overrides, ...facts.relations],
      conditions: this.conditions([body]),
      controlFlow: controlFlowOf(body),
      method: this.methodInfo(node, accessibility, !isConstructor),
      extensions: this.httpExtension(facts),
    });
  }

  private accessorDocument(
    node: ts.AccessorDeclaration,
    file: OwnedFile,
    container: string,
  ): CiirDocument | undefined {
    this.lastFacts = { relations: [], httpCalls: [], injected: [] };
    const symbol = this.symbolOf(node, container);
    const tsSymbol = this.symbolAt(node);
    if (!symbol || !tsSymbol || !this.claim(node)) {
      return undefined;
    }
    const accessors = (tsSymbol.declarations ?? []).filter(ts.isAccessor);
    const getter = accessors.find(ts.isGetAccessorDeclaration);
    const setter = accessors.find(ts.isSetAccessorDeclaration);
    const facts = this.facts(accessors.flatMap((accessor) => [...accessor.parameters, accessor.body]));

    return this.finish(file, 'property', symbol, {
      source: this.source(node),
      additionalSourceLocations: this.additionalLocations(node),
      documentation: documentationOf(getter ?? node),
      comments: accessors.flatMap((accessor) => commentsWithin(accessor)),
      relations: [...this.overrides(node), ...facts.relations],
      conditions: this.conditions(accessors.map((accessor) => accessor.body)),
      property: {
        accessibility: memberAccessibility(node),
        modifiers: modifiersOf(node),
        type: this.deps.naming.typeText(this.deps.checker.getTypeOfSymbol(tsSymbol)),
        hasGetter: getter !== undefined,
        hasSetter: setter !== undefined,
      },
      extensions: this.httpExtension(facts),
    });
  }

  private propertyDeclarationDocument(
    node: ts.PropertyDeclaration,
    file: OwnedFile,
    container: string,
    signal: string | undefined,
  ): CiirDocument | undefined {
    this.lastFacts = { relations: [], httpCalls: [], injected: [] };
    const symbol = this.symbolOf(node, container);
    const tsSymbol = this.symbolAt(node);
    if (!symbol || !tsSymbol || !this.claim(node)) {
      return undefined;
    }
    const kind = this.deps.naming.documentKindOf(node) ?? 'field';
    const facts = this.facts([node.initializer]);
    const info = {
      accessibility: memberAccessibility(node),
      modifiers: modifiersOf(node),
      type: this.deps.naming.typeText(this.deps.checker.getTypeOfSymbol(tsSymbol)),
    };
    const angular = {
      ...(signal ? { signal } : {}),
      ...(facts.httpCalls.length > 0 ? { httpCalls: facts.httpCalls } : {}),
    };

    return this.finish(file, kind, symbol, {
      source: this.source(node),
      documentation: documentationOf(node),
      comments: commentsWithin(node),
      relations: [...this.overrides(node), ...facts.relations],
      conditions: this.conditions([node.initializer]),
      ...(kind === 'event' ? { event: info } : { field: info }),
      extensions: Object.keys(angular).length > 0 ? { angular } : undefined,
    });
  }

  private parameterPropertyDocument(
    node: ts.ParameterPropertyDeclaration,
    file: OwnedFile,
    container: string,
  ): CiirDocument | undefined {
    const symbol = this.symbolOf(node, container);
    const property = this.deps.checker.getSymbolsOfParameterPropertyDeclaration(node, node.name.getText())[1];
    if (!symbol || !property || this.emitted.has(property)) {
      return undefined;
    }
    this.emitted.add(property);
    return this.finish(file, 'field', symbol, {
      source: this.source(node),
      field: {
        accessibility: memberAccessibility(node),
        modifiers: modifiersOf(node),
        type: this.deps.naming.typeText(this.deps.checker.getTypeOfSymbol(property)),
      },
    });
  }

  private propertySignatureDocument(
    node: ts.PropertySignature,
    file: OwnedFile,
    container: string,
  ): CiirDocument | undefined {
    const symbol = this.symbolOf(node, container);
    const tsSymbol = this.symbolAt(node);
    if (!symbol || !tsSymbol || !this.claim(node)) {
      return undefined;
    }
    const readonly = (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Readonly) !== 0;
    return this.finish(file, 'property', symbol, {
      source: this.source(node),
      documentation: documentationOf(node),
      comments: commentsWithin(node),
      property: {
        accessibility: 'public',
        modifiers: modifiersOf(node),
        type: this.deps.naming.typeText(this.deps.checker.getTypeOfSymbol(tsSymbol)),
        hasGetter: true,
        hasSetter: !readonly,
      },
    });
  }

  /** A class member whose name also exists on the base class overrides it (every TS method is overridable). */
  private overrides(node: ts.ClassElement): CiirRelation[] {
    const owner = node.parent;
    const name = node.name && !ts.isComputedPropertyName(node.name) ? node.name.getText() : undefined;
    if (
      !name ||
      !ts.isClassDeclaration(owner) ||
      !owner.name ||
      ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static
    ) {
      return [];
    }
    const classSymbol = this.deps.checker.getSymbolAtLocation(owner.name);
    if (!classSymbol) {
      return [];
    }
    const classType = this.deps.checker.getDeclaredTypeOfSymbol(classSymbol);
    for (const base of this.deps.checker.getBaseTypes(classType as ts.InterfaceType)) {
      const baseMember = this.deps.checker.getPropertyOfType(base, name);
      if (baseMember) {
        const relation = this.deps.targets.relation('overrides', baseMember, undefined);
        return relation ? [relation] : [];
      }
    }
    return [];
  }

  // --- top-level functions and variables ---------------------------------------------------

  private functionDocument(
    node: ts.FunctionDeclaration,
    file: OwnedFile,
    container: string | undefined,
  ): CiirDocument | undefined {
    const symbol = this.symbolOf(node, container);
    if (!symbol || !this.claim(node)) {
      return undefined;
    }
    const facts = this.facts([...node.parameters, node.body]);
    return this.finish(file, 'function', symbol, {
      source: this.source(node),
      additionalSourceLocations: this.additionalLocations(node),
      documentation: documentationOf(node),
      comments: commentsWithin(node),
      relations: facts.relations,
      conditions: this.conditions([node.body]),
      controlFlow: controlFlowOf(node.body),
      method: this.methodInfo(node, topLevelAccessibility(node), true),
      extensions: this.httpExtension(facts),
    });
  }

  private variableDocument(
    node: ts.VariableDeclaration,
    file: OwnedFile,
    container: string | undefined,
  ): CiirDocument | undefined {
    const symbol = this.symbolOf(node, container);
    const tsSymbol = this.symbolAt(node);
    if (!symbol || !tsSymbol || !this.claim(node)) {
      return undefined;
    }
    const facts = this.facts([node.initializer]);
    const angularInfo = variableAngularInfo(node, this.deps.angular);
    const angular = {
      ...angularInfo,
      ...(facts.httpCalls.length > 0 ? { httpCalls: facts.httpCalls } : {}),
    };
    const extensions = Object.keys(angular).length > 0 ? { angular } : undefined;
    const common = {
      source: this.source(node),
      documentation: documentationOf(node),
      comments: commentsWithin(node.parent.parent),
      relations: facts.relations,
      conditions: this.conditions([node.initializer]),
      extensions,
    };

    if (isFunctionInitializer(node.initializer)) {
      const fn = callableOf(node) as ts.ArrowFunction | ts.FunctionExpression;
      return this.finish(file, 'function', symbol, {
        ...common,
        controlFlow: controlFlowOf(fn.body),
        method: this.methodInfo(fn, topLevelAccessibility(node), true, modifiersOf(fn)),
      });
    }
    return this.finish(file, 'field', symbol, {
      ...common,
      field: {
        accessibility: topLevelAccessibility(node),
        modifiers: modifiersOf(node),
        type: this.deps.naming.typeText(this.deps.checker.getTypeOfSymbol(tsSymbol)),
      },
    });
  }

  // --- shared helpers ----------------------------------------------------------------------

  private methodInfo(
    node: ts.SignatureDeclaration,
    accessibility: CiirMethodInfo['accessibility'],
    withReturn: boolean,
    modifiers = modifiersOf(node),
  ): CiirMethodInfo {
    const parameters: CiirParameter[] = node.parameters
      .filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'))
      .map((parameter) => ({
        name: parameter.name.getText().replace(/\s+/g, ' '),
        type: this.deps.naming.typeText(this.deps.checker.getTypeAtLocation(parameter)),
      }));

    const info: CiirMethodInfo = { accessibility, modifiers, parameters };
    if (withReturn) {
      const signature = this.deps.checker.getSignatureFromDeclaration(node);
      if (signature) {
        const returnType = this.deps.checker.getReturnTypeOfSignature(signature);
        info.returnType = this.deps.naming.typeText(returnType);
        const unwrapped = this.embeddingReturnType(returnType);
        if (unwrapped) {
          info.embeddingReturnType = unwrapped;
        }
      }
    }
    return info;
  }

  /** `Promise<T>` → `T` (like C#'s `Task<T>`); undefined when there is nothing to unwrap. */
  private embeddingReturnType(type: ts.Type): string | undefined {
    if (type.getSymbol()?.getName() !== 'Promise') {
      return undefined;
    }
    const [inner] = this.deps.checker.getTypeArguments(type as ts.TypeReference);
    if (!inner || inner.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) {
      return undefined;
    }
    return this.deps.naming.typeText(inner);
  }

  private facts(nodes: readonly (ts.Node | undefined)[]): BodyFacts {
    this.lastFacts = this.deps.relations.extract(nodes);
    return this.lastFacts;
  }

  private conditions(nodes: readonly (ts.Node | undefined)[]) {
    return extractConditions(nodes, (expression) => this.deps.relations.readsOf(expression));
  }

  private httpExtension(facts: BodyFacts): CiirDocument['extensions'] {
    return facts.httpCalls.length > 0 ? { angular: { httpCalls: facts.httpCalls } } : undefined;
  }

  private symbolAt(node: ts.Declaration): ts.Symbol | undefined {
    const name = ts.getNameOfDeclaration(node);
    const symbol = name
      ? this.deps.checker.getSymbolAtLocation(name)
      : (node as unknown as { symbol?: ts.Symbol }).symbol;
    return symbol ?? (node as unknown as { symbol?: ts.Symbol }).symbol;
  }

  private declarationsOf(node: ts.Declaration): ts.Declaration[] {
    return this.symbolAt(node)?.declarations ?? [node];
  }

  /**
   * Returns true exactly once per semantic symbol, and only at its primary declaration: other
   * declarations (overload signatures, the other accessor, merged declarations) are folded into
   * that one document's `additionalSourceLocations`.
   */
  private claim(node: ts.Declaration): boolean {
    const symbol = this.symbolAt(node);
    if (!symbol) {
      return true;
    }
    if (this.emitted.has(symbol) || this.deps.naming.primaryDeclaration(symbol) !== node) {
      return false;
    }
    this.emitted.add(symbol);
    return true;
  }

  private additionalLocations(node: ts.Declaration): CiirSourceLocation[] | undefined {
    const others = this.declarationsOf(node)
      .filter(
        (declaration) =>
          declaration !== node && this.deps.naming.originOf(declaration.getSourceFile()).kind === 'owned',
      )
      .sort((a, b) =>
        a.getSourceFile().fileName < b.getSourceFile().fileName
          ? -1
          : a.getSourceFile().fileName > b.getSourceFile().fileName
            ? 1
            : a.getStart() - b.getStart(),
      )
      .map((declaration) => this.source(declaration));
    return others.length > 0 ? others : undefined;
  }

  private source(node: ts.Node): CiirSourceLocation {
    return sourceLocationOf(node, this.deps.rootDirectory, this.deps.includeSource);
  }

  private symbolOf(node: ts.Declaration, container: string | undefined): CiirSymbol | undefined {
    const name = this.deps.naming.simpleNameOf(node);
    const qualifiedName = this.deps.naming.qualifiedNameOf(node);
    const canonicalName = this.deps.naming.canonicalNameOf(node);
    if (!name || !qualifiedName || !canonicalName) {
      return undefined;
    }
    return { name, qualifiedName, canonicalName, ...(container ? { container } : {}) };
  }

  private finish(file: OwnedFile, kind: CiirKind, symbol: CiirSymbol, draft: Draft): CiirDocument {
    const document: CiirDocument = {
      schemaVersion: SCHEMA_VERSION,
      id: computeId(file.language, this.deps.project.name, kind, symbol.canonicalName),
      kind,
      language: file.language,
      project: this.deps.project.name,
      symbol,
      ...draft,
    };
    return attachEmbeddingText(document, this.deps.policy);
  }

  private push(documents: CiirDocument[], document: CiirDocument | undefined): void {
    if (document) {
      documents.push(document);
    }
  }
}

function isExecutableStatement(statement: ts.Statement): boolean {
  if (ts.isVariableStatement(statement)) {
    // Destructuring declarations have no single named entity to attach to.
    return statement.declarationList.declarations.some((declaration) => !ts.isIdentifier(declaration.name));
  }
  return !(
    ts.isImportDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  );
}

function sortMembers(members: CiirDocument[]): CiirDocument[] {
  return members.sort(
    (a, b) =>
      (MEMBER_ORDER[a.kind] ?? 9) - (MEMBER_ORDER[b.kind] ?? 9) ||
      compare(a.symbol.name, b.symbol.name) ||
      compare(a.symbol.canonicalName, b.symbol.canonicalName),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
