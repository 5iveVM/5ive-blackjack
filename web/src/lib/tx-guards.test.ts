import test from "node:test";
import assert from "node:assert/strict";

import {
  decodePrecondition,
  evaluateDealGuard,
  evaluateRoundActionGuard,
  normalizeSeed,
  normalizeWager,
  prepareStartRoundArgs,
} from "./tx-guards";

test("decodePrecondition maps start-round failures", () => {
  const byDecimal = decodePrecondition('{"InstructionError":[0,{"Custom":9006}]}');
  const byHex = decodePrecondition("custom program error: 0x232e");
  assert.equal(byDecimal, "start_round_precondition_failed");
  assert.equal(byHex, "start_round_precondition_failed");
});

test("decodePrecondition maps round-not-active/session failures", () => {
  const byDecimal = decodePrecondition('{"InstructionError":[0,{"Custom":9003}]}');
  const byHex = decodePrecondition("custom program error: 0x232b");
  assert.equal(byDecimal, "round_not_active_or_session_invalid");
  assert.equal(byHex, "round_not_active_or_session_invalid");
});

test("decodePrecondition maps AccountNotFound", () => {
  assert.equal(decodePrecondition("preflight simulation failed: AccountNotFound"), "account_not_found");
});

test("evaluateDealGuard accepts valid preconditions", () => {
  const result = evaluateDealGuard({
    wallet: "walletA",
    wager: 25,
    table: { minBet: 10, maxBet: 100 },
    player: { owner: "walletA", chips: 500, inRound: false, roundStatus: 0 },
  });
  assert.deepEqual(result, {
    ok: true,
    code: "ok",
    reason: "deal preconditions satisfied",
  });
});

test("evaluateDealGuard rejects non-integer wager", () => {
  const result = evaluateDealGuard({
    wallet: "walletA",
    wager: 12.5,
    table: { minBet: 10, maxBet: 100 },
    player: { owner: "walletA", chips: 500, inRound: false, roundStatus: 0 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_wager");
});

test("evaluateDealGuard rejects out-of-bounds wager", () => {
  const result = evaluateDealGuard({
    wallet: "walletA",
    wager: 250,
    table: { minBet: 10, maxBet: 100 },
    player: { owner: "walletA", chips: 500, inRound: false, roundStatus: 0 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "wager_out_of_bounds");
});

test("evaluateRoundActionGuard accepts active round and rejects inactive", () => {
  const ok = evaluateRoundActionGuard({
    action: "hit",
    player: { owner: "walletA", chips: 500, inRound: true, roundStatus: 1 },
  });
  const blocked = evaluateRoundActionGuard({
    action: "stand_and_settle",
    player: { owner: "walletA", chips: 500, inRound: false, roundStatus: 0 },
  });
  assert.equal(ok.ok, true);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "round_not_active");
});

test("normalizeWager clamps and integer-normalizes", () => {
  assert.equal(normalizeWager(49.8, 10, 100), 49);
  assert.equal(normalizeWager(Number.NaN, 10, 100, 25), 25);
  assert.equal(normalizeWager(999, 10, 100), 100);
  assert.equal(normalizeWager(-5, 10, 100), 10);
});

test("normalizeSeed returns non-negative safe integers", () => {
  assert.equal(normalizeSeed(123.9), 123);
  assert.equal(normalizeSeed(-10), 0);
  assert.equal(normalizeSeed(Number.NaN, 7), 7);
});

test("prepareStartRoundArgs produces valid start_round payload", () => {
  const prepared = prepareStartRoundArgs({
    wager: 11.7,
    seed: Number.NaN,
    minBet: 25,
    maxBet: 500,
    fallbackWager: 25,
    fallbackSeed: 42,
  });

  assert.deepEqual(prepared, {
    bet: 25,
    seed: 42,
  });
});
