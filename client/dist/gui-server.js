import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { LocalnetBlackjackEngine } from './src/localnet-engine.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
const htmlPath = resolve(projectRoot, 'client', 'gui', 'index.html');
let enginePromise = null;
let queue = Promise.resolve();
function withLock(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
}
async function getEngine() {
    if (!enginePromise) {
        enginePromise = LocalnetBlackjackEngine.create(projectRoot);
    }
    return enginePromise;
}
async function parseJson(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw)
        return {};
    return JSON.parse(raw);
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
const server = createServer(async (req, res) => {
    try {
        if (!req.url)
            return sendJson(res, 404, { error: 'missing url' });
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
                    lastAction: null,
                });
            }
            if (req.url === '/api/init') {
                const steps = await engine.initGame({
                    minBet: Number(payload.minBet ?? 10),
                    maxBet: Number(payload.maxBet ?? 100),
                    dealerSoft17Hits: payload.dealerSoft17Hits !== false,
                    initialChips: Number(payload.initialChips ?? 500),
                });
                return sendJson(res, 200, {
                    message: 'game initialized',
                    state: engine.getState(),
                    addresses: engine.getAddresses(),
                    lastAction: steps,
                });
            }
            if (req.url === '/api/start') {
                const step = await engine.startRound(Number(payload.bet ?? 25), Number(payload.seed ?? Date.now() % 1_000_000));
                return sendJson(res, step.ok ? 200 : 400, {
                    message: step.ok ? 'round started' : 'start failed',
                    state: engine.getState(),
                    addresses: engine.getAddresses(),
                    lastAction: step,
                });
            }
            if (req.url === '/api/hit') {
                const step = await engine.hit();
                return sendJson(res, step.ok ? 200 : 400, {
                    message: step.ok ? 'hit executed' : 'hit failed',
                    state: engine.getState(),
                    addresses: engine.getAddresses(),
                    lastAction: step,
                });
            }
            if (req.url === '/api/stand') {
                const step = await engine.stand();
                const reads = await engine.readBack();
                return sendJson(res, step.ok ? 200 : 400, {
                    message: step.ok ? 'stand settled' : 'stand failed',
                    state: engine.getState(),
                    addresses: engine.getAddresses(),
                    lastAction: { step, reads },
                });
            }
            return sendJson(res, 404, { error: 'unknown endpoint' });
        });
    }
    catch (error) {
        return sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
const port = Number(process.env.GUI_PORT || 4177);
server.listen(port, () => {
    console.log(`Blackjack GUI server listening on http://127.0.0.1:${port}`);
});
