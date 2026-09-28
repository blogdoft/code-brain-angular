import ts from 'typescript';
import { computeId } from '../core/identity.js';
import type { CiirRelation, CiirRelationKind, CiirRange } from '../core/model.js';
import type { SymbolNaming } from './symbol-naming.js';

type Target = Pick<CiirRelation, 'target' | 'resolution'>;

/**
 * Classifies relation targets (resolved / external / unresolved / dynamic, and their origin) and
 * computes `target.id` for targets this generator emits a document for.
 */
export class TargetResolver {
  constructor(
    private readonly naming: SymbolNaming,
    private readonly currentProject: string,
  ) {}

  /** The relation for a statically resolved symbol, or undefined when it has no stable name. */
  relation(
    kind: CiirRelationKind,
    symbol: ts.Symbol,
    location: CiirRange | undefined,
    signatureDeclaration?: ts.SignatureDeclaration,
  ): CiirRelation | undefined {
    const target = this.resolve(this.naming.resolveAlias(symbol), signatureDeclaration);
    return target ? { kind, ...target, ...(location ? { location } : {}) } : undefined;
  }

  unresolved(
    kind: CiirRelationKind,
    text: string,
    reason: string,
    location: CiirRange | undefined,
  ): CiirRelation {
    return {
      kind,
      target: { symbol: text },
      resolution: { status: 'unresolved', origin: 'unknown', reason },
      ...(location ? { location } : {}),
    };
  }

  dynamic(kind: CiirRelationKind, text: string, location: CiirRange | undefined): CiirRelation {
    return {
      kind,
      target: { symbol: text },
      resolution: {
        status: 'dynamic',
        origin: 'unknown',
        reason: "The receiver has type 'any'; the target cannot be determined statically.",
      },
      ...(location ? { location } : {}),
    };
  }

  /** The document id of a project declaration (undefined when it gets no document). */
  documentIdOf(declaration: ts.Declaration): string | undefined {
    const origin = this.naming.originOf(declaration.getSourceFile());
    if (origin.kind !== 'owned') {
      return undefined;
    }
    const kind = this.naming.documentKindOf(declaration);
    const canonical = this.naming.canonicalNameOf(declaration);
    return kind && canonical
      ? computeId(origin.file.language, origin.file.project.name, kind, canonical)
      : undefined;
  }

  private resolve(symbol: ts.Symbol, signatureDeclaration?: ts.SignatureDeclaration): Target | undefined {
    const declaration = this.naming.primaryDeclaration(symbol);
    if (!declaration) {
      return undefined;
    }
    const name = this.naming.targetNameOf(symbol, signatureDeclaration);
    if (!name) {
      return undefined;
    }

    const origin = this.naming.originOf(declaration.getSourceFile());
    switch (origin.kind) {
      case 'owned': {
        const id = this.documentIdOf(declaration);
        return {
          target: { ...(id ? { id } : {}), symbol: name },
          resolution: {
            status: 'resolved',
            origin: origin.file.project.name === this.currentProject ? 'project' : 'solution',
          },
        };
      }
      case 'library':
        return { target: { symbol: name }, resolution: { status: 'external', origin: 'framework' } };
      case 'runtime':
        return { target: { symbol: name }, resolution: { status: 'external', origin: 'runtime' } };
      case 'package':
        return { target: { symbol: name }, resolution: { status: 'external', origin: 'dependency' } };
      default:
        return {
          target: { symbol: name },
          resolution: {
            status: 'external',
            origin: 'unknown',
            reason: 'Declared outside the analyzed projects.',
          },
        };
    }
  }
}
