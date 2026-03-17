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
  localnet: '5ive5uKDkc3Yhyfu1Sk7i3eVPDQUmG2GmTm2FnUZiTJd',
  devnet: '5ive5uKDkc3Yhyfu1Sk7i3eVPDQUmG2GmTm2FnUZiTJd',
  mainnet: '5ive5uKDkc3Yhyfu1Sk7i3eVPDQUmG2GmTm2FnUZiTJd',
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

const SESSION_SCOPE_HASH = scopeHashForFunctions(['hit', 'stand_and_settle']);

const ACCOUNT_OVERRIDES: Record<string, Record<string, string>> = {
  init_table: {
    table: '<TABLE_ACCOUNT_PUBKEY>',
  },
  init_player: {
    player: '<PLAYER_ACCOUNT_PUBKEY>',
  },
  start_round: {
    table: '<TABLE_ACCOUNT_PUBKEY>',
    player: '<PLAYER_ACCOUNT_PUBKEY>',
    round: '<ROUND_ACCOUNT_PUBKEY>',
  },
  hit: {
    player: '<PLAYER_ACCOUNT_PUBKEY>',
    round: '<ROUND_ACCOUNT_PUBKEY>',
  },
  stand_and_settle: {
    table: '<TABLE_ACCOUNT_PUBKEY>',
    player: '<PLAYER_ACCOUNT_PUBKEY>',
    round: '<ROUND_ACCOUNT_PUBKEY>',
  },
  get_player_chips: {
    player: '<PLAYER_ACCOUNT_PUBKEY>',
  },
  get_round_status: {
    player: '<PLAYER_ACCOUNT_PUBKEY>',
  },
  get_last_outcome: {
    player: '<PLAYER_ACCOUNT_PUBKEY>',
  },
};

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
  const map = { ...(ACCOUNT_OVERRIDES[functionName] || {}) };
  const fnMissing = Object.values(map).some((v) => v.includes('<'));
  if (fnMissing) {
    throw new Error(
      `Missing ACCOUNT_OVERRIDES for ${functionName}. Update client/main.ts with real table/player/round pubkeys.`
    );
  }
  map.owner = payer.publicKey.toBase58();
  return map;
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
    .accounts(options.accountMap || ensureAccountMap(functionName, payer));
  if (Object.keys(args).length > 0) builder = builder.args(args);
  const encoded = await builder.instruction();
  return sendIx(connection, payer, encoded, options.extraSigners || [], functionName);
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
    await callFunction(connection, payer, program, 'init_table', {
      min_bet: MIN_BET,
      max_bet: MAX_BET,
      dealer_soft17_hits: DEALER_SOFT17_HITS,
    })
  );

  steps.push(
    await callFunction(connection, payer, program, 'init_player', {
      initial_chips: INITIAL_CHIPS,
    })
  );

  steps.push(
    await callFunction(connection, payer, program, 'start_round', {
      bet: BET,
      seed: SEED,
    })
  );

  const sessionLamports = await connection.getMinimumBalanceForRentExemption(256);
  const createSessionAccountTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: session.publicKey,
      lamports: sessionLamports,
      space: 256,
      programId: new PublicKey(fiveProgramId),
    })
  );
  try {
    const signature = await connection.sendTransaction(createSessionAccountTx, [payer, session], CONFIRM);
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    steps.push({ name: 'create_session_account', signature, computeUnits: null, ok: true, err: null });
  } catch (err) {
    steps.push({
      name: 'create_session_account',
      signature: null,
      computeUnits: null,
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    });
  }

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
      compatMode: 'auto',
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
            owner: delegate.publicKey.toBase58(),
            __session: session.publicKey.toBase58(),
          },
          extraSigners: [delegate],
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
          owner: delegate.publicKey.toBase58(),
          __session: session.publicKey.toBase58(),
        },
        extraSigners: [delegate],
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
