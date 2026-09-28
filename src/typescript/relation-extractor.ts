import ts from 'typescript';
import type { CiirRelation, CiirRelationKind } from '../core/model.js';
import { nodeRange } from './source-evidence.js';
import { angularImportName, isTopLevelVariable, skipOuter, type SymbolNaming } from './symbol-naming.js';
import type { TargetResolver } from './target-resolver.js';

export interface HttpCall {
  method: string;
  url: string;
}

/** Everything statically observable in a body/initializer. */
export interface BodyFacts {
  relations: CiirRelation[];
  httpCalls: HttpCall[];
  /** Qualified names passed to Angular's `inject(...)`. */
  injected: string[];
}

const HTTP_CLIENT_PREFIX = '@angular/common#HttpClient.';
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'jsonp']);
const WRITABLE_SIGNAL_PREFIXES = ['@angular/core#WritableSignal.', '@angular/core#ModelSignal.'];
const SIGNAL_WRITERS = new Set(['set', 'update']);

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Walks bodies and initializers, resolving every invocation, construction, member access and
 * throw through the TypeChecker - never from the source text. Only the forward relation is ever
 * recorded.
 */
export class RelationExtractor {
  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly naming: SymbolNaming,
    private readonly targets: TargetResolver,
  ) {}

  extract(nodes: readonly (ts.Node | undefined)[]): BodyFacts {
    const facts: BodyFacts = { relations: [], httpCalls: [], injected: [] };
    const visit = (node: ts.Node): void => this.visit(node, facts, visit);
    nodes.forEach((node) => node && visit(node));
    return facts;
  }

  /** Qualified names of the members/fields read inside an expression (for `conditions[].reads`). */
  readsOf(expression: ts.Node): string[] {
    const reads = this.extract([expression]).relations.filter((relation) => relation.kind === 'reads');
    return [...new Set(reads.map((relation) => relation.target.symbol))];
  }

  private visit(node: ts.Node, facts: BodyFacts, visit: (node: ts.Node) => void): void {
    if (
      ts.isTypeNode(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node)) {
      this.visitCall(node, facts, visit);
      return;
    }
    if (ts.isNewExpression(node)) {
      this.visitNew(node, facts, visit);
      return;
    }
    if (ts.isThrowStatement(node)) {
      this.visitThrow(node, facts);
      visit(node.expression);
      return;
    }
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      this.visitAccess(node.left, 'writes', facts, visit);
      visit(node.right);
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      this.visitAccess(node.operand, 'writes', facts, visit);
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node)) {
      this.visitAccess(node, 'reads', facts, visit);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = this.checker.getShorthandAssignmentValueSymbol(node);
      if (symbol && this.isFieldLike(symbol)) {
        this.push(facts, this.targets.relation('reads', symbol, nodeRange(node)));
      }
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      visit(node.initializer); // the property name is a declaration, not a read.
      return;
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      if (node.initializer) {
        visit(node.initializer);
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node)
    ) {
      node.parameters.forEach(visit);
      if (node.body) {
        visit(node.body);
      }
      return;
    }
    if (ts.isLabeledStatement(node)) {
      visit(node.statement);
      return;
    }
    if (ts.isBreakOrContinueStatement(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  }

  /** Receiver first, then the invocation itself, then its arguments - reading order. */
  private visitCall(node: ts.CallExpression, facts: BodyFacts, visit: (node: ts.Node) => void): void {
    this.visitCallTarget(node, facts, visit);
    node.arguments.forEach(visit);
  }

  private visitCallTarget(node: ts.CallExpression, facts: BodyFacts, visit: (node: ts.Node) => void): void {
    const location = nodeRange(node);

    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return; // dynamic import(): a module load, not an invocation of a symbol.
    }

    const callee = unwrapCallee(node.expression);
    const signature = this.checker.getResolvedSignature(node);
    const signatureDeclaration =
      signature?.declaration && !ts.isJSDocSignature(signature.declaration)
        ? signature.declaration
        : undefined;

    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
      const constructor = signatureDeclaration && symbolOfDeclaration(signatureDeclaration);
      if (constructor) {
        this.push(facts, this.targets.relation('calls', constructor, location, signatureDeclaration));
      }
      return;
    }

    const nameNode = ts.isPropertyAccessExpression(callee)
      ? callee.name
      : ts.isIdentifier(callee)
        ? callee
        : undefined;
    if (ts.isPropertyAccessExpression(callee)) {
      visit(callee.expression);
    } else if (!nameNode) {
      visit(callee);
      return;
    }

    const raw = this.checker.getSymbolAtLocation(nameNode!);
    if (!raw) {
      this.push(facts, this.unresolvedOrDynamic('calls', callee, location));
      return;
    }
    const symbol = this.naming.resolveAlias(raw);

    if (this.isFieldLike(symbol)) {
      // Invoking a field/property value (e.g. reading a signal: `this.count()`) reads it.
      this.push(facts, this.targets.relation('reads', symbol, location));
      return;
    }

    const relation = this.targets.relation('calls', symbol, location, signatureDeclaration);
    this.push(facts, relation);
    if (!relation) {
      return;
    }

    this.recordAngularFacts(node, callee, relation.target.symbol, facts);
  }

  private recordAngularFacts(
    node: ts.CallExpression,
    callee: ts.Expression,
    target: string,
    facts: BodyFacts,
  ): void {
    if (target.startsWith(HTTP_CLIENT_PREFIX)) {
      const method = target.slice(HTTP_CLIENT_PREFIX.length).split('(')[0]!;
      if (HTTP_VERBS.has(method) && node.arguments[0]) {
        facts.httpCalls.push({ method: method.toUpperCase(), url: node.arguments[0].getText() });
      } else if (method === 'request' && node.arguments[1]) {
        facts.httpCalls.push({
          method: node.arguments[0]!.getText()
            .replace(/^['"`]|['"`]$/g, '')
            .toUpperCase(),
          url: node.arguments[1].getText(),
        });
      }
    }

    if (
      ts.isPropertyAccessExpression(callee) &&
      SIGNAL_WRITERS.has(callee.name.text) &&
      WRITABLE_SIGNAL_PREFIXES.some((prefix) => target.startsWith(prefix))
    ) {
      const receiver = memberNameNode(callee.expression);
      const receiverSymbol = receiver && this.checker.getSymbolAtLocation(receiver);
      if (receiverSymbol && this.isFieldLike(this.naming.resolveAlias(receiverSymbol))) {
        this.push(
          facts,
          this.targets.relation('writes', this.naming.resolveAlias(receiverSymbol), nodeRange(node)),
        );
      }
    }

    if (
      ts.isIdentifier(callee) &&
      angularImportName(callee, this.checker) === 'inject' &&
      node.arguments[0]
    ) {
      const token = this.qualifiedNameOfExpression(node.arguments[0]);
      if (token) {
        facts.injected.push(token);
      }
    }
  }

  private visitNew(node: ts.NewExpression, facts: BodyFacts, visit: (node: ts.Node) => void): void {
    this.visitNewTarget(node, facts, visit);
    node.arguments?.forEach(visit);
  }

  private visitNewTarget(node: ts.NewExpression, facts: BodyFacts, visit: (node: ts.Node) => void): void {
    const location = nodeRange(node);
    const expression = skipOuter(node.expression);
    const nameNode = memberNameNode(expression);
    if (ts.isPropertyAccessExpression(expression)) {
      visit(expression.expression);
    }
    const symbol = nameNode && this.checker.getSymbolAtLocation(nameNode);
    if (!symbol) {
      this.push(facts, this.unresolvedOrDynamic('constructs', expression, location));
      return;
    }
    this.push(facts, this.targets.relation('constructs', symbol, location));
  }

  private visitThrow(node: ts.ThrowStatement, facts: BodyFacts): void {
    const location = nodeRange(node);
    const expression = skipOuter(node.expression);
    const nameNode = ts.isNewExpression(expression)
      ? memberNameNode(skipOuter(expression.expression))
      : undefined;
    const symbol = nameNode
      ? this.checker.getSymbolAtLocation(nameNode)
      : this.checker.getTypeAtLocation(expression).getSymbol();
    if (!symbol) {
      this.push(
        facts,
        this.targets.unresolved(
          'throws',
          expression.getText(),
          'The thrown type could not be determined statically.',
          location,
        ),
      );
      return;
    }
    this.push(facts, this.targets.relation('throws', symbol, location));
  }

  private visitAccess(
    node: ts.Expression,
    kind: CiirRelationKind,
    facts: BodyFacts,
    visit: (node: ts.Node) => void,
  ): void {
    const target = skipOuterAndNonNull(node);
    if (ts.isPropertyAccessExpression(target)) {
      visit(target.expression);
      this.recordAccess(target.name, target, kind, facts);
      return;
    }
    if (ts.isIdentifier(target)) {
      this.recordAccess(target, target, kind, facts);
      return;
    }
    visit(target);
  }

  private recordAccess(
    nameNode: ts.MemberName,
    node: ts.Node,
    kind: CiirRelationKind,
    facts: BodyFacts,
  ): void {
    const raw = this.checker.getSymbolAtLocation(nameNode);
    if (!raw) {
      return; // untyped property access or unknown identifier: nothing provable.
    }
    const symbol = this.naming.resolveAlias(raw);
    if (this.isFieldLike(symbol)) {
      this.push(facts, this.targets.relation(kind, symbol, nodeRange(node)));
    }
  }

  /** Properties, accessors, enum members and module-level variables - never locals or parameters. */
  private isFieldLike(symbol: ts.Symbol): boolean {
    if (symbol.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Accessor | ts.SymbolFlags.EnumMember)) {
      return true;
    }
    if (symbol.flags & ts.SymbolFlags.Variable) {
      const declaration = symbol.valueDeclaration;
      return !!declaration && ts.isVariableDeclaration(declaration) && isTopLevelVariable(declaration);
    }
    return false;
  }

  private qualifiedNameOfExpression(expression: ts.Expression): string | undefined {
    const nameNode = memberNameNode(skipOuter(expression));
    const symbol = nameNode && this.checker.getSymbolAtLocation(nameNode);
    const declaration = symbol && this.naming.primaryDeclaration(this.naming.resolveAlias(symbol));
    return declaration ? this.naming.qualifiedNameOf(declaration) : undefined;
  }

  private unresolvedOrDynamic(
    kind: CiirRelationKind,
    callee: ts.Expression,
    location: ReturnType<typeof nodeRange>,
  ): CiirRelation {
    const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
    if (receiver && this.checker.getTypeAtLocation(receiver).flags & ts.TypeFlags.Any) {
      return this.targets.dynamic(kind, callee.getText(), location);
    }
    return this.targets.unresolved(
      kind,
      callee.getText(),
      'No symbol could be resolved for the target.',
      location,
    );
  }

  private push(facts: BodyFacts, relation: CiirRelation | undefined): void {
    if (relation) {
      facts.relations.push(relation);
    }
  }
}

function unwrapCallee(expression: ts.Expression): ts.Expression {
  return skipOuterAndNonNull(expression);
}

function skipOuterAndNonNull(expression: ts.Expression): ts.Expression {
  let current = skipOuter(expression);
  while (ts.isNonNullExpression(current)) {
    current = skipOuter(current.expression);
  }
  return current;
}

function memberNameNode(expression: ts.Expression): ts.MemberName | undefined {
  const target = skipOuterAndNonNull(expression);
  if (ts.isPropertyAccessExpression(target)) {
    return target.name;
  }
  return ts.isIdentifier(target) ? target : undefined;
}

function symbolOfDeclaration(declaration: ts.Declaration): ts.Symbol | undefined {
  return (declaration as unknown as { symbol?: ts.Symbol }).symbol;
}
