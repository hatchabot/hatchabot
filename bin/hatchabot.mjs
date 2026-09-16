#!/usr/bin/env node
// The CLI is TypeScript, so it runs through tsx. The old shebang was
// `env -S npx tsx`, which resolves tsx against the CURRENT DIRECTORY: run
// `hatchabot ls` from anywhere but the checkout and npx offered to download
// tsx first ("Need to install the following packages: tsx… Ok to proceed?").
// This wrapper runs the copy installed beside the CLI instead, so it works
// from any directory and never reaches for the network.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'cli.ts');
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsx)) {
  console.error(`hatchabot: dependencies are missing — run "npm ci" in ${root}`);
  process.exit(1);
}
const child = spawn(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
