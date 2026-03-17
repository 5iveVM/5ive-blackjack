#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '../../five-cli/node_modules/@solana/web3.js/lib/index.cjs.js';
import { FiveProgram, FiveSDK } from '../../five-sdk/dist/index.js';

const DEFAULT_VM_PROGRAM_ID = '5ive5uKDkc3Yhyfu1Sk7i3eVPDQUmG2GmTm2FnUZiTJd';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const SESSION_SCOPE_HASH = scopeHashForFunctions(['hit', 'stand_and_settle']);

const SESSION_MANAGER_ABI = {
  name: 'SessionManager',
  functions: [
    {
      name: 'create_session',
      index: 0,
      parameters: [
        { name: 'session', type: 'Account', is_account: true, attributes: ['mut'] },
        { name: 'authority', type: 'Account', is_account: true, attributes: ['signer'] },
        { name: 'delegate', type: 'Account', is_account: true, attributes: [] },
        { name: 'target_program', type: 'pubkey', is_account: false, attributes: [] },
        { name: 'expires_at_slot', type: 'u64', is_account: false, attributes: [] },
        { name: 'scope_hash', type: 'u64', is_account: false, attributes: [] },
        { name: 'bind_account', type: 'pubkey', is_account: false, attributes: [] },
        { name: 'nonce', type: 'u64', is_account: false, attributes: [] },
        { name: 'manager_script_account', type: 'pubkey', is_account: false, attributes: [] },
        { name: 'manager_code_hash', type: 'pubkey', is_account: false, attributes: [] },
        { name: 'manager_version', type: 'u8', is_account: false, attributes: [] },
      ],
      return_type: null,
      is_public: true,
      bytecode_offset: 0,
    },
  ],
};

function scopeHashForFunctions(functions) {
  const sorted = [...functions].sort();
  let acc = 0n;
  const mask = (1n << 64n) - 1n;
  for (const ch of sorted.join('|')) {
    acc = (acc * 131n + BigInt(ch.charCodeAt(0))) & mask;
  }
  return acc.toString();
}

function canonicalSessionManagerScriptAccount(vmProgramId) {
  const [scriptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('session_v1', 'utf-8')],
    new PublicKey(vmProgramId)
  );
  return scriptPda.toBase58();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = '1';
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

async function loadPayer(pathArg) {
  const keypairPath = pathArg || join(homedir(), '.config/solana/id.json');
  const secret = JSON.parse(await readFile(keypairPath, 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

async function sendNamedIx(connection, signer, name, encoded, extraSigners = []) {
  const ix = new TransactionInstruction({
    programId: new PublicKey(encoded.programId),
    keys: encoded.keys.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(encoded.data, 'base64'),
  });
  const tx = new Transaction().add(ix);
  try {
    const signature = await connection.sendTransaction(tx, [signer, ...extraSigners], {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    const txInfo = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const err = txInfo?.meta?.err ?? null;
    return {
      name,
      signature,
      err,
      computeUnits: txInfo?.meta?.computeUnitsConsumed ?? null,
      logsTail: err ? (txInfo?.meta?.logMessages || []).slice(-8) : [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logs = Array.isArray(error?.logs) ? error.logs.slice(-8) : [];
    return {
      name,
      signature: error?.signature || null,
      err: message,
      computeUnits: null,
      logsTail: logs,
    };
  }
}

async function setupAccounts(connection, payer, ownerProgram) {
  const table = Keypair.generate();
  const player = Keypair.generate();
  const round = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(256);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: table.publicKey,
      lamports: rent,
      space: 256,
      programId: ownerProgram,
    }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: player.publicKey,
      lamports: rent,
      space: 256,
      programId: ownerProgram,
    }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: round.publicKey,
      lamports: rent,
      space: 256,
      programId: ownerProgram,
    })
  );
  const signature = await connection.sendTransaction(tx, [payer, table, player, round], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  return {
    setupSignature: signature,
    table,
    player,
    round,
  };
}

async function runMode({
  mode,
  connection,
  payer,
  program,
  sessionProgram,
  vmProgramId,
  scriptAccount,
  startSeed,
  includeStand,
}) {
  const ownerProgram = new PublicKey(vmProgramId);
  const owner = payer.publicKey.toBase58();
  const setup = await setupAccounts(connection, payer, ownerProgram);

  const summary = {
    mode,
    setup: {
      signature: setup.setupSignature,
      table: setup.table.publicKey.toBase58(),
      player: setup.player.publicKey.toBase58(),
      round: setup.round.publicKey.toBase58(),
    },
    steps: [],
  };

  const runCall = async (fnName, args, accounts, extraSigners = []) => {
    const encoded = await program
      .function(fnName)
      .payer(owner)
      .accounts(accounts)
      .args(args || {})
      .instruction();
    const step = await sendNamedIx(connection, payer, fnName, encoded, extraSigners);
    summary.steps.push(step);
    return step;
  };

  await runCall('init_table', { min_bet: 10, max_bet: 100, dealer_soft17_hits: true }, {
    table: setup.table.publicKey.toBase58(),
    authority: owner,
  });
  await runCall('init_player', { initial_chips: 500 }, {
    player: setup.player.publicKey.toBase58(),
    owner,
  });
  await runCall('start_round', { bet: 25, seed: startSeed }, {
    table: setup.table.publicKey.toBase58(),
    player: setup.player.publicKey.toBase58(),
    round: setup.round.publicKey.toBase58(),
    owner,
  });

  let hitOwner = owner;
  let sessionAccount = vmProgramId;
  let hitSigners = [];

  if (mode === 'delegated') {
    const delegate = Keypair.generate();
    const session = Keypair.generate();
    const rent = await connection.getMinimumBalanceForRentExemption(256);
    const createSessionAccountTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: session.publicKey,
        lamports: rent,
        space: 256,
        programId: ownerProgram,
      })
    );
    const createSig = await connection.sendTransaction(createSessionAccountTx, [payer, session], {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature: createSig, ...latest }, 'confirmed');
    summary.steps.push({
      name: 'create_session_account',
      signature: createSig,
      err: null,
      computeUnits: null,
      logsTail: [],
    });

    const slot = await connection.getSlot('confirmed');
    const sessionManagerScriptAccount = canonicalSessionManagerScriptAccount(vmProgramId);
    const createSessionIx = await sessionProgram
      .function('create_session')
      .payer(owner)
      .accounts({
        session: session.publicKey.toBase58(),
        authority: owner,
        delegate: delegate.publicKey.toBase58(),
      })
      .args({
        target_program: scriptAccount,
        expires_at_slot: slot + 3000,
        scope_hash: SESSION_SCOPE_HASH,
        bind_account: setup.player.publicKey.toBase58(),
        nonce: 0,
        manager_script_account: sessionManagerScriptAccount,
        manager_code_hash: SYSTEM_PROGRAM_ID,
        manager_version: 1,
      })
      .instruction();
    summary.steps.push(await sendNamedIx(connection, payer, 'create_session', createSessionIx));

    hitOwner = delegate.publicKey.toBase58();
    sessionAccount = session.publicKey.toBase58();
    hitSigners = [delegate];
    summary.delegate = delegate.publicKey.toBase58();
    summary.session = session.publicKey.toBase58();
  }

  await runCall(
    'hit',
    {},
    {
      player: setup.player.publicKey.toBase58(),
      round: setup.round.publicKey.toBase58(),
      owner: hitOwner,
      __session: sessionAccount,
    },
    hitSigners
  );

  if (includeStand) {
    await runCall(
      'stand_and_settle',
      {},
      {
        table: setup.table.publicKey.toBase58(),
        player: setup.player.publicKey.toBase58(),
        round: setup.round.publicKey.toBase58(),
        owner: hitOwner,
        __session: sessionAccount,
      },
      hitSigners
    );
  }

  return summary;
}

function summarize(results) {
  const failures = [];
  for (const run of results) {
    for (const step of run.steps) {
      if (step.err) {
        failures.push({ mode: run.mode, step: step.name, signature: step.signature, err: step.err });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = args['rpc-url'] || process.env.FIVE_RPC_URL || 'https://api.devnet.solana.com';
  const vmProgramId = args['vm-program-id'] || process.env.FIVE_VM_PROGRAM_ID || DEFAULT_VM_PROGRAM_ID;
  const scriptAccount = args['script-account'] || process.env.FIVE_SCRIPT_ACCOUNT;
  if (!scriptAccount) {
    throw new Error('Missing --script-account (or FIVE_SCRIPT_ACCOUNT)');
  }
  const artifactPath = resolve(args.artifact || './build/5ive-blackjack.five');
  const keypairPath = args.keypair || join(homedir(), '.config/solana/id.json');
  const startSeed = Number(args.seed || process.env.FIVE_SEED || '1337');
  const includeStand = args['no-stand'] ? false : true;

  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = await loadPayer(keypairPath);
  const artifact = await readFile(artifactPath, 'utf8');
  const loaded = await FiveSDK.loadFiveFile(artifact);
  const program = FiveProgram.fromABI(scriptAccount, loaded.abi, { fiveVMProgramId: vmProgramId });
  const sessionProgram = FiveProgram.fromABI(canonicalSessionManagerScriptAccount(vmProgramId), SESSION_MANAGER_ABI, {
    fiveVMProgramId: vmProgramId,
  });

  const direct = await runMode({
    mode: 'direct',
    connection,
    payer,
    program,
    sessionProgram,
    vmProgramId,
    scriptAccount,
    startSeed,
    includeStand,
  });
  const delegated = await runMode({
    mode: 'delegated',
    connection,
    payer,
    program,
    sessionProgram,
    vmProgramId,
    scriptAccount,
    startSeed: startSeed + 1,
    includeStand,
  });

  const results = [direct, delegated];
  const summary = summarize(results);
  const payload = {
    rpcUrl,
    vmProgramId,
    scriptAccount,
    artifactPath,
    generatedAt: new Date().toISOString(),
    results,
    summary,
  };

  if (args.output) {
    const outputPath = resolve(args.output);
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify(payload, null, 2));
  if (!summary.ok) process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
