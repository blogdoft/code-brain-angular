import { join } from 'node:path';
import { SCHEMA_VERSION, type CiirDocument } from '../core/model.js';
import { AnalysisStatistics } from './analysis-statistics.js';
import { toPosixRelative } from './file-walker.js';
import { resolveInput } from './input-resolver.js';
import {
  ExitCode,
  type AnalysisFailure,
  type AnalysisOptions,
  type AnalysisResult,
  type DiscoveryResult,
  type AnalysisInput,
} from './model.js';
import { discoverProjects } from './project-discovery.js';
import {
  UploadError,
  type ArtifactWriter,
  type CiirUploader,
  type CiirWriter,
  type CiirWriterSession,
  type CodeAnalyzer,
  type Logger,
  type ProgressReporter,
  type WrittenFile,
} from './ports.js';

export const CIIR_FILE_NAME = 'ciir.jsonl';

export interface GeneratorInfo {
  name: string;
  version: string;
}

export interface AnalyzeInputHandlerDependencies {
  generator: GeneratorInfo;
  analyzers: readonly CodeAnalyzer[];
  writer: CiirWriter;
  artifacts: ArtifactWriter;
  uploader: CiirUploader;
  progress: ProgressReporter;
  logger: Logger;
  clock?: () => Date;
}

interface RunState {
  failures: AnalysisFailure[];
  warnings: string[];
  filesAnalyzed: number;
  filesIgnored: number;
}

/**
 * The main use case: resolve the input, discover projects, stream every analyzer's documents to
 * the JSONL writer, write the manifest/report/schema, and optionally upload the result. It knows
 * nothing about TypeScript, Angular or the CLI.
 */
export class AnalyzeInputHandler {
  constructor(private readonly deps: AnalyzeInputHandlerDependencies) {}

  async handle(options: AnalysisOptions, signal: AbortSignal): Promise<AnalysisResult> {
    const resolution = resolveInput(options.inputPath);
    if (!resolution.ok) {
      return { exitCode: ExitCode.InvalidInput, message: resolution.error, failures: [] };
    }

    const discovery = discoverProjects(resolution.input);
    discovery.warnings.forEach((warning) => this.deps.logger.warn(warning));
    this.deps.progress.projectsDiscovered(discovery.projects.length);

    let session: CiirWriterSession;
    try {
      session = await this.deps.writer.open(options.outputDirectory);
    } catch (error) {
      return this.outputFailure(error);
    }

    const statistics = new AnalysisStatistics();
    const state: RunState = {
      failures: [],
      warnings: [...discovery.warnings],
      filesAnalyzed: 0,
      filesIgnored: 0,
    };

    try {
      await this.runAnalyzers(options, discovery, session, statistics, state, signal);
    } catch (error) {
      await session.abort();
      if (signal.aborted) {
        return { exitCode: ExitCode.Cancelled, message: 'Analysis cancelled.', failures: state.failures };
      }
      return this.outputFailure(error);
    }

    let ciirFile: WrittenFile;
    try {
      ciirFile = await session.close();
      const schemaFile = await this.deps.artifacts.writeSchema(options.outputDirectory);
      await this.deps.artifacts.writeJson(
        options.outputDirectory,
        'manifest.json',
        this.manifest(resolution.input, discovery, statistics, state, [ciirFile, schemaFile]),
      );
      await this.deps.artifacts.writeJson(
        options.outputDirectory,
        'analysis-report.json',
        this.report(discovery, statistics, state),
      );
    } catch (error) {
      return this.outputFailure(error);
    }

    const result: AnalysisResult = {
      exitCode:
        options.failOnError && state.failures.length > 0 ? ExitCode.AnalysisFailure : ExitCode.Success,
      outputDirectory: options.outputDirectory,
      records: statistics.records,
      failures: state.failures,
    };

    if (result.exitCode !== ExitCode.Success || !options.send) {
      return result;
    }

    try {
      const upload = await this.deps.uploader.upload(
        join(options.outputDirectory, CIIR_FILE_NAME),
        options.send,
        signal,
      );
      return { ...result, upload };
    } catch (error) {
      const message = error instanceof UploadError ? error.message : `Upload failed: ${describe(error)}`;
      return { ...result, exitCode: ExitCode.UploadFailure, message };
    }
  }

  private async runAnalyzers(
    options: AnalysisOptions,
    discovery: DiscoveryResult,
    session: CiirWriterSession,
    statistics: AnalysisStatistics,
    state: RunState,
    signal: AbortSignal,
  ): Promise<void> {
    const emit = async (document: CiirDocument): Promise<void> => {
      signal.throwIfAborted();
      statistics.observe(document);
      try {
        await session.write(document);
      } catch (error) {
        throw new OutputWriteError(describe(error));
      }
    };

    for (const analyzer of this.deps.analyzers) {
      signal.throwIfAborted();
      try {
        const outcome = await analyzer.analyze({
          rootDirectory: discovery.rootDirectory,
          projects: discovery.projects,
          includeSource: options.includeSource,
          includeTests: options.includeTests,
          signal,
          progress: this.deps.progress,
          logger: this.deps.logger,
          emit,
        });
        state.failures.push(...outcome.failures);
        state.warnings.push(...outcome.warnings);
        state.filesAnalyzed += outcome.filesAnalyzed;
        state.filesIgnored += outcome.filesIgnored;
        outcome.failures.forEach((failure) =>
          this.deps.logger.error(`${failure.project}: ${failure.message}`),
        );
      } catch (error) {
        if (signal.aborted || isWriteError(error)) {
          throw error;
        }
        const failure: AnalysisFailure = {
          project: analyzer.name,
          message: `Analyzer failed unexpectedly: ${describe(error)}`,
          category: 'analysis',
        };
        state.failures.push(failure);
        this.deps.logger.error(failure.message);
      }
    }
  }

  private manifest(
    input: AnalysisInput,
    discovery: DiscoveryResult,
    statistics: AnalysisStatistics,
    state: RunState,
    files: WrittenFile[],
  ): unknown {
    const root = discovery.rootDirectory;
    return {
      format: 'ciir',
      schemaVersion: SCHEMA_VERSION,
      generator: this.deps.generator,
      input: { type: input.type, path: toPosixRelative(root, input.path) },
      generatedAt: (this.deps.clock ?? (() => new Date()))()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
      projects: discovery.projects.map((project) => ({
        name: project.name,
        kind: project.kind,
        path: toPosixRelative(root, project.sourceRoot),
        declaredIn: toPosixRelative(root, project.declaredIn),
        ...(project.configFile ? { config: toPosixRelative(root, project.configFile) } : {}),
      })),
      files: files.map((file) => ({
        path: file.path,
        ...(file.records !== undefined ? { records: file.records } : {}),
        sha256: file.sha256,
      })),
      statistics: {
        projects: discovery.projects.length,
        filesAnalyzed: state.filesAnalyzed,
        types: statistics.types,
        methods: statistics.methods,
        functions: statistics.functions,
        configurationKeys: statistics.configurationKeys,
        files: statistics.files,
        relations: statistics.relations,
        unresolvedRelations: statistics.unresolvedRelations,
      },
    };
  }

  private report(discovery: DiscoveryResult, statistics: AnalysisStatistics, state: RunState): unknown {
    const failedProjects = new Set(
      state.failures.filter((f) => f.category === 'project_load').map((failure) => failure.project),
    );
    return {
      success: state.failures.length === 0,
      projects: {
        discovered: discovery.projects.length,
        analyzed: discovery.projects.length - failedProjects.size,
        failed: failedProjects.size,
      },
      documents: { analyzed: state.filesAnalyzed, ignored: state.filesIgnored },
      relations: {
        resolved: statistics.relations - statistics.unresolvedRelations,
        unresolved: statistics.unresolvedRelations,
      },
      unresolvedRelations: statistics.unresolved,
      errors: state.failures,
      warnings: state.warnings,
    };
  }

  private outputFailure(error: unknown): AnalysisResult {
    return {
      exitCode: ExitCode.OutputFailure,
      message: `Could not write the output: ${describe(error)}`,
      failures: [],
    };
  }
}

/** Marker for errors raised while writing output, which must abort the run rather than be recorded. */
export class OutputWriteError extends Error {}

function isWriteError(error: unknown): boolean {
  return error instanceof OutputWriteError;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
