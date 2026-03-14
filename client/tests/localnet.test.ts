import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(__dirname, '..', '..');
const DIST_MAIN = resolve(CLIENT_DIR, 'dist', 'main.js');

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runClient(extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [DIST_MAIN], {
      cwd: CLIENT_DIR,
      env: {
        ...process.env,
        FIVE_NETWORK: 'localnet',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

test('fails fast when blackjack script account is not configured', async () => {
  const { code, stderr } = await runClient({
    // Explicitly blank to force config-path validation branch.
    FIVE_SCRIPT_ACCOUNT: '',
  });

  assert.notEqual(code, 0);
  assert.match(
    stderr,
    /Missing blackjack script account/i,
    'expected missing script-account guard to trigger before chain calls'
  );
});

test('fails fast when account overrides are placeholders', async () => {
  const { code, stderr } = await runClient({
    // Bypass first guard so execution reaches account-map validation.
    FIVE_SCRIPT_ACCOUNT: '11111111111111111111111111111111',
  });

  assert.notEqual(code, 0);
  assert.match(
    stderr,
    /Missing ACCOUNT_OVERRIDES for init_table/i,
    'expected account override guard to trigger for localnet run'
  );
});
