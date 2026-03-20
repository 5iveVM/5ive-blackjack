export type TableLike = {
  minBet: number;
  maxBet: number;
};

export type PlayerLike = {
  owner: string;
  chips: number;
  inRound: boolean;
  roundStatus: number;
};

export type GuardResult = {
  ok: boolean;
  code: string;
  reason: string;
};

export function isSessionAuthFailure(message: string): boolean {
  return /custom\":9003|custom program error:\s*0x232b|InstructionError.+Custom\":9003/i.test(message);
}

export function isRoundNoLongerActiveError(message: string): boolean {
  return /custom\":9003|custom program error:\s*0x232b|InstructionError.+Custom\":9003/i.test(message);
}

export function isStartRoundPreconditionFailure(message: string): boolean {
  return /custom\":9006|custom program error:\s*0x232e|InstructionError.+Custom\":9006/i.test(message);
}

export function decodePrecondition(message: string): string {
  if (isStartRoundPreconditionFailure(message)) return "start_round_precondition_failed";
  if (isRoundNoLongerActiveError(message)) return "round_not_active_or_session_invalid";
  if (/AccountNotFound/i.test(message)) return "account_not_found";
  return "unknown";
}

export function evaluateDealGuard(input: {
  wallet: string;
  wager: number;
  table: TableLike | null;
  player: PlayerLike | null;
}): GuardResult {
  if (!input.table) return { ok: false, code: "table_missing", reason: "table account is missing" };
  if (!input.player) return { ok: false, code: "player_missing", reason: "player account is missing" };
  if (!Number.isFinite(input.wager) || !Number.isInteger(input.wager) || input.wager <= 0) {
    return { ok: false, code: "invalid_wager", reason: `wager must be a positive integer; got ${String(input.wager)}` };
  }
  if (input.player.owner !== input.wallet) {
    return { ok: false, code: "owner_mismatch", reason: "player owner does not match connected wallet" };
  }
  if (input.player.inRound) {
    return { ok: false, code: "round_active", reason: "round already active on-chain" };
  }
  if (input.wager < input.table.minBet || input.wager > input.table.maxBet) {
    return {
      ok: false,
      code: "wager_out_of_bounds",
      reason: `wager ${input.wager} outside [${input.table.minBet}, ${input.table.maxBet}]`,
    };
  }
  if (input.player.chips < input.wager) {
    return {
      ok: false,
      code: "insufficient_chips",
      reason: `chips ${input.player.chips} below wager ${input.wager}`,
    };
  }
  return { ok: true, code: "ok", reason: "deal preconditions satisfied" };
}

export function evaluateRoundActionGuard(input: {
  player: PlayerLike | null;
  action: "hit" | "stand_and_settle";
  roundActiveCode?: number;
}): GuardResult {
  const roundActiveCode = input.roundActiveCode ?? 1;
  if (!input.player) return { ok: false, code: "player_missing", reason: "player account is missing" };
  if (!input.player.inRound || input.player.roundStatus !== roundActiveCode) {
    return {
      ok: false,
      code: "round_not_active",
      reason: `${input.action} blocked: in_round=${input.player.inRound}, round_status=${input.player.roundStatus}`,
    };
  }
  return { ok: true, code: "ok", reason: `${input.action} preconditions satisfied` };
}

export function normalizeWager(raw: number, minBet: number, maxBet: number, fallback = 25): number {
  const base = Number.isFinite(raw) ? raw : fallback;
  const floored = Math.floor(base);
  return Math.max(minBet, Math.min(maxBet, Number.isFinite(floored) ? floored : fallback));
}

export function normalizeSeed(raw: number, fallback = 1): number {
  const base = Number.isFinite(raw) ? raw : fallback;
  const floored = Math.floor(base);
  const safe = Number.isFinite(floored) ? floored : fallback;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, safe));
}

export function prepareStartRoundArgs(input: {
  wager: number;
  seed: number;
  minBet: number;
  maxBet: number;
  fallbackWager?: number;
  fallbackSeed?: number;
}): { bet: number; seed: number } {
  const fallbackWager = input.fallbackWager ?? input.minBet;
  const fallbackSeed = input.fallbackSeed ?? 1;
  return {
    bet: normalizeWager(input.wager, input.minBet, input.maxBet, fallbackWager),
    seed: normalizeSeed(input.seed, fallbackSeed),
  };
}
