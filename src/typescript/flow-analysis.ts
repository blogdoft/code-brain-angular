import ts from 'typescript';
import type { CiirCondition, CiirConditionKind, CiirControlFlow } from '../core/model.js';
import { nodeRange } from './source-evidence.js';

/**
 * Extracts branching/looping constructs verbatim (the literal expression text - never
 * interpreted as a business rule). Nested functions are included: a condition inside a callback
 * is still a condition of the enclosing entity's code.
 */
export function extractConditions(
  roots: readonly (ts.Node | undefined)[],
  readsOf: (expression: ts.Node) => string[],
): CiirCondition[] {
  const conditions: CiirCondition[] = [];

  const add = (kind: CiirConditionKind, expression: ts.Node | undefined, statement: ts.Node): void => {
    const reads = expression ? readsOf(expression) : [];
    conditions.push({
      kind,
      expression: expression ? normalize(expression.getText()) : '',
      location: nodeRange(statement),
      ...(reads.length > 0 ? { reads } : {}),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isTypeNode(node)) {
      return;
    }
    if (ts.isIfStatement(node)) {
      add(ifKind(node), node.expression, node);
    } else if (ts.isSwitchStatement(node)) {
      add('switch', node.expression, node);
    } else if (ts.isConditionalExpression(node)) {
      add('conditional_expression', node.condition, node);
    } else if (ts.isWhileStatement(node)) {
      add('while', node.expression, node);
    } else if (ts.isDoStatement(node)) {
      add('do_while', node.expression, node);
    } else if (ts.isForStatement(node)) {
      add('for', node.condition, node);
    } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      add('foreach', node.expression, node);
    }
    ts.forEachChild(node, visit);
  };

  roots.forEach((root) => root && visit(root));
  return conditions;
}

function ifKind(node: ts.IfStatement): CiirConditionKind {
  if (ts.isIfStatement(node.parent) && node.parent.elseStatement === node) {
    return 'else_if';
  }
  return !node.elseStatement && isEarlyExit(node.thenStatement) ? 'guard' : 'if';
}

function isEarlyExit(statement: ts.Statement): boolean {
  const single = ts.isBlock(statement)
    ? statement.statements.length === 1
      ? statement.statements[0]
      : undefined
    : statement;
  return (
    !!single &&
    (ts.isReturnStatement(single) ||
      ts.isThrowStatement(single) ||
      ts.isContinueStatement(single) ||
      ts.isBreakStatement(single))
  );
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const LOOP_KINDS = new Set([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

const SHORT_CIRCUIT_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Aggregate metrics (no CFG API exists in the TypeScript compiler; same documented approximation
 * as the Java generator): complexity = 1 + decision points, basic blocks = decision points + 1.
 * Nested functions have their own graph (as lambdas do in Roslyn's CFG) and are not counted.
 */
export function controlFlowOf(body: ts.Node | undefined): CiirControlFlow | undefined {
  if (!body) {
    return undefined;
  }
  let decisions = 0;
  let loops = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (LOOP_KINDS.has(node.kind)) {
      loops++;
      decisions++;
    } else if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isCatchClause(node)) {
      decisions++;
    } else if (ts.isCaseClause(node)) {
      decisions++;
    } else if (ts.isBinaryExpression(node) && SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind)) {
      decisions++;
    }
    ts.forEachChild(node, visit);
  };

  visit(body);
  return {
    basicBlockCount: decisions + 1,
    cyclomaticComplexity: decisions + 1,
    hasBranches: decisions > 0,
    hasLoops: loops > 0,
  };
}
