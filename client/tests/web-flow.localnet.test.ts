import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type ConfirmOptions,
} from "@solana/web3.js";
import { FiveProgram, FiveSDK } from "@5ive-tech/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..", "..");
const rpcUrl = process.env.FIVE_RPC_URL || "http://127.0.0.1:8899";
const vmProgramId = process.env.FIVE_VM_PROGRAM_ID || "2DXiYbzfSMwkDSxc9aWEaW7XgJjkNzGdADfRN4FbxMNN";
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
  const ownerProgram = new PublicKey(vmProgramId);
  const space = 256;
  const lamports = await connection.getMinimumBalanceForRentExemption(space);

  const owner = payer.publicKey.toBase58();
  const baseAccounts = {
    table: table.publicKey.toBase58(),
    player: player.publicKey.toBase58(),
    round: round.publicKey.toBase58(),
    owner,
    authority: owner,
  };

  // Web-equivalent action flow.
  const initTableIx = decodeIx(
    await program
      .function("init_table")
      .payer(owner)
      .accounts({ table: baseAccounts.table, authority: baseAccounts.authority })
      .args({ min_bet: 10, max_bet: 100, dealer_soft17_hits: true })
      .instruction()
  );
  const initPlayerIx = decodeIx(
    await program
      .function("init_player")
      .payer(owner)
      .accounts({ player: baseAccounts.player, owner: baseAccounts.owner })
      .args({ initial_chips: 500 })
      .instruction()
  );
  const startIx = decodeIx(
    await program
      .function("start_round")
      .payer(owner)
      .accounts({ table: baseAccounts.table, player: baseAccounts.player, round: baseAccounts.round, owner })
      .args({ bet: 25, seed: Date.now() % 1_000_000 })
      .instruction()
  );
  // First deal setup should be 2 tx max:
  // tx1 combines provision + init_table + init_player
  // tx2 does start_round
  const setupTx1 = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: table.publicKey,
      lamports,
      space,
      programId: ownerProgram,
    }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: player.publicKey,
      lamports,
      space,
      programId: ownerProgram,
    }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: round.publicKey,
      lamports,
      space,
      programId: ownerProgram,
    }),
    initTableIx,
    initPlayerIx
  );
  await sendTx(connection, payer, setupTx1, [table, player, round]);
  await sendTx(connection, payer, new Transaction().add(startIx));

  const hitIx = decodeIx(
    await program
      .function("hit")
      .payer(owner)
      .accounts({ player: baseAccounts.player, round: baseAccounts.round, owner })
      .instruction()
  );
  await sendTx(connection, payer, new Transaction().add(hitIx));

  const standIx = decodeIx(
    await program
      .function("stand_and_settle")
      .payer(owner)
      .accounts({ table: baseAccounts.table, player: baseAccounts.player, round: baseAccounts.round, owner })
      .instruction()
  );
  await sendTx(connection, payer, new Transaction().add(standIx));

  // Subsequent deals should be one transaction (start_round only).
  const secondStartIx = decodeIx(
    await program
      .function("start_round")
      .payer(owner)
      .accounts({ table: baseAccounts.table, player: baseAccounts.player, round: baseAccounts.round, owner })
      .args({ bet: 30, seed: (Date.now() + 7) % 1_000_000 })
      .instruction()
  );
  await sendTx(connection, payer, new Transaction().add(secondStartIx));
});
