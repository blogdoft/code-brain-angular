#!/usr/bin/env node
import { runCli } from './cli.js';

const controller = new AbortController();
process.once('SIGINT', () => {
  process.stderr.write('\nCancelling...\n');
  controller.abort();
});

const exitCode = await runCli(
  process.argv.slice(2),
  { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
  process.env,
  controller.signal,
);
process.exitCode = exitCode;
