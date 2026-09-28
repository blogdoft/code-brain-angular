import type { Logger, ProgressReporter } from '../application/ports.js';

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

/** Diagnostics go to stderr; `debug` only with `--verbose`. */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly output: Output,
    private readonly verbose: boolean,
  ) {}

  debug(message: string): void {
    if (this.verbose) {
      this.output.err(`debug: ${message}\n`);
    }
  }

  info(message: string): void {
    if (this.verbose) {
      this.output.err(`info: ${message}\n`);
    }
  }

  warn(message: string): void {
    if (this.verbose) {
      this.output.err(`warning: ${message}\n`);
    }
  }

  error(message: string): void {
    this.output.err(`error: ${message}\n`);
  }
}

export class ConsoleProgress implements ProgressReporter {
  constructor(
    private readonly output: Output,
    private readonly enabled: boolean,
  ) {}

  projectsDiscovered(count: number): void {
    if (this.enabled) {
      this.output.out(`Discovering projects...\nFound ${count} project${count === 1 ? '' : 's'}.\n\n`);
    }
  }

  projectStarted(index: number, total: number, name: string): void {
    if (this.enabled) {
      this.output.out(`[${index}/${total}] ${name}\n`);
    }
  }

  projectCompleted(_name: string, files: number, entities: number): void {
    if (this.enabled) {
      this.output.out(
        `       ${files.toLocaleString('en-US')} files\n       ${entities.toLocaleString('en-US')} entities\n\n`,
      );
    }
  }
}

export const SILENT_PROGRESS: ProgressReporter = {
  projectsDiscovered: () => undefined,
  projectStarted: () => undefined,
  projectCompleted: () => undefined,
};
