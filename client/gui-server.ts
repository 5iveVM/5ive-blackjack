import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PublicKey } from '@solana/web3.js';
import { LocalnetBlackjackEngine } from './src/localnet-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
const htmlPath = resolve(projectRoot, 'client', 'gui', 'index.html');

let enginePromise: Promise<LocalnetBlackjackEngine> | null = null;
let queue = Promise.resolve();
let lastAction: unknown = null;

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function getEngine() {
  if (!enginePromise) {
    enginePromise = LocalnetBlackjackEngine.create(projectRoot).catch((err) => {
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

async function parseJson(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: any, status: number, body: any) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url) return sendJson(res, 404, { error: 'missing url' });

    if (req.method === 'GET' && req.url === '/') {
      const html = await readFile(htmlPath, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method !== 'POST' || !req.url.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not found' });
    }

    const payload = await parseJson(req);

    return withLock(async () => {
      const engine = await getEngine();

      if (req.url === '/api/state') {
        return sendJson(res, 200, {
          message: 'state loaded',
          state: engine.getState(),
          addresses: engine.getAddresses(),
          lastAction,
        });
      }

      if (req.url === '/api/ready') {
        const addresses = engine.getAddresses();
        const wallet = String(payload.wallet || '');
        const minSol = Number(payload.minSol || 0.1);
        const minLamports = Math.max(1, Math.floor(minSol * 1_000_000_000));

        const [latestBlockhash, vmInfo, scriptInfo] = await Promise.all([
          engine.connection.getLatestBlockhash('confirmed'),
          engine.connection.getAccountInfo(new PublicKey(addresses.fiveVmProgramId), 'confirmed'),
          engine.connection.getAccountInfo(new PublicKey(addresses.scriptAccount), 'confirmed'),
        ]);

        let walletInfo = null as null | { address: string; lamports: number; balanceSol: number; minSol: number; hasMinFunds: boolean };
        if (wallet) {
          const lamports = await engine.connection.getBalance(new PublicKey(wallet), 'confirmed');
          walletInfo = {
            address: wallet,
            lamports,
            balanceSol: lamports / 1_000_000_000,
            minSol,
            hasMinFunds: lamports >= minLamports,
          };
        }

        const ok = Boolean(latestBlockhash?.blockhash && vmInfo && scriptInfo && (walletInfo ? walletInfo.hasMinFunds : true));
        return sendJson(res, 200, {
          ok,
          validator: { ok: Boolean(latestBlockhash?.blockhash), blockhash: latestBlockhash?.blockhash || null },
          vmProgram: { ok: Boolean(vmInfo), address: addresses.fiveVmProgramId },
          scriptAccount: { ok: Boolean(scriptInfo), address: addresses.scriptAccount },
          wallet: walletInfo,
        });
      }

      if (req.url === '/api/build-wallet-action') {
        const action = String(payload.action || '');
        const wallet = String(payload.wallet || '');
        if (!wallet) {
          return sendJson(res, 400, { error: 'wallet is required' });
        }
        let functionName = '';
        let args: Record<string, any> = {};
        if (action === 'init') {
          functionName = 'init_table';
          args = {
            min_bet: Number(payload.minBet ?? 10),
            max_bet: Number(payload.maxBet ?? 100),
            dealer_soft17_hits: payload.dealerSoft17Hits !== false,
          };
        } else if (action === 'start') {
          functionName = 'start_round';
          args = {
            bet: Number(payload.bet ?? 25),
            seed: Number(payload.seed ?? Date.now() % 1_000_000),
          };
        } else if (action === 'hit') {
          functionName = 'hit';
        } else if (action === 'stand') {
          functionName = 'stand_and_settle';
        } else {
          return sendJson(res, 400, { error: `unsupported action: ${action}` });
        }
        const txBase64 = await engine.buildUnsignedTx(functionName, 'p1', args, wallet);
        return sendJson(res, 200, { action, functionName, txBase64 });
      }

      if (req.url === '/api/commit-wallet-action') {
        const action = String(payload.action || '');
        const signature = String(payload.signature || '');
        if (!signature) {
          return sendJson(res, 400, { error: 'signature is required for commit' });
        }
        if (Boolean(payload.simulated)) {
          return sendJson(res, 400, { error: 'simulated commits are not allowed in strict on-chain mode' });
        }
        await engine.applyLocalAction(action, payload);
        lastAction = { kind: 'wallet-action', action, signature };
        return sendJson(res, 200, { ok: true, state: engine.getState(), addresses: engine.getAddresses(), lastAction });
      }

      return sendJson(res, 404, { error: 'unknown endpoint' });
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const basePort = Number(process.env.GUI_PORT || 4177);
const host = process.env.GUI_HOST || '0.0.0.0';
let activePort = basePort;
let listening = false;

function startListening(port: number) {
  activePort = port;
  server.listen(activePort, host, () => {
    listening = true;
    console.log(`Blackjack GUI server listening on http://${host}:${activePort}`);
  });
}

server.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE' && !listening && activePort < basePort + 20) {
    const next = activePort + 1;
    console.warn(`Port ${activePort} in use, retrying on ${next}...`);
    return startListening(next);
  }
  console.error('GUI server fatal error:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

startListening(basePort);
