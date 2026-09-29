/**
 * Put a .env in order by hand: every setting listed, what's set kept in force
 * (src/config/envFile.ts). Hatchabot does the same at every start.
 *   npm run env:sync [-- path/to/.env]      default ./.env
 *   npm run env:sync -- --example           rewrite .env.example
 * Prints what it did, never a value.
 */
import { writeFileSync } from 'node:fs';
import { renderEnv, syncEnvFile } from '../src/config/envFile.js';

const args = process.argv.slice(2);
if (args.includes('--example')) {
  writeFileSync('.env.example', renderEnv('', { example: true }));
  console.log('.env.example written.');
} else {
  const path = args[0] ?? '.env';
  const r = await syncEnvFile(path);
  if (r.error) { console.error(`Not changed: ${r.error}`); process.exit(1); }
  console.log(r.changed ? `${path} is in order (the old one is at ${r.backup}).` : `${path} was already in order.`);
}
