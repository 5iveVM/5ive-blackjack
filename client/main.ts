import { readFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  Connection,
  Keypair,
  SystemProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type ConfirmOptions,
} from '@solana/web3.js';
import { FiveProgram, FiveSDK, SessionClient, scopeHashForFunctions } from '@5ive-tech/sdk';

type StepResult = {
  name: string;
  signature: string | null;
  computeUnits: number | null;
  ok: boolean;
  err: string | null;
};

const NETWORK = process.env.FIVE_NETWORK || 'localnet';
const NORMALIZED_NETWORK = NETWORK === 'local' ? 'localnet' : NETWORK;
const RPC_BY_NETWORK: Record<string, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};
const PROGRAM_BY_NETWORK: Record<string, string> = {
  localnet: '5ive5hbC3aRsvq37MP5m4sHtTSFxT4Cq1smS4ddyWJ6h',
  devnet: '5ive5hbC3aRsvq37MP5m4sHtTSFxT4Cq1smS4ddyWJ6h',
  mainnet: '5ive5hbC3aRsvq37MP5m4sHtTSFxT4Cq1smS4ddyWJ6h',
};
const CONFIRM: ConfirmOptions = {
  commitment: 'confirmed',
  preflightCommitment: 'confirmed',
  skipPreflight: false,
};

const BET = Number(process.env.FIVE_BET || '25');
const SEED = Number(process.env.FIVE_SEED || '1337');
const INITIAL_CHIPS = Number(process.env.FIVE_INITIAL_CHIPS || '500');
const MIN_BET = Number(process.env.FIVE_MIN_BET || '10');
const MAX_BET = Number(process.env.FIVE_MAX_BET || '100');
const DEALER_SOFT17_HITS = process.env.FIVE_DEALER_SOFT17_HITS === '1';
const DO_HIT = process.env.FIVE_DO_HIT !== '0';
const SESSION_TTL_SLOTS = Number(process.env.FIVE_SESSION_TTL_SLOTS || '3000');
const USE_DELEGATED_SESSION = process.env.FIVE_USE_SESSION !== '0';

const SESSION_SCOPE_HASH = scopeHashForFunctions(['hit', 'stand_and_settle']);
const TABLE_ACCOUNT_SPACE = 4096;
const PLAYER_ACCOUNT_SPACE = 4096;
const ROUND_ACCOUNT_SPACE = 4096;
const SESSION_ACCOUNT_SPACE = 1024;

type RuntimeAccounts = {
  table: string;
  player: string;
  round: string;
};

let RUNTIME_ACCOUNTS: RuntimeAccounts | null = null;
let VM_SENTINEL_SESSION = PROGRAM_BY_NETWORK.localnet;

function parseConsumedUnits(logs: string[] | null | undefined): number | null {
  if (!logs) return null;
  for (const line of logs) {
    const m = line.match(/consumed (\d+) of/);
    if (m) return Number(m[1]);
  }
  return null;
}

async function loadDeploymentConfig(network: string): Promise<{
  rpcUrl?: string;
  fiveProgramId?: string;
  blackjackScriptAccount?: string;
}> {
  const path = join(process.cwd(), '..', `deployment-config.${network}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as {
      rpcUrl?: string;
      fiveProgramId?: string;
      blackjackScriptAccount?: string;
    };
    return parsed;
  } catch {
    return {};
  }
}

async function loadPayer(): Promise<Keypair> {
  const path = process.env.SOLANA_KEYPAIR_PATH || join(homedir(), '.config/solana/id.json');
  const secret = JSON.parse(await readFile(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

function ensureAccountMap(functionName: string, payer: Keypair): Record<string, string> {
  if (!RUNTIME_ACCOUNTS) {
    throw new Error('Runtime accounts are not initialized');
  }
  const owner = payer.publicKey.toBase58();
  const base = {
    owner,
    table: RUNTIME_ACCOUNTS.table,
    player: RUNTIME_ACCOUNTS.player,
    round: RUNTIME_ACCOUNTS.round,
    __session: VM_SENTINEL_SESSION,
  };
  if (functionName === 'init_table') return { __session: VM_SENTINEL_SESSION, table: base.table, authority: owner };
  if (functionName === 'init_player') return { __session: VM_SENTINEL_SESSION, player: base.player, owner };
  if (functionName === 'start_round') {
    return { __session: VM_SENTINEL_SESSION, table: base.table, player: base.player, round: base.round, owner };
  }
  if (functionName === 'hit') {
    return { __session: VM_SENTINEL_SESSION, player: base.player, round: base.round, owner };
  }
  if (functionName === 'stand_and_settle') {
    return {
      __session: VM_SENTINEL_SESSION,
      table: base.table,
      player: base.player,
      round: base.round,
      owner,
    };
  }
  if (functionName === 'get_player_chips') return { __session: VM_SENTINEL_SESSION, player: base.player };
  if (functionName === 'get_round_status') return { __session: VM_SENTINEL_SESSION, player: base.player };
  if (functionName === 'get_last_outcome') return { __session: VM_SENTINEL_SESSION, player: base.player };
  return {};
}

async function sendIx(
  connection: Connection,
  payer: Keypair,
  encoded: any,
  extraSigners: Keypair[] = [],
  name: string
): Promise<StepResult> {
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: new PublicKey(encoded.programId),
      keys: encoded.keys.map((k: any) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(encoded.data, 'base64'),
    })
  );

  try {
    const signature = await connection.sendTransaction(tx, [payer, ...extraSigners], CONFIRM);
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    const txMeta = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const metaErr = txMeta?.meta?.err ?? null;
    const cu = txMeta?.meta?.computeUnitsConsumed ?? parseConsumedUnits(txMeta?.meta?.logMessages);
    return {
      name,
      signature,
      computeUnits: cu,
      ok: metaErr == null,
      err: metaErr == null ? null : JSON.stringify(metaErr),
    };
  } catch (err) {
    return {
      name,
      signature: null,
      computeUnits: null,
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    };
  }
}

async function sendRawIx(
  connection: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
  extraSigners: Keypair[] = [],
  name: string
): Promise<StepResult> {
  const tx = new Transaction().add(ix);
  try {
    const signature = await connection.sendTransaction(tx, [payer, ...extraSigners], CONFIRM);
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    const txMeta = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const metaErr = txMeta?.meta?.err ?? null;
    const cu = txMeta?.meta?.computeUnitsConsumed ?? parseConsumedUnits(txMeta?.meta?.logMessages);
    return {
      name,
      signature,
      computeUnits: cu,
      ok: metaErr == null,
      err: metaErr == null ? null : JSON.stringify(metaErr),
    };
  } catch (err) {
    return {
      name,
      signature: null,
      computeUnits: null,
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    };
  }
}

async function callFunction(
  connection: Connection,
  payer: Keypair,
  program: any,
  functionName: string,
  args: Record<string, any>,
  options: {
    accountMap?: Record<string, string>;
    extraSigners?: Keypair[];
  } = {}
): Promise<StepResult> {
  let builder = program
    .function(functionName)
    .accounts(options.accountMap || ensureAccountMap(functionName, payer))
    .payer(payer.publicKey.toBase58());
  if (Object.keys(args).length > 0) builder = builder.args(args);
  const encoded = await builder.instruction();
  return sendIx(connection, payer, encoded, options.extraSigners || [], functionName);
}

async function createOwnedAccount(
  connection: Connection,
  payer: Keypair,
  account: Keypair,
  owner: PublicKey,
  space: number
): Promise<StepResult> {
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: account.publicKey,
      lamports,
      space,
      programId: owner,
    })
  );

  try {
    const signature = await connection.sendTransaction(tx, [payer, account], CONFIRM);
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    return {
      name: `setup:create_account:${account.publicKey.toBase58()}`,
      signature,
      computeUnits: null,
      ok: true,
      err: null,
    };
  } catch (err) {
    return {
      name: `setup:create_account:${account.publicKey.toBase58()}`,
      signature: null,
      computeUnits: null,
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    };
  }
}

function printStep(step: StepResult): void {
  console.log('---');
  console.log('step:', step.name);
  console.log('signature:', step.signature ?? 'n/a');
  console.log('meta.err:', step.err ?? 'null');
  console.log('compute_units:', step.computeUnits ?? 'n/a');
}

async function run(): Promise<void> {
  const deploymentConfig = await loadDeploymentConfig(NORMALIZED_NETWORK);
  const rpcUrl =
    process.env.FIVE_RPC_URL ||
    deploymentConfig.rpcUrl ||
    RPC_BY_NETWORK[NORMALIZED_NETWORK] ||
    RPC_BY_NETWORK.localnet;
  const fiveProgramId =
    process.env.FIVE_VM_PROGRAM_ID ||
    deploymentConfig.fiveProgramId ||
    PROGRAM_BY_NETWORK[NORMALIZED_NETWORK] ||
    PROGRAM_BY_NETWORK.localnet;

  const scriptAccount =
    process.env.FIVE_SCRIPT_ACCOUNT || deploymentConfig.blackjackScriptAccount || '';

  if (!scriptAccount || scriptAccount.includes('<')) {
    throw new Error(
      'Missing blackjack script account. Set FIVE_SCRIPT_ACCOUNT or deployment-config.<network>.json blackjackScriptAccount.'
    );
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = await loadPayer();
  VM_SENTINEL_SESSION = fiveProgramId;
  const ownerProgram = new PublicKey(fiveProgramId);
  const tableAccount = Keypair.generate();
  const playerAccount = Keypair.generate();
  const roundAccount = Keypair.generate();
  RUNTIME_ACCOUNTS = {
    table: tableAccount.publicKey.toBase58(),
    player: playerAccount.publicKey.toBase58(),
    round: roundAccount.publicKey.toBase58(),
  };

  const artifactPath = await resolveArtifactPath();
  const artifactText = await readFile(artifactPath, 'utf8');
  const loaded = await FiveSDK.loadFiveFile(artifactText);
  const program = FiveProgram.fromABI(scriptAccount, loaded.abi, {
    fiveVMProgramId: fiveProgramId,
  });
  const sessionManagerScriptAccount =
    process.env.FIVE_SESSION_MANAGER_SCRIPT_ACCOUNT ||
    SessionClient.canonicalManagerScriptAccount(fiveProgramId);
  const sessionClient = new SessionClient({
    vmProgramId: fiveProgramId,
    managerScriptAccount: sessionManagerScriptAccount,
  });
  const delegate = Keypair.generate();
  const session = Keypair.generate();

  console.log('[blackjack-client] network:', NORMALIZED_NETWORK);
  console.log('[blackjack-client] rpc:', rpcUrl);
  console.log('[blackjack-client] payer:', payer.publicKey.toBase58());
  console.log('[blackjack-client] script_account:', scriptAccount);
  console.log('[blackjack-client] five_vm_program_id:', fiveProgramId);
  console.log('[blackjack-client] session_manager_script_account:', sessionManagerScriptAccount);
  console.log('[blackjack-client] delegate:', delegate.publicKey.toBase58());
  console.log('[blackjack-client] session:', session.publicKey.toBase58());

  const steps: StepResult[] = [];

  steps.push(
    await callFunction(
      connection,
      payer,
      program,
      'init_table',
      {
        min_bet: MIN_BET,
        max_bet: MAX_BET,
        dealer_soft17_hits: DEALER_SOFT17_HITS,
      },
      {
        extraSigners: [tableAccount],
      }
    )
  );

  steps.push(
    await callFunction(
      connection,
      payer,
      program,
      'init_player',
      {
        initial_chips: INITIAL_CHIPS,
      },
      {
        extraSigners: [playerAccount],
      }
    )
  );

  steps.push(
    await callFunction(
      connection,
      payer,
      program,
      'start_round',
      {
        bet: BET,
        seed: SEED,
      },
      {
        extraSigners: [roundAccount],
      }
    )
  );

  if (USE_DELEGATED_SESSION) {
    const slot = await connection.getSlot('confirmed');
    const createSession = await sessionClient.createSessionWithCompat(
      {
        authority: payer.publicKey.toBase58(),
        delegate: delegate.publicKey.toBase58(),
        targetProgram: scriptAccount,
        expiresAtSlot: slot + Math.max(1, SESSION_TTL_SLOTS),
        scopeHash: SESSION_SCOPE_HASH,
        bindAccount: ensureAccountMap('hit', payer).player,
        nonce: 0,
      },
      async (ix, schema) => sendRawIx(connection, payer, ix, [], `create_session_${schema}`).then((r) => {
        if (!r.ok) throw new Error(r.err || 'create_session failed');
        return r.signature || '';
      })
    ).then((result) => ({
      name: `create_session_${result.schema}`,
      signature: result.signature,
      computeUnits: null,
      ok: true,
      err: null,
    })).catch((err) => ({
      name: 'create_session',
      signature: null,
      computeUnits: null,
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    }));
    steps.push(createSession);
  }

  if (DO_HIT) {
    steps.push(
      await callFunction(
        connection,
        payer,
        program,
        'hit',
        {},
        {
          accountMap: {
            player: ensureAccountMap('hit', payer).player,
            round: ensureAccountMap('hit', payer).round,
            owner: USE_DELEGATED_SESSION ? delegate.publicKey.toBase58() : payer.publicKey.toBase58(),
            __session: USE_DELEGATED_SESSION ? session.publicKey.toBase58() : fiveProgramId,
          },
          extraSigners: USE_DELEGATED_SESSION ? [delegate] : [],
        }
      )
    );
  }

  steps.push(
    await callFunction(
      connection,
      payer,
      program,
      'stand_and_settle',
      {},
      {
        accountMap: {
          table: ensureAccountMap('stand_and_settle', payer).table,
          player: ensureAccountMap('stand_and_settle', payer).player,
          round: ensureAccountMap('stand_and_settle', payer).round,
          owner: USE_DELEGATED_SESSION ? delegate.publicKey.toBase58() : payer.publicKey.toBase58(),
          __session: USE_DELEGATED_SESSION ? session.publicKey.toBase58() : fiveProgramId,
        },
        extraSigners: USE_DELEGATED_SESSION ? [delegate] : [],
      }
    )
  );

  // Getter calls still execute as on-chain instructions; we surface tx evidence.
  steps.push(await callFunction(connection, payer, program, 'get_player_chips', {}));
  steps.push(await callFunction(connection, payer, program, 'get_round_status', {}));
  steps.push(await callFunction(connection, payer, program, 'get_last_outcome', {}));

  let failed = false;
  for (const step of steps) {
    printStep(step);
    if (!step.ok) failed = true;
  }

  if (failed) {
    throw new Error('one or more client steps failed');
  }
}

async function resolveArtifactPath(): Promise<string> {
  const buildDir = join(process.cwd(), '..', 'build');
  const mainPath = join(buildDir, 'main.five');

  try {
    await readFile(mainPath, 'utf8');
    return mainPath;
  } catch {
    const entries = await readdir(buildDir);
    const firstFive = entries.find((name) => name.endsWith('.five'));
    if (!firstFive) {
      throw new Error(`No .five artifact found in ${buildDir}. Run npm run build from project root.`);
    }
    return join(buildDir, firstFive);
  }
}

run().catch((error) => {
  console.error('[blackjack-client] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
