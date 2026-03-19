import { readFile } from 'fs/promises';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  FiveProgram,
  FiveSDK,
  SessionClient,
  SessionManager,
  deployScriptWithFallback,
  loadDefaultPayerKeypair,
  resolveFiveArtifactPath,
  sendEncodedInstruction,
  sendTransactionInstruction,
  scopeHashForFunctions,
  type LocalnetStepResult,
} from '@5ive-tech/sdk';

export type StepResult = LocalnetStepResult;

export type LocalnetState = {
  table: {
    minBet: number;
    maxBet: number;
    dealerSoft17Hits: boolean;
    roundNonce: number;
  };
  player: {
    chips: number;
    activeBet: number;
    handTotal: number;
    dealerTotal: number;
    roundStatus: number;
    outcome: number;
    sessionNonce: number;
    inRound: boolean;
  };
  round: {
    deckSeed: number;
    ownerMarker: number;
    drawCursor: number;
    playerCardCount: number;
    dealerCardCount: number;
    playerSoftAces: number;
    dealerSoftAces: number;
    playerStand: boolean;
  };
  hands: {
    player: number[];
    dealer: number[];
    dealerReveal: boolean;
  };
  session: {
    active: boolean;
    scopeHash: string;
    managerScriptAccount: string;
    sessionAccount: string;
    delegate: string;
  };
};

export type GameSetup = {
  minBet: number;
  maxBet: number;
  dealerSoft17Hits: boolean;
  initialChips: number;
};
export type Role = 'p1';

const ROUND_IDLE = 0;
const ROUND_ACTIVE = 1;
const ROUND_PLAYER_BUST = 2;
const ROUND_DEALER_BUST = 3;
const ROUND_PLAYER_WIN = 4;
const ROUND_DEALER_WIN = 5;
const ROUND_PUSH = 6;
const SESSION_SCOPE_HASH = scopeHashForFunctions(['hit', 'stand_and_settle']);

async function loadSessionManagerArtifact(projectRoot: string) {
  const templateProject = join(projectRoot, '..', 'five-templates', 'session-manager');
  const templateArtifact = join(templateProject, 'build', 'five-session-manager-template.five');
  const build = spawnSync(
    'node',
    [join(projectRoot, '..', 'five-cli', 'dist', 'index.js'), 'build', '--project', templateProject],
    { encoding: 'utf8' }
  );
  if (build.status !== 0) {
    throw new Error(`session manager template build failed: ${build.stderr || build.stdout || 'unknown error'}`);
  }
  const artifactText = await readFile(templateArtifact, 'utf8');
  return FiveSDK.loadFiveFile(artifactText);
}

async function ensureSessionManagerDeployment(
  connection: Connection,
  payer: Keypair,
  vmProgramId: string,
  sessionManagerScriptAccount: string,
  projectRoot: string
): Promise<void> {
  const existing = await connection.getAccountInfo(new PublicKey(sessionManagerScriptAccount), 'confirmed');
  if (existing) return;
  const loaded = await loadSessionManagerArtifact(projectRoot);
  const result: any = await FiveSDK.deployToSolana(loaded.bytecode, connection, payer, {
    fiveVMProgramId: vmProgramId,
    service: 'session_v1',
  });

  if (!result.success) {
    throw new Error(`session manager deploy failed: ${result.error || 'unknown error'}`);
  }
}

function cardRank(seed: number, cursor: number, marker: number): number {
  const mixed = seed + cursor * 17 + marker * 31 + 7;
  return (mixed % 13) + 1;
}

function cardValue(rank: number): number {
  if (rank === 1) return 11;
  if (rank >= 10) return 10;
  return rank;
}

function addCard(total: number, softAces: number, seed: number, cursor: number, marker: number) {
  const rank = cardRank(seed, cursor, marker);
  const value = cardValue(rank);
  let nextTotal = total + value;
  let nextSoftAces = softAces;
  if (rank === 1) nextSoftAces += 1;
  while (nextTotal > 21 && nextSoftAces > 0) {
    nextTotal -= 10;
    nextSoftAces -= 1;
  }
  return {
    total: nextTotal,
    softAces: nextSoftAces,
    cursor: cursor + 1,
    rank,
  };
}

function dealerShouldDraw(total: number, softAces: number, dealerSoft17Hits: boolean): boolean {
  if (total < 17) return true;
  if (dealerSoft17Hits && total === 17 && softAces > 0) return true;
  return false;
}

export class LocalnetBlackjackEngine {
  readonly projectRoot: string;
  readonly connection: Connection;
  readonly payer: Keypair;
  readonly fiveVmProgramId: string;
  readonly scriptAccount: string;
  readonly program: any;
  readonly sessionProgram: any;
  readonly tableAccount: Keypair;
  readonly playerAccount: Keypair;
  readonly roundAccount: Keypair;
  readonly owner: Keypair;
  readonly delegate: Keypair;
  readonly sessionAccount: string;
  readonly sessionClient: SessionClient;
  readonly sessionManagerScriptAccount: string;
  readonly setupSteps: StepResult[];
  readonly useDelegatedSession: boolean;

  private state: LocalnetState;

  private constructor(args: {
    projectRoot: string;
    connection: Connection;
    payer: Keypair;
    fiveVmProgramId: string;
    scriptAccount: string;
    program: any;
    sessionProgram: any;
    tableAccount: Keypair;
    playerAccount: Keypair;
    roundAccount: Keypair;
    owner: Keypair;
    delegate: Keypair;
    sessionAccount: string;
    sessionClient: SessionClient;
    sessionManagerScriptAccount: string;
    setupSteps: StepResult[];
  }) {
    this.projectRoot = args.projectRoot;
    this.connection = args.connection;
    this.payer = args.payer;
    this.fiveVmProgramId = args.fiveVmProgramId;
    this.scriptAccount = args.scriptAccount;
    this.program = args.program;
    this.sessionProgram = args.sessionProgram;
    this.tableAccount = args.tableAccount;
    this.playerAccount = args.playerAccount;
    this.roundAccount = args.roundAccount;
    this.owner = args.owner;
    this.delegate = args.delegate;
    this.sessionAccount = args.sessionAccount;
    this.sessionClient = args.sessionClient;
    this.sessionManagerScriptAccount = args.sessionManagerScriptAccount;
    this.setupSteps = args.setupSteps;
    this.useDelegatedSession = process.env.FIVE_USE_SESSION !== '0';

    this.state = {
      table: { minBet: 0, maxBet: 0, dealerSoft17Hits: false, roundNonce: 0 },
      player: {
        chips: 0,
        activeBet: 0,
        handTotal: 0,
        dealerTotal: 0,
        roundStatus: ROUND_IDLE,
        outcome: ROUND_IDLE,
        sessionNonce: 0,
        inRound: false,
      },
      round: {
        deckSeed: 0,
        ownerMarker: 0,
        drawCursor: 0,
        playerCardCount: 0,
        dealerCardCount: 0,
        playerSoftAces: 0,
        dealerSoftAces: 0,
        playerStand: false,
      },
      hands: {
        player: [],
        dealer: [],
        dealerReveal: false,
      },
      session: {
        active: false,
        scopeHash: SESSION_SCOPE_HASH,
        managerScriptAccount: args.sessionManagerScriptAccount,
        sessionAccount: args.sessionAccount,
        delegate: args.delegate.publicKey.toBase58(),
      },
    };
  }

  static async create(projectRoot: string): Promise<LocalnetBlackjackEngine> {
    const artifactPath = await resolveFiveArtifactPath(projectRoot);
    const artifactText = await readFile(artifactPath, 'utf8');
    const loaded = await FiveSDK.loadFiveFile(artifactText);

    const rpcUrl = process.env.FIVE_RPC_URL || 'http://127.0.0.1:8899';
    const fiveVmProgramId = process.env.FIVE_VM_PROGRAM_ID || '5ive5hbC3aRsvq37MP5m4sHtTSFxT4Cq1smS4ddyWJ6h';

    const connection = new Connection(rpcUrl, 'confirmed');
    const payer = await loadDefaultPayerKeypair();
    await connection.getLatestBlockhash('confirmed');

    const vmProgramPk = new PublicKey(fiveVmProgramId);
    const vmProgramInfo = await connection.getAccountInfo(vmProgramPk, 'confirmed');
    if (!vmProgramInfo) {
      throw new Error(
        `Five VM program ${fiveVmProgramId} is not deployed on ${rpcUrl}. ` +
          `Deploy/start Five VM on localnet or set FIVE_VM_PROGRAM_ID to a valid deployed program.`
      );
    }

    const existingScript = process.env.FIVE_SCRIPT_ACCOUNT || '';
    const deploy = existingScript
      ? { scriptAccount: existingScript }
      : await deployScriptWithFallback(connection, payer, loaded, fiveVmProgramId);

    const program = FiveProgram.fromABI(deploy.scriptAccount, loaded.abi, {
      fiveVMProgramId: fiveVmProgramId,
    });

    const tableAccount = Keypair.generate();
    const playerAccount = Keypair.generate();
    const roundAccount = Keypair.generate();
    const owner = Keypair.generate();
    const delegate = Keypair.generate();
    const useDelegatedSession = process.env.FIVE_USE_SESSION !== '0';
    const configuredSessionManagerScript = process.env.FIVE_SESSION_MANAGER_SCRIPT_ACCOUNT || '';
    let sessionManagerScriptAccount =
      configuredSessionManagerScript || SessionClient.canonicalManagerScriptAccount(fiveVmProgramId);
    if (useDelegatedSession) {
      if (configuredSessionManagerScript) {
        await ensureSessionManagerDeployment(
          connection,
          payer,
          fiveVmProgramId,
          sessionManagerScriptAccount,
          projectRoot
        );
      } else {
        const managerLoaded = await loadSessionManagerArtifact(projectRoot);
        const managerDeploy = await deployScriptWithFallback(connection, payer, managerLoaded, fiveVmProgramId);
        sessionManagerScriptAccount = managerDeploy.scriptAccount;
      }
    }
    const sessionClient = new SessionClient({
      vmProgramId: fiveVmProgramId,
      managerScriptAccount: sessionManagerScriptAccount,
    });
    const sessionAccount = await sessionClient.deriveSessionAddress(
      payer.publicKey.toBase58(),
      delegate.publicKey.toBase58(),
      deploy.scriptAccount
    );
    const sessionManager = new SessionManager(
      FiveProgram.fromABI(sessionManagerScriptAccount, { name: 'SessionManager', functions: [] } as any, {
        fiveVMProgramId: fiveVmProgramId,
      }),
      Number(process.env.FIVE_SESSION_TTL_SLOTS || '3000')
    );
    const sessionProgram = program.withSession({
      manager: sessionManager,
      sessionAccountByFunction: {
        hit: sessionAccount,
        stand_and_settle: sessionAccount,
      },
    });

    const setupSteps: StepResult[] = [];
    const fundOwnerTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: owner.publicKey,
        lamports: 1_000_000_000,
      })
    );
    try {
      const signature = await connection.sendTransaction(fundOwnerTx, [payer]);
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      setupSteps.push({
        name: `setup:fund_owner:${owner.publicKey.toBase58()}`,
        signature,
        computeUnits: null,
        ok: true,
        err: null,
      });
    } catch (err) {
      setupSteps.push({
        name: `setup:fund_owner:${owner.publicKey.toBase58()}`,
        signature: null,
        computeUnits: null,
        ok: false,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const failed = setupSteps.find((s) => !s.ok);
    if (failed) {
      throw new Error(`failed setup step: ${failed.name}: ${failed.err || 'unknown error'}`);
    }

    return new LocalnetBlackjackEngine({
      projectRoot,
      connection,
      payer,
      fiveVmProgramId,
      scriptAccount: deploy.scriptAccount,
      program,
      sessionProgram,
      tableAccount,
      playerAccount,
      roundAccount,
      owner,
      delegate,
      sessionAccount,
      sessionClient,
      sessionManagerScriptAccount,
      setupSteps,
    });
  }

  getState(): LocalnetState {
    return JSON.parse(JSON.stringify(this.state)) as LocalnetState;
  }

  getAddresses() {
    return {
      payer: this.payer.publicKey.toBase58(),
      owner: this.owner.publicKey.toBase58(),
      scriptAccount: this.scriptAccount,
      fiveVmProgramId: this.fiveVmProgramId,
      table: this.tableAccount.publicKey.toBase58(),
      player: this.playerAccount.publicKey.toBase58(),
      round: this.roundAccount.publicKey.toBase58(),
      delegate: this.delegate.publicKey.toBase58(),
      session: this.sessionAccount,
      sessionManagerScriptAccount: this.sessionManagerScriptAccount,
    };
  }

  private accountsFor(functionName: string): Record<string, string> {
    const base = {
      owner: this.owner.publicKey.toBase58(),
      table: this.tableAccount.publicKey.toBase58(),
      player: this.playerAccount.publicKey.toBase58(),
      round: this.roundAccount.publicKey.toBase58(),
    };
    if (functionName === 'init_table') return { table: base.table, authority: this.payer.publicKey.toBase58() };
    if (functionName === 'init_player') return { player: base.player, owner: base.owner };
    if (functionName === 'start_round') {
      return { table: base.table, player: base.player, round: base.round, owner: base.owner };
    }
    if (functionName === 'hit') {
      return {
        player: base.player,
        round: base.round,
        owner: base.owner,
      };
    }
    if (functionName === 'stand_and_settle') {
      return {
        table: base.table,
        player: base.player,
        round: base.round,
        owner: base.owner,
      };
    }
    if (functionName === 'get_player_chips') return { player: base.player };
    if (functionName === 'get_round_status') return { player: base.player };
    if (functionName === 'get_last_outcome') return { player: base.player };
    return {};
  }

  private builderFor(functionName: string, args: Record<string, any> = {}, walletPubkey?: string) {
    const sessionized =
      this.useDelegatedSession && (functionName === 'hit' || functionName === 'stand_and_settle');
    const activeProgram = sessionized ? this.sessionProgram : this.program;
    let builder = activeProgram
      .function(functionName)
      .payer(walletPubkey || this.payer.publicKey.toBase58())
      .accounts(this.accountsFor(functionName));
    if (Object.keys(args).length > 0) {
      builder = builder.args(args);
    }
    return builder;
  }

  private async ensureSession(): Promise<StepResult | null> {
    if (this.state.session.active) return null;
    const slot = await this.connection.getSlot('confirmed');
    const ttlSlots = Number(process.env.FIVE_SESSION_TTL_SLOTS || '3000');
    const expiresAtSlot = slot + Math.max(1, ttlSlots);
    const nonce = this.state.player.sessionNonce;

    const createSession = await this.sessionClient
      .createSessionWithCompat(
        {
          authority: this.payer.publicKey.toBase58(),
          delegate: this.delegate.publicKey.toBase58(),
          targetProgram: this.scriptAccount,
          expiresAtSlot,
          scopeHash: SESSION_SCOPE_HASH,
          bindAccount: this.playerAccount.publicKey.toBase58(),
          nonce,
        },
        async (ix, schema) => {
          const sent = await sendTransactionInstruction(this.connection, this.payer, ix, [], `create_session_${schema}`);
          if (!sent.ok) throw new Error(sent.err || 'create_session failed');
          return sent.signature || '';
        }
      )
      .then((result) => ({
        name: `create_session_${result.schema}`,
        signature: result.signature,
        computeUnits: null,
        ok: true,
        err: null,
      }))
      .catch((err) => ({
        name: 'create_session',
        signature: null,
        computeUnits: null,
        ok: false,
        err: err instanceof Error ? err.message : String(err),
      }));
    const step = createSession;
    if (step.ok) {
      this.state.session.active = true;
    }
    return step;
  }

  private async call(
    functionName: string,
    args: Record<string, any> = {},
    extraSigners: Keypair[] = []
  ): Promise<StepResult> {
    const sessionized =
      this.useDelegatedSession && (functionName === 'hit' || functionName === 'stand_and_settle');
    if (sessionized) {
      const sessionStep = await this.ensureSession();
      if (sessionStep && !sessionStep.ok) return sessionStep;
    }

    const builder = this.builderFor(functionName, args);
    const ix = await builder.instruction();
    return sendEncodedInstruction(this.connection, this.payer, ix, extraSigners, functionName);
  }

  async buildUnsignedTx(functionName: string, _role: Role, args: Record<string, any>, walletPubkey: string): Promise<string> {
    const builder = this.builderFor(functionName, args, walletPubkey);
    const ix = await builder.instruction();
    const tx = new Transaction().add(
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((k: any) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Buffer.from(ix.data, 'base64'),
      })
    );
    tx.feePayer = new PublicKey(walletPubkey);
    const latest = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = latest.blockhash;
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }

  private applyInitLocal(setup: GameSetup) {
    this.state.table.minBet = setup.minBet;
    this.state.table.maxBet = setup.maxBet;
    this.state.table.dealerSoft17Hits = setup.dealerSoft17Hits;
    this.state.table.roundNonce = 0;

    this.state.player.chips = setup.initialChips;
    this.state.player.activeBet = 0;
    this.state.player.handTotal = 0;
    this.state.player.dealerTotal = 0;
    this.state.player.roundStatus = ROUND_IDLE;
    this.state.player.outcome = ROUND_IDLE;
    this.state.player.sessionNonce = 0;
    this.state.player.inRound = false;

    this.state.round.deckSeed = 0;
    this.state.round.ownerMarker = 0;
    this.state.round.drawCursor = 0;
    this.state.round.playerCardCount = 0;
    this.state.round.dealerCardCount = 0;
    this.state.round.playerSoftAces = 0;
    this.state.round.dealerSoftAces = 0;
    this.state.round.playerStand = false;

    this.state.hands.player = [];
    this.state.hands.dealer = [];
    this.state.hands.dealerReveal = false;
    this.state.session.active = false;
  }

  private applyStartRoundLocal(bet: number, seed: number) {
    this.state.table.roundNonce += 1;

    this.state.round.deckSeed = seed;
    this.state.round.ownerMarker = this.state.table.roundNonce + bet + (seed % 97);
    this.state.round.drawCursor = 0;
    this.state.round.playerCardCount = 0;
    this.state.round.dealerCardCount = 0;
    this.state.round.playerSoftAces = 0;
    this.state.round.dealerSoftAces = 0;
    this.state.round.playerStand = false;

    this.state.hands.player = [];
    this.state.hands.dealer = [];
    this.state.hands.dealerReveal = false;

    this.state.player.activeBet = bet;
    this.state.player.handTotal = 0;
    this.state.player.dealerTotal = 0;

    let d = addCard(
      this.state.player.handTotal,
      this.state.round.playerSoftAces,
      this.state.round.deckSeed,
      this.state.round.drawCursor,
      this.state.round.ownerMarker
    );
    this.state.player.handTotal = d.total;
    this.state.round.playerSoftAces = d.softAces;
    this.state.round.drawCursor = d.cursor;
    this.state.round.playerCardCount += 1;
    this.state.hands.player.push(d.rank);

    d = addCard(
      this.state.player.dealerTotal,
      this.state.round.dealerSoftAces,
      this.state.round.deckSeed,
      this.state.round.drawCursor,
      this.state.round.ownerMarker
    );
    this.state.player.dealerTotal = d.total;
    this.state.round.dealerSoftAces = d.softAces;
    this.state.round.drawCursor = d.cursor;
    this.state.round.dealerCardCount += 1;
    this.state.hands.dealer.push(d.rank);

    d = addCard(
      this.state.player.handTotal,
      this.state.round.playerSoftAces,
      this.state.round.deckSeed,
      this.state.round.drawCursor,
      this.state.round.ownerMarker
    );
    this.state.player.handTotal = d.total;
    this.state.round.playerSoftAces = d.softAces;
    this.state.round.drawCursor = d.cursor;
    this.state.round.playerCardCount += 1;
    this.state.hands.player.push(d.rank);

    d = addCard(
      this.state.player.dealerTotal,
      this.state.round.dealerSoftAces,
      this.state.round.deckSeed,
      this.state.round.drawCursor,
      this.state.round.ownerMarker
    );
    this.state.player.dealerTotal = d.total;
    this.state.round.dealerSoftAces = d.softAces;
    this.state.round.drawCursor = d.cursor;
    this.state.round.dealerCardCount += 1;
    this.state.hands.dealer.push(d.rank);

    this.state.player.roundStatus = ROUND_ACTIVE;
    this.state.player.outcome = ROUND_ACTIVE;
    this.state.player.inRound = true;
  }

  private applyHitLocal() {
    const d = addCard(
      this.state.player.handTotal,
      this.state.round.playerSoftAces,
      this.state.round.deckSeed,
      this.state.round.drawCursor,
      this.state.round.ownerMarker
    );
    this.state.player.handTotal = d.total;
    this.state.round.playerSoftAces = d.softAces;
    this.state.round.drawCursor = d.cursor;
    this.state.round.playerCardCount += 1;
    this.state.hands.player.push(d.rank);

    if (this.state.player.handTotal > 21) {
      this.state.player.roundStatus = ROUND_PLAYER_BUST;
      this.state.player.outcome = ROUND_DEALER_WIN;
      this.state.player.chips -= this.state.player.activeBet;
      this.state.player.inRound = false;
      this.state.hands.dealerReveal = true;
    }
    this.state.player.sessionNonce += 1;
  }

  private applyStandLocal() {
    this.state.round.playerStand = true;

    let dealerTotal = this.state.player.dealerTotal;
    let dealerSoftAces = this.state.round.dealerSoftAces;
    let dealerCursor = this.state.round.drawCursor;
    let dealerGuard = 0;

    while (
      dealerShouldDraw(dealerTotal, dealerSoftAces, this.state.table.dealerSoft17Hits) &&
      dealerGuard < 8
    ) {
      const d = addCard(
        dealerTotal,
        dealerSoftAces,
        this.state.round.deckSeed,
        dealerCursor,
        this.state.round.ownerMarker
      );
      dealerTotal = d.total;
      dealerSoftAces = d.softAces;
      dealerCursor = d.cursor;
      dealerGuard += 1;
      this.state.round.dealerCardCount += 1;
      this.state.hands.dealer.push(d.rank);
    }

    this.state.round.dealerSoftAces = dealerSoftAces;
    this.state.round.drawCursor = dealerCursor;
    this.state.player.dealerTotal = dealerTotal;

    if (dealerTotal > 21) {
      this.state.player.roundStatus = ROUND_DEALER_BUST;
      this.state.player.outcome = ROUND_PLAYER_WIN;
      this.state.player.chips += this.state.player.activeBet;
    } else if (this.state.player.handTotal > dealerTotal) {
      this.state.player.roundStatus = ROUND_PLAYER_WIN;
      this.state.player.outcome = ROUND_PLAYER_WIN;
      this.state.player.chips += this.state.player.activeBet;
    } else if (this.state.player.handTotal < dealerTotal) {
      this.state.player.roundStatus = ROUND_DEALER_WIN;
      this.state.player.outcome = ROUND_DEALER_WIN;
      this.state.player.chips -= this.state.player.activeBet;
    } else {
      this.state.player.roundStatus = ROUND_PUSH;
      this.state.player.outcome = ROUND_PUSH;
    }

    this.state.player.inRound = false;
    this.state.player.activeBet = 0;
    this.state.player.sessionNonce += 1;
    this.state.hands.dealerReveal = true;
  }

  async applyLocalAction(action: string, payload: Record<string, any>): Promise<void> {
    if (action === 'init') {
      this.applyInitLocal({
        minBet: Number(payload.minBet ?? 10),
        maxBet: Number(payload.maxBet ?? 100),
        dealerSoft17Hits: payload.dealerSoft17Hits !== false,
        initialChips: Number(payload.initialChips ?? 500),
      });
      return;
    }
    if (action === 'start') {
      this.applyStartRoundLocal(Number(payload.bet ?? 25), Number(payload.seed ?? Date.now() % 1_000_000));
      return;
    }
    if (action === 'hit') {
      this.applyHitLocal();
      return;
    }
    if (action === 'stand') {
      this.applyStandLocal();
      await this.readBack();
      return;
    }
    throw new Error(`unsupported action: ${action}`);
  }

  async initGame(setup: GameSetup): Promise<StepResult[]> {
    const steps: StepResult[] = [];

    const initTable = await this.call(
      'init_table',
      {
        min_bet: setup.minBet,
        max_bet: setup.maxBet,
        dealer_soft17_hits: setup.dealerSoft17Hits,
      },
      [this.tableAccount]
    );
    steps.push(initTable);

    const initPlayer = await this.call(
      'init_player',
      {
        initial_chips: setup.initialChips,
      },
      [this.playerAccount, this.owner]
    );
    steps.push(initPlayer);

    if (initTable.ok && initPlayer.ok) {
      this.applyInitLocal(setup);
    }

    return steps;
  }

  async startRound(bet: number, seed: number): Promise<StepResult> {
    const step = await this.call('start_round', { bet, seed }, [this.roundAccount, this.owner]);
    if (!step.ok) return step;
    this.applyStartRoundLocal(bet, seed);

    return step;
  }

  async hit(): Promise<StepResult> {
    const step = await this.call('hit', {}, [this.owner]);
    if (!step.ok) return step;
    this.applyHitLocal();

    return step;
  }

  async stand(): Promise<StepResult> {
    const step = await this.call('stand_and_settle', {}, [this.owner]);
    if (!step.ok) return step;
    this.applyStandLocal();

    return step;
  }

  async readBack(): Promise<StepResult[]> {
    const steps: StepResult[] = [];
    steps.push(await this.call('get_player_chips', {}));
    steps.push(await this.call('get_round_status', {}));
    steps.push(await this.call('get_last_outcome', {}));
    return steps;
  }
}
