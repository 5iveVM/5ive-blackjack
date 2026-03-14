import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { LocalnetBlackjackEngine } from './src/localnet-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

async function main() {
  const engine = await LocalnetBlackjackEngine.create(projectRoot);

  console.log('[journey] addresses:', engine.getAddresses());

  const init = await engine.initGame({
    minBet: Number(process.env.FIVE_MIN_BET || '10'),
    maxBet: Number(process.env.FIVE_MAX_BET || '100'),
    dealerSoft17Hits: process.env.FIVE_DEALER_SOFT17_HITS !== '0',
    initialChips: Number(process.env.FIVE_INITIAL_CHIPS || '500'),
  });

  const roundStart = await engine.startRound(
    Number(process.env.FIVE_BET || '25'),
    Number(process.env.FIVE_SEED || String(Date.now() % 1_000_000))
  );

  const hit = process.env.FIVE_DO_HIT === '1' ? await engine.hit() : null;
  const maybeStand = engine.getState().player.inRound ? await engine.stand() : null;
  const reads = await engine.readBack();

  const output = {
    setup: engine.setupSteps,
    init,
    roundStart,
    hit,
    stand: maybeStand,
    reads,
    state: engine.getState(),
  };

  console.log(JSON.stringify(output, null, 2));

  const allSteps = [
    ...engine.setupSteps,
    ...init,
    roundStart,
    ...(hit ? [hit] : []),
    ...(maybeStand ? [maybeStand] : []),
    ...reads,
  ];

  const bad = allSteps.find((s) => !s.ok);
  if (bad) {
    throw new Error(`journey failed at ${bad.name}: ${bad.err || 'unknown error'}`);
  }
}

main().catch((error) => {
  console.error('[journey] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
