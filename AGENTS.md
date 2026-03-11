# AGENTS.md - 5IVE Agent Operating Contract

This file is the complete minimum contract for building and locally validating a 5IVE project.
Use `./AGENTS_CHECKLIST.md` and `./AGENTS_REFERENCE.md` only as optional supplements for deeper failure triage, extended syntax examples, and client/debug details.

## 0) Policy Overrides (2026-03)

These rules override any older examples:
1. Typed account metadata access uses `acct.ctx.*` (for example `acct.ctx.key`), not `acct.key`.
2. Account serializer keywords are `raw`, `borsh`, `bincode`.
3. Default account serializer is `raw`.
4. Serializer precedence is parameter override > account type default > interface/program default.
5. `anchor` is not a serializer keyword.

## 1) Mission

Deliver production-ready 5IVE contracts in one focused pass when possible, with deterministic build/test verification first and deploy/execute verification when on-chain scope is requested.
No placeholder logic in production paths.
When porting from Anchor, preserve the original security model unless the user explicitly approves a behavioral change.

## 2) Public Toolchain and Environment

1. The installed `5ive` / `five` CLI and bundled `@5ive-tech/sdk` behavior are the supported end-user toolchain.
2. Do not assume access to internal compiler scripts, Rust build flows, or monorepo-only tooling.
3. Node.js `>=18` is the supported runtime for the public CLI.
4. Prefer local CLI help (`5ive --help`, `5ive help <command>`) and generated project files over external docs when behavior differs.

## 3) Project Layout and Local Sources of Truth

Expect these local files and directories in a project created with `5ive init`:
1. `five.toml` is the project configuration root.
2. `src/` contains `.v` source files.
3. `build/` contains compiled artifacts.
4. `tests/` contains local tests.
5. `docs/STDLIB.md` is the bundled local stdlib reference; use it for module details instead of assuming access to monorepo docs.

## 4) Source of Truth Order

When docs conflict, follow this order:
1. Local compiler/CLI/SDK source code installed in the workspace
2. Package manifests and command definitions
3. CLI help output and generated project artifacts (`five.toml`, `.five`, ABI, `.five/` build metadata)
4. READMEs/examples/docs

Offline-first fallback:
1. If source/docs are unavailable, continue with local CLI behavior and generated artifacts.
2. Never block waiting for external docs when compile/test feedback is available.
3. Treat compiler and runtime output as the immediate truth source.
4. For end users, the installed `5ive` CLI, bundled SDK, and bundled compiler are the supported toolchain. Do not assume access to maintainer-only compilers or internal build scripts.

## 5) Non-Negotiable Build and Local Validation Workflow

For the default build-and-validate path, always run this sequence:
1. Inspect `five.toml`.
2. Verify the build-critical fields before compiling:
- `[project].entry_point`
- `[project].build_dir`
- `[project].target`
- `[deploy].program_id` (secondary for build-only work, but required later for on-chain commands)
- `[deploy].cluster`, `[deploy].rpc_url`, and `[deploy].keypair_path` (can affect tests and on-chain flows)
3. Build with `5ive build` as the preferred project build command.
4. Run local tests with `5ive test --sdk-runner`.
5. Re-run focused tests with `5ive test --filter "test_*" --verbose` when isolating failures.
6. Treat deploy/execute as conditional and only continue when the user asks for on-chain scope.

Build contract details:
1. `5ive build` discovers `five.toml` by searching upward from the current directory, or you can pass `--project <path>`.
2. Project builds require `project.entry_point` in `five.toml`.
3. Prefer `5ive build` over ad hoc compilation for real projects because project builds handle multi-file imports and module discovery.
4. `5ive compile <file>` remains valid for direct-file compilation, but it is secondary to `5ive build` for project work.
5. Treat `build/main.five` as the default output artifact unless project config or explicit output flags override it.
6. The `.five` artifact is the primary output and contains bytecode plus ABI.
7. The build process also writes project metadata under `.five/` (including the build manifest). Treat generated project artifacts as authoritative.

Local test contract details:
1. `5ive test` defaults to the project `tests/` directory when run in a project context.
2. Both `.v` tests and `.test.json` suites are supported.
3. If `target`, `network`, or `keypair` are not passed explicitly, test runs may inherit defaults from `five.toml`.
4. Use on-chain test modes only when the user explicitly requests on-chain validation.

For Anchor ports, add this before coding:
1. Enumerate each Anchor instruction, account constraint, signer rule, and PDA seed flow.
2. Decide the exact 5IVE account/state model and interface/CPI replacements.
3. Preserve auth, range/amount guards, replay protection, and counter semantics before optimizing syntax.

## 6) One-Shot Delivery Policy

1. Start with full-scope design: state, guards, init flows, core instructions, tests, and client integration.
2. Implement in compile-clean increments: state/init first, then each instruction, then tests, then client.
3. If compile fails, do not replace the design with a simplified contract.
4. Keep original scope and fix errors incrementally using compiler output and checklist gates.
5. Only reduce scope if the user explicitly requests reduced scope.

Anchor-porting default:
1. Port all public instructions and required helpers, not just the easiest path.
2. Carry forward security-critical sysvar, signature, and entropy/auth checks.
3. If an Anchor feature does not map directly, implement the platform support or document a release blocker. Do not silently weaken behavior.

## 7) Hard Authoring Rules

1. Every account field ends with `;`.
2. Use `account @signer` for auth params (not `pubkey @signer`).
3. Use `account.ctx.key` for account pubkey access (legacy `account.key` is removed).
4. Use `account.ctx.lamports|owner|data` for runtime account metadata (legacy direct access is removed).
5. For seeded `@init`, use `account.ctx.bump` (legacy `<account>_bump` alias is removed).
6. Functions returning values must declare `-> ReturnType`.
7. Use `0` for pubkey zero-init/revocation values. Do not use `pubkey(0)`.
8. `string<N>` is production-safe.
9. `require()` supports `==`, `!=`, `<`, `<=`, `>`, `>=`, `!`, `&&`, `||`.
10. Locals are immutable by default. Use `let mut` if reassigning.
11. No mock timestamps/rates/auth bypasses in production logic.
12. Prefer lowercase authored DSL types (`account`, `pubkey`, `string<N>`). Generated ABI or bundled stdlib surfaces may still show `Account`, but authored source should use the current lowercase form.

## 8) Stdlib and Import Contract (Mandatory)

1. Use module imports, then call stdlib interfaces with an explicit interface segment:
- `use std::builtins;` then `builtins::now_seconds()`
- `use std::builtins::now_seconds;` then `now_seconds()`
- `use std::interfaces::spl_token;` then `spl_token::SPLToken::transfer(...)`
- `use std::interfaces::system_program;` then `system_program::SystemProgram::transfer(...)`
2. Interface symbol imports are supported:
- `use std::interfaces::spl_token::SPLToken;` then `SPLToken::transfer(...)`
- `use payments::MemoProgram;` then `MemoProgram::write(...)`
3. Full-path calls are valid:
- `std::interfaces::spl_token::SPLToken::transfer(...)`
- `std::interfaces::system_program::SystemProgram::transfer(...)`
- `std::builtins::now_seconds()`
4. Legacy local dot-call syntax may still compile for in-file interfaces, but canonical authored syntax is:
- `MemoProgram::write(...)`
5. `module::method(...)` is not the canonical interface form; include the interface name segment.
6. Missing import for alias calls should be fixed by adding `use <module path>;` or `use <module path>::<Symbol>;`.
7. Prefer interface `@authority` parameters plus caller-side `account @pda(seeds=[...])` metadata over explicit `invoke_signed(...)` calls.
8. If an interface authority arg is a normal signer account, the compiler should emit plain `INVOKE`; if it is a PDA account, the compiler should emit signed CPI automatically.

## 8.3) Reserved Identifier Guidance (Mandatory)

1. Avoid reserved or compiler-sensitive field/parameter names in authored DSL when equivalent names exist.
2. Do not use `owner` for mutable account-state authority fields in new contracts; prefer `authority`.
3. For account-control semantics, standardize on:
- account field: `authority: pubkey`
- signer parameter: `authority: account @signer`
4. If porting older code that uses `owner`, rename to `authority` unless compatibility constraints require preserving the external name.
5. If an `ImmutableField` or similar checker error appears around identifiers, treat naming as the first triage step before deeper refactors.

## 8.4) Account Serializer State Access Contract (Mandatory)

Use these rules whenever reading external account state via typed fields.

1. Keep CPI and account decoding concepts separate:
- Interface `@serializer(...)` = instruction-data encoding for CPI calls.
- Account/parameter `@serializer(...)` = account-state decode mode for field access.
2. Account decode precedence is strict:
- parameter instance `@serializer(...)` > account type `@serializer(...)` > contextual default.
3. For SPL Token `Mint` and `TokenAccount`, use `raw` decoding.
4. Supported account decode serializers are `raw`, `borsh`, and `bincode`.
5. For typed accounts, always use `account.ctx.key` (and `ctx.*` metadata); direct `account.key` is invalid.
6. Prefer namespaced stdlib account types (for example `spl_token::Mint`, `spl_token::TokenAccount`) over local shadow definitions.
7. If you only need a subset of fields, partial definitions can compile, but production integrations should prefer canonical full layouts for external programs.
8. Enforce behavior with on-chain assertion instructions (`require(...)` checks over decoded fields), not only local mocks.

Authoring examples:

```five
account Mint @serializer("raw") {
    mint_authority_option: u32;
    mint_authority: pubkey;
    supply: u64;
    decimals: u8;
    is_initialized: bool;
    freeze_authority_option: u32;
    freeze_authority: pubkey;
}

pub read_supply(mint: Mint @serializer("raw")) -> u64 {
    return mint.supply;
}
```

## 8.1) Crypto Capability Contract (Mandatory)

1. Hash builtins use explicit output buffers:
- `sha256(input_bytes, out32)`
- `keccak256(input_bytes, out32)`
- `blake3(input_bytes, out32)`
2. Preferred wrapper names (via `std::builtins`) are:
- `hash_sha256_into(input, out)`
- `hash_keccak256_into(input, out)`
- `hash_blake3_into(input, out)`
3. Byte preimage assembly should use `bytes_concat(left, right)` for deterministic composition.
4. Ed25519 entropy/auth checks should use:
- `verify_ed25519_instruction(instruction_sysvar, expected_pubkey, message, signature) -> bool`
5. For production auth-sensitive randomness, no fallback path is allowed when Ed25519 verification fails.

Notes:
1. `bytes_concat(left, right)` returns a bytes-compatible buffer that can be fed directly into hash builtins.
2. Large fixed `[u8; N]` literals are supported through the raw-bytes lowering path; use them directly for signatures, preimages, and known vectors when the size is static.

## 8.2) Anchor Porting Contract (Mandatory When Migrating)

Map Anchor concepts to 5IVE explicitly:
1. `#[account]` struct -> `account Name { ... }`
2. signer account access -> `account @signer`
3. signer pubkey extraction -> `signer.ctx.key`
4. mutable state -> `State @mut`
5. init flows -> `State @mut @init(...)`
6. Anchor `require!()` guards -> `require(...)`
7. instruction sysvar verification patterns -> explicit `instruction_sysvar: account` parameter plus builtin validation
8. PDA seed/bump logic -> `@seed(...)`, `account.ctx.bump`, and PDA builtins as needed
9. Anchor CPI -> 5IVE interfaces with `@program(...)`, serializer/discriminator selection, and direct account params
10. Anchor CPI authorities backed by PDAs -> interface `@authority` plus caller-side `account @pda(seeds=[...])`; do not make users pass signer-seed arrays at the call site

Porting rules:
1. Keep instruction names and semantic ordering stable unless the user requests an API change.
2. Preserve counter increments, state transitions, and failure behavior exactly.
3. Do not replace verified randomness/auth paths with counters, placeholders, or simplified arithmetic.
4. If Anchor used Ed25519 instruction-sysvar proofs, the 5IVE port must also verify them before accepting entropy/authenticated input.
5. If Anchor used raw byte hashing, reproduce the byte layout exactly and prove it with a deterministic vector.

For serializer/state-access details, see:
1. `docs/ACCOUNT_SERIALIZER_STATE_ACCESS_GUIDE.md`
2. `docs/CPI_GUIDE.md`

## 9) Mismatch and Fallback Rules

1. If CLI behavior and docs disagree, trust the installed CLI help output and actual compile/test results.
2. If build fails because module discovery or import resolution is unavailable, do not invent alternate internal workflows; stay within the public CLI path and report the blocking compiler/toolchain limitation.
3. If an older global install appears stale, record the mismatch explicitly instead of assuming monorepo behavior.
4. Treat `./AGENTS_CHECKLIST.md` and `./AGENTS_REFERENCE.md` as optional supplements, not prerequisites for baseline build/test success.

## 10) Definition of Done

Work is done only when all applicable items are true:
1. `.five` artifact produced.
2. Tests passed with evidence.
3. Deployment confirmed (if in scope and explicitly requested).
4. Execution confirmed with `meta.err == null` (if in scope and explicitly requested).
5. Signatures and compute units recorded for on-chain work.
6. SDK/frontend integration snippet delivered when requested.

## 11) Required Agent Output Format

Unless the user explicitly asks for a different format, final output must include:
1. Scope implemented (what was built).
2. Files changed.
3. Build/test commands run and outcomes.
4. Security checks performed and results.
5. Deploy/execute evidence when on-chain work is in scope:
   - target
   - program ID
   - signature(s)
   - `meta.err` result
   - compute units
6. SDK/client usage snippet or runnable command path.
7. Remaining risks and explicit next steps.
8. For Anchor ports: explicit mapping summary from Anchor constructs to 5IVE constructs, plus any unresolved parity gaps.

## 12) Where to Look Next

1. `./AGENTS_CHECKLIST.md` for deeper failure triage and execution gates.
2. `./AGENTS_REFERENCE.md` for expanded syntax, CPI rules, testing patterns, and SDK client templates.
