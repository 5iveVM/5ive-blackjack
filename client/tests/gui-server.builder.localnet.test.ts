import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientRoot = resolve(__dirname, '..', '..');
const port = 4700 + Math.floor(Math.random() * 300);
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

test('gui builder endpoint maps blackjack actions to expected function names', async () => {
  const proc = spawn('node', ['dist/gui-server.js'], {
    cwd: clientRoot,
    stdio: 'pipe',
    env: { ...process.env, GUI_PORT: String(port) },
  });

  try {
    await waitForServerReady();
    const wallet = 'HDaVYzEeTsu5v3YzojroWt3GLAhHNvDja6VnCjURwJHk';

    const cases: Array<{ action: string; functionName: string; payload?: Record<string, unknown> }> = [
      {
        action: 'init',
        functionName: 'init_table',
        payload: { minBet: 10, maxBet: 100, dealerSoft17Hits: true, initialChips: 500 },
      },
      { action: 'start', functionName: 'start_round', payload: { bet: 25, seed: 1337 } },
      { action: 'hit', functionName: 'hit' },
      { action: 'stand', functionName: 'stand_and_settle' },
    ];

    for (const c of cases) {
      const built = await post('/api/build-wallet-action', {
        action: c.action,
        wallet,
        ...(c.payload || {}),
      });
      assert.equal(built.status, 200, `build failed for ${c.action}`);
      assert.equal(String(built.data.functionName || ''), c.functionName);
      assert.ok(typeof built.data.txBase64 === 'string' && built.data.txBase64.length > 10);
    }

    const bad = await post('/api/build-wallet-action', { action: 'unknown-action', wallet });
    assert.equal(bad.status, 400);
    assert.match(String(bad.data.error || ''), /unsupported action/i);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 250));
    if (!proc.killed) proc.kill('SIGKILL');
  }
});
