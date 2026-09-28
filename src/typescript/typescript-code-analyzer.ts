import ts from 'typescript';
import type { DiscoveredProject } from '../application/model.js';
import type { AnalysisContext, AnalyzerOutcome, CodeAnalyzer } from '../application/ports.js';
import { attachEmbeddingText } from '../core/embedding-text.js';
import { computeId } from '../core/identity.js';
import { SCHEMA_VERSION, type CiirDocument } from '../core/model.js';
import { buildAngularIndex, type AngularIndex } from './angular/angular-index.js';
import { DocumentBuilder } from './document-builder.js';
import { TypeScriptNoiseEmbeddingTextPolicy } from './embedding-policy.js';
import { listProjectFiles, type OwnedFile } from './project-files.js';
import { RelationExtractor } from './relation-extractor.js';
import { SymbolNaming } from './symbol-naming.js';
import { TargetResolver } from './target-resolver.js';

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  experimentalDecorators: true,
  strict: true,
};

const POLICY = new TypeScriptNoiseEmbeddingTextPolicy();

/**
 * The TypeScript/JavaScript (+ Angular) generator. One `ts.Program` per project (the equivalent
 * of a Roslyn compilation); documents are streamed file by file and the program is released
 * before the next project is loaded.
 */
export class TypeScriptCodeAnalyzer implements CodeAnalyzer {
  readonly name = 'typescript';

  async analyze(context: AnalysisContext): Promise<AnalyzerOutcome> {
    const outcome: AnalyzerOutcome = { filesAnalyzed: 0, filesIgnored: 0, failures: [], warnings: [] };

    // File ownership across the whole run decides `project` vs `solution` resolution, and the
    // Angular index lets templates match declarables of other projects.
    const fileSets = context.projects.map((project) => ({
      project,
      ...listProjectFiles(project, context.includeTests),
    }));
    const owners = new Map<string, OwnedFile>();
    for (const set of fileSets) {
      outcome.filesIgnored += set.ignored;
      for (const file of set.analyzed) {
        owners.set(normalizeProgramPath(file.path), file);
      }
    }
    const index = buildAngularIndex([...owners.values()]);

    for (const [position, set] of fileSets.entries()) {
      context.signal.throwIfAborted();
      context.progress.projectStarted(position + 1, fileSets.length, set.project.name);
      let entities = 0;
      const emit = async (document: CiirDocument): Promise<void> => {
        entities++;
        await context.emit(document);
      };

      await emit(projectDocument(set.project));

      const program = createProgram(set.project, set.analyzed, outcome);
      if (!program) {
        context.progress.projectCompleted(set.project.name, 0, entities);
        continue;
      }

      const builder = createBuilder(program, set.project, owners, index, context, outcome.warnings);
      for (const file of set.analyzed) {
        context.signal.throwIfAborted();
        const sourceFile = program.getSourceFile(normalizeProgramPath(file.path));
        if (!sourceFile) {
          outcome.warnings.push(`'${file.path}' is not part of the program of '${set.project.name}'.`);
          continue;
        }
        let documents: CiirDocument[];
        try {
          documents = builder.build(sourceFile, file);
        } catch (error) {
          outcome.failures.push({
            project: set.project.name,
            message: `Failed to analyze '${file.modulePath}': ${error instanceof Error ? error.message : String(error)}`,
            category: 'analysis',
          });
          continue;
        }
        for (const document of documents) {
          await emit(document);
        }
        outcome.filesAnalyzed++;
      }
      context.progress.projectCompleted(set.project.name, set.analyzed.length, entities);
    }

    return outcome;
  }
}

function createBuilder(
  program: ts.Program,
  project: DiscoveredProject,
  owners: ReadonlyMap<string, OwnedFile>,
  index: AngularIndex,
  context: AnalysisContext,
  warnings: string[],
): DocumentBuilder {
  const checker = program.getTypeChecker();
  const naming = new SymbolNaming(program, checker, owners, project.rootDir);
  const targets = new TargetResolver(naming, project.name);
  const relations = new RelationExtractor(checker, naming, targets);
  return new DocumentBuilder({
    project,
    checker,
    naming,
    targets,
    relations,
    angular: { checker, naming, targets, index, rootDirectory: context.rootDirectory, warnings },
    policy: POLICY,
    rootDirectory: context.rootDirectory,
    includeSource: context.includeSource,
  });
}

function createProgram(
  project: DiscoveredProject,
  files: readonly OwnedFile[],
  outcome: AnalyzerOutcome,
): ts.Program | undefined {
  let options = DEFAULT_OPTIONS;
  if (project.configFile) {
    const diagnostics: ts.Diagnostic[] = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(
      project.configFile,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );
    if (!parsed || diagnostics.length > 0) {
      outcome.failures.push({
        project: project.name,
        message: `Could not load '${project.configFile}': ${diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ') || 'unknown error'}`,
        category: 'project_load',
      });
      return undefined;
    }
    options = parsed.options;
  }

  return ts.createProgram({
    rootNames: files.map((file) => file.path),
    options: { ...options, allowJs: true, noEmit: true, composite: false, incremental: false },
  });
}

function projectDocument(project: DiscoveredProject): CiirDocument {
  const language = project.kind === 'javascript' ? 'javascript' : 'typescript';
  return attachEmbeddingText(
    {
      schemaVersion: SCHEMA_VERSION,
      id: computeId(language, project.name, 'project', project.name),
      kind: 'project',
      language,
      project: project.name,
      symbol: { name: project.name, qualifiedName: project.name, canonicalName: project.name },
      ...(project.kind === 'angular' ? { extensions: { angular: { artifact: 'project' } } } : {}),
    },
    POLICY,
  );
}

/** The TypeScript program keys source files by forward-slash paths. */
function normalizeProgramPath(path: string): string {
  return path.replace(/\\/g, '/');
}
