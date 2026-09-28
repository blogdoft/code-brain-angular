import type { CiirDocument } from '../core/model.js';
import type { AnalysisFailure, DiscoveredProject, SendOptions, UploadReceipt } from './model.js';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Progress notifications; the presentation of progress is the driving adapter's concern. */
export interface ProgressReporter {
  projectsDiscovered(count: number): void;
  projectStarted(index: number, total: number, name: string): void;
  projectCompleted(name: string, files: number, entities: number): void;
}

export interface AnalysisContext {
  rootDirectory: string;
  projects: readonly DiscoveredProject[];
  includeSource: boolean;
  includeTests: boolean;
  signal: AbortSignal;
  progress: ProgressReporter;
  logger: Logger;
  /** Streams one finished document to the output; documents must never be buffered globally. */
  emit(document: CiirDocument): Promise<void>;
}

export interface AnalyzerOutcome {
  filesAnalyzed: number;
  filesIgnored: number;
  failures: AnalysisFailure[];
  warnings: string[];
}

/** A source-language (or artifact-type) generator. */
export interface CodeAnalyzer {
  readonly name: string;
  analyze(context: AnalysisContext): Promise<AnalyzerOutcome>;
}

export interface WrittenFile {
  path: string;
  records?: number;
  sha256: string;
}

export interface CiirWriterSession {
  write(document: CiirDocument): Promise<void>;
  close(): Promise<WrittenFile>;
  abort(): Promise<void>;
}

export interface CiirWriter {
  open(outputDirectory: string): Promise<CiirWriterSession>;
}

/** Writes the non-JSONL artifacts: the schema copy, manifest and analysis report. */
export interface ArtifactWriter {
  writeSchema(outputDirectory: string): Promise<WrittenFile>;
  writeJson(outputDirectory: string, fileName: string, content: unknown): Promise<void>;
}

export class UploadError extends Error {}

export interface CiirUploader {
  upload(ciirFile: string, options: SendOptions, signal: AbortSignal): Promise<UploadReceipt>;
}
