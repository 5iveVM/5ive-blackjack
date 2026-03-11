# AGENTS_REFERENCE.md - 5IVE Practical Reference

This reference is for agents that do not have direct access to the 5IVE monorepo internals.
Use with `./AGENTS.md` and `./AGENTS_CHECKLIST.md`.

## Policy Overrides (2026-03)

These rules are authoritative and override older examples:
1. Typed account metadata access must use `acct.ctx.*` (for example `acct.ctx.key`), not `acct.key`.
2. Account serializer keywords are `raw`, `borsh`, `bincode`.
3. Default account serializer is `raw`.
4. Serializer precedence is parameter override > account type default > interface/program default.
5. `anchor` is not a serializer keyword.

## 1) Core Surfaces

1. Source language: `.v`
2. Build artifact: `.five` (bytecode + ABI)
3. CLI: `@5ive-tech/cli` commands `5ive` or `five`
4. SDK: `@5ive-tech/sdk`
5. For end users, the installed CLI/SDK behavior is authoritative. Treat maintainer-only compiler workflows as internal parity tooling, not part of the supported user path.

## 2) Online and Offline Working Modes

1. Online mode:
- use docs/examples as supplemental context
- still treat compile output and tx logs as authoritative
2. Offline mode:
- rely on `five.toml`, CLI help, compiler errors, generated ABI, and runtime logs
- do not block waiting for external references

## 3) Compiler-Critical Syntax

### Quickstart skeleton (recommended starting point)

```v
use std::builtins;
use std::interfaces::spl_token;

pub run(
    source: account @mut,
    destination: account @mut,
    authority: account @signer
) -> u64 {
    spl_token::SPLToken::transfer(source, destination, authority, 1);
    return builtins::now_seconds();
}
```

Import/call contract:
1. `use <module path>;`
2. call using module alias and interface segment: `<last_segment>::<Interface>::<method>(...)`
3. full path calls are also valid: `<full::module::path>::<method>(...)`
4. canonical interface calls include the interface symbol segment: `module_alias::Interface::method(...)`
5. locally declared interfaces should use `Interface::method(...)`; legacy dot-call may still compile in some cases
6. prefer lowercase authored source types like `account`; some generated ABI/std surfaces may still display `Account`

### Account declarations

```v
account Vault {
    authority: pubkey;
    balance: u64;
    status: u8;
}
```

Rule: every account field must end with `;`.

### Signers and key extraction

```v
pub update_authority(
    state: Vault @mut,
    authority: account @signer,
    next_authority: pubkey
) {
    require(state.authority == authority.ctx.key);
    state.authority = next_authority;
}
```

Rules:
1. signer params are `account @signer`
2. use `.ctx.key` when comparing or assigning pubkeys from account params
3. use `.ctx.lamports`, `.ctx.owner`, `.ctx.data`, and `.ctx.bump` for runtime metadata and seeded init flows

### Zero pubkey sentinel

Use `0` for unset/revoked pubkey values in assignments and checks.
Do not use `pubkey(0)`; current parser paths treat `pubkey` as a type token, not a callable constructor.

### Init attribute order

Canonical order for initialized account params:

`Type @mut @init(payer=name, space=bytes) @signer`

```v
pub initialize(
    state: Vault @mut @init(payer=creator, space=128) @signer,
    creator: account @mut @signer
) {
    state.authority = creator.ctx.key;
    state.balance = 0;
    state.status = 1;
}
```

### Return types and locals

```v
pub quote(amount: u64, fee_bps: u64) -> u64 {
    let mut result: u64 = amount;
    result = result - ((amount * fee_bps) / 10000);
    return result;
}
```

Rules:
1. functions returning values must use `-> ReturnType`
2. locals are immutable unless declared with `let mut`

## 4) Built-ins and Units

Use stdlib wrappers via module import:
1. `use std::builtins;`
2. call `builtins::now_seconds()`, `builtins::abort_now()`, `builtins::panic_now(...)`, and crypto wrappers:
- `builtins::hash_sha256_into(input, out32)`
- `builtins::hash_keccak256_into(input, out32)`
- `builtins::hash_blake3_into(input, out32)`
- `builtins::bytes_concat(left, right)`
- `builtins::verify_ed25519_instruction(instruction_sysvar, expected_pubkey, message, signature)`
3. full path form is valid: `std::builtins::now_seconds()`

Current crypto guidance:
1. Prefer direct full-width preimage assembly with `bytes_concat`.
2. Hash into a fixed `[u8; 32]` output buffer.
3. Large fixed `[u8; N]` literals are valid for static messages, signatures, and test vectors.
4. Treat `verify_ed25519_instruction(...) == false` as a hard failure in auth-sensitive paths.

Recommended unit standards:
1. time in seconds
2. USD price scale `1e6`
3. rate scale `1e9` (or `1e12`, but stay consistent per contract)

## 5) CPI Rules

1. Interface uses `@program("...")` with valid base58 program ID.
2. Anchor CPI: use `@anchor` and do not add manual discriminator.
3. Non-anchor CPI: use single-byte `@discriminator(N)`.
4. Interface account params should be account-like values, not raw pubkeys, when the callee expects account metas.
5. Invoke interface methods with module/interface qualification: `module_alias::Interface::method(...)`.
6. Full-path form is valid: `std::interfaces::spl_token::SPLToken::transfer(...)`.
7. Local interfaces declared in the same file should use `Interface::method(...)`.
8. Pass account params directly in CPI calls, not `.ctx.key`.
9. CPI-writable accounts must be `account @mut` in caller signature.
10. Do not inject the callee program account into instruction metas unless the interface explicitly models it as a callee account; it still must be present in the CPI account-info slice.
11. For raw-byte CPI payloads, use fixed `[u8; N]` literals or deterministic byte buffers and let the compiler lower them through the bytes path.
12. Mark callee authority slots with `@authority` on interface account params.
13. Declare caller PDA authorities once with `account @pda(seeds=[...])`; interface calls should then select signed CPI automatically with no signer-seed arrays at the call site.

## 5.1) Anchor-to-5IVE Porting Map

Use this as the default migration map:

| Anchor | 5IVE |
|---|---|
| `#[account]` state struct | `account Name { ... }` |
| `Signer<'info>` | `account @signer` |
| `.key()` | `.ctx.key` |
| mutable account | `State @mut` |
| `init` / payer / space constraints | `@init(payer=..., space=...)` |
| `require!()` | `require(...)` |
| instruction sysvar checks | explicit `instruction_sysvar: account` plus builtins |
| PDA bump access | `account.ctx.bump` |
| Anchor CPI | interface + `@program(...)` + serializer/discriminator |

Porting checklist:
1. List all Anchor instructions and port them one by one.
2. Copy every auth/range/state guard before refactoring names or layout.
3. Reproduce byte layouts exactly when hashing, signing, or verifying sysvar-backed proofs.
4. Keep failure behavior intact unless the user explicitly approves an API/semantics change.

## 6) Build and Test Commands

```bash
5ive build
5ive test --sdk-runner
5ive test --filter "test_*" --verbose
```

Discovery behavior:
1. test functions can be named `pub test_*`
2. `.v` tests and `.test.json` suites are supported by `5ive test`
3. If the globally installed CLI behaves differently from the pinned monorepo compiler/runtime, treat the monorepo toolchain as the source of truth and record the mismatch explicitly.

## 7) Security Review Minimum

Before deploy, verify:
1. every privileged instruction checks signer/authority correctly
2. state transitions are explicit and valid
3. math and units are consistent and bounded
4. CPI interfaces and account mutability/signer expectations are correct
5. negative tests cover auth, state, and boundary failures
6. for Anchor ports, add parity tests for:
- instruction auth/signer behavior
- deterministic hash/preimage vectors
- counter/state transition parity
- CPI/sysvar proof semantics

## 8) Debugging Loop for Weak Error Messages

When compiler errors are unclear, use this fixed loop:
1. Keep the requested contract scope intact.
2. Compile and capture the first failing file/line.
3. Check parser-critical items first:
- account field semicolons
- init attribute order
- signer type and `.ctx.key` usage
- `let` vs `let mut`
4. Recompile immediately after each small fix.
5. If still failing, isolate one instruction block, fix it, then merge back.
6. Do not downgrade to a simplified contract unless the user requests it.
7. For `Unresolved module alias 'x'`, add `use <module path ending in x>;`.

## 9) five.toml and Program ID Resolution

On-chain command precedence (`deploy`, `execute`, `namespace`):
1. `--program-id`
2. `five.toml [deploy].program_id`
3. current CLI config target/program
4. `FIVE_PROGRAM_ID`

Never deploy/execute with ambiguous target or program ID.

## 10) Deployment and Execution Evidence

Minimum evidence to report:
1. target and program ID used
2. deploy signature (if deploy is in scope)
3. execute signature(s)
4. confirmed `meta.err == null`
5. compute units consumed

Use CLI and RPC checks to confirm transaction status and logs; never infer success from submission alone.

## 11) SDK Client Pattern

Use this pattern for clients:

```ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { FiveSDK } from "@5ive-tech/sdk";
import fs from "node:fs";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("./payer.json", "utf8")))
);

const programId = new PublicKey("REPLACE_WITH_PROGRAM_ID");
const artifact = fs.readFileSync("./build/main.five");

const sdk = new FiveSDK(connection, payer);
const program = await sdk.loadProgram({
  programId,
  bytecode: artifact,
});

const sig = await program
  .method("initialize")
  .accounts({
    state: new PublicKey("REPLACE_STATE"),
    authority: payer.publicKey,
  })
  .args({})
  .rpc();

console.log("signature", sig);
```

Client debugging checks:
1. method name must exactly match ABI
2. required accounts must all be provided
3. args shape/order must match ABI
4. signer/payer must be funded and correct
5. confirm tx and inspect logs on failure

## 12) Required Final Output (Default)

Unless the user explicitly asks for a different format, include:
1. scope implemented
2. files changed
3. build/test commands and results
4. security checks and outcomes
5. deploy/execute evidence (`meta.err`, signatures, compute units)
6. SDK/client usage snippet or runnable path
7. remaining risks and next steps
