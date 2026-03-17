"use client";

import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type ConfirmOptions,
} from "@solana/web3.js";
import { FiveProgram, FiveSDK, SessionClient, scopeHashForFunctions } from "@5ive-tech/sdk";
import { Navbar } from "@/components/layout/Navbar";
import { PlayingCard } from "@/components/ui/PlayingCard";

type GameAccounts = {
  table: string;
  player: string;
  round: string;
};

type SessionState = {
  delegate: Keypair | null;
  sessionAccount: Keypair | null;
  status: "unknown" | "active" | "revoked" | "expired";
  nonce: number;
  expiresAtSlot: number | null;
  managerScriptAccount: string;
};

type PlayMode = "direct" | "session";

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
const SESSION_ACCOUNT_SPACE = 256;
const SESSION_TTL_SLOTS = Number(process.env.NEXT_PUBLIC_SESSION_TTL_SLOTS || "3000");
const SESSION_DELEGATE_MIN_FEE_LAMPORTS = 500_000;
const SESSION_DELEGATE_TOPUP_LAMPORTS = 2_000_000;

const DEFAULT_SESSION_SCOPE_HASH = scopeHashForFunctions(["hit", "stand_and_settle"]);
const SESSION_SCOPE_HASH = process.env.NEXT_PUBLIC_SESSION_SCOPE_HASH || DEFAULT_SESSION_SCOPE_HASH;

const DEFAULT_VM_PROGRAM_ID =
  process.env.NEXT_PUBLIC_FIVE_VM_PROGRAM_ID || "5ive5uKDkc3Yhyfu1Sk7i3eVPDQUmG2GmTm2FnUZiTJd";
const DEFAULT_SCRIPT_ACCOUNT = process.env.NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT || "";
const DEFAULT_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";

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

function parseEnvAccounts(): GameAccounts | null {
  const table = process.env.NEXT_PUBLIC_BJ_TABLE_ACCOUNT || "";
  const player = process.env.NEXT_PUBLIC_BJ_PLAYER_ACCOUNT || "";
  const round = process.env.NEXT_PUBLIC_BJ_ROUND_ACCOUNT || "";
  if (!table || !player || !round) return null;
  return { table, player, round };
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

function cardValue(rank: number): number {
  if (rank === 1) return 11;
  if (rank >= 10) return 10;
  return rank;
}

function addCard(total: number, softAces: number, seed: number, cursor: number, marker: number) {
  const rank = cardRank(seed, cursor, marker);
  let nextTotal = total + cardValue(rank);
  let nextSoftAces = softAces + (rank === 1 ? 1 : 0);
  while (nextTotal > 21 && nextSoftAces > 0) {
    nextTotal -= 10;
    nextSoftAces -= 1;
  }
  return { rank, total: nextTotal, softAces: nextSoftAces, cursor: cursor + 1 };
}

function dealerShouldDraw(total: number, softAces: number, soft17Hits: boolean): boolean {
  if (total < 17) return true;
  if (soft17Hits && total === 17 && softAces > 0) return true;
  return false;
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

export default function Home() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [status, setStatus] = useState("ready");
  const [busy, setBusy] = useState(false);
  const [bet, setBet] = useState(25);
  const [accounts, setAccounts] = useState<GameAccounts | null>(parseEnvAccounts());
  const [sigs, setSigs] = useState<string[]>([]);
  const [state, setState] = useState<GameState>(initialState());
  const [session, setSession] = useState<SessionState>({
    delegate: null,
    sessionAccount: null,
    status: "unknown",
    nonce: 0,
    expiresAtSlot: null,
    managerScriptAccount: "",
  });
  const [playMode, setPlayMode] = useState<PlayMode>("direct");

  const vmProgramId = useMemo(() => DEFAULT_VM_PROGRAM_ID, []);
  const scriptAccount = useMemo(() => DEFAULT_SCRIPT_ACCOUNT, []);
  const explorerPrefix = useMemo(() => {
    const explicit = process.env.NEXT_PUBLIC_EXPLORER_BASE || "";
    if (explicit) return explicit;
    if (DEFAULT_RPC_URL.includes("devnet") || DEFAULT_RPC_URL.includes("mainnet")) {
      return "https://explorer.solana.com/tx/";
    }
    return "";
  }, []);
  const explorerSuffix = useMemo(() => {
    if (DEFAULT_RPC_URL.includes("devnet")) return "?cluster=devnet";
    return "";
  }, []);

  const walletConnected = !!wallet.connected && !!wallet.publicKey;

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
    if (!scriptAccount) throw new Error("Set NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT in web/.env.local.");

    let program = await loadProgram(scriptAccount, vmProgramId);
    const walletPk = wallet.publicKey.toBase58();
    const delegatedSession = isDelegatedSessionActive(sessionState);
    const ownerForSessionizedAction = delegatedSession
      ? sessionState!.delegate!.publicKey.toBase58()
      : walletPk;
    const sessionForSessionizedAction = delegatedSession
      ? sessionState!.sessionAccount!.publicKey.toBase58()
      : walletPk;
    const vmPayer = delegatedSession ? ownerForSessionizedAction : walletPk;
    if ((functionName === "hit" || functionName === "stand_and_settle") && delegatedSession) {
      program = program.withSession({
        mode: "auto",
        manager: { defaultTtlSlots: SESSION_TTL_SLOTS } as any,
        sessionAccountByFunction: {
          [functionName]: sessionState!.sessionAccount!.publicKey.toBase58(),
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
    if (!scriptAccount) throw new Error("Set NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT in web/.env.local.");
    const resolved = await ensureInitialized();

    const owner = new PublicKey(vmProgramId);
    const delegate = session.delegate || Keypair.generate();
    const sessionAccount = Keypair.generate();
    const managerScriptAccount = resolveSessionManagerScriptAccount();
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

    const lamports = await connection.getMinimumBalanceForRentExemption(SESSION_ACCOUNT_SPACE);
    const sessionDraft: SessionState = {
      delegate,
      sessionAccount,
      status: "unknown",
      nonce: syncedNonce,
      expiresAtSlot,
      managerScriptAccount,
    };

    const createIx = SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: sessionAccount.publicKey,
      lamports,
      space: SESSION_ACCOUNT_SPACE,
      programId: owner,
    });
    const delegateBalance = await connection.getBalance(delegate.publicKey, "confirmed");
    const topupIx =
      delegateBalance >= SESSION_DELEGATE_MIN_FEE_LAMPORTS
        ? null
        : SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: delegate.publicKey,
            lamports: SESSION_DELEGATE_TOPUP_LAMPORTS,
          });

    const sessionClient = new SessionClient({
      vmProgramId,
      managerScriptAccount,
    });
    await sessionClient.createSessionWithCompat(
      {
        authority: wallet.publicKey.toBase58(),
        delegate: delegate.publicKey.toBase58(),
        targetProgram: scriptAccount,
        expiresAtSlot,
        scopeHash: SESSION_SCOPE_HASH,
        bindAccount: resolved.player,
        nonce: syncedNonce,
        compatMode: "auto",
      },
      async (sessionIx) => {
        const tx = new Transaction().add(createIx);
        if (topupIx) tx.add(topupIx);
        tx.add(sessionIx);
        return sendAndConfirm(tx, [sessionAccount]);
      }
    );
    setSession({
      delegate,
      sessionAccount,
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
    const sessionClient = new SessionClient({
      vmProgramId,
      managerScriptAccount: session.managerScriptAccount || resolveSessionManagerScriptAccount(),
    });
    const revokeIx = await sessionClient.revokeSessionIx({
      authority: wallet.publicKey.toBase58(),
      delegate: session.delegate.publicKey.toBase58(),
      targetProgram: scriptAccount,
      payer: wallet.publicKey.toBase58(),
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
    const startRoundIx = await buildInstruction("start_round", { bet: wager, seed }, resolved);
    try {
      await sendAndConfirm(new Transaction().add(startRoundIx));
    } catch (err) {
      throw new Error(`setup(start_round) failed: ${errText(err)}`);
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

  function applyStartRound(seed: number, wager: number) {
    setState((prev) => {
      const ownerMarker = 1 + wager + (seed % 97);
      let drawCursor = 0;
      let pTotal = 0;
      let dTotal = 0;
      let pSoft = 0;
      let dSoft = 0;
      const pCards: number[] = [];
      const dCards: number[] = [];

      let c = addCard(pTotal, pSoft, seed, drawCursor, ownerMarker);
      pTotal = c.total; pSoft = c.softAces; drawCursor = c.cursor; pCards.push(c.rank);
      c = addCard(dTotal, dSoft, seed, drawCursor, ownerMarker);
      dTotal = c.total; dSoft = c.softAces; drawCursor = c.cursor; dCards.push(c.rank);
      c = addCard(pTotal, pSoft, seed, drawCursor, ownerMarker);
      pTotal = c.total; pSoft = c.softAces; drawCursor = c.cursor; pCards.push(c.rank);
      c = addCard(dTotal, dSoft, seed, drawCursor, ownerMarker);
      dTotal = c.total; dSoft = c.softAces; drawCursor = c.cursor; dCards.push(c.rank);

      return {
        ...prev,
        activeBet: wager,
        deckSeed: seed,
        ownerMarker,
        drawCursor,
        playerTotal: pTotal,
        dealerTotal: dTotal,
        playerSoftAces: pSoft,
        dealerSoftAces: dSoft,
        playerCards: pCards,
        dealerCards: dCards,
        inRound: true,
        outcome: ROUND_ACTIVE,
        dealerReveal: false,
      };
    });
  }

  function applyHit() {
    setState((prev) => {
      if (!prev.inRound) return prev;
      const c = addCard(prev.playerTotal, prev.playerSoftAces, prev.deckSeed, prev.drawCursor, prev.ownerMarker);
      const next = {
        ...prev,
        playerTotal: c.total,
        playerSoftAces: c.softAces,
        drawCursor: c.cursor,
        playerCards: [...prev.playerCards, c.rank],
      };
      if (next.playerTotal > 21) {
        return {
          ...next,
          inRound: false,
          outcome: ROUND_DEALER_WIN,
          chips: next.chips - next.activeBet,
          dealerReveal: true,
        };
      }
      return next;
    });
  }

  function applyStand() {
    setState((prev) => {
      if (!prev.inRound) return prev;
      let dealerTotal = prev.dealerTotal;
      let dealerSoft = prev.dealerSoftAces;
      let cursor = prev.drawCursor;
      const dealerCards = [...prev.dealerCards];

      while (dealerShouldDraw(dealerTotal, dealerSoft, prev.dealerSoft17Hits)) {
        const c = addCard(dealerTotal, dealerSoft, prev.deckSeed, cursor, prev.ownerMarker);
        dealerTotal = c.total;
        dealerSoft = c.softAces;
        cursor = c.cursor;
        dealerCards.push(c.rank);
        if (dealerCards.length > 12) break;
      }

      let outcome = ROUND_PUSH;
      let chips = prev.chips;
      if (dealerTotal > 21) {
        outcome = ROUND_PLAYER_WIN;
        chips += prev.activeBet;
      } else if (prev.playerTotal > dealerTotal) {
        outcome = ROUND_PLAYER_WIN;
        chips += prev.activeBet;
      } else if (prev.playerTotal < dealerTotal) {
        outcome = ROUND_DEALER_WIN;
        chips -= prev.activeBet;
      }

      return {
        ...prev,
        dealerTotal,
        dealerSoftAces: dealerSoft,
        drawCursor: cursor,
        dealerCards,
        outcome,
        chips,
        inRound: false,
        activeBet: 0,
        dealerReveal: true,
      };
    });
  }

  async function runAction(name: string, fn: () => Promise<void>) {
    try {
      setBusy(true);
      setStatus(`${name}...`);
      await fn();
      setStatus(`${name} complete`);
    } catch (err) {
      const message = errText(err);
      if (/access forbidden|\"code\"\s*:\s*403/i.test(message)) {
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
      <Navbar status={status} chips={state.chips} activeBet={state.activeBet} walletConnected={walletConnected} />

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
                    applyStartRound(seed, wager);
                  })
                }
              >
                Deal
              </button>

              <button
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold uppercase tracking-widest text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
                disabled={!canHit || sessionModeBlocked}
                onClick={() => runAction("hit", async () => { await callAction("hit", {}); applyHit(); })}
              >
                Hit
              </button>

              <button
                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-bold uppercase tracking-widest text-rose-300 hover:bg-rose-500/20 hover:border-rose-500/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
                disabled={!canStand || sessionModeBlocked}
                onClick={() => runAction("stand", async () => { await callAction("stand_and_settle", {}); applyStand(); })}
              >
                Stand
              </button>
            </div>

            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-2 text-xs font-mono text-emerald-100/80">
              <div className="mb-2 flex items-center justify-between">
                <div className="uppercase tracking-widest text-emerald-300/70">Session</div>
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
              <div>script: {scriptAccount || "MISSING NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT"}</div>
              <div>round_status: {outcomeLabel(state.outcome)}</div>
              <div>
                accounts:{" "}
                {accounts
                  ? `t=${shortKey(accounts.table)} p=${shortKey(accounts.player)} r=${shortKey(accounts.round)}`
                  : "unset"}
              </div>
              <div>
                txs:{" "}
                {sigs.length ? (
                  sigs.map((sig, idx) => (
                    <span key={sig}>
                      {explorerPrefix ? (
                        <a href={`${explorerPrefix}${sig}${explorerSuffix}`} target="_blank" rel="noreferrer" className="text-emerald-300 hover:underline">
                          {shortSig(sig)}
                        </a>
                      ) : (
                        shortSig(sig)
                      )}
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
