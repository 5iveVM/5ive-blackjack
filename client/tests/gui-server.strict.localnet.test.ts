import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientRoot = resolve(__dirname, '..', '..');
const port = 4300 + Math.floor(Math.random() * 300);
const guiUrl = `http://127.0.0.1:${port}`;

async function waitForServerReady(timeoutMs = 60000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${guiUrl}/`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('GUI server did not become ready in time');
}

async function post(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${guiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    data: (await res.json()) as Record<string, any>,
  };
}

test('gui server strict mode: ready endpoint works and simulated commits are rejected', async () => {
  const proc = spawn('node', ['dist/gui-server.js'], {
    cwd: clientRoot,
    stdio: 'pipe',
    env: { ...process.env, GUI_PORT: String(port) },
  });

  let output = '';
  proc.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  proc.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForServerReady();

    const ready = await post('/api/ready', {
      wallet: 'HDaVYzEeTsu5v3YzojroWt3GLAhHNvDja6VnCjURwJHk',
      minSol: 0.01,
    });
    assert.equal(ready.status, 200);
    assert.equal(typeof ready.data.ok, 'boolean');
    assert.equal(ready.data.validator?.ok, true);
    assert.equal(ready.data.vmProgram?.ok, true);
    assert.equal(ready.data.scriptAccount?.ok, true);

    const missingSig = await post('/api/commit-wallet-action', {
      action: 'start',
    });
    assert.equal(missingSig.status, 400);
    assert.match(String(missingSig.data.error || ''), /signature is required/i);

    const simulated = await post('/api/commit-wallet-action', {
      action: 'start',
      signature: 'test-sig',
      simulated: true,
    });
    assert.equal(simulated.status, 400);
    assert.match(String(simulated.data.error || ''), /simulated commits are not allowed/i);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 250));
    if (!proc.killed) proc.kill('SIGKILL');
    if (!output.includes('Blackjack GUI server listening')) {
      assert.fail(`GUI server startup logs missing listen line. Logs:\n${output}`);
    }
  }
});
