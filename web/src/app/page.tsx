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
  scopeHashForFunctions,
  type CreateSessionParams,
} from "@5ive-tech/sdk";
import { Navbar } from "@/components/layout/Navbar";
import { PlayingCard } from "@/components/ui/PlayingCard";
import { useNetworkConfig, type NetworkName } from "@/components/providers/WalletContextProvider";

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

const DEFAULT_SESSION_SCOPE_HASH = scopeHashForFunctions(["hit", "stand_and_settle"]);
const SESSION_SCOPE_HASH = process.env.NEXT_PUBLIC_SESSION_SCOPE_HASH || DEFAULT_SESSION_SCOPE_HASH;

const DEFAULT_VM_PROGRAM_ID =
  process.env.NEXT_PUBLIC_FIVE_VM_PROGRAM_ID || "5ive5hbC3aRsvq37MP5m4sHtTSFxT4Cq1smS4ddyWJ6h";
const DEVNET_SCRIPT_ACCOUNT =
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_DEVNET ||
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT ||
  "";
const MAINNET_SCRIPT_ACCOUNT =
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_MAINNET ||
  process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT ||
  "";
const ACCOUNTS_STORAGE_PREFIX = "five-blackjack-accounts";
const SESSION_STORAGE_PREFIX = "five-blackjack-session";
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

function readPlayerSnapshot(bytes: Uint8Array): {
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
  // round_status(8), outcome(8), session_nonce(8), in_round(1)
  const chips = Number(readU64Le(bytes, 32));
  const activeBet = Number(readU64Le(bytes, 40));
  const handTotal = Number(readU64Le(bytes, 48));
  const dealerTotal = Number(readU64Le(bytes, 56));
  const roundStatus = Number(readU64Le(bytes, 64));
  const outcome = Number(readU64Le(bytes, 72));
  const inRound = readBool(bytes, 88);
  return { chips, activeBet, handTotal, dealerTotal, roundStatus, outcome, inRound };
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

function parseEnvAccounts(): GameAccounts | null {
  const table = process.env.NEXT_PUBLIC_BJ_TABLE_ACCOUNT || "";
  const player = process.env.NEXT_PUBLIC_BJ_PLAYER_ACCOUNT || "";
  const round = process.env.NEXT_PUBLIC_BJ_ROUND_ACCOUNT || "";
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
  return FiveProgram.fromABI(scriptAccount, loaded.abi, { fiveVMProgramId: vmProgramId });
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

function isUserRejectedWalletAction(message: string): boolean {
  return /user rejected|rejected the request|declined|cancelled/i.test(message);
}

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
  const [playMode, setPlayMode] = useState<PlayMode>("direct");
  const previousNetworkRef = useRef(network);

  const vmProgramId = useMemo(() => DEFAULT_VM_PROGRAM_ID, []);
  const scriptAccount = useMemo(
    () => (network === "mainnet" ? MAINNET_SCRIPT_ACCOUNT : DEVNET_SCRIPT_ACCOUNT),
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
    setAccounts(fromStorage || parseEnvAccounts());
    setSession(sessionFromStorage || emptySessionState());
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
    setAccounts(fromStorage || parseEnvAccounts());
    setSigs([]);
    setSession(sessionFromStorage || emptySessionState());
    setState(initialState());
    setPlayMode("direct");
    setBusy(false);
    setStatus(`switched to ${network}`);
    setLastTxError(null);
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

  function resolveSessionManagerScriptAccount(): string {
    const explicit = process.env.NEXT_PUBLIC_SESSION_MANAGER_SCRIPT_ACCOUNT || "";
    if (explicit) return explicit;
    return SessionClient.canonicalManagerScriptAccount(vmProgramId);
  }

  async function sendAndConfirm(
    tx: Transaction,
    extraSigners: Keypair[] = [],
    options?: { feePayer?: PublicKey; requireWalletSignature?: boolean }
  ) {
    if (!wallet.publicKey && !options?.feePayer) throw new Error("Connect wallet first.");
    tx.feePayer = options?.feePayer || wallet.publicKey || undefined;
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;
    if (extraSigners.length > 0) tx.partialSign(...extraSigners);
    let sig = "";
    try {
      const requireWalletSignature = options?.requireWalletSignature ?? true;
      if (!requireWalletSignature) {
        sig = await connection.sendRawTransaction(tx.serialize(), { ...CONFIRM_OPTS, maxRetries: 3 });
      } else if (wallet.signTransaction) {
        const signed = await wallet.signTransaction(tx);
        sig = await connection.sendRawTransaction(signed.serialize(), { ...CONFIRM_OPTS, maxRetries: 3 });
      } else if (wallet.sendTransaction) {
        sig = await wallet.sendTransaction(tx, connection, CONFIRM_OPTS);
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

    await connection.confirmTransaction(
      { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );
    pushSig(sig);
    return sig;
  }

  async function provisionAccounts() {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    const owner = new PublicKey(vmProgramId);
    const table = Keypair.generate();
    const player = Keypair.generate();
    const round = Keypair.generate();
    const lamports = await connection.getMinimumBalanceForRentExemption(256);
    const needLamports = lamports * 3;
    const walletLamports = await connection.getBalance(wallet.publicKey, "confirmed");
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

  async function ensureInitialized(): Promise<GameAccounts> {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    let resolved = accounts;
    let setupSigners: Keypair[] = [];
    let setupTx = new Transaction();

    if (!resolved) {
      const owner = new PublicKey(vmProgramId);
      const table = Keypair.generate();
      const player = Keypair.generate();
      const round = Keypair.generate();
      const lamports = await connection.getMinimumBalanceForRentExemption(256);
      const needLamports = lamports * 3;
      const walletLamports = await connection.getBalance(wallet.publicKey, "confirmed");
      if (walletLamports < needLamports) {
        throw new Error(
          `insufficient SOL for account creation: need ${(needLamports / 1e9).toFixed(4)} SOL, have ${(walletLamports / 1e9).toFixed(4)} SOL`
        );
      }

      setupTx = setupTx.add(
        SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: table.publicKey, lamports, space: 256, programId: owner }),
        SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: player.publicKey, lamports, space: 256, programId: owner }),
        SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: round.publicKey, lamports, space: 256, programId: owner })
      );
      setupSigners = [table, player, round];
      resolved = { table: table.publicKey.toBase58(), player: player.publicKey.toBase58(), round: round.publicKey.toBase58() };
      setAccounts(resolved);
      persistAccounts({
        network,
        wallet: wallet.publicKey.toBase58(),
        vmProgramId,
        scriptAccount,
        accounts: resolved,
      });
    }

    if (!state.setupDone) {
      const initTableIx = await buildInstruction(
        "init_table",
        {
          min_bet: state.minBet,
          max_bet: state.maxBet,
          dealer_soft17_hits: state.dealerSoft17Hits,
        },
        resolved
      );
      const initPlayerIx = await buildInstruction("init_player", { initial_chips: 500 }, resolved);
      await sendAndConfirm(setupTx.add(initTableIx, initPlayerIx), setupSigners);
      applyInit();
    }

    return resolved;
  }

  async function buildInstruction(
    functionName: "init_table" | "init_player" | "start_round" | "hit" | "stand_and_settle",
    args: Record<string, unknown>,
    resolved: GameAccounts,
    sessionState?: SessionState
  ): Promise<TransactionInstruction> {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    if (!scriptAccount) {
      throw new Error("Set NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_DEVNET/MAINNET in web/.env.local.");
    }

    let program = await loadProgram(scriptAccount, vmProgramId);
    const walletPk = wallet.publicKey.toBase58();
    const delegatedSession = isDelegatedSessionActive(sessionState);
    const ownerForSessionizedAction = delegatedSession
      ? sessionState!.delegate!.publicKey.toBase58()
      : walletPk;
    const sessionForSessionizedAction = delegatedSession
      ? sessionState!.sessionAccount!.toBase58()
      : walletPk;
    const vmPayer = delegatedSession ? ownerForSessionizedAction : walletPk;
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
      init_table: { table: resolved.table, authority: walletPk },
      init_player: { player: resolved.player, owner: walletPk },
      start_round: { table: resolved.table, player: resolved.player, round: resolved.round, owner: walletPk },
      hit: {
        player: resolved.player,
        round: resolved.round,
        owner: ownerForSessionizedAction,
        __session: sessionForSessionizedAction,
      },
      stand_and_settle: {
        table: resolved.table,
        player: resolved.player,
        round: resolved.round,
        owner: ownerForSessionizedAction,
        __session: sessionForSessionizedAction,
      },
    };

    let builder = program
      .function(functionName)
      .payer(vmPayer)
      .accounts(accountMapByFunction[functionName]);
    if (Object.keys(args).length > 0) builder = builder.args(args);
    const encoded = await builder.instruction();

    const ix = new TransactionInstruction({
      programId: new PublicKey(encoded.programId),
      keys: encoded.keys.map((k: { pubkey: string; isSigner: boolean; isWritable: boolean }) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(decodeBase64ToBytes(encoded.data)),
    });

    return ix;
  }

  async function callAction(functionName: "start_round" | "hit" | "stand_and_settle", args: Record<string, unknown>) {
    const resolved = await ensureInitialized();
    const sessionized = functionName === "hit" || functionName === "stand_and_settle";
    if (sessionized) {
      const playerInfo = await connection.getAccountInfo(new PublicKey(resolved.player), "confirmed");
      if (!playerInfo?.data) throw new Error("player account not found");
      const player = readPlayerSnapshot(playerInfo.data);
      setState((prev) => ({
        ...prev,
        chips: player.chips,
        activeBet: player.activeBet,
        playerTotal: player.handTotal,
        dealerTotal: player.dealerTotal,
        inRound: player.inRound,
        outcome: player.outcome,
        dealerReveal: !player.inRound,
      }));
      if (!player.inRound || player.roundStatus !== ROUND_ACTIVE) {
        await syncStateFromChain(resolved);
        throw new Error(
          `${functionName} blocked: round is not active on-chain (in_round=${player.inRound}, status=${player.roundStatus})`
        );
      }
    }

    let extraSigners: Keypair[] = [];
    let mergedArgs = { ...args };
    let sessionForInstruction: SessionState | undefined;
    let txFeePayer: PublicKey | undefined;
    let requireWalletSignature = true;
    if (sessionized) {
      if (playMode !== "session") {
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
        const currentSlot = await connection.getSlot("confirmed");
        if (session.expiresAtSlot && currentSlot > session.expiresAtSlot) {
          setSession((prev) => ({ ...prev, status: "expired" }));
        } else {
          sessionForInstruction = session;
          extraSigners = [session.delegate as Keypair];
          txFeePayer = session.delegate!.publicKey;
          requireWalletSignature = false;
        }
      } else {
        throw new Error("Session mode is enabled, but no active delegated session exists.");
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
      throw new Error(`action ${functionName} failed: ${errText(err)}`);
    }
  }

  async function createSession() {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    if (!scriptAccount) {
      throw new Error("Set NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_DEVNET/MAINNET in web/.env.local.");
    }
    const resolved = await ensureInitialized();

    const delegate = session.delegate || Keypair.generate();
    const managerScriptAccount = resolveSessionManagerScriptAccount();
    const sessionClient = new SessionClient({
      vmProgramId,
      managerScriptAccount,
    });
    const slot = await connection.getSlot("confirmed");
    const expiresAtSlot = slot + Math.max(1, SESSION_TTL_SLOTS);

    let syncedNonce = session.nonce;
    try {
      const playerInfo = await connection.getAccountInfo(new PublicKey(resolved.player), "confirmed");
      if (playerInfo?.data) {
        // PlayerState layout stores session_nonce as u64 LE at byte offset 80.
        syncedNonce = Number(readU64Le(playerInfo.data, 80));
      }
    } catch {
      // Keep local nonce fallback if account read fails.
    }

    const delegateBalance = await connection.getBalance(delegate.publicKey, "confirmed");
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
      setSession({
        delegate,
        sessionAccount: new PublicKey(plan.sessionAddress),
        status: "active",
        nonce: syncedNonce,
        expiresAtSlot,
        managerScriptAccount,
      });
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
    setSession({
      delegate,
      sessionAccount: new PublicKey(sessionAddress),
      status: "active",
      nonce: syncedNonce,
      expiresAtSlot,
      managerScriptAccount,
    });
  }

  async function revokeSession() {
    if (!session.sessionAccount || !session.delegate || !wallet.publicKey) {
      throw new Error("No session to revoke.");
    }
    const managerScriptAccount = session.managerScriptAccount || resolveSessionManagerScriptAccount();
    const authority = wallet.publicKey.toBase58();
    const program = FiveProgram.fromABI(
      managerScriptAccount,
      SESSION_MANAGER_REVOKE_ABI as Parameters<typeof FiveProgram.fromABI>[1],
      { fiveVMProgramId: vmProgramId }
    );
    const encoded = await program
      .function("revoke_session")
      .accounts({
        session: session.sessionAccount.toBase58(),
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
    setSession((prev) => ({
      ...prev,
      status: "revoked",
      delegate: null,
      sessionAccount: null,
      expiresAtSlot: null,
    }));
  }

  async function setupAndDeal(seed: number, wager: number) {
    const resolved = await ensureInitialized();
    const playerInfo = await connection.getAccountInfo(new PublicKey(resolved.player), "confirmed");
    if (!playerInfo?.data) throw new Error("player account not found");
    const player = readPlayerSnapshot(playerInfo.data);
    setState((prev) => ({ ...prev, chips: player.chips }));
    if (player.inRound) {
      throw new Error("round already in progress on-chain; finish with hit/stand before dealing again");
    }
    if (player.chips < wager) {
      throw new Error(`insufficient chips for bet ${wager}; on-chain chips=${player.chips}`);
    }
    const startRoundIx = await buildInstruction("start_round", { bet: wager, seed }, resolved);
    try {
      await sendAndConfirm(new Transaction().add(startRoundIx));
      await syncStateFromChain(resolved);
    } catch (err) {
      throw new Error(`setup(start_round) failed: ${errText(err)}`);
    }
  }

  async function syncStateFromChain(resolved: GameAccounts) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [playerInfo, roundInfo] = await Promise.all([
        connection.getAccountInfo(new PublicKey(resolved.player), "confirmed"),
        connection.getAccountInfo(new PublicKey(resolved.round), "confirmed"),
      ]);
      if (!playerInfo?.data) {
        if (attempt < 2) await sleep(120);
        continue;
      }

      const player = readPlayerSnapshot(playerInfo.data);
      if (!roundInfo?.data) {
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
        if (attempt < 2) await sleep(120);
        continue;
      }

      const round = readRoundSnapshot(roundInfo.data);
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
      while (playerCards.length < round.playerCardCount) pushPlayer();
      while (dealerCards.length < round.dealerCardCount) pushDealer();

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
      return;
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

  async function runAction(name: string, fn: () => Promise<void>) {
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
    <div className="h-[100dvh] relative overflow-hidden flex flex-col bg-emerald-950">
      <Navbar status={status} chips={state.chips} activeBet={state.activeBet} />

      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(16,185,129,0.15)_0%,_rgba(2,44,34,1)_100%)] pointer-events-none z-0" />
      <div className="absolute inset-0 opacity-10 bg-[url('https://www.transparenttextures.com/patterns/black-paper.png')] pointer-events-none mix-blend-overlay z-0" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-emerald-400/5 rounded-full blur-[100px] pointer-events-none z-0" />

      <main className="flex-1 w-full max-w-7xl mx-auto px-3 md:px-6 pt-20 pb-3 relative z-10 min-h-0 overflow-hidden">
        <div className="grid h-full min-h-0 gap-3 grid-rows-[minmax(0,1fr)_auto] md:grid-rows-1 md:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="order-1 md:order-1 rounded-3xl border border-emerald-300/15 bg-black/35 backdrop-blur-xl p-2.5 md:p-4 shadow-[0_20px_50px_rgba(0,0,0,0.45)] flex flex-col justify-between min-h-0 overflow-hidden">
            <div className="flex flex-col items-center">
              <div className="mb-1 w-full max-w-md flex items-center gap-2">
                <div className="h-px bg-emerald-500/20 flex-1" />
                <div className="text-center">
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-200/50 block">Dealer</span>
                  <span className="text-lg font-mono text-emerald-100">{dealerDisplayTotal}</span>
                </div>
                <div className="h-px bg-emerald-500/20 flex-1" />
              </div>

              <div className="flex justify-center -space-x-7 sm:-space-x-8 md:-space-x-10 perspective-1000 min-h-20 sm:min-h-24 md:min-h-32 py-1 px-3 sm:px-4 md:px-6">
                {state.dealerCards.length === 0 && (
                  <div className="w-14 h-20 sm:w-16 sm:h-24 md:w-20 md:h-28 rounded-xl border border-dashed border-emerald-500/20 flex items-center justify-center opacity-30">
                    <span className="text-[10px] uppercase font-bold text-emerald-200">Empty</span>
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

            <div className="flex flex-col items-center justify-center my-1.5 md:my-2">
              <div className="text-center opacity-30 pointer-events-none select-none mb-1">
                <h2 className="text-lg sm:text-xl md:text-3xl font-black uppercase tracking-[0.2em] md:tracking-[0.28em] text-emerald-100">Blackjack</h2>
                <p className="text-[10px] sm:text-xs md:text-sm font-bold tracking-[0.24em] md:tracking-[0.35em] text-emerald-200">Pays 3 to 2</p>
                <p className="hidden md:block text-[10px] uppercase tracking-widest text-emerald-300/60 mt-1">Dealer Draws to 16, Stands on 17</p>
              </div>

              {banner && (
                <div className={`mt-1 rounded-full border px-3 sm:px-4 md:px-5 py-1 text-[10px] sm:text-xs md:text-sm font-bold tracking-widest uppercase shadow-[0_0_30px_rgba(0,0,0,0.5)] backdrop-blur-md ${banner.cls}`}>
                  {banner.text}
                </div>
              )}
            </div>

            <div className="flex flex-col items-center">
              <div className="flex justify-center -space-x-7 sm:-space-x-8 md:-space-x-10 perspective-1000 min-h-20 sm:min-h-24 md:min-h-32 py-1 px-3 sm:px-4 md:px-6 z-10">
                {state.playerCards.length === 0 && (
                  <div className="w-14 h-20 sm:w-16 sm:h-24 md:w-20 md:h-28 rounded-xl border border-dashed border-emerald-500/20 flex items-center justify-center opacity-30">
                    <span className="text-[10px] uppercase font-bold text-emerald-200">Empty</span>
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

              <div className="mt-1.5 md:mt-2 w-full max-w-md flex items-center gap-3">
                <div className="h-px bg-emerald-500/20 flex-1" />
                <div className="text-center">
                  <span className="text-base md:text-lg font-mono text-emerald-100">{state.playerTotal}</span>
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-200/50 block">Player</span>
                </div>
                <div className="h-px bg-emerald-500/20 flex-1" />
              </div>
            </div>
          </section>

          <aside className="order-2 md:order-2 rounded-3xl border border-white/10 bg-black/40 backdrop-blur-xl p-2.5 md:p-4 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col gap-2 md:gap-3 min-h-0 max-h-none md:max-h-[calc(100dvh-6.5rem)] overflow-hidden md:overflow-y-auto">
            <div className="grid grid-cols-[auto_1fr] items-end gap-2">
              <label className="text-[10px] uppercase font-bold tracking-widest text-slate-400 pb-1">Bet</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                <input
                  type="number"
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-2 pl-7 pr-3 text-base font-mono text-white transition-all focus:border-emerald-500/50 focus:bg-white/10 outline-none disabled:opacity-50"
                  value={bet}
                  min={state.minBet}
                  max={state.maxBet}
                  disabled={busy || state.inRound}
                  onChange={(e) => setBet(Number(e.target.value || 0))}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                className="rounded-xl bg-gradient-to-t from-emerald-600 to-emerald-400 px-3 py-2 text-xs font-black uppercase tracking-widest text-emerald-950 hover:from-emerald-500 hover:to-emerald-300 disabled:from-slate-800 disabled:to-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed transition-all shadow-lg active:scale-95"
                disabled={!canDeal}
                onClick={() =>
                  runAction("deal", async () => {
                    const wager = Math.max(state.minBet, Math.min(state.maxBet, bet || 25));
                    const seed = Date.now() % 1_000_000;
                    await setupAndDeal(seed, wager);
                  })
                }
              >
                Deal
              </button>

              <button
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold uppercase tracking-widest text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
                disabled={!canHit || sessionModeBlocked}
                onClick={() => runAction("hit", async () => { await callAction("hit", {}); })}
              >
                Hit
              </button>

              <button
                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-bold uppercase tracking-widest text-rose-300 hover:bg-rose-500/20 hover:border-rose-500/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
                disabled={!canStand || sessionModeBlocked}
                onClick={() => runAction("stand", async () => { await callAction("stand_and_settle", {}); })}
              >
                Stand
              </button>
            </div>

            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-2 text-xs font-mono text-emerald-100/80">
              <div className="mb-2 flex items-center justify-between">
                <div className="relative group/session-help flex items-center gap-1.5">
                  <div className="uppercase tracking-widest text-emerald-300/70">Session</div>
                  <button
                    type="button"
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-emerald-300/35 text-[9px] font-bold text-emerald-200/90 hover:bg-emerald-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
                    aria-label="What session mode does"
                  >
                    ?
                  </button>
                  <div className="pointer-events-none absolute left-0 top-6 z-20 hidden w-64 rounded-lg border border-emerald-300/30 bg-emerald-950/95 p-2 text-[10px] font-medium normal-case leading-relaxed tracking-normal text-emerald-100 shadow-xl group-hover/session-help:block group-focus-within/session-help:block">
                    Session mode lets you approve once, then a delegated signer can submit hit/stand transactions until the session expires.
                  </div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  session.status === "active"
                    ? "bg-emerald-400/20 text-emerald-200"
                    : session.status === "revoked"
                    ? "bg-rose-400/20 text-rose-200"
                    : "bg-white/10 text-emerald-100/80"
                }`}>
                  {session.status}
                </span>
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  className={`rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                    playMode === "direct"
                      ? "border border-sky-300/50 bg-sky-500/25 text-sky-100"
                      : "border border-white/15 bg-white/5 text-emerald-100 hover:bg-white/10"
                  }`}
                  disabled={busy}
                  onClick={() => setPlayMode("direct")}
                >
                  Direct
                </button>
                <button
                  className={`rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                    playMode === "session"
                      ? "border border-sky-300/50 bg-sky-500/25 text-sky-100"
                      : "border border-white/15 bg-white/5 text-emerald-100 hover:bg-white/10"
                  }`}
                  disabled={busy}
                  onClick={() => setPlayMode("session")}
                >
                  Session
                </button>
                <span className="text-[10px] uppercase tracking-wider text-emerald-200/75">
                  {playMode === "session" && !hasActiveDelegatedSession ? "session mode needs active session" : `mode: ${playMode}`}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  className="rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
                  disabled={!canCreateSession}
                  onClick={() => runAction("create session", createSession)}
                >
                  Create Session
                </button>
                <button
                  className="rounded-lg border border-rose-400/40 bg-rose-500/20 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-rose-100 hover:bg-rose-500/30 disabled:opacity-40"
                  disabled={!canRevokeSession}
                  onClick={() => runAction("revoke session", revokeSession)}
                >
                  Revoke Session
                </button>
              </div>
              <div className="mt-2 text-[10px] uppercase tracking-wider text-emerald-200/70">
                {playMode === "direct"
                  ? "Direct mode uses your wallet for hit/stand."
                  : hasActiveDelegatedSession
                  ? "Session mode ready."
                  : "Create a session to use session mode."}
              </div>
            </div>

              <div className="hidden md:block mt-1 rounded-xl border border-white/10 bg-black/25 p-2 text-[10px] font-mono text-emerald-500/70 space-y-1">
              <div>vm: {vmProgramId}</div>
              <div>script: {scriptAccount || "MISSING NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_DEVNET/MAINNET"}</div>
              <div>network: {network}</div>
              <div>rpc: {displayEndpoint}</div>
              <div>round_status: {outcomeLabel(state.outcome)}</div>
              <div className="break-words whitespace-pre-wrap text-rose-300/90">
                last_error: {lastTxError || "none"}
              </div>
              <div>
                accounts:{" "}
                {accounts ? (
                  <>
                    <a
                      href={`https://solscan.io/account/${accounts.table}${solscanClusterSuffix}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-300 hover:underline"
                    >
                      t={shortKey(accounts.table)}
                    </a>{" "}
                    <a
                      href={`https://solscan.io/account/${accounts.player}${solscanClusterSuffix}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-300 hover:underline"
                    >
                      p={shortKey(accounts.player)}
                    </a>{" "}
                    <a
                      href={`https://solscan.io/account/${accounts.round}${solscanClusterSuffix}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-300 hover:underline"
                    >
                      r={shortKey(accounts.round)}
                    </a>
                  </>
                ) : (
                  "unset"
                )}
              </div>
              <div>
                txs:{" "}
                {sigs.length ? (
                  sigs.map((sig, idx) => (
                    <span key={sig}>
                      <a
                        href={`https://solscan.io/tx/${sig}${solscanClusterSuffix}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-emerald-300 hover:underline"
                      >
                        {shortSig(sig)}
                      </a>
                      {idx < sigs.length - 1 ? " | " : ""}
                    </span>
                  ))
                ) : (
                  "none"
                )}
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
