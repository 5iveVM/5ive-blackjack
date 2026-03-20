#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const input = (process.argv[2] || '').toLowerCase();
const network = input === 'local' ? 'localnet' : input;

if (!['localnet', 'devnet', 'mainnet'].includes(network)) {
  console.error('Usage: node scripts/run-onchain.mjs <localnet|devnet|mainnet>');
  process.exit(1);
}

const run = (cmd, args, extraEnv = {}) => {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
};

if (network === 'localnet') {
  run('npm', ['run', 'client:run:local']);
  process.exit(0);
}

if (network === 'devnet') {
  run('npm', ['run', 'client:run:devnet']);
  process.exit(0);
}

console.error('Mainnet on-chain test flow is disabled for this project.');
process.exit(1);
