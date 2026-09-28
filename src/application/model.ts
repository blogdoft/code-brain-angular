/** How the `<path>` argument was interpreted. */
export type AnalysisInputType = 'workspace' | 'project' | 'directory';

export interface AnalysisInput {
  type: AnalysisInputType;
  /** Absolute, normalized path of what the user pointed at. */
  path: string;
}

export type ProjectKind = 'angular' | 'typescript' | 'javascript';

/** One unique project to analyze. Identity = its normalized `sourceRoot`. */
export interface DiscoveredProject {
  name: string;
  kind: ProjectKind;
  /** Project root: module paths (and so symbol names) are relative to it. */
  rootDir: string;
  /** Directory whose files belong to this project. */
  sourceRoot: string;
  /** Subdirectories of `sourceRoot` owned by another (nested) project. */
  excludedDirs: string[];
  /** The tsconfig/jsconfig providing compiler options, when there is one. */
  configFile?: string;
  /** The file this project was declared in (angular.json, package.json, tsconfig.json...). */
  declaredIn: string;
}

export interface DiscoveryResult {
  /** The analysis root: `source.path` values are relative to it. */
  rootDirectory: string;
  projects: DiscoveredProject[];
  warnings: string[];
}

export type IndexerCredentials =
  { kind: 'bearer'; token: string } | { kind: 'client'; clientId: string; clientSecret: string };

export interface SendOptions {
  baseUrl: URL;
  projectId: string;
  credentials?: IndexerCredentials;
  insecure: boolean;
}

export interface AnalysisOptions {
  inputPath: string;
  outputDirectory: string;
  includeSource: boolean;
  includeTests: boolean;
  failOnError: boolean;
  send?: SendOptions;
}

export interface AnalysisFailure {
  project: string;
  message: string;
  category: 'project_load' | 'analysis' | 'configuration';
}

export interface UnresolvedRelationReport {
  source: string;
  relation: string;
  target: string;
  status: string;
  reason?: string;
}

export interface UploadReceipt {
  uploadId: string;
  status: string;
}

export const ExitCode = {
  Success: 0,
  AnalysisFailure: 1,
  InvalidInput: 2,
  OutputFailure: 3,
  EnvironmentFailure: 4,
  UploadFailure: 5,
  Cancelled: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface AnalysisResult {
  exitCode: ExitCodeValue;
  message?: string;
  outputDirectory?: string;
  records?: number;
  failures: AnalysisFailure[];
  upload?: UploadReceipt;
}
