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

if (process.env.ALLOW_MAINNET_TESTS !== '1') {
  console.error(
    'Mainnet test run blocked. Set ALLOW_MAINNET_TESTS=1 to permit live mainnet transactions.\n' +
    'For non-submitting validation, use: npm run test:onchain:mainnet:preflight'
  );
  process.exit(1);
}

run('npm', ['run', 'client:run:mainnet']);
