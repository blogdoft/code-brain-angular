import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { ExitCode } from '../application/model.js';
import { composeHandler } from './composition.js';
import { ConsoleLogger, ConsoleProgress, SILENT_PROGRESS, type Output } from './console-reporting.js';
import { createSendOptions } from './send-options.js';
import { isSplashSuppressed, NO_LOGO_ENVIRONMENT_VARIABLE, renderSplash } from './splash-screen.js';

export const GENERATOR_NAME = 'code-brain-angular';
const MINIMUM_NODE_MAJOR = 20;

/** Multi-letter short aliases (kept identical to the C# `ciir`) that commander cannot declare. */
const ALIASES: Readonly<Record<string, string>> = {
  '-pi': '--projectId',
  '-ci': '--clientId',
  '-cs': '--clientSecret',
};

interface CliOptions {
  output: string;
  verbose?: boolean;
  progress: boolean;
  banner: boolean;
  includeSource?: boolean;
  includeTests?: boolean;
  failOnError?: boolean;
  send?: string | boolean;
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
  token?: string;
  insecure?: boolean;
}

export function toolVersion(): string {
  try {
    const manifest = new URL('../../package.json', import.meta.url);
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? '0.0.0-local';
  } catch {
    return '0.0.0-local';
  }
}

/** Runs the CLI and returns the process exit code. No analysis logic lives here. */
export async function runCli(
  argv: readonly string[],
  output: Output,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  nodeVersion = process.versions.node,
): Promise<number> {
  const version = toolVersion();
  const program = new Command()
    .name(GENERATOR_NAME)
    .description('Analyzes TypeScript/JavaScript (with Angular support) and generates CIIR (ciir.jsonl).')
    .version(version, '--version')
    .argument('<path>', 'angular.json, tsconfig*.json, jsconfig.json, package.json or a directory')
    .option('--output <path>', 'output directory', './ciir-output')
    .option('--verbose', 'verbose diagnostic logging')
    .option('--no-progress', 'suppress progress reporting')
    .option('--no-banner', `suppress the splash screen (also ${NO_LOGO_ENVIRONMENT_VARIABLE}=1|true)`)
    .option('--include-source', "embed each entity's literal source text")
    .option('--include-tests', 'also analyze test files (*.spec.ts, *.test.ts, cypress/, e2e/)')
    .option('--fail-on-error', 'exit with a non-zero code if any project fails to load/analyze')
    .addOption(
      new Option(
        '-s, --send [base-url]',
        'send ciir.jsonl to the code-ciir-indexer (fallback: CIIR_BASE_URL)',
      ),
    )
    .option('--projectId <guid>', 'with --send: id of the project registered in the indexer (alias -pi)')
    .option('--clientId <id>', 'with --send: client id for client credentials (alias -ci)')
    .option('--clientSecret <secret>', 'with --send: client secret for client credentials (alias -cs)')
    .option('-t, --token <jwt>', 'with --send: access token sent as Bearer')
    .option('--insecure', "with --send: do not validate the indexer's TLS certificate")
    .exitOverride()
    .configureOutput({ writeOut: (text) => output.out(text), writeErr: (text) => output.err(text) });

  let path: string;
  let options: CliOptions;
  try {
    program.parse(
      argv.map((argument) => ALIASES[argument] ?? argument),
      { from: 'user' },
    );
    path = program.args[0]!;
    options = program.opts<CliOptions>();
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.Success : ExitCode.InvalidInput;
    }
    throw error;
  }

  if (!isSplashSuppressed(!options.banner, environment[NO_LOGO_ENVIRONMENT_VARIABLE])) {
    output.out(renderSplash(version));
  }

  if (Number(nodeVersion.split('.')[0]) < MINIMUM_NODE_MAJOR) {
    output.err(`error: Node.js ${MINIMUM_NODE_MAJOR} or later is required (running ${nodeVersion}).\n`);
    return ExitCode.EnvironmentFailure;
  }

  const send = createSendOptions(options, environment);
  if (!send.ok) {
    output.err(`error: ${send.error}\n`);
    return ExitCode.InvalidInput;
  }
  send.warnings.forEach((warning) => output.err(`warning: ${warning}\n`));

  const logger = new ConsoleLogger(output, options.verbose === true);
  const progress = options.progress ? new ConsoleProgress(output, true) : SILENT_PROGRESS;
  const handler = composeHandler({ name: GENERATOR_NAME, version }, logger, progress);

  const result = await handler.handle(
    {
      inputPath: path,
      outputDirectory: resolve(options.output),
      includeSource: options.includeSource === true,
      includeTests: options.includeTests === true,
      failOnError: options.failOnError === true,
      send: send.options,
    },
    signal,
  );

  if (result.message) {
    output.err(`error: ${result.message}\n`);
  }
  if (result.outputDirectory && result.exitCode !== ExitCode.OutputFailure) {
    output.out(`CIIR written to ${result.outputDirectory} (${result.records ?? 0} records).\n`);
  }
  if (result.failures.length > 0) {
    output.err(`${result.failures.length} error(s) recorded in analysis-report.json.\n`);
  }
  if (result.upload) {
    output.out(`Sent to the indexer: uploadId=${result.upload.uploadId} status=${result.upload.status}\n`);
  }
  return result.exitCode;
}
