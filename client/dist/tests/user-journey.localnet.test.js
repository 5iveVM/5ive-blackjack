import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { LocalnetBlackjackEngine } from '../src/localnet-engine.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..', '..');
function mustPass(step) {
    assert.equal(step.ok, true, `${step.name} failed: ${step.err || 'unknown error'}`);
}
test('full localnet user journey: init -> start -> hit/stand -> replay', async () => {
    const engine = await LocalnetBlackjackEngine.create(projectRoot);
    for (const s of engine.setupSteps) {
        mustPass(s);
    }
    const initSteps = await engine.initGame({
        minBet: 10,
        maxBet: 100,
        dealerSoft17Hits: true,
        initialChips: 500,
    });
    initSteps.forEach(mustPass);
    const round1Start = await engine.startRound(25, 1337);
    mustPass(round1Start);
    const hit1 = await engine.hit();
    mustPass(hit1);
    const stateAfterHit = engine.getState();
    if (stateAfterHit.player.inRound) {
        const stand1 = await engine.stand();
        mustPass(stand1);
    }
    const reads1 = await engine.readBack();
    reads1.forEach(mustPass);
    const stateAfterRound1 = engine.getState();
    assert.equal(stateAfterRound1.player.inRound, false);
    assert.ok([3, 4, 5, 6].includes(stateAfterRound1.player.outcome));
    const chipsAfterRound1 = stateAfterRound1.player.chips;
    const round2Start = await engine.startRound(20, 2026);
    mustPass(round2Start);
    const stand2 = await engine.stand();
    mustPass(stand2);
    const reads2 = await engine.readBack();
    reads2.forEach(mustPass);
    const stateAfterRound2 = engine.getState();
    assert.equal(stateAfterRound2.player.inRound, false);
    assert.ok([3, 4, 5, 6].includes(stateAfterRound2.player.outcome));
    assert.ok(Number.isFinite(stateAfterRound2.player.chips));
    assert.notEqual(stateAfterRound2.player.chips, chipsAfterRound1, 'expected chip balance to change after second round');
});
