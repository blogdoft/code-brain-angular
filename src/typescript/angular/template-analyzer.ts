import {
  Binary,
  Call,
  CombinedRecursiveAstVisitor,
  ImplicitReceiver,
  ParsedEventType,
  PropertyRead,
  SafeCall,
  createCssSelectorFromNode,
  parseTemplate,
  type AST,
  type BindingPipe,
  type TmplAstBoundEvent,
  type TmplAstElement,
  type TmplAstLetDeclaration,
  type TmplAstReference,
  type TmplAstTemplate,
  type TmplAstVariable,
} from '@angular/compiler';
import ts from 'typescript';
import type { CiirRange, CiirRelation, CiirRelationKind } from '../../core/model.js';
import { rangeOf } from '../source-evidence.js';
import type { TargetResolver } from '../target-resolver.js';
import type { AngularIndex, DeclarableEntry } from './angular-index.js';

/** Where the template text came from. */
export type TemplateOrigin =
  { kind: 'inline'; sourceFile: ts.SourceFile; offset: number } | { kind: 'file'; path: string };

export interface TemplateFacts {
  relations: CiirRelation[];
  usedComponents: string[];
  usedDirectives: string[];
  usedPipes: string[];
  unresolvedElements: string[];
  errors: string[];
}

const FRAMEWORK_ELEMENTS = new Set(['ng-container', 'ng-template', 'ng-content']);

/**
 * Parses a component template with Angular's own template parser and records:
 * - `calls`/`reads`/`writes` relations to members of the component class itself;
 * - which components/directives (by selector) and pipes (by name) the template uses.
 */
export function analyzeTemplate(
  template: string,
  origin: TemplateOrigin,
  componentType: ts.Type,
  checker: ts.TypeChecker,
  targets: TargetResolver,
  index: AngularIndex,
): TemplateFacts {
  const parsed = parseTemplate(template, origin.kind === 'file' ? origin.path : 'inline-template.html', {
    preserveWhitespaces: false,
    preserveLineEndings: true,
  });

  const locals = new LocalNameCollector();
  locals.visitAllTemplateNodes(parsed.nodes);

  const recorder = new TemplateRecorder(origin, componentType, checker, targets, index, locals.names);
  recorder.visitAllTemplateNodes(parsed.nodes);

  return {
    relations: recorder.relations,
    usedComponents: sorted(recorder.components),
    usedDirectives: sorted(recorder.directives),
    usedPipes: sorted(recorder.pipes),
    unresolvedElements: sorted(recorder.unresolvedElements),
    errors: (parsed.errors ?? []).map((error) => error.toString()),
  };
}

/** Template-scoped names (`@for` items, `let-x`, `#ref`, `@let`) shadow component members. */
class LocalNameCollector extends CombinedRecursiveAstVisitor {
  readonly names = new Set<string>();

  override visitVariable(variable: TmplAstVariable): void {
    this.names.add(variable.name);
  }

  override visitReference(reference: TmplAstReference): void {
    this.names.add(reference.name);
  }

  override visitLetDeclaration(declaration: TmplAstLetDeclaration): void {
    this.names.add(declaration.name);
    super.visitLetDeclaration(declaration);
  }

  /** Entry point (widened from `protected`). */
  override visitAllTemplateNodes(
    nodes: Parameters<CombinedRecursiveAstVisitor['visitAllTemplateNodes']>[0],
  ): void {
    super.visitAllTemplateNodes(nodes);
  }
}

class TemplateRecorder extends CombinedRecursiveAstVisitor {
  readonly relations: CiirRelation[] = [];
  readonly components = new Set<string>();
  readonly directives = new Set<string>();
  readonly pipes = new Set<string>();
  readonly unresolvedElements = new Set<string>();

  constructor(
    private readonly origin: TemplateOrigin,
    private readonly componentType: ts.Type,
    private readonly checker: ts.TypeChecker,
    private readonly targets: TargetResolver,
    private readonly index: AngularIndex,
    private readonly locals: ReadonlySet<string>,
  ) {
    super();
  }

  /** Entry point (widened from `protected`). */
  override visitAllTemplateNodes(
    nodes: Parameters<CombinedRecursiveAstVisitor['visitAllTemplateNodes']>[0],
  ): void {
    super.visitAllTemplateNodes(nodes);
  }

  override visitElement(element: TmplAstElement): void {
    const matched = this.matchDeclarables(element);
    if (
      element.name.includes('-') &&
      !FRAMEWORK_ELEMENTS.has(element.name) &&
      !matched.some((e) => e.kind === 'component')
    ) {
      this.unresolvedElements.add(element.name);
    }
    super.visitElement(element);
  }

  override visitTemplate(template: TmplAstTemplate): void {
    this.matchDeclarables(template);
    super.visitTemplate(template);
  }

  override visitBoundEvent(event: TmplAstBoundEvent): void {
    const handler = unwrap(event.handler);
    if (event.type === ParsedEventType.TwoWay && isMemberRead(handler)) {
      this.record('writes', handler.name, handler);
      return;
    }
    super.visitBoundEvent(event);
  }

  override visitPropertyRead(ast: PropertyRead, context: unknown): void {
    if (isMemberRead(ast)) {
      this.record('reads', ast.name, ast);
      return;
    }
    super.visitPropertyRead(ast, context);
  }

  override visitCall(ast: Call, context: unknown): void {
    this.visitInvocation(ast, context, () => super.visitCall(ast, context));
  }

  override visitSafeCall(ast: SafeCall, context: unknown): void {
    this.visitInvocation(ast, context, () => super.visitSafeCall(ast, context));
  }

  override visitBinary(ast: Binary, context: unknown): void {
    if (Binary.isAssignmentOperation(ast.operation) && isMemberRead(ast.left)) {
      this.record('writes', ast.left.name, ast);
      this.visit(ast.right);
      return;
    }
    super.visitBinary(ast, context);
  }

  override visitPipe(ast: BindingPipe, context: unknown): void {
    this.pipes.add(this.index.pipes.get(ast.name) ?? ast.name);
    super.visitPipe(ast, context);
  }

  private visitInvocation(ast: Call | SafeCall, context: unknown, fallback: () => void): void {
    if (isMemberRead(ast.receiver)) {
      this.record('calls', ast.receiver.name, ast);
      this.visitAll(ast.args, context);
      return;
    }
    fallback();
  }

  private matchDeclarables(node: TmplAstElement | TmplAstTemplate): DeclarableEntry[] {
    const matched: DeclarableEntry[] = [];
    try {
      this.index.matcher.match(createCssSelectorFromNode(node), (_selector, entry) => {
        matched.push(entry);
        (entry.kind === 'component' ? this.components : this.directives).add(entry.qualifiedName);
      });
    } catch {
      // A node that cannot be turned into a selector matches nothing.
    }
    return matched;
  }

  /** `name` is a template expression on the implicit receiver: resolve it against the component. */
  private record(kind: CiirRelationKind, name: string, ast: AST): void {
    if (this.locals.has(name)) {
      return;
    }
    const member = this.checker.getPropertyOfType(this.componentType, name);
    if (!member) {
      return;
    }
    const isMethod = (member.flags & ts.SymbolFlags.Method) !== 0;
    const effectiveKind: CiirRelationKind = kind === 'calls' && !isMethod ? 'reads' : kind;
    const relation = this.targets.relation(effectiveKind, member, this.locationOf(ast));
    if (relation) {
      this.relations.push(relation);
    }
  }

  private locationOf(ast: AST): CiirRange | undefined {
    if (this.origin.kind !== 'inline') {
      return undefined; // a range must be in the same file as the component's own source location.
    }
    const { sourceFile, offset } = this.origin;
    return rangeOf(sourceFile, offset + ast.sourceSpan.start, offset + ast.sourceSpan.end);
  }
}

function unwrap(ast: AST): AST {
  return (ast as { ast?: AST }).ast ?? ast;
}

function isMemberRead(ast: AST): ast is PropertyRead {
  return ast instanceof PropertyRead && ast.receiver instanceof ImplicitReceiver;
}

function sorted(values: Set<string>): string[] {
  return [...values].sort();
}
