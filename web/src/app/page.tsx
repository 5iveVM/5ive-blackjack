"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type ConfirmOptions,
  type TransactionSignature,
} from "@solana/web3.js";
import {
  FiveProgram,
  FiveSDK,
  SessionClient,
  stripDslRawHeader,
  scopeHashForFunctions,
  type CreateSessionParams,
} from "@5ive-tech/sdk";
import { Navbar } from "@/components/layout/Navbar";
import { PlayingCard } from "@/components/ui/PlayingCard";
import { useNetworkConfig, type NetworkName } from "@/components/providers/WalletContextProvider";
import {
  decodePrecondition,
  evaluateDealGuard,
  evaluateRoundActionGuard,
  isRoundNoLongerActiveError,
  isSessionAuthFailure,
  isStartRoundPreconditionFailure,
  normalizeWager,
  prepareStartRoundArgs,
} from "@/lib/tx-guards";
import { motion } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type GameAccounts = {
  table: string;
  player: string;
  round: string;
};

type SessionState = {
  delegate: Keypair | null;
  sessionAccount: PublicKey | null;
  status: "unknown" | "active" | "revoked" | "expired";
  nonce: number;
  expiresAtSlot: number | null;
  managerScriptAccount: string;
};

type PlayMode = "direct" | "session";
type SessionConfig = Parameters<FiveProgram["withSession"]>[0];
type SessionPlan = {
  schema: "legacy" | "minimal";
  sessionAddress: string;
  createSessionIx: TransactionInstruction;
  createSessionAccountIx: TransactionInstruction | null;
  topupDelegateIx: TransactionInstruction | null;
};
type SessionClientWithPlanBuilder = SessionClient & {
  buildCreateSessionPlan: (
    params: CreateSessionParams,
    options: {
      connection: Connection;
      payer: PublicKey;
      delegateMinLamports: number;
      delegateTopupLamports: number;
      rpcLabel?: string;
    }
  ) => Promise<SessionPlan>;
};

type GameState = {
  chips: number;
  activeBet: number;
  playerTotal: number;
  dealerTotal: number;
  outcome: number;
  inRound: boolean;
  deckSeed: number;
  ownerMarker: number;
  drawCursor: number;
  playerSoftAces: number;
  dealerSoftAces: number;
  playerCards: number[];
  dealerCards: number[];
  dealerReveal: boolean;
  minBet: number;
  maxBet: number;
  dealerSoft17Hits: boolean;
  initialized: boolean;
  setupDone: boolean;
};

type ResumePromptCandidate = {
  accounts: GameAccounts;
  chips: number;
  activeBet: number;
  playerTotal: number;
  dealerTotal: number;
  inRound: boolean;
  outcome: number;
};

type TrackedSessionRecord = {
  sessionAccount: string;
  managerScriptAccount: string;
  status: "active" | "unknown" | "expired";
  expiresAtSlot: number | null;
  createdAt: string;
  updatedAt: string;
};

const ROUND_IDLE = 0;
const ROUND_ACTIVE = 1;
const ROUND_PLAYER_BUST = 2;
const ROUND_DEALER_BUST = 3;
const ROUND_PLAYER_WIN = 4;
const ROUND_DEALER_WIN = 5;
const ROUND_PUSH = 6;
const SESSION_TTL_SLOTS = Number(process.env.NEXT_PUBLIC_SESSION_TTL_SLOTS || "3000");
const SESSION_DELEGATE_MIN_FEE_LAMPORTS = 500_000;
const SESSION_DELEGATE_TOPUP_LAMPORTS = 2_000_000;
const ENABLE_DELEGATED_SESSION_ACTIONS = process.env.NEXT_PUBLIC_ENABLE_DELEGATED_SESSION_ACTIONS === "1";
const ENABLE_SESSION_DIRECT_FALLBACK = process.env.NEXT_PUBLIC_ENABLE_SESSION_DIRECT_FALLBACK === "1";

const DEFAULT_SESSION_SCOPE_HASH = scopeHashForFunctions(["hit", "stand_and_settle"]);
const SESSION_SCOPE_HASH = process.env.NEXT_PUBLIC_SESSION_SCOPE_HASH || DEFAULT_SESSION_SCOPE_HASH;

const DEFAULT_VM_PROGRAM_ID =
  process.env.NEXT_PUBLIC_FIVE_VM_PROGRAM_ID || "55555SyrYLzydvDMBhAL8uo6h4WETHTm81z8btf6nAVJ";
const DEVNET_SCRIPT_ACCOUNT =
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_DEVNET ||
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT ||
  "";
const LOCALNET_SCRIPT_ACCOUNT =
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_LOCALNET ||
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT ||
  "";
const MAINNET_SCRIPT_ACCOUNT =
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_MAINNET ||
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT ||
  "";
const ACCOUNTS_STORAGE_PREFIX = "five-blackjack-accounts";
const SESSION_STORAGE_PREFIX = "five-blackjack-session";
const SESSION_TRACKER_STORAGE_PREFIX = "five-blackjack-open-sessions";
const SESSION_MANAGER_REVOKE_ABI = {
  name: "SessionManager",
  functions: [
    {
      name: "revoke_session",
      index: 1,
      parameters: [
        { name: "session", type: "Account", is_account: true, attributes: ["mut"] },
        { name: "authority", type: "Account", is_account: true, attributes: ["signer"] },
      ],
      return_type: null,
      visibility: "public",
      is_public: true,
      bytecode_offset: 0,
    },
  ],
};

function decodeBase64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function readU64Le(bytes: Uint8Array, offset: number): bigint {
  if (bytes.length < offset + 8) throw new Error("account data too short for u64 read");
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  }
  return value;
}

function readBool(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 1) throw new Error("account data too short for bool read");
  return bytes[offset] !== 0;
}

type TableSnapshot = {
  authority: string;
  minBet: number;
  maxBet: number;
  dealerSoft17Hits: boolean;
  roundNonce: number;
};

function readPlayerSnapshot(bytes: Uint8Array): {
  owner: string;
  chips: number;
  activeBet: number;
  handTotal: number;
  dealerTotal: number;
  roundStatus: number;
  outcome: number;
  inRound: boolean;
} {
  // PlayerState layout:
  // owner(32), chips(8), active_bet(8), hand_total(8), dealer_total(8),
  // round_status(8), outcome(8), session_nonce(8), in_round(1).
  if (bytes.length < 32) throw new Error("account data too short for owner read");
  const owner = new PublicKey(bytes.slice(0, 32)).toBase58();
  const chips = Number(readU64Le(bytes, 32));
  const activeBet = Number(readU64Le(bytes, 40));
  const handTotal = Number(readU64Le(bytes, 48));
  const dealerTotal = Number(readU64Le(bytes, 56));
  const roundStatus = Number(readU64Le(bytes, 64));
  const outcome = Number(readU64Le(bytes, 72));
  const inRound = readBool(bytes, 88);
  return { owner, chips, activeBet, handTotal, dealerTotal, roundStatus, outcome, inRound };
}

function readTableSnapshot(bytes: Uint8Array): TableSnapshot {
  // BlackjackTable layout:
  // authority(32), min_bet(8), max_bet(8), dealer_soft17_hits(1), round_nonce(8).
  if (bytes.length < 57) throw new Error("account data too short for table read");
  const authority = new PublicKey(bytes.slice(0, 32)).toBase58();
  const minBet = Number(readU64Le(bytes, 32));
  const maxBet = Number(readU64Le(bytes, 40));
  const dealerSoft17Hits = readBool(bytes, 48);
  const roundNonce = Number(readU64Le(bytes, 49));
  return { authority, minBet, maxBet, dealerSoft17Hits, roundNonce };
}

function readRoundSnapshot(bytes: Uint8Array): {
  deckSeed: number;
  ownerMarker: number;
  drawCursor: number;
  playerCardCount: number;
  dealerCardCount: number;
  playerSoftAces: number;
  dealerSoftAces: number;
} {
  return {
    deckSeed: Number(readU64Le(bytes, 0)),
    ownerMarker: Number(readU64Le(bytes, 8)),
    drawCursor: Number(readU64Le(bytes, 16)),
    playerCardCount: Number(readU64Le(bytes, 24)),
    dealerCardCount: Number(readU64Le(bytes, 32)),
    playerSoftAces: Number(readU64Le(bytes, 40)),
    dealerSoftAces: Number(readU64Le(bytes, 48)),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvAccounts(network: NetworkName | "localnet"): GameAccounts | null {
  if (network === "localnet") return null;
  const table =
    network === "mainnet"
      ? process.env.NEXT_PUBLIC_BJ_TABLE_ACCOUNT_MAINNET || process.env.NEXT_PUBLIC_BJ_TABLE_ACCOUNT || ""
      : process.env.NEXT_PUBLIC_BJ_TABLE_ACCOUNT_DEVNET || process.env.NEXT_PUBLIC_BJ_TABLE_ACCOUNT || "";
  const player =
    network === "mainnet"
      ? process.env.NEXT_PUBLIC_BJ_PLAYER_ACCOUNT_MAINNET || process.env.NEXT_PUBLIC_BJ_PLAYER_ACCOUNT || ""
      : process.env.NEXT_PUBLIC_BJ_PLAYER_ACCOUNT_DEVNET || process.env.NEXT_PUBLIC_BJ_PLAYER_ACCOUNT || "";
  const round =
    network === "mainnet"
      ? process.env.NEXT_PUBLIC_BJ_ROUND_ACCOUNT_MAINNET || process.env.NEXT_PUBLIC_BJ_ROUND_ACCOUNT || ""
      : process.env.NEXT_PUBLIC_BJ_ROUND_ACCOUNT_DEVNET || process.env.NEXT_PUBLIC_BJ_ROUND_ACCOUNT || "";
  if (!table || !player || !round) return null;
  return { table, player, round };
}

function accountsStorageKey(input: {
  network: NetworkName | "localnet";
  wallet: string;
  vmProgramId: string;
  scriptAccount: string;
}): string {
  return `${ACCOUNTS_STORAGE_PREFIX}:${input.network}:${input.wallet}:${input.vmProgramId}:${input.scriptAccount}`;
}

function sessionStorageKey(input: {
  network: NetworkName | "localnet";
  wallet: string;
  vmProgramId: string;
  scriptAccount: string;
}): string {
  return `${SESSION_STORAGE_PREFIX}:${input.network}:${input.wallet}:${input.vmProgramId}:${input.scriptAccount}`;
}

function sessionTrackerStorageKey(input: {
  network: NetworkName | "localnet";
  wallet: string;
  vmProgramId: string;
  scriptAccount: string;
}): string {
  return `${SESSION_TRACKER_STORAGE_PREFIX}:${input.network}:${input.wallet}:${input.vmProgramId}:${input.scriptAccount}`;
}

function readStoredAccounts(input: {
  network: NetworkName | "localnet";
  wallet: string | null;
  vmProgramId: string;
  scriptAccount: string;
}): GameAccounts | null {
  if (typeof window === "undefined") return null;
  if (input.network === "localnet") return null;
  if (!input.wallet || !input.scriptAccount) return null;
  const raw = window.localStorage.getItem(
    accountsStorageKey({
      network: input.network,
      wallet: input.wallet,
      vmProgramId: input.vmProgramId,
      scriptAccount: input.scriptAccount,
    })
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GameAccounts>;
    if (!parsed.table || !parsed.player || !parsed.round) return null;
    return { table: parsed.table, player: parsed.player, round: parsed.round };
  } catch {
    return null;
  }
}

function persistAccounts(input: {
  network: NetworkName | "localnet";
  wallet: string | null;
  vmProgramId: string;
  scriptAccount: string;
  accounts: GameAccounts;
}) {
  if (typeof window === "undefined") return;
  if (input.network === "localnet") return;
  if (!input.wallet || !input.scriptAccount) return;
  window.localStorage.setItem(
    accountsStorageKey({
      network: input.network,
      wallet: input.wallet,
      vmProgramId: input.vmProgramId,
      scriptAccount: input.scriptAccount,
    }),
    JSON.stringify(input.accounts)
  );
}

function clearStoredAccounts(input: {
  network: NetworkName | "localnet";
  wallet: string | null;
  vmProgramId: string;
  scriptAccount: string;
}) {
  if (typeof window === "undefined") return;
  if (input.network === "localnet") return;
  if (!input.wallet || !input.scriptAccount) return;
  window.localStorage.removeItem(
    accountsStorageKey({
      network: input.network,
      wallet: input.wallet,
      vmProgramId: input.vmProgramId,
      scriptAccount: input.scriptAccount,
    })
  );
}

function upsertTrackedSessionRecord(
  records: TrackedSessionRecord[],
  next: Omit<TrackedSessionRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }
): TrackedSessionRecord[] {
  const nowIso = new Date().toISOString();
  const idx = records.findIndex((r) => r.sessionAccount === next.sessionAccount);
  if (idx === -1) {
    return [
      {
        ...next,
        createdAt: next.createdAt || nowIso,
        updatedAt: next.updatedAt || nowIso,
      },
      ...records,
    ];
  }
  const prev = records[idx];
  const merged: TrackedSessionRecord = {
    ...prev,
    ...next,
    createdAt: prev.createdAt || next.createdAt || nowIso,
    updatedAt: next.updatedAt || nowIso,
  };
  const out = [...records];
  out[idx] = merged;
  return out;
}

function readTrackedSessions(input: {
  network: NetworkName | "localnet";
  wallet: string | null;
  vmProgramId: string;
  scriptAccount: string;
}): TrackedSessionRecord[] {
  if (typeof window === "undefined") return [];
  if (input.network === "localnet") return [];
  if (!input.wallet || !input.scriptAccount) return [];
  const raw = window.localStorage.getItem(
    sessionTrackerStorageKey({
      network: input.network,
      wallet: input.wallet,
      vmProgramId: input.vmProgramId,
      scriptAccount: input.scriptAccount,
    })
  );
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<Partial<TrackedSessionRecord>>;
    if (!Array.isArray(parsed)) return [];
    const out: TrackedSessionRecord[] = [];
    for (const row of parsed) {
      if (!row?.sessionAccount || !row?.managerScriptAccount) continue;
      try {
        const sessionAccount = new PublicKey(row.sessionAccount).toBase58();
        const managerScriptAccount = new PublicKey(row.managerScriptAccount).toBase58();
        const status =
          row.status === "active" || row.status === "unknown" || row.status === "expired"
            ? row.status
            : "unknown";
        out.push({
          sessionAccount,
          managerScriptAccount,
          status,
          expiresAtSlot: typeof row.expiresAtSlot === "number" ? row.expiresAtSlot : null,
          createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
          updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
        });
      } catch {
        // Ignore malformed records.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function persistTrackedSessions(input: {
  network: NetworkName | "localnet";
  wallet: string | null;
  vmProgramId: string;
  scriptAccount: string;
  sessions: TrackedSessionRecord[];
}) {
  if (typeof window === "undefined") return;
  if (input.network === "localnet") return;
  if (!input.wallet || !input.scriptAccount) return;
  const key = sessionTrackerStorageKey({
    network: input.network,
    wallet: input.wallet,
    vmProgramId: input.vmProgramId,
    scriptAccount: input.scriptAccount,
  });
  if (input.sessions.length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(input.sessions));
}

function emptySessionState(): SessionState {
  return {
    delegate: null,
    sessionAccount: null,
    status: "unknown",
    nonce: 0,
    expiresAtSlot: null,
    managerScriptAccount: "",
  };
}

function readStoredSession(input: {
  network: NetworkName | "localnet";
  wallet: string | null;
  vmProgramId: string;
  scriptAccount: string;
}): SessionState | null {
  if (typeof window === "undefined") return null;
  if (input.network === "localnet") return null;
  if (!input.wallet || !input.scriptAccount) return null;
  const raw = window.localStorage.getItem(
    sessionStorageKey({
      network: input.network,
      wallet: input.wallet,
      vmProgramId: input.vmProgramId,
      scriptAccount: input.scriptAccount,
    })
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      delegateSecretKey?: number[];
      sessionAccount?: string | null;
      status?: SessionState["status"];
      nonce?: number;
      expiresAtSlot?: number | null;
      managerScriptAccount?: string;
    };
    const delegate =
      Array.isArray(parsed.delegateSecretKey) && parsed.delegateSecretKey.length > 0
        ? Keypair.fromSecretKey(Uint8Array.from(parsed.delegateSecretKey))
        : null;
    const sessionAccount =
      typeof parsed.sessionAccount === "string" && parsed.sessionAccount.length > 0
        ? new PublicKey(parsed.sessionAccount)
        : null;
    return {
      delegate,
      sessionAccount,
      status: parsed.status || "unknown",
      nonce: Number(parsed.nonce || 0),
      expiresAtSlot: parsed.expiresAtSlot ?? null,
      managerScriptAccount: parsed.managerScriptAccount || "",
    };
  } catch {
    return null;
  }
}

function persistSession(input: {
  network: NetworkName | "localnet";
  wallet: string | null;
  vmProgramId: string;
  scriptAccount: string;
  session: SessionState;
}) {
  if (typeof window === "undefined") return;
  if (input.network === "localnet") return;
  if (!input.wallet || !input.scriptAccount) return;
  const isEmpty =
    !input.session.delegate &&
    !input.session.sessionAccount &&
    input.session.status === "unknown" &&
    input.session.nonce === 0 &&
    !input.session.expiresAtSlot &&
    !input.session.managerScriptAccount;
  const key = sessionStorageKey({
    network: input.network,
    wallet: input.wallet,
    vmProgramId: input.vmProgramId,
    scriptAccount: input.scriptAccount,
  });
  if (isEmpty) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(
    key,
    JSON.stringify({
      delegateSecretKey: input.session.delegate ? Array.from(input.session.delegate.secretKey) : null,
      sessionAccount: input.session.sessionAccount?.toBase58() || null,
      status: input.session.status,
      nonce: input.session.nonce,
      expiresAtSlot: input.session.expiresAtSlot,
      managerScriptAccount: input.session.managerScriptAccount,
    })
  );
}

async function loadProgram(scriptAccount: string, vmProgramId: string) {
  const artifactText = await fetch("/main.five", { cache: "no-store" }).then(async (res) => {
    if (!res.ok) throw new Error("Missing /main.five. Run npm run build in 5ive-blackjack first.");
    return res.text();
  });
  const loaded = await FiveSDK.loadFiveFile(artifactText);
  const feeShardIndex = Number(process.env.NEXT_PUBLIC_FIVE_FEE_SHARD_INDEX || "0");
  return FiveProgram.fromABI(scriptAccount, loaded.abi, {
    fiveVMProgramId: vmProgramId,
    feeShardIndex,
  } as any);
}

function isDelegatedSessionActive(sessionState?: SessionState): boolean {
  return !!sessionState?.delegate && !!sessionState?.sessionAccount && sessionState.status === "active";
}

const CONFIRM_OPTS: ConfirmOptions = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
  skipPreflight: false,
};

function initialState(): GameState {
  return {
    chips: 0,
    activeBet: 0,
    playerTotal: 0,
    dealerTotal: 0,
    outcome: ROUND_IDLE,
    inRound: false,
    deckSeed: 0,
    ownerMarker: 0,
    drawCursor: 0,
    playerSoftAces: 0,
    dealerSoftAces: 0,
    playerCards: [],
    dealerCards: [],
    dealerReveal: false,
    minBet: 10,
    maxBet: 100,
    dealerSoft17Hits: true,
    initialized: false,
    setupDone: false,
  };
}

function cardRank(seed: number, cursor: number, marker: number): number {
  return ((seed + cursor * 17 + marker * 31 + 7) % 13) + 1;
}

function suitFor(index: number, seed: number): string {
  const suits = ["♠", "♥", "♦", "♣"];
  return suits[Math.abs((seed + index * 3) % 4)];
}

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function outcomeLabel(outcome: number): string {
  const map: Record<number, string> = {
    0: "idle",
    1: "active",
    2: "player bust",
    3: "dealer bust",
    4: "player win",
    5: "dealer win",
    6: "push",
  };
  return map[outcome] || `status:${outcome}`;
}

function outcomeBanner(outcome: number): { text: string; cls: string } | null {
  if (outcome === ROUND_PLAYER_WIN || outcome === ROUND_DEALER_BUST) {
    return { text: "You win this hand.", cls: "border-green-400/50 bg-green-500/10 text-green-300" };
  }
  if (outcome === ROUND_DEALER_WIN || outcome === ROUND_PLAYER_BUST) {
    return { text: "Dealer wins this hand.", cls: "border-red-400/50 bg-red-500/10 text-red-300" };
  }
  if (outcome === ROUND_PUSH) {
    return { text: "Push. Bet returned.", cls: "border-amber-400/50 bg-amber-500/10 text-amber-200" };
  }
  return null;
}

function shortSig(sig: string): string {
  return sig.length > 14 ? `${sig.slice(0, 6)}...${sig.slice(-6)}` : sig;
}

function shortKey(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function formatSolFromLamports(lamports: number | null | undefined): string {
  if (lamports == null) return "n/a";
  return `${(lamports / 1_000_000_000).toFixed(6)} SOL`;
}

function isUserRejectedWalletAction(message: string): boolean {
  return /user rejected|rejected the request|declined|cancelled/i.test(message);
}

function isBlockhashExpiryError(message: string): boolean {
  return /block height exceeded|blockhash not found|transactionexpiredblockheightexceedederror/i.test(
    message
  );
}

async function confirmSignatureByPolling(
  connection: Connection,
  signature: string,
  confirmation: "confirmed" | "finalized" = "finalized",
  timeoutMs = 75_000
): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = response.value[0];
    if (status) {
      if (status.err) {
        throw new Error(`transaction failed on-chain: ${JSON.stringify(status.err)}`);
      }
      if (
        status.confirmationStatus === "finalized" ||
        (confirmation === "confirmed" && status.confirmationStatus === "confirmed")
      ) {
        return status.slot ?? null;
      }
    }
    await sleep(1200);
  }
  throw new Error("transaction confirmation timed out");
}

async function waitForAccountsReady(
  connection: Connection,
  scriptAccount: string,
  accounts: GameAccounts,
  expectedOwner: string,
  attempts = 12
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const [tableInfo, playerInfo] = await Promise.all([
      connection.getAccountInfo(new PublicKey(accounts.table), "finalized"),
      connection.getAccountInfo(new PublicKey(accounts.player), "finalized"),
    ]);
    if (tableInfo?.data && playerInfo?.data) {
      try {
        const player = readPlayerSnapshot(stripDslRawHeader(playerInfo.data, scriptAccount));
        if (player.owner === expectedOwner) return;
      } catch {
        // Wait and retry if account payload is not yet readable on this RPC node.
      }
    }
    await sleep(250);
  }
  throw new Error("fresh accounts not ready on RPC yet; retry deal in a moment");
}

type PlayerSnapshot = ReturnType<typeof readPlayerSnapshot>;
type RoundSnapshot = ReturnType<typeof readRoundSnapshot>;
type AuthoritativeGameState = {
  slot: number | null;
  table: TableSnapshot | null;
  player: PlayerSnapshot | null;
  round: RoundSnapshot | null;
};
export default function Home() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { network, displayEndpoint } = useNetworkConfig();

  const [status, setStatus] = useState("ready");
  const [lastTxError, setLastTxError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bet, setBet] = useState(25);
  const [accounts, setAccounts] = useState<GameAccounts | null>(null);
  const [sigs, setSigs] = useState<string[]>([]);
  const [state, setState] = useState<GameState>(initialState());
  const [session, setSession] = useState<SessionState>(emptySessionState());
  const [trackedSessions, setTrackedSessions] = useState<TrackedSessionRecord[]>([]);
  const [sessionLamportsByAccount, setSessionLamportsByAccount] = useState<Record<string, number | null>>({});
  const [playMode, setPlayMode] = useState<PlayMode>("direct");
  const [resumeCandidate, setResumeCandidate] = useState<ResumePromptCandidate | null>(null);
  const [resumePromptSuppressed, setResumePromptSuppressed] = useState(false);
  const previousNetworkRef = useRef(network);
  const lastFinalizedSlotRef = useRef<number | null>(null);
  const actionLockRef = useRef(false);

  const vmProgramId = useMemo(() => DEFAULT_VM_PROGRAM_ID, []);
  const scriptAccount = useMemo(
    () =>
      network === "mainnet"
        ? MAINNET_SCRIPT_ACCOUNT
        : network === "localnet"
          ? LOCALNET_SCRIPT_ACCOUNT
          : DEVNET_SCRIPT_ACCOUNT,
    [network]
  );
  const solscanClusterSuffix = useMemo(() => {
    if (network === "devnet") return "?cluster=devnet";
    return "";
  }, [network]);

  const walletConnected = !!wallet.connected && !!wallet.publicKey;
  const walletBase58 = wallet.publicKey?.toBase58() || null;

  useEffect(() => {
    const fromStorage = readStoredAccounts({
      network,
      wallet: walletBase58,
      vmProgramId,
      scriptAccount,
    });
    const sessionFromStorage = readStoredSession({
      network,
      wallet: walletBase58,
      vmProgramId,
      scriptAccount,
    });
    setAccounts(fromStorage || parseEnvAccounts(network));
    setSession(sessionFromStorage || emptySessionState());
    setTrackedSessions(
      readTrackedSessions({
        network,
        wallet: walletBase58,
        vmProgramId,
        scriptAccount,
      })
    );
    lastFinalizedSlotRef.current = null;
    setResumeCandidate(null);
    setResumePromptSuppressed(false);
  }, [network, walletBase58, vmProgramId, scriptAccount]);

  useEffect(() => {
    if (previousNetworkRef.current === network) return;
    previousNetworkRef.current = network;
    const fromStorage = readStoredAccounts({
      network,
      wallet: walletBase58,
      vmProgramId,
      scriptAccount,
    });
    const sessionFromStorage = readStoredSession({
      network,
      wallet: walletBase58,
      vmProgramId,
      scriptAccount,
    });
    setAccounts(fromStorage || parseEnvAccounts(network));
    setSigs([]);
    setSession(sessionFromStorage || emptySessionState());
    setTrackedSessions(
      readTrackedSessions({
        network,
        wallet: walletBase58,
        vmProgramId,
        scriptAccount,
      })
    );
    setState(initialState());
    setPlayMode("direct");
    setBusy(false);
    lastFinalizedSlotRef.current = null;
    setStatus(`switched to ${network}`);
    setLastTxError(null);
    setResumeCandidate(null);
    setResumePromptSuppressed(false);
  }, [network, walletBase58, vmProgramId, scriptAccount]);

  useEffect(() => {
    persistSession({
      network,
      wallet: walletBase58,
      vmProgramId,
      scriptAccount,
      session,
    });
  }, [network, walletBase58, vmProgramId, scriptAccount, session]);

  useEffect(() => {
    persistTrackedSessions({
      network,
      wallet: walletBase58,
      vmProgramId,
      scriptAccount,
      sessions: trackedSessions,
    });
  }, [network, walletBase58, vmProgramId, scriptAccount, trackedSessions]);

  useEffect(() => {
    if (!session.sessionAccount) return;
    const manager = session.managerScriptAccount || resolveSessionManagerScriptAccount();
    const account = session.sessionAccount.toBase58();
    if (session.status === "revoked") {
      forgetOpenSession(account);
      return;
    }
    const trackedStatus: TrackedSessionRecord["status"] =
      session.status === "active" ? "active" : session.status === "expired" ? "expired" : "unknown";
    rememberOpenSession(account, manager, trackedStatus, session.expiresAtSlot);
  }, [session.expiresAtSlot, session.managerScriptAccount, session.sessionAccount, session.status]);

  useEffect(() => {
    let cancelled = false;
    async function refreshSessionBalances() {
      if (trackedSessions.length === 0) {
        if (!cancelled) setSessionLamportsByAccount({});
        return;
      }
      try {
        const keys = trackedSessions.map((s) => new PublicKey(s.sessionAccount));
        const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
        if (cancelled) return;
        const next: Record<string, number | null> = {};
        for (let i = 0; i < trackedSessions.length; i += 1) {
          next[trackedSessions[i].sessionAccount] = infos[i]?.lamports ?? null;
        }
        setSessionLamportsByAccount(next);
      } catch {
        if (!cancelled) setSessionLamportsByAccount({});
      }
    }
    void refreshSessionBalances();
    return () => {
      cancelled = true;
    };
  }, [connection, trackedSessions]);

  useEffect(() => {
    let cancelled = false;

    async function probeResumableGame() {
      if (network === "localnet") {
        if (!cancelled) setResumeCandidate(null);
        return;
      }
      if (resumePromptSuppressed || state.setupDone) {
        if (!cancelled) setResumeCandidate(null);
        return;
      }
      if (!walletBase58 || !scriptAccount) {
        if (!cancelled) setResumeCandidate(null);
        return;
      }
      const storedAccounts = readStoredAccounts({
        network,
        wallet: walletBase58,
        vmProgramId,
        scriptAccount,
      });
      if (!storedAccounts) {
        if (!cancelled) setResumeCandidate(null);
        return;
      }

      try {
        const playerInfo = await connection.getAccountInfo(new PublicKey(storedAccounts.player), "confirmed");
        if (!playerInfo?.data) {
          if (!cancelled) setResumeCandidate(null);
          return;
        }
        const player = readPlayerSnapshot(stripDslRawHeader(playerInfo.data, scriptAccount));
        if (cancelled) return;
        setResumeCandidate({
          accounts: storedAccounts,
          chips: player.chips,
          activeBet: player.activeBet,
          playerTotal: player.handTotal,
          dealerTotal: player.dealerTotal,
          inRound: player.inRound,
          outcome: player.outcome,
        });
      } catch {
        if (!cancelled) setResumeCandidate(null);
      }
    }

    void probeResumableGame();
    return () => {
      cancelled = true;
    };
  }, [
    connection,
    network,
    resumePromptSuppressed,
    scriptAccount,
    state.setupDone,
    vmProgramId,
    walletBase58,
  ]);

  const pushSig = (sig: string) => setSigs((prev) => [sig, ...prev].slice(0, 6));
  const errText = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const rec = err as Record<string, unknown>;
      if (typeof rec.message === "string") return rec.message;
      if (typeof rec.error === "string") return rec.error;
      try {
        return JSON.stringify(rec);
      } catch {
        return String(err);
      }
    }
    return String(err);
  };
  const debugErrText = (err: unknown): string => {
    const message = errText(err);
    if (!err || typeof err !== "object") return message;
    const rec = err as Record<string, unknown>;
    const logs = rec.logs || rec.transactionLogs;
    if (Array.isArray(logs) && logs.length > 0) {
      return `${message}\n${logs.map((line) => String(line)).join("\n")}`;
    }
    return message;
  };

  const formatActionFailure = (
    action: "deal" | "hit" | "stand",
    resolved: GameAccounts,
    precondition: string,
    message: string
  ): string => {
    const slot = lastFinalizedSlotRef.current ?? "n/a";
    return `action=${action} network=${network} script=${scriptAccount} player=${resolved.player} round=${resolved.round} slot=${slot} precondition=${precondition} error=${message}`;
  };

  const fetchAuthoritativeGameState = async (resolved: GameAccounts): Promise<AuthoritativeGameState> => {
    const slot = await connection.getSlot("finalized");
    const [tableInfo, playerInfo, roundInfo] = await Promise.all([
      connection.getAccountInfo(new PublicKey(resolved.table), "finalized"),
      connection.getAccountInfo(new PublicKey(resolved.player), "finalized"),
      connection.getAccountInfo(new PublicKey(resolved.round), "finalized"),
    ]);
    const table = tableInfo?.data ? readTableSnapshot(stripDslRawHeader(tableInfo.data, scriptAccount)) : null;
    const player = playerInfo?.data ? readPlayerSnapshot(stripDslRawHeader(playerInfo.data, scriptAccount)) : null;
    const round = roundInfo?.data ? readRoundSnapshot(stripDslRawHeader(roundInfo.data, scriptAccount)) : null;
    lastFinalizedSlotRef.current = Math.max(lastFinalizedSlotRef.current ?? 0, slot);
    return { slot, table, player, round };
  };

  const applyAuthoritativeGameState = (auth: AuthoritativeGameState): void => {
    const player = auth.player;
    const round = auth.round;
    if (!player) return;
    if (!round) {
      setState((prev) => ({
        ...prev,
        chips: player.chips,
        activeBet: player.activeBet,
        playerTotal: player.handTotal,
        dealerTotal: player.dealerTotal,
        outcome: player.outcome,
        inRound: player.inRound,
        dealerReveal: !player.inRound,
      }));
      return;
    }

    const playerCards: number[] = [];
    const dealerCards: number[] = [];
    let cursor = 0;
    const pushPlayer = () => {
      if (playerCards.length >= round.playerCardCount) return;
      playerCards.push(cardRank(round.deckSeed, cursor, round.ownerMarker));
      cursor += 1;
    };
    const pushDealer = () => {
      if (dealerCards.length >= round.dealerCardCount) return;
      dealerCards.push(cardRank(round.deckSeed, cursor, round.ownerMarker));
      cursor += 1;
    };
    pushPlayer();
    pushDealer();
    pushPlayer();
    pushDealer();
    const targetPlayerCount = Math.max(0, Math.min(16, round.playerCardCount));
    const targetDealerCount = Math.max(0, Math.min(16, round.dealerCardCount));
    while (playerCards.length < targetPlayerCount) pushPlayer();
    while (dealerCards.length < targetDealerCount) pushDealer();

    setState((prev) => ({
      ...prev,
      chips: player.chips,
      activeBet: player.activeBet,
      playerTotal: player.handTotal,
      dealerTotal: player.dealerTotal,
      outcome: player.outcome,
      inRound: player.inRound,
      deckSeed: round.deckSeed,
      ownerMarker: round.ownerMarker,
      drawCursor: round.drawCursor,
      playerSoftAces: round.playerSoftAces,
      dealerSoftAces: round.dealerSoftAces,
      playerCards,
      dealerCards,
      dealerReveal: !player.inRound,
    }));
  };

  function resolveSessionManagerScriptAccount(): string {
    const explicit = process.env.NEXT_PUBLIC_SESSION_MANAGER_SCRIPT_ACCOUNT || "";
    if (explicit) return explicit;
    return SessionClient.canonicalManagerScriptAccount(vmProgramId);
  }

  function rememberOpenSession(
    sessionAccount: string,
    managerScriptAccount: string,
    status: TrackedSessionRecord["status"],
    expiresAtSlot: number | null
  ) {
    setTrackedSessions((prev) =>
      upsertTrackedSessionRecord(prev, {
        sessionAccount,
        managerScriptAccount,
        status,
        expiresAtSlot,
      })
    );
  }

  function forgetOpenSession(sessionAccount: string) {
    setTrackedSessions((prev) => prev.filter((s) => s.sessionAccount !== sessionAccount));
  }

  async function revokeSessionAccount(sessionAccount: string, managerScriptAccount: string) {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    const authority = wallet.publicKey.toBase58();
    const program = FiveProgram.fromABI(
      managerScriptAccount,
      SESSION_MANAGER_REVOKE_ABI as Parameters<typeof FiveProgram.fromABI>[1],
      { fiveVMProgramId: vmProgramId }
    );
    const encoded = await program
      .function("revoke_session")
      .accounts({
        session: sessionAccount,
        authority,
      })
      .payer(authority)
      .instruction();
    const revokeIx = new TransactionInstruction({
      programId: new PublicKey(encoded.programId),
      keys: encoded.keys.map((k: { pubkey: string; isSigner: boolean; isWritable: boolean }) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(decodeBase64ToBytes(encoded.data)),
    });
    await sendAndConfirm(new Transaction().add(revokeIx));
  }

  async function sendAndConfirm(
    tx: Transaction,
    extraSigners: Keypair[] = [],
    options?: { feePayer?: PublicKey; requireWalletSignature?: boolean }
  ) {
    if (!wallet.publicKey && !options?.feePayer) throw new Error("Connect wallet first.");
    const feePayer = options?.feePayer || wallet.publicKey || undefined;
    const requireWalletSignature = options?.requireWalletSignature ?? true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptTx = new Transaction().add(...tx.instructions);
      attemptTx.feePayer = feePayer;
      const minContextSlot = lastFinalizedSlotRef.current ?? undefined;
      const latest = await connection.getLatestBlockhash({
        commitment: "confirmed",
        minContextSlot,
      });
      attemptTx.recentBlockhash = latest.blockhash;
      let sig = "";

      try {
        if (!requireWalletSignature) {
          if (extraSigners.length > 0) attemptTx.partialSign(...extraSigners);
          sig = await connection.sendRawTransaction(attemptTx.serialize(), {
            ...CONFIRM_OPTS,
            maxRetries: 3,
            minContextSlot,
          });
        } else if (wallet.signTransaction) {
          const signedByWallet = await wallet.signTransaction(attemptTx);
          if (extraSigners.length > 0) signedByWallet.partialSign(...extraSigners);
          sig = await connection.sendRawTransaction(signedByWallet.serialize(), {
            ...CONFIRM_OPTS,
            maxRetries: 3,
            minContextSlot,
          });
        } else if (wallet.sendTransaction) {
          sig = await wallet.sendTransaction(attemptTx, connection, {
            ...CONFIRM_OPTS,
            maxRetries: 3,
            signers: extraSigners,
            minContextSlot,
          });
        } else {
          throw new Error("Wallet does not support signTransaction/sendTransaction.");
        }
      } catch (err) {
        const message = errText(err);
        if (isUserRejectedWalletAction(message)) {
          throw new Error("wallet request cancelled");
        }
        throw new Error(`transaction submit failed: ${message}`);
      }

      try {
        const finalizedSlot = await confirmSignatureByPolling(connection, sig, "finalized");
        if (finalizedSlot != null) {
          lastFinalizedSlotRef.current = Math.max(lastFinalizedSlotRef.current ?? 0, finalizedSlot);
        }
        pushSig(sig);
        return sig;
      } catch (err) {
        const message = errText(err);
        if (attempt === 0 && isBlockhashExpiryError(message)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error("transaction confirm failed after retry");
  }

  async function provisionAccounts() {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    const owner = new PublicKey(vmProgramId);
    const table = Keypair.generate();
    const player = Keypair.generate();
    const round = Keypair.generate();
    const lamports = await connection.getMinimumBalanceForRentExemption(256);
    const needLamports = lamports * 3;
    const walletLamports = await connection.getBalance(wallet.publicKey, "finalized");
    if (walletLamports < needLamports) {
      throw new Error(
        `insufficient SOL for account creation: need ${(needLamports / 1e9).toFixed(4)} SOL, have ${(walletLamports / 1e9).toFixed(4)} SOL`
      );
    }

    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: table.publicKey, lamports, space: 256, programId: owner }),
      SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: player.publicKey, lamports, space: 256, programId: owner }),
      SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: round.publicKey, lamports, space: 256, programId: owner })
    );

    await sendAndConfirm(tx, [table, player, round]);
    const next = { table: table.publicKey.toBase58(), player: player.publicKey.toBase58(), round: round.publicKey.toBase58() };
    setAccounts(next);
    persistAccounts({
      network,
      wallet: wallet.publicKey.toBase58(),
      vmProgramId,
      scriptAccount,
      accounts: next,
    });
    return next;
  }

  async function ensureInitialized(forceFresh = false): Promise<GameAccounts> {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    const initializeFreshAccounts = async (): Promise<GameAccounts> => {
      // Always use fresh init signers while setup is incomplete to avoid reusing stale
      // partially-initialized accounts after a failed attempt.
      const table = Keypair.generate();
      const player = Keypair.generate();
      const round = Keypair.generate();
      const resolved = { table: table.publicKey.toBase58(), player: player.publicKey.toBase58(), round: round.publicKey.toBase58() };
      setAccounts(resolved);
      persistAccounts({
        network,
        wallet: wallet.publicKey.toBase58(),
        vmProgramId,
        scriptAccount,
        accounts: resolved,
      });
      const initTableIx = await buildInstruction(
        "init_table",
        {
          min_bet: state.minBet,
          max_bet: state.maxBet,
          dealer_soft17_hits: state.dealerSoft17Hits,
        },
        resolved,
        undefined,
        [resolved.table]
      );
      const initPlayerIx = await buildInstruction(
        "init_player",
        { initial_chips: 500 },
        resolved,
        undefined,
        [resolved.player]
      );
      await sendAndConfirm(new Transaction().add(initTableIx, initPlayerIx), [table, player]);
      await waitForAccountsReady(connection, scriptAccount, resolved, wallet.publicKey.toBase58());
      applyInit();
      return resolved;
    };

    const resolved = accounts;
    if (forceFresh || !state.setupDone) {
      return initializeFreshAccounts();
    }

    if (!resolved) {
      throw new Error("accounts not initialized");
    }

    try {
      const [tableInfo, playerInfo] = await Promise.all([
        connection.getAccountInfo(new PublicKey(resolved.table), "finalized"),
        connection.getAccountInfo(new PublicKey(resolved.player), "finalized"),
      ]);
      if (!tableInfo?.data || !playerInfo?.data) {
        return initializeFreshAccounts();
      }
      const playerState = readPlayerSnapshot(stripDslRawHeader(playerInfo.data, scriptAccount));
      if (playerState.owner !== wallet.publicKey.toBase58()) {
        return initializeFreshAccounts();
      }
    } catch {
      return initializeFreshAccounts();
    }

    return resolved;
  }

  async function buildInstruction(
    functionName: "init_table" | "init_player" | "start_round" | "hit" | "stand_and_settle",
    args: Record<string, unknown>,
    resolved: GameAccounts,
    sessionState?: SessionState,
    initSignerPubkeys: string[] = []
  ): Promise<TransactionInstruction> {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    if (!scriptAccount) {
      throw new Error("Set NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_LOCALNET/DEVNET/MAINNET in web/.env.local.");
    }

    let program = await loadProgram(scriptAccount, vmProgramId);
    const walletPk = wallet.publicKey.toBase58();
    const delegatedSession = isDelegatedSessionActive(sessionState);
    const callerForSessionizedAction = delegatedSession
      ? sessionState!.delegate!.publicKey.toBase58()
      : walletPk;
    const sessionForSessionizedAction = delegatedSession
      ? sessionState!.sessionAccount!.toBase58()
      : vmProgramId;
    const vmPayer = delegatedSession ? callerForSessionizedAction : walletPk;
    if ((functionName === "hit" || functionName === "stand_and_settle") && delegatedSession) {
      program = program.withSession({
        mode: "auto",
        manager: { defaultTtlSlots: SESSION_TTL_SLOTS } as SessionConfig["manager"],
        sessionAccountByFunction: {
          [functionName]: sessionState!.sessionAccount!.toBase58(),
        },
        delegateSignerByFunction: {
          [functionName]: sessionState!.delegate!,
        },
      });
    }

    const accountMapByFunction: Record<string, Record<string, string>> = {
      init_table: { table: resolved.table, authority: walletPk, __session: vmProgramId },
      init_player: { player: resolved.player, owner: walletPk, __session: vmProgramId },
      start_round: { table: resolved.table, player: resolved.player, round: resolved.round, owner: walletPk, __session: vmProgramId },
      hit: {
        table: resolved.table,
        player: resolved.player,
        round: resolved.round,
        caller: callerForSessionizedAction,
        __session: sessionForSessionizedAction,
      },
      stand_and_settle: {
        table: resolved.table,
        player: resolved.player,
        round: resolved.round,
        caller: callerForSessionizedAction,
        __session: sessionForSessionizedAction,
      },
    };

    let builder = program
      .function(functionName)
      .payer(vmPayer)
      .accounts(accountMapByFunction[functionName]);
    if (Object.keys(args).length > 0) builder = builder.args(args);
    const encoded = await builder.instruction();

    const initSignerSet = new Set(initSignerPubkeys);
    const ix = new TransactionInstruction({
      programId: new PublicKey(encoded.programId),
      keys: encoded.keys.map((k: { pubkey: string; isSigner: boolean; isWritable: boolean }) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: !!k.isSigner || initSignerSet.has(k.pubkey),
        isWritable: !!k.isWritable || initSignerSet.has(k.pubkey),
      })),
      data: Buffer.from(decodeBase64ToBytes(encoded.data)),
    });

    return ix;
  }

  async function callAction(functionName: "start_round" | "hit" | "stand_and_settle", args: Record<string, unknown>) {
    const resolved = await ensureInitialized();
    const sessionized = functionName === "hit" || functionName === "stand_and_settle";
    const actionName: "deal" | "hit" | "stand" =
      functionName === "hit" ? "hit" : functionName === "stand_and_settle" ? "stand" : "deal";
    if (sessionized) {
      const authBefore = await fetchAuthoritativeGameState(resolved);
      applyAuthoritativeGameState(authBefore);
      const guardBefore = evaluateRoundActionGuard({
        player: authBefore.player,
        action: functionName as "hit" | "stand_and_settle",
      });
      if (!guardBefore.ok) {
        throw new Error(formatActionFailure(actionName, resolved, guardBefore.code, guardBefore.reason));
      }
    }

    let extraSigners: Keypair[] = [];
    let mergedArgs = { ...args };
    let sessionForInstruction: SessionState | undefined;
    let txFeePayer: PublicKey | undefined;
    let requireWalletSignature = true;
    let effectivePlayMode: PlayMode = playMode;
    if (sessionized) {
      if (!ENABLE_DELEGATED_SESSION_ACTIONS && effectivePlayMode === "session") {
        throw new Error(
          "delegated session actions are disabled (set NEXT_PUBLIC_ENABLE_DELEGATED_SESSION_ACTIONS=1)"
        );
      }
      if (effectivePlayMode !== "session") {
        const ix = await buildInstruction(functionName, mergedArgs, resolved);
        await sendAndConfirm(new Transaction().add(ix), extraSigners, {
          feePayer: txFeePayer,
          requireWalletSignature,
        });
        await syncStateFromChain(resolved);
        setSession((prev) => ({ ...prev, nonce: prev.nonce + 1 }));
        return;
      }
      const delegatedReady =
        session.status === "active" && !!session.delegate && !!session.sessionAccount;
      if (delegatedReady) {
        const currentSlot = await connection.getSlot("finalized");
        if (session.expiresAtSlot && currentSlot > session.expiresAtSlot) {
          setSession((prev) => ({ ...prev, status: "expired" }));
        } else {
          sessionForInstruction = session;
          extraSigners = [session.delegate as Keypair];
          txFeePayer = session.delegate!.publicKey;
          requireWalletSignature = false;
        }
      } else {
        throw new Error(
          formatActionFailure(
            actionName,
            resolved,
            "session_not_ready",
            "session mode enabled but no active delegated session exists"
          )
        );
      }
      mergedArgs = { ...mergedArgs };
    }

    try {
      const ix = await buildInstruction(functionName, mergedArgs, resolved, sessionForInstruction);
      await sendAndConfirm(new Transaction().add(ix), extraSigners, {
        feePayer: txFeePayer,
        requireWalletSignature,
      });
      await syncStateFromChain(resolved);
      if (sessionized) {
        // PlayerState.session_nonce advances on-chain for hit/stand in both
        // direct-owner and delegated-session paths; keep local nonce in sync.
        setSession((prev) => ({ ...prev, nonce: prev.nonce + 1 }));
      }
    } catch (err) {
      const message = errText(err);
      if (sessionized && (isRoundNoLongerActiveError(message) || isSessionAuthFailure(message))) {
        const authAfter = await fetchAuthoritativeGameState(resolved);
        applyAuthoritativeGameState(authAfter);
        const guardAfter = evaluateRoundActionGuard({
          player: authAfter.player,
          action: functionName as "hit" | "stand_and_settle",
        });
        if (!guardAfter.ok) {
          if (functionName === "stand_and_settle" && guardAfter.code === "round_not_active") {
            return;
          }
          throw new Error(
            formatActionFailure(actionName, resolved, guardAfter.code, `${guardAfter.reason}; rpc=${message}`)
          );
        }
        if (!ENABLE_SESSION_DIRECT_FALLBACK) {
          throw new Error(
            formatActionFailure(
              actionName,
              resolved,
              "session_auth_failed_no_fallback",
              `session auth failed and direct fallback is disabled; rpc=${message}`
            )
          );
        }
        // Optional compatibility path: retry once via direct-owner mode.
        setSession((prev) => ({
          ...prev,
          status: "revoked",
          delegate: null,
          sessionAccount: null,
          expiresAtSlot: null,
        }));
        setPlayMode("direct");
        const directIx = await buildInstruction(functionName, mergedArgs, resolved);
        await sendAndConfirm(new Transaction().add(directIx));
        await syncStateFromChain(resolved);
        setSession((prev) => ({ ...prev, nonce: prev.nonce + 1 }));
        return;
      }
      throw new Error(formatActionFailure(actionName, resolved, decodePrecondition(message), message));
    }
  }

  async function createSession() {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    if (!scriptAccount) {
      throw new Error("Set NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_LOCALNET/DEVNET/MAINNET in web/.env.local.");
    }
    const resolved = await ensureInitialized();

    const delegate = session.delegate || Keypair.generate();
    const managerScriptAccount = resolveSessionManagerScriptAccount();
    const sessionClient = new SessionClient({
      vmProgramId,
      managerScriptAccount,
    });
    const slot = await connection.getSlot("finalized");
    const expiresAtSlot = slot + Math.max(1, SESSION_TTL_SLOTS);

    let syncedNonce = session.nonce;
    try {
      const playerInfo = await connection.getAccountInfo(new PublicKey(resolved.player), "finalized");
      if (playerInfo?.data) {
        // PlayerState layout stores session_nonce as u64 LE at byte offset 80.
        const payload = stripDslRawHeader(playerInfo.data, scriptAccount);
        syncedNonce = Number(readU64Le(payload, 80));
      }
    } catch {
      // Keep local nonce fallback if account read fails.
    }

    const delegateBalance = await connection.getBalance(delegate.publicKey, "finalized");
    const topupIx =
      delegateBalance >= SESSION_DELEGATE_MIN_FEE_LAMPORTS
        ? null
        : SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: delegate.publicKey,
            lamports: SESSION_DELEGATE_TOPUP_LAMPORTS,
          });
    const legacySessionSigner = Keypair.generate();
    const sessionParams: CreateSessionParams & { sessionAccount?: string; rpcLabel?: string } = {
      authority: wallet.publicKey.toBase58(),
      delegate: delegate.publicKey.toBase58(),
      targetProgram: scriptAccount,
      sessionAccount: legacySessionSigner.publicKey.toBase58(),
      expiresAtSlot,
      scopeHash: SESSION_SCOPE_HASH,
      bindAccount: resolved.player,
      nonce: syncedNonce,
      payer: wallet.publicKey.toBase58(),
      rpcLabel: displayEndpoint,
    };

    const sessionClientMaybePlan = sessionClient as unknown as SessionClientWithPlanBuilder;
    const hasPlanBuilder = typeof sessionClientMaybePlan.buildCreateSessionPlan === "function";
    if (hasPlanBuilder) {
      const plan = await sessionClientMaybePlan.buildCreateSessionPlan(sessionParams, {
        connection,
        payer: wallet.publicKey,
        delegateMinLamports: SESSION_DELEGATE_MIN_FEE_LAMPORTS,
        delegateTopupLamports: SESSION_DELEGATE_TOPUP_LAMPORTS,
        rpcLabel: displayEndpoint,
      });
      const tx = new Transaction();
      if (plan.createSessionAccountIx) tx.add(plan.createSessionAccountIx);
      if (plan.topupDelegateIx) tx.add(plan.topupDelegateIx);
      tx.add(plan.createSessionIx);
      await sendAndConfirm(
        tx,
        plan.createSessionAccountIx ? [legacySessionSigner] : []
      );
      rememberOpenSession(plan.sessionAddress, managerScriptAccount, "active", expiresAtSlot);
      setSession({
        delegate,
        sessionAccount: new PublicKey(plan.sessionAddress),
        status: "active",
        nonce: syncedNonce,
        expiresAtSlot,
        managerScriptAccount,
      });
      setPlayMode("session");
      return;
    }

    const compatResult = await sessionClient.createSessionWithCompat(
        sessionParams,
        async (sessionIx, schema): Promise<TransactionSignature> => {
          const tx = new Transaction();
          let extraSigners: Keypair[] = [];
          if (schema === "legacy") {
            const prepared = await sessionClient.prepareSessionAccountTx({
              connection,
              payer: wallet.publicKey,
              sessionAccount: legacySessionSigner.publicKey,
              delegate: delegate.publicKey,
              delegateMinLamports: SESSION_DELEGATE_MIN_FEE_LAMPORTS,
              delegateTopupLamports: SESSION_DELEGATE_TOPUP_LAMPORTS,
            });
            if (prepared.createIx) {
              tx.add(prepared.createIx);
              extraSigners = [legacySessionSigner];
            }
            if (prepared.topupIx) tx.add(prepared.topupIx);
          } else if (topupIx) {
            tx.add(topupIx);
          }
          tx.add(sessionIx);
          return sendAndConfirm(tx, extraSigners);
        }
    );
    const sessionAddress =
      compatResult.schema === "legacy"
        ? legacySessionSigner.publicKey.toBase58()
        : await sessionClient.deriveSessionAddress(
            wallet.publicKey.toBase58(),
            delegate.publicKey.toBase58(),
            scriptAccount
          );
    rememberOpenSession(sessionAddress, managerScriptAccount, "active", expiresAtSlot);
    setSession({
      delegate,
      sessionAccount: new PublicKey(sessionAddress),
      status: "active",
      nonce: syncedNonce,
      expiresAtSlot,
      managerScriptAccount,
    });
    setPlayMode("session");
  }

  async function revokeSession() {
    if (!session.sessionAccount || !wallet.publicKey) {
      throw new Error("No session to revoke.");
    }
    const sessionAccount = session.sessionAccount.toBase58();
    const managerScriptAccount = session.managerScriptAccount || resolveSessionManagerScriptAccount();
    await revokeSessionAccount(sessionAccount, managerScriptAccount);
    forgetOpenSession(sessionAccount);
    setSession((prev) => ({
      ...prev,
      status: "revoked",
      delegate: null,
      sessionAccount: null,
      expiresAtSlot: null,
    }));
  }

  async function closeTrackedSession(record: TrackedSessionRecord) {
    await revokeSessionAccount(record.sessionAccount, record.managerScriptAccount);
    forgetOpenSession(record.sessionAccount);
    if (session.sessionAccount?.toBase58() === record.sessionAccount) {
      setSession((prev) => ({
        ...prev,
        status: "revoked",
        delegate: null,
        sessionAccount: null,
        expiresAtSlot: null,
      }));
    }
  }

  async function setupAndDeal(seed: number, wager: number) {
    const resolved = await ensureInitialized();
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    const walletPk = wallet.publicKey.toBase58();
    const authBefore = await fetchAuthoritativeGameState(resolved);
    applyAuthoritativeGameState(authBefore);
    const tableMinBet = authBefore.table?.minBet ?? state.minBet;
    const tableMaxBet = authBefore.table?.maxBet ?? state.maxBet;
    const startRoundArgs = prepareStartRoundArgs({
      wager,
      seed,
      minBet: tableMinBet,
      maxBet: tableMaxBet,
      fallbackWager: tableMinBet,
      fallbackSeed: Date.now() % 1_000_000,
    });
    const guardBefore = evaluateDealGuard({
      wallet: walletPk,
      wager: startRoundArgs.bet,
      table: authBefore.table,
      player: authBefore.player,
    });
    if (!guardBefore.ok) {
      throw new Error(formatActionFailure("deal", resolved, guardBefore.code, guardBefore.reason));
    }

    const startRoundWithFreshRound = async (base: GameAccounts): Promise<void> => {
      const round = Keypair.generate();
      const nextResolved = { ...base, round: round.publicKey.toBase58() };
      const startRoundIx = await buildInstruction(
        "start_round",
        startRoundArgs,
        nextResolved,
        undefined,
        [round.publicKey.toBase58()]
      );
      await sendAndConfirm(new Transaction().add(startRoundIx), [round]);
      setAccounts(nextResolved);
      persistAccounts({
        network,
        wallet: wallet.publicKey?.toBase58() || null,
        vmProgramId,
        scriptAccount,
        accounts: nextResolved,
      });
      await syncStateFromChain(nextResolved);
    };
    try {
      await startRoundWithFreshRound(resolved);
    } catch (err) {
      const message = errText(err);
      if (
        /AccountNotFound/i.test(message) ||
        isStartRoundPreconditionFailure(message) ||
        isRoundNoLongerActiveError(message)
      ) {
        try {
          const authNow = await fetchAuthoritativeGameState(resolved);
          applyAuthoritativeGameState(authNow);
          const guardNow = evaluateDealGuard({
            wallet: walletPk,
            wager: startRoundArgs.bet,
            table: authNow.table,
            player: authNow.player,
          });
          if (!guardNow.ok) {
            throw new Error(formatActionFailure("deal", resolved, guardNow.code, `${guardNow.reason}; rpc=${message}`));
          }

          const recovered = await ensureInitialized(true);
          const authRecovered = await fetchAuthoritativeGameState(recovered);
          applyAuthoritativeGameState(authRecovered);
          const guardRecovered = evaluateDealGuard({
            wallet: walletPk,
            wager: startRoundArgs.bet,
            table: authRecovered.table,
            player: authRecovered.player,
          });
          if (!guardRecovered.ok) {
            throw new Error(formatActionFailure("deal", recovered, guardRecovered.code, guardRecovered.reason));
          }
          await startRoundWithFreshRound(recovered);
          return;
        } catch (retryErr) {
          const retryMessage = errText(retryErr);
          throw new Error(formatActionFailure("deal", resolved, decodePrecondition(retryMessage), retryMessage));
        }
      }
      throw new Error(formatActionFailure("deal", resolved, decodePrecondition(message), message));
    }
  }

  async function syncStateFromChain(resolved: GameAccounts) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const auth = await fetchAuthoritativeGameState(resolved);
        if (auth.player) {
          applyAuthoritativeGameState(auth);
          return;
        }
      } catch {
        // Retry with short backoff.
      }
      if (attempt < 2) await sleep(120);
    }
  }

  function applyInit() {
    setState((prev) => ({
      ...prev,
      initialized: true,
      setupDone: true,
      chips: 500,
      activeBet: 0,
      playerTotal: 0,
      dealerTotal: 0,
      inRound: false,
      outcome: ROUND_IDLE,
      playerCards: [],
      dealerCards: [],
      dealerReveal: false,
    }));
  }

  async function resumeStoredGame() {
    if (!resumeCandidate) return;
    await syncStateFromChain(resumeCandidate.accounts);
    setState((prev) => ({
      ...prev,
      initialized: true,
      setupDone: true,
    }));
    setAccounts(resumeCandidate.accounts);
    setResumePromptSuppressed(true);
    setResumeCandidate(null);
  }

  function startFreshGame() {
    clearStoredAccounts({
      network,
      wallet: walletBase58,
      vmProgramId,
      scriptAccount,
    });
    setAccounts(null);
    setSession(emptySessionState());
    setPlayMode("direct");
    setSigs([]);
    setLastTxError(null);
    setState(initialState());
    setResumePromptSuppressed(true);
    setResumeCandidate(null);
    setStatus("starting fresh");
  }

  async function runAction(name: string, fn: () => Promise<void>) {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    try {
      setBusy(true);
      setStatus(`${name}...`);
      await fn();
      setStatus(`${name} complete`);
    } catch (err) {
      const message = errText(err);
      setLastTxError(`[${name}] ${debugErrText(err)}`);
      if (isUserRejectedWalletAction(message)) {
        setStatus(`${name} cancelled in wallet`);
      } else if (/access forbidden|\"code\"\s*:\s*403/i.test(message)) {
        setStatus(`${name} failed: RPC endpoint blocked this request (403). Switch to a permitted endpoint.`);
      } else {
        setStatus(`${name} failed: ${message}`);
      }
    } finally {
      actionLockRef.current = false;
      setBusy(false);
    }
  }

  const canDeal = walletConnected && !busy && !state.inRound;
  const canHit = walletConnected && !busy && state.inRound;
  const canStand = walletConnected && !busy && state.inRound;
  const canCreateSession = walletConnected && !busy && !!scriptAccount;
  const canRevokeSession = walletConnected && !busy && session.status === "active" && !!session.sessionAccount;
  const hasActiveDelegatedSession = isDelegatedSessionActive(session);
  const sessionModeBlocked = playMode === "session" && !hasActiveDelegatedSession;
  const dealerDisplayTotal = state.dealerReveal ? state.dealerTotal : "?";
  const banner = !state.inRound ? outcomeBanner(state.outcome) : null;

  return (
    <div className="h-[100dvh] relative overflow-hidden flex flex-col bg-[#022c22] vignette">
      <Navbar status={status} chips={state.chips} activeBet={state.activeBet} />

      {busy && (
        <div className="absolute inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center">
          <div className="rounded-2xl border border-primary/40 bg-black/70 px-5 py-4 shadow-2xl flex items-center gap-3">
            <span className="h-5 w-5 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-[0.24em] font-black text-primary/90">Transaction In Progress</span>
              <span className="text-xs font-mono text-white/80">{status}</span>
            </div>
          </div>
        </div>
      )}

      {/* Atmospheric Background Elements */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(16,185,129,0.12)_0%,_transparent_70%)] pointer-events-none z-0" />
      <div className="absolute inset-0 opacity-20 bg-[url('https://www.transparenttextures.com/patterns/felt.png')] pointer-events-none mix-blend-overlay z-0" />
      
      {/* Table Spotlight */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-emerald-400/10 rounded-full blur-[120px] pointer-events-none z-0" />

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 md:px-8 pt-20 md:pt-24 pb-6 relative z-10 min-h-0">
        <div className="grid h-full min-h-0 gap-4 md:gap-6 grid-rows-[minmax(0,1fr)_auto] md:grid-rows-1 md:grid-cols-[minmax(0,1fr)_360px] lg:grid-cols-[minmax(0,1fr)_400px]">
          
          {/* Main Table Area */}
          <section className="relative order-1 md:order-1 rounded-[40px] border-4 border-[#2d1a12] bg-[#04332a]/40 backdrop-blur-md shadow-premium overflow-hidden flex flex-col justify-between p-4 md:p-10">
            {/* Table Inner Rail Effect */}
            <div className="absolute inset-0 border-[12px] border-black/10 rounded-[36px] pointer-events-none" />
            
            {/* Dealer Section */}
            <div className="relative flex flex-col items-center">
              <div className="mb-2 md:mb-4 flex flex-col items-center">
                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary/60 mb-0.5">Dealer Hand</span>
                <div className="px-3 md:px-4 py-0.5 md:py-1 rounded-full bg-black/40 border border-primary/20 backdrop-blur-md shadow-lg">
                  <span className="text-lg md:text-xl font-mono font-bold text-primary text-glow-gold">{dealerDisplayTotal}</span>
                </div>
              </div>

              <div className="flex justify-center -space-x-4 sm:-space-x-5 md:-space-x-6 perspective-1000 min-h-[100px] md:min-h-[140px] py-2 md:py-4">
                {state.dealerCards.length === 0 && (
                  <div className="w-16 h-24 md:w-20 md:h-28 rounded-xl border-2 border-dashed border-primary/10 flex items-center justify-center opacity-20">
                    <span className="text-[9px] uppercase font-bold text-primary tracking-widest">Awaiting...</span>
                  </div>
                )}
                {state.dealerCards.map((rank, idx) => {
                  const hidden = !state.dealerReveal && idx === 1;
                  const suit = suitFor(idx, state.deckSeed + 29);
                  return (
                    <PlayingCard
                      key={`d-${idx}`}
                      index={idx}
                      hidden={hidden}
                      rankLabel={rankLabel(rank)}
                      suitLabel={suit}
                    />
                  );
                })}
              </div>
            </div>

            {/* Table Center Branding */}
            <div className="flex flex-col items-center justify-center my-2 md:my-4 py-2 md:py-4 border-y border-primary/5">
              <div className="text-center opacity-20 pointer-events-none select-none mb-1 md:mb-2">
                <h2 className="text-2xl md:text-5xl font-black uppercase tracking-[0.3em] text-primary drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">5IVE BLACKJACK</h2>
                <div className="flex items-center gap-4 justify-center mt-1 md:mt-2">
                  <span className="h-px w-8 md:w-12 bg-primary/30" />
                  <p className="text-[9px] md:text-sm font-bold tracking-[0.4em] text-primary/80 uppercase">Dealer Stands on 17</p>
                  <span className="h-px w-8 md:w-12 bg-primary/30" />
                </div>
              </div>

              {banner && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  className={cn(
                    "mt-1 md:mt-2 rounded-2xl border-2 px-6 md:px-8 py-2 md:py-3 text-xs md:text-base font-black tracking-[0.2em] uppercase shadow-[0_10px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl z-20",
                    banner.text.includes("win") ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400 text-glow-emerald" : 
                    banner.text.includes("Dealer wins") ? "border-rose-500/50 bg-rose-500/10 text-rose-400 text-glow-red" :
                    "border-amber-400/50 bg-amber-500/10 text-amber-300 text-glow-gold"
                  )}
                >
                  {banner.text}
                </motion.div>
              )}
            </div>

            {/* Player Section */}
            <div className="relative flex flex-col items-center">
              <div className="flex justify-center -space-x-4 sm:-space-x-5 md:-space-x-6 perspective-1000 min-h-[100px] md:min-h-[140px] py-2 md:py-4 z-10">
                {state.playerCards.length === 0 && (
                  <div className="w-16 h-24 md:w-20 md:h-28 rounded-xl border-2 border-dashed border-primary/10 flex items-center justify-center opacity-20">
                    <span className="text-[9px] uppercase font-bold text-primary tracking-widest">Place Bet</span>
                  </div>
                )}
                {state.playerCards.map((rank, idx) => {
                  const suit = suitFor(idx, state.deckSeed + 11);
                  return (
                    <PlayingCard
                      key={`p-${idx}`}
                      index={idx}
                      hidden={false}
                      rankLabel={rankLabel(rank)}
                      suitLabel={suit}
                    />
                  );
                })}
              </div>

              <div className="mt-2 md:mt-4 flex flex-col items-center">
                <div className="px-3 md:px-4 py-0.5 md:py-1 rounded-full bg-black/40 border border-primary/20 backdrop-blur-md shadow-lg">
                  <span className="text-lg md:text-xl font-mono font-bold text-primary text-glow-gold">{state.playerTotal}</span>
                </div>
                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary/60 mt-0.5">Player Hand</span>
              </div>
            </div>
          </section>

          {/* Controls & Info Aside */}
          <aside className="order-2 flex flex-col gap-3 min-w-0">
            {resumeCandidate && !state.setupDone && (
              <div className="rounded-[32px] border border-amber-400/30 bg-amber-500/10 backdrop-blur-xl p-5 shadow-2xl">
                <div className="text-[10px] uppercase tracking-[0.25em] font-black text-amber-200">Resume Available</div>
                <div className="mt-2 text-sm font-semibold text-amber-100">
                  {resumeCandidate.inRound
                    ? `Found an active hand for this wallet on ${network}.`
                    : `Found a saved table for this wallet on ${network}.`}
                </div>
                <div className="mt-2 text-[11px] text-amber-100/80 font-mono">
                  Bet: {resumeCandidate.activeBet} | Chips: {resumeCandidate.chips} | P: {resumeCandidate.playerTotal} | D:{" "}
                  {resumeCandidate.dealerTotal}
                </div>
                {!resumeCandidate.inRound && (
                  <div className="mt-1 text-[10px] text-amber-100/70 uppercase tracking-[0.2em]">
                    Last outcome: {outcomeLabel(resumeCandidate.outcome)}
                  </div>
                )}
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    className="rounded-xl border border-emerald-400/40 bg-emerald-500/15 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
                    disabled={busy}
                    onClick={() => runAction("resume game", resumeStoredGame)}
                  >
                    Resume
                  </button>
                  <button
                    className="rounded-xl border border-white/20 bg-white/5 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-white/80 hover:bg-white/10 disabled:opacity-40"
                    disabled={busy}
                    onClick={startFreshGame}
                  >
                    Start Fresh
                  </button>
                </div>
              </div>
            )}

            {/* Action Card */}
            <div className="rounded-[32px] border border-primary/20 bg-black/40 backdrop-blur-xl p-5 shadow-2xl flex flex-col gap-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <label className="text-[9px] uppercase font-black tracking-[0.2em] text-primary/70">Wager Amount</label>
                  <span className="text-[9px] uppercase font-bold text-emerald-400/70">Min: ${state.minBet}</span>
                </div>
                
                <div className="relative group">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary font-bold text-lg">$</span>
                  <input
                    type="number"
                    className="w-full rounded-2xl border-2 border-primary/10 bg-black/20 py-3 pl-10 pr-4 text-xl font-mono text-white transition-all focus:border-primary/50 focus:bg-black/40 outline-none disabled:opacity-50"
                    value={bet}
                    min={state.minBet}
                    max={state.maxBet}
                    disabled={busy || state.inRound}
                    onChange={(e) => {
                      const parsed = Number(e.target.value);
                      setBet(Number.isFinite(parsed) ? parsed : state.minBet);
                    }}
                  />
                </div>

                <div className="grid grid-cols-4 gap-2 mt-2">
                  {[10, 25, 50, 100].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setBet(amt)}
                      disabled={busy || state.inRound}
                      className="py-1.5 rounded-xl bg-primary/5 border border-primary/10 text-[9px] font-black uppercase tracking-widest text-primary/70 hover:bg-primary/20 hover:text-primary transition-all disabled:opacity-30"
                    >
                      ${amt}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  className="w-full rounded-2xl bg-gradient-to-b from-primary to-[#b8860b] py-3.5 text-xs font-black uppercase tracking-[0.3em] text-primary-foreground shadow-[0_10px_20px_rgba(212,175,55,0.3)] hover:scale-[1.02] active:scale-[0.98] disabled:from-slate-800 disabled:to-slate-900 disabled:text-slate-600 disabled:shadow-none disabled:cursor-not-allowed transition-all"
                  disabled={!canDeal}
                  onClick={() =>
                    runAction("deal", async () => {
                      const wager = normalizeWager(bet, state.minBet, state.maxBet, state.minBet);
                      const seed = Date.now() % 1_000_000;
                      await setupAndDeal(seed, wager);
                    })
                  }
                >
                  DEAL HAND
                </button>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    className="rounded-2xl border-2 border-primary/30 bg-primary/5 py-3 text-xs font-black uppercase tracking-[0.2em] text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-[0.95]"
                    disabled={!canHit || sessionModeBlocked}
                    onClick={() => runAction("hit", async () => { await callAction("hit", {}); })}
                  >
                    HIT
                  </button>

                  <button
                    className="rounded-2xl border-2 border-accent/40 bg-accent/5 py-3 text-xs font-black uppercase tracking-[0.2em] text-accent hover:bg-accent/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-[0.95]"
                    disabled={!canStand || sessionModeBlocked}
                    onClick={() => runAction("stand", async () => { await callAction("stand_and_settle", {}); })}
                  >
                    STAND
                  </button>
                </div>
              </div>
            </div>

            {/* Session & Tech Card */}
            <div className="rounded-[32px] border border-white/5 bg-black/30 backdrop-blur-md p-5 shadow-xl flex flex-col gap-3 min-h-0 overflow-hidden">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-primary animate-pulse shadow-[0_0_8px_rgba(212,175,55,0.8)]" />
                  <span className="text-[9px] uppercase font-black tracking-[0.2em] text-primary/80">Premium Session</span>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-[8px] font-black uppercase tracking-widest ${
                  session.status === "active" ? "bg-emerald-500/20 text-emerald-400" : 
                  session.status === "revoked" ? "bg-rose-500/20 text-rose-400" : "bg-white/10 text-white/50"
                }`}>
                  {session.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  className={cn(
                    "rounded-xl py-1.5 text-[8px] font-black uppercase tracking-wider transition-all",
                    playMode === "direct" ? "bg-primary text-primary-foreground" : "bg-white/5 text-white/60 hover:bg-white/10"
                  )}
                  disabled={busy}
                  onClick={() => setPlayMode("direct")}
                >
                  Direct
                </button>
                <button
                  className={cn(
                    "rounded-xl py-1.5 text-[8px] font-black uppercase tracking-wider transition-all",
                    playMode === "session" ? "bg-primary text-primary-foreground" : "bg-white/5 text-white/60 hover:bg-white/10"
                  )}
                  disabled={busy}
                  onClick={() => setPlayMode("session")}
                >
                  Session
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  className="rounded-xl border border-primary/20 bg-primary/5 py-1.5 text-[8px] font-black uppercase tracking-wider text-primary hover:bg-primary/10 disabled:opacity-40"
                  disabled={!canCreateSession}
                  onClick={() => runAction("create session", createSession)}
                >
                  Establish
                </button>
                <button
                  className="rounded-xl border border-rose-500/30 bg-rose-500/5 py-1.5 text-[8px] font-black uppercase tracking-wider text-rose-400 hover:bg-rose-500/10 disabled:opacity-40"
                  disabled={!canRevokeSession}
                  onClick={() => runAction("revoke session", revokeSession)}
                >
                  Revoke
                </button>
              </div>

              <div className="pt-1.5 border-t border-white/5">
                <div className="text-[8px] uppercase tracking-widest text-white/40 mb-1.5">Open Sessions</div>
                <div className="space-y-1.5">
                  {trackedSessions.length === 0 && (
                    <div className="text-[8px] font-mono text-white/25 italic">No open sessions tracked</div>
                  )}
                  {trackedSessions.map((tracked) => {
                    return (
                      <div
                        key={tracked.sessionAccount}
                        className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[8px] font-mono text-white/70 truncate">
                            {shortKey(tracked.sessionAccount)}
                          </span>
                          <button
                            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[8px] font-black uppercase tracking-wider text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
                            disabled={busy}
                            onClick={() =>
                              runAction(`close session ${shortKey(tracked.sessionAccount)}`, async () => {
                                await closeTrackedSession(tracked);
                              })
                            }
                          >
                            Close
                          </button>
                        </div>
                        <div className="mt-1 text-[8px] font-mono text-white/40">
                          {tracked.status}
                          {tracked.expiresAtSlot != null ? ` @${tracked.expiresAtSlot}` : ""}
                          {` | ${formatSolFromLamports(sessionLamportsByAccount[tracked.sessionAccount])}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-1 flex-1 overflow-y-auto pr-2 custom-scrollbar min-h-0">
                <div className="space-y-1.5 pb-1">
                  <div className="flex justify-between items-center text-[9px] font-mono text-white/40">
                    <span>Network</span>
                    <span className="text-primary/70">{network.toUpperCase()}</span>
                  </div>
                  <div className="flex justify-between items-center text-[9px] font-mono text-white/40">
                    <span>Outcome</span>
                    <span className="text-primary/70">{outcomeLabel(state.outcome).toUpperCase()}</span>
                  </div>
                  <div className="pt-1.5 border-t border-white/5">
                    <div className="text-[8px] uppercase tracking-widest text-white/30 mb-1">TX Log</div>
                    <div className="space-y-1">
                      {sigs.length > 0 ? sigs.slice(0, 3).map((sig) => (
                        <a
                          key={sig}
                          href={`https://solscan.io/tx/${sig}${solscanClusterSuffix}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-[8px] font-mono text-primary/60 hover:text-primary transition-colors truncate"
                        >
                          {sig}
                        </a>
                      )) : <div className="text-[8px] font-mono text-white/20 italic">Empty</div>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
