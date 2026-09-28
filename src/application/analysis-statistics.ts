import type { CiirDocument } from '../core/model.js';
import type { UnresolvedRelationReport } from './model.js';

const MAX_REPORTED_UNRESOLVED = 200;
const NOT_RESOLVED = new Set(['unresolved', 'ambiguous', 'dynamic']);

/** Accumulates manifest/report counters from the document stream (never the documents themselves). */
export class AnalysisStatistics {
  records = 0;
  types = 0;
  methods = 0;
  functions = 0;
  configurationKeys = 0;
  files = 0;
  relations = 0;
  unresolvedRelations = 0;
  readonly unresolved: UnresolvedRelationReport[] = [];

  observe(document: CiirDocument): void {
    this.records++;
    switch (document.kind) {
      case 'type':
        this.types++;
        break;
      case 'method':
      case 'constructor':
        this.methods++;
        break;
      case 'function':
        this.functions++;
        break;
      case 'configuration_key':
        this.configurationKeys++;
        break;
      case 'file':
        this.files++;
        break;
      default:
        break;
    }

    for (const relation of document.relations ?? []) {
      this.relations++;
      if (!NOT_RESOLVED.has(relation.resolution.status)) {
        continue;
      }
      this.unresolvedRelations++;
      if (this.unresolved.length < MAX_REPORTED_UNRESOLVED) {
        this.unresolved.push({
          source: document.symbol.qualifiedName,
          relation: relation.kind,
          target: relation.target.symbol,
          status: relation.resolution.status,
          reason: relation.resolution.reason,
        });
      }
    }
  }
}
