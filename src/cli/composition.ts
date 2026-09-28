import { AnalyzeInputHandler, type GeneratorInfo } from '../application/analyze-input-handler.js';
import type { Logger, ProgressReporter } from '../application/ports.js';
import { ConfigurationAnalyzer } from '../configuration/configuration-analyzer.js';
import { HttpCiirUploader } from '../indexer-client/http-ciir-uploader.js';
import { FileArtifactWriter } from '../serialization/file-artifact-writer.js';
import { JsonlCiirWriter } from '../serialization/jsonl-ciir-writer.js';
import { TypeScriptCodeAnalyzer } from '../typescript/typescript-code-analyzer.js';

/** The composition root: the only place that knows every concrete adapter. */
export function composeHandler(
  generator: GeneratorInfo,
  logger: Logger,
  progress: ProgressReporter,
): AnalyzeInputHandler {
  return new AnalyzeInputHandler({
    generator,
    analyzers: [new TypeScriptCodeAnalyzer(), new ConfigurationAnalyzer()],
    writer: new JsonlCiirWriter(),
    artifacts: new FileArtifactWriter(),
    uploader: new HttpCiirUploader(),
    progress,
    logger,
  });
}
