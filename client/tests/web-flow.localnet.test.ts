import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type ConfirmOptions,
} from "@solana/web3.js";
import { FiveProgram, FiveSDK, SessionClient, scopeHashForFunctions } from "@5ive-tech/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..", "..");
const rpcUrl = process.env.FIVE_RPC_URL || "http://127.0.0.1:8899";
const vmProgramId = process.env.FIVE_VM_PROGRAM_ID || "55555SyrYLzydvDMBhAL8uo6h4WETHTm81z8btf6nAVJ";
const scriptAccount = process.env.FIVE_SCRIPT_ACCOUNT || "";
const keypairPath = process.env.SOLANA_KEYPAIR_PATH || join(process.env.HOME || "", ".config/solana/id.json");

const CONFIRM: ConfirmOptions = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
  skipPreflight: false,
};

async function resolveArtifactPath(): Promise<string> {
  const buildDir = join(projectRoot, "build");
  const mainPath = join(buildDir, "main.five");
  try {
    await readFile(mainPath, "utf8");
    return mainPath;
  } catch {
    const entries = await readdir(buildDir);
    const firstFive = entries.find((name) => name.endsWith(".five"));
    if (!firstFive) throw new Error(`No .five artifact in ${buildDir}`);
    return join(buildDir, firstFive);
  }
}

async function loadPayer(): Promise<Keypair> {
  const raw = await readFile(keypairPath, "utf8");
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

function decodeIx(encoded: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(encoded.programId),
    keys: encoded.keys.map((k: any) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(encoded.data, "base64"),
  });
}

async function sendTx(connection: Connection, payer: Keypair, tx: Transaction, signers: Keypair[] = []) {
  const sig = await connection.sendTransaction(tx, [payer, ...signers], CONFIRM);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  const meta = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  assert.equal(meta?.meta?.err ?? null, null, `tx failed: ${sig} :: ${JSON.stringify(meta?.meta?.err)}`);
  return sig;
}

const SESSION_SCOPE_HASH = scopeHashForFunctions(["hit", "stand_and_settle"]);

async function ensureSessionManagerDeployment(
  connection: Connection,
  payer: Keypair,
  vmProgramId: string,
  sessionManagerScriptAccount: string
) {
  const existing = await connection.getAccountInfo(new PublicKey(sessionManagerScriptAccount), "confirmed");
  if (existing) return;

  const templateProject = join(projectRoot, "..", "five-templates", "session-manager");
  const templateArtifact = join(templateProject, "build", "five-session-manager-template.five");
  const build = spawnSync(
    "node",
    [join(projectRoot, "..", "five-cli", "dist", "index.js"), "build", "--project", templateProject],
    { encoding: "utf8" }
  );
  assert.equal(build.status, 0, `session manager template build failed: ${build.stderr || build.stdout || ""}`);

  const artifact = await readFile(templateArtifact, "utf8");
  const loaded = await FiveSDK.loadFiveFile(artifact);
  const result: any = await FiveSDK.deployToSolana(loaded.bytecode, connection, payer, {
    fiveVMProgramId: vmProgramId,
    service: "session_v1",
  });
  assert.equal(result.success, true, `session manager deploy failed: ${result.error || ""}`);
}

test("web flow on localnet using five-sdk", async () => {
  assert.ok(scriptAccount, "Set FIVE_SCRIPT_ACCOUNT to the deployed blackjack script account");

  const connection = new Connection(rpcUrl, "confirmed");
  await connection.getLatestBlockhash("confirmed");

  const payer = await loadPayer();
  const artifactPath = await resolveArtifactPath();
  const artifact = await readFile(artifactPath, "utf8");
  const loaded = await FiveSDK.loadFiveFile(artifact);
  const program = FiveProgram.fromABI(scriptAccount, loaded.abi, { fiveVMProgramId: vmProgramId });

  const table = Keypair.generate();
  const player = Keypair.generate();
  const round = Keypair.generate();
  const delegate = Keypair.generate();
  const managerScriptAccount =
    process.env.FIVE_SESSION_MANAGER_SCRIPT_ACCOUNT ||
    SessionClient.canonicalManagerScriptAccount(vmProgramId);
  await ensureSessionManagerDeployment(connection, payer, vmProgramId, managerScriptAccount);
  const sessionClient = new SessionClient({
    vmProgramId,
    managerScriptAccount,
  });
  const owner = payer.publicKey.toBase58();
  const sessionAddress = await sessionClient.deriveSessionAddress(
    owner,
    delegate.publicKey.toBase58(),
    scriptAccount
  );
  const sessionProgram = program.withSession({
    mode: "auto",
    manager: { defaultTtlSlots: 3000 } as any,
    sessionAccountByFunction: {
      hit: sessionAddress,
      stand_and_settle: sessionAddress,
    },
    delegateSignerByFunction: {
      hit: delegate,
      stand_and_settle: delegate,
    },
  });
  const baseAccounts = {
    table: table.publicKey.toBase58(),
    player: player.publicKey.toBase58(),
    round: round.publicKey.toBase58(),
    owner,
    authority: owner,
    delegate: delegate.publicKey.toBase58(),
    session: sessionAddress,
  };
  const vmSentinelSession = vmProgramId;

  // Web-equivalent action flow.
  const initTableIx = decodeIx(
    await program
      .function("init_table")
      .payer(owner)
      .accounts({ __session: vmSentinelSession, table: baseAccounts.table, authority: baseAccounts.authority })
      .args({ min_bet: 10, max_bet: 100, dealer_soft17_hits: true })
      .instruction()
  );
  const initPlayerIx = decodeIx(
    await program
      .function("init_player")
      .payer(owner)
      .accounts({ __session: vmSentinelSession, player: baseAccounts.player, owner: baseAccounts.owner })
      .args({ initial_chips: 500 })
      .instruction()
  );
  const startIx = decodeIx(
    await program
      .function("start_round")
      .payer(owner)
      .accounts({ __session: vmSentinelSession, table: baseAccounts.table, player: baseAccounts.player, round: baseAccounts.round, owner })
      .args({ bet: 25, seed: Date.now() % 1_000_000 })
      .instruction()
  );
  // First deal setup should be 2 tx max:
  // tx1 combines provision + init_table + init_player
  // tx2 does start_round
  const setupTx1 = new Transaction().add(initTableIx, initPlayerIx);
  await sendTx(connection, payer, setupTx1, [table, player]);

  const slot = await connection.getSlot("confirmed");
  const sessionPlan = await sessionClient.buildCreateSessionPlan(
    {
      authority: owner,
      delegate: baseAccounts.delegate,
      targetProgram: scriptAccount,
      expiresAtSlot: slot + 3000,
      scopeHash: SESSION_SCOPE_HASH,
      bindAccount: baseAccounts.player,
      nonce: 0,
    },
    {
      connection,
      payer: payer.publicKey,
      delegateMinLamports: 500_000,
      delegateTopupLamports: 2_000_000,
    }
  );
  const createSessionTx = new Transaction();
  if (sessionPlan.createSessionAccountIx) createSessionTx.add(sessionPlan.createSessionAccountIx);
  if (sessionPlan.topupDelegateIx) createSessionTx.add(sessionPlan.topupDelegateIx);
  createSessionTx.add(sessionPlan.createSessionIx);
  await sendTx(connection, payer, createSessionTx);
  await sendTx(connection, payer, new Transaction().add(startIx), [round]);

  const hitIx = decodeIx(
    await sessionProgram
      .function("hit")
      .payer(baseAccounts.delegate)
      .accounts({
        table: baseAccounts.table,
        player: baseAccounts.player,
        round: baseAccounts.round,
        caller: baseAccounts.delegate,
      })
      .instruction()
  );
  await sendTx(connection, delegate, new Transaction().add(hitIx));

  const standIx = decodeIx(
    await sessionProgram
      .function("stand_and_settle")
      .payer(baseAccounts.delegate)
      .accounts({
        table: baseAccounts.table,
        player: baseAccounts.player,
        round: baseAccounts.round,
        caller: baseAccounts.delegate,
      })
      .instruction()
  );
  try {
    await sendTx(connection, delegate, new Transaction().add(standIx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If hit already ended the round (e.g., bust), stand can be invalid; that's acceptable in this smoke test.
    if (!message.includes("invalid instruction data") && !message.includes("0x232b")) {
      throw err;
    }
  }

  // Smoke coverage ends after one full round.
});
